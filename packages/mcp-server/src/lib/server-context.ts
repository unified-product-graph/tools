/**
 * Shared types and runtime helpers used by every UPG MCP tool handler.
 *
 * Handlers are top-level functions in `src/tools/*.ts`. They no longer close
 * over `createServer`'s scope; instead they take a `ToolContext` as their
 * second argument. This shape lets the JSDoc-driven reference generator
 * walk handler symbols at the file level without losing access to the
 * session/cache/store closures.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { UPGFileStore } from '@unified-product-graph/sdk'
import { getLensIds } from '@unified-product-graph/core'

// ── Result helpers ─────────────────────────────────────────────────────────

export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: ToolTextContent[]
  isError?: true
}

export function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] }
}

export function textError(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true }
}

// ── Session context (cross-skill awareness) ────────────────────────────────

/**
 * Canonical lens ids, DERIVED from core's lens registry at module load
 * (`getLensIds()` → the 8 lenses in `@unified-product-graph/core`). Single
 * source of truth so the session-context setter's accepted lenses can never
 * drift from what `get_lens` / `list_lenses` resolve (Seam 4 / DT-LENS-5).
 */
export const CANONICAL_LENS_IDS: readonly string[] = getLensIds()

/** Runtime membership check for the lens enum, against the canonical set. */
export function isCanonicalLens(id: unknown): id is UPGLens {
  return typeof id === 'string' && CANONICAL_LENS_IDS.includes(id)
}

/**
 * A lens id accepted by the session context. Kept as the canonical id-string
 * union so it tracks core: product, ux_design, engineering, growth, business,
 * research, marketing, full. (Was a 4-value hardcode that omitted 4 real
 * lenses and used the non-existent id "design".)
 */
export type UPGLens =
  | 'product'
  | 'ux_design'
  | 'engineering'
  | 'growth'
  | 'business'
  | 'research'
  | 'marketing'
  | 'full'

export interface SessionContext {
  lens: UPGLens
  skills_invoked: Array<{ skill: string; timestamp: string }>
  recommendations_given: Array<{ skill: string; recommendation: string; timestamp: string }>
  focus_area: string | null
  custom: Record<string, unknown>
}

export function createSessionContext(): SessionContext {
  return {
    lens: 'product',
    skills_invoked: [],
    recommendations_given: [],
    focus_area: null,
    custom: {},
  }
}

// ── Query result cache (for diff-based repeat queries) ─────────────────────

export interface CachedQueryResult {
  params: string
  nodes: Array<{ id: string; type: string }>
  edges: Array<{ id: string }>
  timestamp: string
}

export interface QueryCache {
  entries: Map<string, CachedQueryResult>
  counter: number
}

export function createQueryCache(): QueryCache {
  return { entries: new Map(), counter: 0 }
}

// ── Sync state (.upg-sync sidecar) ─────────────────────────────────────────

export interface SyncState {
  cloud_endpoint: string
  product_id: string
  last_synced_at: string
  node_id_map: Record<string, string>
  edge_id_map: Record<string, string>
  last_snapshot_hash: string
}

export function syncFilePath(upgPath: string): string {
  const dir = path.dirname(upgPath)
  const base = path.basename(upgPath, '.upg')
  return path.join(dir, `${base}.upg-sync`)
}

// ── Workspace root (0.38.0, F1) ──────────────────────────────────────────────
// The ABSOLUTE (real) path of the .upg workspace directory this server is
// serving, set once at startup. One server process serves one workspace, so
// module state is the honest scope. Tools report it (get_workspace_info /
// get_graph_digest) so an agent can assert it is where it thinks it is —
// the assertion a cloud VM with an uncontrolled cwd otherwise cannot make.
let workspaceRoot: string | null = null

/** Record the absolute workspace path at startup (null = single-file mode with no workspace dir). */
export function setWorkspaceRoot(absPath: string | null): void {
  workspaceRoot = absPath
}

/** The absolute workspace path recorded at startup, or null. */
export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export async function readSyncState(upgPath: string): Promise<SyncState | null> {
  const p = syncFilePath(upgPath)
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    return JSON.parse(raw) as SyncState
  } catch {
    return null
  }
}

export async function writeSyncState(upgPath: string, state: SyncState): Promise<void> {
  const p = syncFilePath(upgPath)
  await fsp.writeFile(p, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath, 'utf-8')
  return createHash('sha256').update(content).digest('hex')
}

// ── ToolContext + ToolHandler ──────────────────────────────────────────────

/**
 * Runtime context every tool handler receives. `createServer` builds this once
 * and passes it through every dispatch; handlers never see the SDK's `Server`
 * directly.
 */
export interface ToolContext {
  store: UPGFileStore
  sessionContext: SessionContext
  queryCache: QueryCache
  sync: {
    readSyncState: typeof readSyncState
    writeSyncState: typeof writeSyncState
    hashFile: typeof hashFile
    syncFilePath: typeof syncFilePath
  }
  /**
   * Server identity (name/version). Optional so lightweight test harnesses need
   * not supply it. Populated by `createServer`. Consumed by `submit_feedback`
   * to stamp the outbound context — never graph content.
   */
  serverInfo?: { name: string; version: string }
  /**
   * MCP client identity from the `initialize` handshake, resolved lazily
   * (available only after the client connects). Optional for the same reason as
   * `serverInfo`. Populated by `createServer` via the SDK's `getClientVersion()`.
   */
  getClientInfo?: () => { name?: string; version?: string } | undefined
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult
