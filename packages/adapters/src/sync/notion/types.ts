/**
 * @unified-product-graph/notion-sync — Internal sync types
 *
 * SyncState, SyncResult, CursorState and related shapes used across
 * the push / pull / sync / cursor modules.
 */

import type { PushResult } from './push.js'
import type { PullResult } from './pull.js'
import type { CursorState } from './cursor.js'

// ─── Sync options ─────────────────────────────────────────────────────────────

/** Direction of a sync operation */
export type SyncDirection = 'push' | 'pull' | 'both'

/** Options for the top-level sync() coordinator */
export interface SyncOptions {
  /** Direction of sync */
  direction: SyncDirection
  /** Notion page ID under which databases live (parent container) */
  parentPageId: string
  /** Notion integration token */
  authToken: string
  /** Persistent cursor storage — defaults to in-memory if omitted */
  cursorStorage?: import('./cursor.js').CursorStorage
  /** Log what would happen without writing to Notion */
  dryRun?: boolean
}

/** Result returned by the top-level sync() coordinator */
export interface SyncResult {
  push?: PushResult
  pull?: PullResult
  cursor: CursorState
  duration_ms: number
}
