/**
 * Graph loader. Uses UPGFileStore from @unified-product-graph/sdk.
 *
 * Same discovery logic, same store, same behavior. The CLI is a thin
 * frontend over the SDK; the MCP server is the other.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { usageError, runtimeError, violation, type CliError } from './errors.js'
import { CLI_VERSION } from './version.js'

export { UPGFileStore }

// Re-export shared tools so commands import from one place
export {
  computeGraphDigest,
  computeHealthScore,
  searchNodes,
  listNodes,
  getOrphans,
  BUSINESS_AREAS,
  CHAINS,
  sortByType,
  inferEdgeType,
  validateStatusAgainstLifecycle,
  nodeId,
  edgeId,
  type GraphDigest,
  type SearchResult,
} from '@unified-product-graph/sdk'

/**
 * A node title must be a non-empty string with at least one non-whitespace
 * character. Reject blanks at the write boundary (create/new/update): the spec's
 * required-title check only catches falsy titles, so "" slips through as a
 * persisted-but-invalid node and whitespace-only ("   ") passes entirely
 * ( / F1+F10). An invalid node on disk then bricks every subsequent read
 * AND the delete/update that could repair it, so the writer must never be more
 * permissive than the reader (CLI-FEEDBACK #4). Returns an error message, or
 * null when the title is valid.
 */
export function validateTitle(title: unknown): string | null {
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'Title is required and cannot be empty or whitespace-only.'
  }
  return null
}

/**
 * Upper bound on a `--data` payload ( E5). A `.upg` node's properties are
 * small structured fields; a multi-hundred-KB blob is a paste mistake or an
 * abuse vector that bloats the file and slows every later read. 256 KiB is
 * generous for legitimate property maps.
 */
export const MAX_DATA_BYTES = 256 * 1024

/**
 * One consistent error message for a malformed `--data` payload across
 * `create` / `update` / `score`. Before D2 these diverged: create/update
 * said "Invalid --data JSON" and exited 1 (runtime); score said "--data must be
 * valid JSON. Got: ..." and exited 3 (usage). The contract says a bad CLI
 * argument is a USAGE error (exit 3), so they now share this text and code.
 */
export const DATA_INVALID_JSON_MSG =
  '--data must be valid JSON, e.g. \'{"reach":800,"impact":3}\'.'

/**
 * Parse a `--data` option value: enforce the size guard (E5) then JSON-parse.
 * Throws a usage error (exit 3) on either failure so every command treats a bad
 * `--data` argument identically ( D2 / E5). Returns the parsed
 * value; the caller decides whether it must be an object.
 */
export function parseDataOption(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf-8') > MAX_DATA_BYTES) {
    throw usageError(
      `--data is too large (${Buffer.byteLength(raw, 'utf-8')} bytes; max ${MAX_DATA_BYTES}). ` +
        `Pass a smaller property map.`,
    )
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw usageError(DATA_INVALID_JSON_MSG)
  }
}

/**
 * Translate the SDK's internal "no canonical edge" failure into a user-facing
 * message ( E4). `inferEdgeType` throws an `InferEdgeTypeError` whose
 * message leaks the catalog internals
 * (`No edge type in UPG_EDGE_CATALOG for source=X, target=Y.`). Rewrite it to a
 * plain sentence and classify it as a policy violation (exit 2) — an
 * incompatible pair is the same class of problem as an incompatible `connect`.
 * Any other error keeps its message and stays a runtime error (exit 1).
 */
export function wrapEdgeInferenceError(err: unknown): CliError {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /No edge type in UPG_EDGE_CATALOG for source=([\w-]+), target=([\w-]+)/.exec(msg)
  if (m) {
    const [, source, target] = m
    // Hyphen, not em-dash (the em-dash hook rejects em-dashes in user strings).
    return violation(
      `${source} cannot connect directly to ${target} - no canonical relationship exists. ` +
        `Reorient the pair, or use \`upg connect\` with an explicit --type.`,
    )
  }
  return runtimeError(msg)
}

