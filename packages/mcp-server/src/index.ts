/**
 * UPG Local MCP Server
 *
 * Usage: upg-mcp-server [--workspace <dir>] [--file <path-to.upg>]
 *                       [--title "My Product"] [--init] [--check] [--help]
 *
 * Resolution order (0.38.0, cloud-agent hardening):
 *   1. --workspace <dir> / UPG_WORKSPACE → dir IS the .upg workspace (holds
 *      workspace.json or *.upg files). The server arranges its own cwd around
 *      it, so every workspace tool resolves there — no shell wrapper needed.
 *   2. --file flag → use that file directly
 *   3. .upg/workspace.json in cwd → load default_product from workspace
 *   4. *.upg files in cwd → if 1, use it; if many, use first alphabetically
 *   5. Nothing found → REFUSE loudly, naming the cwd and every path checked.
 *      Creating a blank graph is opt-in via --init, never a fallback: in a
 *      cloud VM where the cwd of a dashboard-launched stdio process is
 *      unknown, a silently fabricated graph means every tool call "succeeds"
 *      against a phantom and writes are lost with no signal.
 *
 * --check resolves the workspace exactly as the server would, prints
 * `{workspace, resolved_file, products, spec_version, server_version}` and
 * exits 0/1 WITHOUT starting the transport — built for environment install
 * scripts, so a misconfigured environment fails at build time, not mid-session.
 *
 * Reads a .upg file into memory and exposes it via MCP over stdio.
 * Changes are auto-saved back to the file with debounced writes.
 */

import { parseArgs } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as nodeCrypto from 'node:crypto'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createServer, createUnavailableServer, SERVER_VERSION } from './server.js'
import { setWorkspaceRoot } from './lib/server-context.js'
import { isValidProfile, TOOL_PROFILES, type ToolProfile } from './lib/tool-profiles.js'
import { UPG_VERSION, isDeprecatedType, getReplacementType, serializeCanonical, parseUpg, type UPGDocument } from '@unified-product-graph/core'
import { nanoid } from 'nanoid'

const USAGE = `upg-mcp-server — Unified Product Graph local MCP server (stdio)

Usage: upg-mcp-server [options]

Options:
  --workspace <dir>   The .upg workspace directory (holds workspace.json or
                      *.upg files). Also read from UPG_WORKSPACE. The server
                      arranges its own cwd, so no shell wrapper is needed.
  -f, --file <path>   Serve one specific .upg file.
  -t, --title <name>  Title for a graph created with --init.
  --init              Allow creating a blank graph when nothing resolves.
                      Without it, an empty resolution REFUSES (exit 1) —
                      creation is never a fallback.
  --profile <name>    Filter the tool surface server-side: "read-only"
                      (no tool that writes a graph, a portfolio, or the
                      network) or "author" (writes allowed; destructive and
                      infrastructure tools gated). The filter applies to
                      tools/list AND tools/call.
  --check             Resolve the workspace exactly as the server would,
                      print JSON, exit 0/1. Never starts the transport,
                      never writes. For environment install scripts.
  -h, --help          Show this help.
`

/**
 * Arrange the process cwd so the workspace tools (which resolve against
 * `cwd/.upg/`) see `wsDir` as the workspace. Two shapes:
 *  - `wsDir` is literally named `.upg` → chdir to its parent.
 *  - anything else → a per-workspace runtime shim dir holding a `.upg`
 *    symlink to it, then chdir there. This internalizes the shell wrapper
 *    cloud environments were hand-writing (mkdir + ln -sfn + cd), which is
 *    the layout the field brief verified working end-to-end.
 * Returns the absolute (real) workspace path for reporting.
 */
async function arrangeWorkspaceCwd(wsDir: string): Promise<string> {
  const real = await fs.realpath(path.resolve(wsDir))
  if (path.basename(real) === '.upg') {
    process.chdir(path.dirname(real))
    return real
  }
  const shim = path.join(
    os.tmpdir(),
    `upg-ws-${nodeCrypto.createHash('sha256').update(real).digest('hex').slice(0, 12)}`,
  )
  await fs.mkdir(shim, { recursive: true })
  const link = path.join(shim, '.upg')
  try {
    const existing = await fs.readlink(link)
    if (existing !== real) {
      await fs.unlink(link)
      await fs.symlink(real, link, 'dir')
    }
  } catch {
    await fs.rm(link, { recursive: true, force: true }).catch(() => {})
    await fs.symlink(real, link, 'dir')
  }
  process.chdir(shim)
  return real
}

