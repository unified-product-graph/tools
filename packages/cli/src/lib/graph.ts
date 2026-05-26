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
  nodeId,
  edgeId,
  type GraphDigest,
  type SearchResult,
} from '@unified-product-graph/sdk'

export async function discoverUPGFile(explicitFile?: string): Promise<string> {
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
      return filePath
    }
  } catch { /* continue */ }

  // Tier 2.5: .upg/ dir with .upg files but no workspace.json
  try {
    const upgDir = path.join(cwd, '.upg')
    const entries = await fs.readdir(upgDir)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length >= 1) return path.join(upgDir, upgFiles[0])
  } catch { /* continue */ }

  // Tier 3: *.upg in cwd
  try {
    const entries = await fs.readdir(cwd)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length >= 1) return path.resolve(upgFiles[0])
  } catch { /* continue */ }

  throw new Error('No .upg file found. Run `upg init` to create one, or use --file <path>.')
}

export async function loadStore(filePath: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(filePath)
  return store
}