/**
 * Resolve the .upg file a command operates on (CLI-FEEDBACK #8).
 *
 * Precedence:
 *   1. explicit `--file <path>`
 *   2. `UPG_FILE` env var (honoured on every command, for CI/scripts)
 *   3. `.upg/workspace.json` default_product
 *   4. exactly one `.upg` in `.upg/` (else, with >1 and no workspace, error —
 *      never silently pick)
 *   5. exactly one `*.upg` in cwd (else, with >1, error)
 *
 * The ambiguity guard raises a UsageError-style message rather than guessing,
 * because silently selecting one of several files surfaced the *wrong* (broken)
 * graph in the field report.
 */
export async function discoverUPGFile(explicitFile?: string): Promise<string> {
  if (explicitFile) return path.resolve(explicitFile)

  // UPG_FILE applies uniformly to every command.
  const envFile = process.env.UPG_FILE
  if (envFile) return path.resolve(envFile)

  const cwd = process.cwd()

  // Tier 2: .upg/workspace.json default_product (an explicit selection).
  const workspacePath = path.join(cwd, '.upg', 'workspace.json')
  try {
    const raw = await fs.readFile(workspacePath, 'utf-8')
    const workspace = JSON.parse(raw)
    if (workspace.default_product) {
      const filePath = path.join(cwd, '.upg', workspace.default_product)
      await fs.access(filePath)
      return filePath
    }
  } catch { /* continue */ }

  // Tier 2.5: .upg/ dir with .upg files but no workspace.json.
  try {
    const upgDir = path.join(cwd, '.upg')
    const entries = await fs.readdir(upgDir)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length === 1) return path.join(upgDir, upgFiles[0])
    if (upgFiles.length > 1) {
      throw new AmbiguousFileError(upgFiles.map((f) => path.join('.upg', f)))
    }
  } catch (err) {
    if (err instanceof AmbiguousFileError) throw err
    /* continue */
  }

  // Tier 3: *.upg in cwd.
  try {
    const entries = await fs.readdir(cwd)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length === 1) return path.resolve(upgFiles[0])
    if (upgFiles.length > 1) throw new AmbiguousFileError(upgFiles)
  } catch (err) {
    if (err instanceof AmbiguousFileError) throw err
    /* continue */
  }

  throw new Error('No .upg file found. Run `upg init` to create one, or use --file <path> (or set UPG_FILE).')
}

/**
 * Raised when more than one `.upg` file is a candidate and there is no
 * workspace default. Carries the candidate list so commands can render a
 * helpful "which file?" message. Classified as a usage error (exit 3).
 */
export class AmbiguousFileError extends Error {
  readonly candidates: string[]
  constructor(candidates: string[]) {
    super(
      `Multiple .upg files found and no workspace default:\n` +
      candidates.map((c) => `  ${c}`).join('\n') +
      `\nPass --file <path> or set UPG_FILE to choose one.`,
    )
    this.name = 'AmbiguousFileError'
    this.candidates = candidates
  }
}

export async function loadStore(filePath: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  // Stamp this CLI (name + real version) as the writer so every file it saves
  // records accurate provenance ( / M7).
  store.setWriter('upg-cli', CLI_VERSION)
  try {
    await store.load(filePath)
  } catch (err) {
    // E4: turn raw filesystem / JSON failures into clear messages.
    // A missing file or an unparsable / non-.upg file (when `--file` or
    // `UPG_FILE` points somewhere wrong) otherwise surfaces a bare `ENOENT ...`
    // or `Unexpected token ...` that says nothing about what the user did.
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') {
      throw runtimeError(`No .upg file at ${filePath}`)
    }
    if (err instanceof SyntaxError) {
      throw runtimeError(`Not a valid .upg file: ${filePath}`)
    }
    throw err
  }
  return store
}
