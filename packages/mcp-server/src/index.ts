/**
 * UPG Local MCP Server
 *
 * Usage: upg-mcp-server [--file <path-to.upg>] [--title "My Product"]
 *
 * Discovery order:
 *   1. --file flag → use that file directly
 *   2. .upg/workspace.json → load default_product from workspace
 *   3. *.upg files in cwd → if 1, use it; if many, use first alphabetically
 *   4. Nothing found → create blank product.upg
 *
 * Reads a .upg file into memory and exposes it via MCP over stdio.
 * Changes are auto-saved back to the file with debounced writes.
 */

import { parseArgs } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createServer, SERVER_VERSION } from './server.js'
import { UPG_VERSION, isDeprecatedType, getReplacementType, serializeCanonical, type UPGDocument } from '@unified-product-graph/core'
import { nanoid } from 'nanoid'

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

export async function runMcpServer() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', short: 'f' },
      title: { type: 'string', short: 't' },
    },
    // Tolerate stray positionals. When launched via `upg mcp run`, argv carries
    // the `mcp run` subcommand tokens; without this, parseArgs throws
    // ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL and the server never starts. The
    // standalone bin (`upg-mcp-server`) passes none, so this is harmless there.
    allowPositionals: true,
  })

  let resolvedPath = await discoverUPGFile(values.file)

  // Tier 4: create blank product.upg
  if (!resolvedPath) {
    const defaultFile = path.resolve('product.upg')
    const title = values.title ?? 'My Product'
    const blank = {
      upg_version: UPG_VERSION,
      exported_at: new Date().toISOString(),
      source: {
        tool: 'upg-mcp-local',
        tool_version: SERVER_VERSION,
      },
      product: {
        id: nanoid(16),
        title,
      },
      nodes: [],
      edges: [],
    }
    await fs.mkdir(path.dirname(defaultFile), { recursive: true })
    await fs.writeFile(defaultFile, serializeCanonical(blank as UPGDocument), 'utf-8')
    process.stderr.write(`Created new UPG file: ${defaultFile}\n`)
    resolvedPath = defaultFile
  } else {
    // If the discovered file doesn't exist yet, create it (e.g. --file flag with new path)
    try {
      await fs.access(resolvedPath)
    } catch {
      const title =
        values.title ?? path.basename(resolvedPath, '.upg')
      const blank = {
        upg_version: UPG_VERSION,
        exported_at: new Date().toISOString(),
        source: {
          tool: 'upg-mcp-local',
          tool_version: SERVER_VERSION,
        },
        product: {
          id: nanoid(16),
          title,
        },
        nodes: [],
        edges: [],
      }
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.writeFile(resolvedPath, serializeCanonical(blank as UPGDocument), 'utf-8')
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
  await store.load(resolvedPath)

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

  // Start MCP server over stdio
  const server = createServer(store)
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
// When imported as a library (e.g. by `@unified-product-graph/mcp` for the
// `upg mcp run` subcommand), the importer calls runMcpServer() directly and
// this branch is skipped.
//
// We compare *realpaths*, not the raw strings. `process.argv[1]` is the literal
// invocation path, while `import.meta.url` is symlink-resolved by the ESM
// loader. They diverge whenever a symlink sits anywhere in the path; npx
// `.bin` shims, macOS `/tmp` → `/private/tmp`, and global installs all do this.
// A raw-string compare would then evaluate false, the server would never start,
// and `node dist/index.js` / `npx @unified-product-graph/mcp-server` would
// silently exit 0, which surfaces to MCP clients as "Failed to connect".
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  runMcpServer().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`)
    process.exit(1)
  })
}