/**
 * Validate that `wsDir` is a plausible workspace: it exists and holds either
 * workspace.json or at least one *.upg file. Returns a human diagnosis on
 * failure, null on success. Never writes.
 */
async function validateWorkspaceDir(wsDir: string): Promise<string | null> {
  const abs = path.resolve(wsDir)
  let entries: string[]
  try {
    entries = await fs.readdir(abs)
  } catch {
    return `--workspace ${abs}: directory does not exist or is unreadable.`
  }
  if (entries.includes('workspace.json') || entries.some((f) => f.endsWith('.upg'))) return null
  return (
    `--workspace ${abs}: no workspace.json and no *.upg files found there.\n` +
    `A workspace directory is the one that CONTAINS the graphs (what .upg/ is in a repo).`
  )
}

/**
 * Discover which .upg file to load using the 4-tier priority system.
 * Returns the resolved file path, or null if nothing found (Tier 4: create blank).
 */
async function discoverUPGFile(explicitFile?: string): Promise<string | null> {
  // Tier 1: explicit --file flag
  if (explicitFile) return path.resolve(explicitFile)

  const cwd = process.cwd()

  // Tier 2: .upg/workspace.json
  const workspacePath = path.join(cwd, '.upg', 'workspace.json')
  try {
    const raw = await fs.readFile(workspacePath, 'utf-8')
    const workspace = JSON.parse(raw)
    if (workspace.default_product) {
      const filePath = path.join(cwd, '.upg', workspace.default_product)
      await fs.access(filePath)
      const title =
        workspace.products?.find(
          (p: { file: string; title?: string }) =>
            p.file === workspace.default_product,
        )?.title ?? workspace.default_product
      process.stderr.write(
        `UPG workspace: loading "${title}"\n`,
      )
      return filePath
    }
  } catch {
    // No workspace.json; check if .upg/ dir has .upg files and auto-create workspace.json
    const upgDir = path.join(cwd, '.upg')
    try {
      const dirEntries = await fs.readdir(upgDir)
      const upgFiles = dirEntries.filter((f) => f.endsWith('.upg')).sort()
      if (upgFiles.length > 0) {
        // Auto-generate workspace.json from discovered files
        const products: Array<{ file: string; title: string }> = []
        for (const file of upgFiles) {
          let title = path.basename(file, '.upg')
          try {
            const raw = await fs.readFile(path.join(upgDir, file), 'utf-8')
            const doc = JSON.parse(raw)
            if (doc.product?.title) title = doc.product.title
          } catch { /* use filename as title */ }
          products.push({ file, title })
        }
        const workspace = {
          version: '1.0',
          default_product: upgFiles[0],
          products,
        }
        await fs.writeFile(workspacePath, JSON.stringify(workspace, null, 2) + '\n', 'utf-8')
        process.stderr.write(
          `UPG workspace: auto-created workspace.json (${upgFiles.length} product${upgFiles.length > 1 ? 's' : ''})\n`,
        )
        const filePath = path.join(upgDir, upgFiles[0])
        process.stderr.write(`UPG workspace: loading "${products[0].title}"\n`)
        return filePath
      }
    } catch {
      // .upg/ dir doesn't exist; continue to Tier 3
    }
  }

  // Tier 3: *.upg files in cwd
  try {
    const entries = await fs.readdir(cwd)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length === 1) {
      return path.resolve(upgFiles[0])
    }
    if (upgFiles.length > 1) {
      process.stderr.write(
        `Found ${upgFiles.length} .upg files: loading ${upgFiles[0]}. Use --file to pick a specific one.\n`,
      )
      return path.resolve(upgFiles[0])
    }
  } catch {
    // readdir failed; continue to Tier 4
  }

  // Tier 4: nothing found
  return null
}

/** The blank-graph document `--init` creates. */
function blankDocument(title: string): UPGDocument {
  return {
    upg_version: UPG_VERSION,
    exported_at: new Date().toISOString(),
    source: { tool: 'upg-mcp-local', tool_version: SERVER_VERSION },
    product: { id: nanoid(16), title },
    nodes: [],
    edges: [],
  } as unknown as UPGDocument
}

