/**
 * @unified-product-graph/notion-sync — Bidirectional sync coordinator
 *
 * Orchestrates push, pull, and cursor persistence.
 * Called by the Workers runtime entry point and the CLI.
 *
 * Design principles:
 * - The coordinator is thin — it wires push/pull/cursor together and
 *   returns a SyncResult. Business logic lives in push.ts and pull.ts.
 * - Cursor is always updated, even on partial success.
 * - Errors from push/pull surface in the result, not as thrown exceptions
 *   (the coordinator tries to complete as much as possible).
 */

import type { UPGBaseNode } from '@unified-product-graph/core'
import type { UPGEdge } from '@unified-product-graph/core'
import { NotionSyncClient } from './client.js'
import { pushToNotion } from './push.js'
import { pullFromNotion } from './pull.js'
import {
  emptyCursor,
  loadCursor,
  saveCursor,
  mergePushIntoCursor,
  MemoryCursorStorage,
} from './cursor.js'
import type { CursorStorage, CursorState } from './cursor.js'
import type { SyncOptions, SyncResult } from './types.js'
import type { NotionWorkspacePlan } from './push.js'

// ─── UPG graph loader (stub) ──────────────────────────────────────────────────
//
// TODO: Replace with a real loader once the CLI/MCP integration is ready.
// The Workers entry point calls loadUPGGraph() to get the graph from a
// .upg file path, a cloud API, or an injected graph object.

export interface UPGGraph {
  nodes: UPGBaseNode[]
  edges: UPGEdge[]
}

/**
 * Load a UPG graph from a file path or object.
 *
 * TODO: Wire to the UPG file parser (upg-spec) once available.
 * For now, accepts a pre-loaded graph object or throws for file paths.
 */
export async function loadUPGGraph(
  source: string | UPGGraph,
): Promise<UPGGraph> {
  if (typeof source === 'object') {
    return source
  }
  // TODO: parse .upg file via @unified-product-graph/core parser
  throw new Error(
    `File-based graph loading not yet implemented. ` +
      `Pass a UPGGraph object directly, or use the CLI which handles file loading.`,
  )
}

// ─── Schema generator stub ───────────────────────────────────────────────────
//
// TODO: Replace with the real generator once it lands:
//
//   import { generateNotionWorkspace } from '@unified-product-graph/adapters'
//
// For now, produce a minimal plan that creates one database per entity type
// present in the graph, with no property schema (so pages get created with
// title only).

function buildWorkspacePlan(
  nodes: UPGBaseNode[],
  _edges: UPGEdge[],
): NotionWorkspacePlan {
  // Collect unique entity types
  const entityTypes = new Set(nodes.map((n) => n.type))

  const databases = Array.from(entityTypes).map((entityType) => ({
    title: entityTypeToLabel(entityType),
    entity_type: entityType,
    description: `UPG ${entityType} entities`,
    properties: {
      Name: { type: 'title' },
      Description: { type: 'rich_text' },
      Status: { type: 'status' },
      'UPG ID': { type: 'rich_text' },
    },
  }))

  const nodePlans = nodes.map((node) => ({
    node_id: node.id,
    entity_type: node.type,
    properties: {
      Name: {
        type: 'title' as const,
        title: [{ text: { content: node.title } }],
      },
      ...(node.description
        ? {
            Description: {
              type: 'rich_text' as const,
              rich_text: [{ text: { content: node.description } }],
            },
          }
        : {}),
      ...(node.status
        ? {
            Status: {
              type: 'status' as const,
              status: { name: node.status },
            },
          }
        : {}),
    },
    relations: {},
  }))

  return { databases, nodes: nodePlans }
}

/** Convert snake_case entity type to Title Case label */
function entityTypeToLabel(entityType: string): string {
  return entityType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') + 's'
}

// ─── Core sync function ───────────────────────────────────────────────────────

/**
 * Bidirectional sync coordinator.
 *
 * For 'push': reads the UPG graph, generates a workspace plan, pushes to Notion.
 * For 'pull': reads Notion databases, returns SourceItems.
 * For 'both': push then pull.
 *
 * The cursor is always updated with the latest ID maps and saved to storage.
 */
export async function sync(
  nodes: UPGBaseNode[],
  edges: UPGEdge[],
  options: SyncOptions,
): Promise<SyncResult> {
  const start = Date.now()

  const {
    direction,
    parentPageId,
    authToken,
    cursorStorage,
    dryRun = false,
  } = options

  // Resolve storage — fall back to in-memory if not provided
  const storage: CursorStorage = cursorStorage ?? new MemoryCursorStorage()

  // Load or initialise the cursor
  let cursor: CursorState = (await loadCursor(storage)) ?? emptyCursor()

  // Create the Notion client
  const client = new NotionSyncClient(authToken)

  const result: SyncResult = {
    cursor,
    duration_ms: 0,
  }

  // ── Push ─────────────────────────────────────────────────────────────────────

  if (direction === 'push' || direction === 'both') {
    // Build the workspace plan
    // TODO: Replace with generateNotionWorkspace() once it lands
    const plan = buildWorkspacePlan(nodes, edges)

    const pushResult = await pushToNotion(plan, client, {
      parentPageId,
      dryRun,
      existingDatabaseIds: cursor.entity_to_database_id,
    })

    result.push = pushResult

    // Merge push results into the cursor
    if (!dryRun) {
      cursor = mergePushIntoCursor(
        cursor,
        pushResult.node_to_page_id,
        pushResult.entity_to_database_id,
      )
    }
  }

  // ── Pull ─────────────────────────────────────────────────────────────────────

  if (direction === 'pull' || direction === 'both') {
    const pullResult = await pullFromNotion(client, {
      parentPageId,
      databaseIds: Object.values(cursor.entity_to_database_id),
    })

    result.pull = pullResult

    // Update the last_sync_at timestamp
    if (!dryRun) {
      cursor = {
        ...cursor,
        last_sync_at: new Date().toISOString(),
      }
    }
  }

  // ── Save cursor ───────────────────────────────────────────────────────────────

  if (!dryRun) {
    await saveCursor(cursor, storage)
  }

  result.cursor = cursor
  result.duration_ms = Date.now() - start

  return result
}
