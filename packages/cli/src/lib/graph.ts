/**
 * Graph loader. Uses UPGFileStore from @unified-product-graph/sdk.
 *
 * Same discovery logic, same store, same behavior. The CLI is a thin
 * frontend over the SDK; the MCP server is the other.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'

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
  await store.load(filePath)
  return store
}
