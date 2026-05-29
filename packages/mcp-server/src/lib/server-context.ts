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

export type UPGLens = 'product' | 'engineering' | 'design' | 'growth'

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
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult
