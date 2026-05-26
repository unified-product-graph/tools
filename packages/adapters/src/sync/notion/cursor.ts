/**
 * @unified-product-graph/notion-sync — Persistent cursor for Workers sync
 *
 * The cursor tracks the ID mappings between UPG node IDs and Notion page IDs,
 * plus pagination cursors for incremental database polling.
 *
 * CursorStorage is intentionally injectable — implementations can use:
 * - The file system (CLI usage)
 * - Notion Workers KV store (Workers runtime)
 * - An in-memory map (tests)
 * - A Notion page as config storage (dogfood)
 */

// ─── Cursor state ─────────────────────────────────────────────────────────────

/** Persistent state for the sync cursor */
export interface CursorState {
  /** ISO 8601 timestamp of the last completed sync */
  last_sync_at: string
  /** Per-database pagination cursors — database_id → Notion pagination cursor */
  database_cursors: Record<string, string | null>
  /** Forward ID map — UPG node_id → Notion page_id */
  node_to_page_id: Record<string, string>
  /** Reverse ID map — Notion page_id → UPG node_id */
  page_to_node_id: Record<string, string>
  /** Entity type to Notion database mapping — UPG entity_type → Notion database_id */
  entity_to_database_id: Record<string, string>
}

// ─── Storage interface ────────────────────────────────────────────────────────

/**
 * Storage backend for cursor persistence.
 *
 * Implementors:
 * - FileCursorStorage  — reads/writes a JSON file alongside the .upg file
 * - KVCursorStorage    — wraps Notion Workers KV store (context.kv)
 * - MemoryCursorStorage — in-memory map for tests and dry runs
 */
export interface CursorStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CURSOR_KEY = 'upg-notion-sync:cursor'

// ─── Factories ────────────────────────────────────────────────────────────────

/** Return an empty cursor state */
export function emptyCursor(): CursorState {
  return {
    last_sync_at: new Date(0).toISOString(),
    database_cursors: {},
    node_to_page_id: {},
    page_to_node_id: {},
    entity_to_database_id: {},
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist the cursor state to storage.
 */
export async function saveCursor(
  state: CursorState,
  storage: CursorStorage,
): Promise<void> {
  await storage.set(CURSOR_KEY, JSON.stringify(state))
}

/**
 * Load the cursor state from storage.
 * Returns null if no cursor has been saved yet.
 */
export async function loadCursor(
  storage: CursorStorage,
): Promise<CursorState | null> {
  const raw = await storage.get(CURSOR_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CursorState
  } catch {
    // Corrupted cursor — start fresh
    return null
  }
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/**
 * Merge push result ID maps into an existing cursor.
 * Returns a new CursorState — does not mutate input.
 */
export function mergePushIntoCursor(
  cursor: CursorState,
  nodeToPageId: Record<string, string>,
  entityToDatabaseId: Record<string, string>,
): CursorState {
  const pageToNodeId: Record<string, string> = { ...cursor.page_to_node_id }
  for (const [nodeId, pageId] of Object.entries(nodeToPageId)) {
    pageToNodeId[pageId] = nodeId
  }

  return {
    ...cursor,
    last_sync_at: new Date().toISOString(),
    node_to_page_id: { ...cursor.node_to_page_id, ...nodeToPageId },
    page_to_node_id: pageToNodeId,
    entity_to_database_id: { ...cursor.entity_to_database_id, ...entityToDatabaseId },
  }
}

// ─── Built-in storage implementations ────────────────────────────────────────

/**
 * In-memory cursor storage — useful for tests and dry runs.
 */
export class MemoryCursorStorage implements CursorStorage {
  private store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
}
