/**
 * @unified-product-graph/notion-sync
 *
 * Bidirectional sync between UPG product graphs and Notion workspaces.
 *
 * Primary exports:
 *
 *   NotionSyncClient  — Notion API client wrapper
 *   pushToNotion      — Execute a NotionWorkspacePlan against Notion
 *   pullFromNotion    — Read Notion databases → SourceItems
 *   sync              — Bidirectional sync coordinator
 *   emptyCursor / saveCursor / loadCursor — Cursor persistence
 *   MemoryCursorStorage — In-memory cursor storage (tests + dry runs)
 *
 * Workers entry point: workers/sync-worker.ts
 */

// Client
export { NotionSyncClient } from './client.js'
export type {
  NotionDatabaseInfo,
  NotionPropertyDefinition,
  NotionPageProperties,
  NotionPage,
  NotionSearchResult,
  NotionQueryResponse,
} from './client.js'

// Push
export { pushToNotion } from './push.js'
export type {
  NotionWorkspacePlan,
  NotionDatabaseSchema,
  NotionNodePlan,
  NotionPropertySchema,
  NotionPropertyValue,
  PushOptions,
  PushResult,
} from './push.js'

// Pull
export { pullFromNotion, classifyDatabase } from './pull.js'
export type {
  PullOptions,
  PullResult,
  DatabaseClassification,
  ClassificationConfidence,
} from './pull.js'

// Sync
export { sync, loadUPGGraph } from './sync.js'
export type { SyncOptions, SyncResult, SyncDirection } from './types.js'
export type { UPGGraph } from './sync.js'

// Cursor
export {
  emptyCursor,
  saveCursor,
  loadCursor,
  mergePushIntoCursor,
  MemoryCursorStorage,
} from './cursor.js'
export type { CursorState, CursorStorage } from './cursor.js'