/** The loud refusal that replaced the phantom-graph fallback (0.38.0, F1). */
function refuseEmptyResolution(cwd: string): never {
  process.stderr.write(
    `\nUPG MCP server: no graph found — refusing to start.\n\n` +
    `Checked, in order:\n` +
    `  1. --workspace / UPG_WORKSPACE   (not set)\n` +
    `  2. --file                        (not set)\n` +
    `  3. ${path.join(cwd, '.upg', 'workspace.json')}   (absent)\n` +
    `  4. ${path.join(cwd, '*.upg')}   (none)\n\n` +
    `cwd: ${cwd}\n\n` +
    `Fix one of:\n` +
    `  --workspace <dir>   point at the directory holding your graphs\n` +
    `  --file <path>       serve one specific .upg file\n` +
    `  --init              deliberately create a blank graph here\n\n` +
    `A silently created blank graph is never the right answer in an\n` +
    `environment whose cwd you do not control: every tool call would\n` +
    `"succeed" against a phantom and your writes would be lost.\n`,
  )
  process.exit(1)
}

export async function runMcpServer() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      file: { type: 'string', short: 'f' },
      title: { type: 'string', short: 't' },
      init: { type: 'boolean' },
      check: { type: 'boolean' },
      profile: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    // Tolerate stray positionals. When launched via `upg mcp run`, argv carries
    // the `mcp run` subcommand tokens; without this, parseArgs throws
    // ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL and the server never starts. The
    // standalone bin (`upg-mcp-server`) passes none, so this is harmless there.
    allowPositionals: true,
  })

  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  // --profile (0.38.0, F5): validated up front so a typo'd profile fails the
  // launch instead of silently serving the full surface.
  let profile: ToolProfile | undefined
  if (values.profile !== undefined) {
    if (!isValidProfile(values.profile)) {
      process.stderr.write(
        `\nUPG MCP server: unknown --profile "${values.profile}". Valid: ${TOOL_PROFILES.join(', ')}.\n`,
      )
      process.exit(1)
    }
    profile = values.profile
  }

  // ── Workspace resolution (F1): explicit beats discovery ────────────────────
  const wsArg = values.workspace ?? process.env.UPG_WORKSPACE
  let workspaceAbsPath: string | null = null
  if (wsArg) {
    const problem = await validateWorkspaceDir(wsArg)
    if (problem) {
      process.stderr.write(`\nUPG MCP server: ${problem}\n`)
      process.exit(1)
    }
    if (values.check) {
      // --check never mutates: report the real path without arranging cwd
      // (arranging may create the runtime shim dir).
      workspaceAbsPath = await fs.realpath(path.resolve(wsArg))
      process.chdir(path.basename(workspaceAbsPath) === '.upg' ? path.dirname(workspaceAbsPath) : workspaceAbsPath)
      // In the non-`.upg`-named case the workspace tools would use the shim;
      // for --check we only need file resolution below, which handles both.
    } else {
      workspaceAbsPath = await arrangeWorkspaceCwd(wsArg)
    }
  } else {
    try {
      workspaceAbsPath = await fs.realpath(path.join(process.cwd(), '.upg'))
    } catch {
      workspaceAbsPath = null
    }
  }
  setWorkspaceRoot(workspaceAbsPath)

  // ── --check (F2): resolve as the server would, print, exit. No transport. ──
  if (values.check) {
    const cwd = process.cwd()
    let resolved: string | null = null
    // With --workspace pointing at a non-`.upg`-named dir, resolve directly
    // against it (the live path resolves via the shim; --check avoids writes).
    if (wsArg && workspaceAbsPath && path.basename(workspaceAbsPath) !== '.upg') {
      try {
        const raw = await fs.readFile(path.join(workspaceAbsPath, 'workspace.json'), 'utf-8')
        const ws = JSON.parse(raw)
        if (ws.default_product) resolved = path.join(workspaceAbsPath, ws.default_product)
      } catch {
        const entries = await fs.readdir(workspaceAbsPath).catch(() => [] as string[])
        const upg = entries.filter((f) => f.endsWith('.upg')).sort()
        if (upg.length > 0) resolved = path.join(workspaceAbsPath, upg[0])
      }
    } else {
      resolved = await discoverUPGFile(values.file)
    }
    let products = 0
    let ok = false
    let error: string | undefined
    if (resolved) {
      try {
        await fs.access(resolved)
        parseUpg(await fs.readFile(resolved, 'utf-8'))
        ok = true
      } catch (err) {
        error = `resolved file unreadable or unparsable: ${(err as Error).message}`
      }
      if (workspaceAbsPath) {
        const entries = await fs.readdir(workspaceAbsPath).catch(() => [] as string[])
        products = entries.filter((f) => f.endsWith('.upg')).length
      } else if (ok) {
        products = 1
      }
    } else {
      error = `nothing resolved from cwd ${cwd}; pass --workspace or --file`
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok,
          workspace: workspaceAbsPath,
          resolved_file: resolved,
          products,
          spec_version: UPG_VERSION,
          server_version: SERVER_VERSION,
          ...(error ? { error } : {}),
        },
        null,
        2,
      ) + '\n',
    )
    process.exit(ok ? 0 : 1)
  }

  let resolvedPath = await discoverUPGFile(values.file)

  // Empty resolution (F1): creation is opt-in via --init, never a fallback.
  if (!resolvedPath) {
    if (!values.init) refuseEmptyResolution(process.cwd())
    const defaultFile = path.resolve('product.upg')
    await fs.mkdir(path.dirname(defaultFile), { recursive: true })
    await fs.writeFile(defaultFile, serializeCanonical(blankDocument(values.title ?? 'My Product')), 'utf-8')
    process.stderr.write(`Created new UPG file: ${defaultFile}\n`)
    resolvedPath = defaultFile
  } else {
    // A discovered-but-absent file (--file with a new path) is likewise only
    // created deliberately.
    try {
      await fs.access(resolvedPath)
    } catch {
      if (!values.init) {
        process.stderr.write(
          `\nUPG MCP server: ${resolvedPath} does not exist — refusing to create it.\n` +
          `Pass --init to deliberately create a blank graph at that path.\n`,
        )
        process.exit(1)
      }
      const title = values.title ?? path.basename(resolvedPath, '.upg')
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.writeFile(resolvedPath, serializeCanonical(blankDocument(title)), 'utf-8')
      process.stderr.write(`Created new UPG file: ${resolvedPath}\n`)
    }
  }

  // Load the .upg file into memory
  const store = new UPGFileStore()
  // Stamp this server (name + real version) as the writer so every file it
  // saves records accurate, last-writer provenance ( / M7). 'upg-mcp-local'
  // matches the blank-doc + store default and distinguishes the local server
  // from the cloud one.
  store.setWriter('upg-mcp-local', SERVER_VERSION)
  try {
    await store.load(resolvedPath)
  } catch (err) {
    // An unloadable graph must be DIAGNOSABLE, not merely fatal.
    //
    // The load already threw, printed to stderr and exited non-zero, which is
    // correct and which almost no MCP client can show its user: clients do not
    // surface a server's stderr. What the user saw was a server that connected
    // and went quiet, with the reason somewhere they could not reach. So the
    // diagnosis goes to stderr for a supervisor AND to the wire for the client,
    // and the process still exits non-zero once the client disconnects.
    const diagnosis =
      `UPG MCP server: cannot load ${resolvedPath}\n\n${(err as Error).message}\n`
    process.stderr.write(`\n${diagnosis}\n`)
    process.exitCode = 1
    await createUnavailableServer(diagnosis).start()
    return
  }

  // Check for deprecated types and warn. Detection AND the suggested replacement
  // both come from entity-meta (the source of truth for current maturity), NOT the
  // historical migration union: a type can be a migration `from` in one version yet
  // be canonical-stable today (e.g. `hypothesis` was split to `hypothesis_claim` at
  // v0.2.8 and reverted at v0.4.0). Using isDeprecatedType / getReplacementType
  // keeps the warning from flagging a canonical type and pointing at a deprecated one.
  const nodes = store.getAllNodes()
  const deprecatedCounts: Record<string, number> = {}
  for (const node of nodes) {
    if (isDeprecatedType(node.type)) {
      deprecatedCounts[node.type] = (deprecatedCounts[node.type] ?? 0) + 1
    }
  }

  if (Object.keys(deprecatedCounts).length > 0) {
    const lines = Object.entries(deprecatedCounts).map(([type, count]) => {
      const replacement = getReplacementType(type)
      return replacement
        ? `  \u26A0\uFE0F  ${count} "${type}" entities \u2192 should be "${replacement}"`
        : `  \u26A0\uFE0F  ${count} "${type}" entities (deprecated)`
    })
    process.stderr.write(`\nDeprecated types found in your graph:\n${lines.join('\n')}\n`)
    process.stderr.write(`Run /upg-fix-types to update them.\n\n`)
  }

  // Spec-version drift warning (0.38.0, F3). A graph sealed under an older
  // spec meeting a newer server is normal and safe to READ; the warning exists
  // so an agent (or a cloud environment author) can tell "graph lags the
  // server" apart from "everything is current" — the field case was graphs
  // sealed at 0.8.13 meeting a 0.36.0 server with no signal anywhere.
  const sealed = store.getDocument().upg_version
  if (sealed && sealed !== UPG_VERSION) {
    const minors = (v: string) => v.split('.').slice(0, 2).map(Number)
    const [sMaj, sMin] = minors(sealed)
    const [cMaj, cMin] = minors(UPG_VERSION)
    if (sMaj < cMaj || (sMaj === cMaj && sMin < cMin)) {
      const delta = (cMaj - sMaj) * 100 + (cMin - sMin)
      process.stderr.write(
        `${delta >= 5 ? '⚠️  ' : ''}Graph spec_version ${sealed} is behind server spec ${UPG_VERSION}. ` +
        `Reads are safe; before heavy writes, review due migrations (upg verify / the migration pass).\n`,
      )
    }
  }

  // Start MCP server over stdio
  const server = createServer(store, { profile })
  await server.start()

  process.stderr.write(`UPG MCP server running: ${resolvedPath}\n`)

  // Graceful shutdown
  const shutdown = async () => {
    await store.flush() // save if dirty
    store.stopWatching()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Auto-invoke when this module is the entrypoint (e.g. `node dist/index.js`).
// When imported as a library (e.g. by the CLI for the `upg mcp run` subcommand),
// the importer calls runMcpServer() directly and this branch must be skipped.
//
// We compare *realpaths*, not the raw strings. `process.argv[1]` is the literal
// invocation path, while `import.meta.url` is symlink-resolved by the ESM
// loader. They diverge whenever a symlink sits anywhere in the path; npx
// `.bin` shims, macOS `/tmp` → `/private/tmp`, and global installs all do this.
// A raw-string compare would then evaluate false, the server would never start,
// and `node dist/index.js` / `npx @unified-product-graph/mcp-server` would
// silently exit 0, which surfaces to MCP clients as "Failed to connect".
//
// BUNDLING GUARD (critical): the CLI bundles this module into its single-file
// `cli.cjs` (tsup `noExternal`). A bundler rewrites `import.meta.url` to the
// BUNDLE's path, so the realpath compare below would wrongly MATCH argv[1] when
// the CLI runs — and the inlined branch would auto-start a SECOND server in
// addition to the CLI's own runMcpServer() call for `mcp run`. Two servers then
// share one stdin and every request is handled twice (every write duplicated).
// Our own build output is named `index.js`; a bundle never is, so we additionally
// require our own filename before auto-invoking. This keeps `node dist/index.js`
// and `npx @unified-product-graph/mcp-server` (bin → dist/index.js) auto-starting
// while making the bundled-into-the-CLI case a no-op.
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

/**
 * Whether this module should auto-start a server. Extracted + exported so the
 * bundling guard is unit-testable. `argv1` = process.argv[1]; `selfUrl` =
 * import.meta.url. Auto-start ONLY when our own entry file (`index.js`) is the
 * thing being executed — never when inlined into another tool's single-file
 * bundle (where a bundler rewrites `selfUrl` to the bundle path, which would
 * otherwise match argv[1] and start a second server).
 */
export function shouldAutoStart(argv1: string | undefined, selfUrl: string): boolean {
  if (!argv1) return false
  try {
    const self = fileURLToPath(selfUrl)
    const base = self.replace(/\\/g, '/').split('/').pop()
    if (base !== 'index.js') return false // inlined in another tool's bundle
    return realpathSync(argv1) === realpathSync(self)
  } catch {
    return false
  }
}

function isEntrypoint(): boolean {
  return shouldAutoStart(process.argv[1], import.meta.url)
}

if (isEntrypoint()) {
  runMcpServer().catch((err) => {
    // `err.message`, not `${err}`: template-stringifying an Error prefixes
    // "Error: " onto text that already reads as a sentence, so the first line a
    // user sees was `Fatal: Error: Invalid UPG document:`.
    process.stderr.write(`\nUPG MCP server failed to start:\n${(err as Error).message ?? err}\n`)
    process.exit(1)
  })
}
