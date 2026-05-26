/**
 * UPG × Notion — Notion Workers Sync Entry Point
 *
 * Deploys via: ntn deploy worker
 *
 * This worker runs on the Notion Workers runtime (Beta, May 2026) and keeps
 * a UPG product graph in sync with a Notion workspace on a 5-minute schedule.
 *
 * The graph flows UPG → Notion (push direction). Changes made in Notion by
 * humans are visible in the UPG graph on the next pull cycle.
 *
 * Runtime environment:
 *   context.env.AUTH         — Notion integration token
 *   context.env.PARENT_PAGE_ID — Notion page ID for database container
 *   context.env.UPG_GRAPH    — JSON-serialised UPG graph (for now)
 *   context.kv               — Notion Workers KV store (cursor persistence)
 *
 * TODO: Notion Workers Beta API shape was not fully stabilised as of May 2026.
 *   The `syncs`, `WorkerContext`, and `context.kv` patterns below follow the
 *   published ntn deploy worker documentation but may require adjustment as
 *   the platform matures. Known uncertainties are marked TODO.
 *
 * References:
 *   notion.com/product/dev
 */

import { sync, loadUPGGraph } from '../sync.js'
import type { CursorStorage } from '../cursor.js'

// ─── Notion Workers types (Beta — stubs) ──────────────────────────────────────
//
// TODO: Replace with the official @notionhq/workers-sdk types once published.
// The Notion Workers Beta runtime provides these via the execution context.

/** Environment variables injected by the Notion Workers runtime */
interface WorkerEnv {
  /** Notion integration token (set via ntn env set) */
  AUTH: string
  /** Notion page ID where UPG databases are created */
  PARENT_PAGE_ID: string
  /**
   * JSON-serialised UPG graph — temporary approach.
   * TODO: Replace with a Notion Workers KV read or Supabase API call once
   * the cloud MCP layer (@unified-product-graph/cloud-server) exposes a graph export endpoint.
   */
  UPG_GRAPH?: string
  /** Log level for the sync worker */
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Notion Workers execution context (Beta).
 *
 * TODO: The exact shape of WorkerContext is not yet published. These are
 * based on the ntn deploy worker documentation as of May 2026. The `kv`
 * property may change before GA.
 */
interface WorkerContext {
  env: WorkerEnv
  /**
   * Notion Workers KV store — persistent key-value storage available to
   * the worker across invocations. Used for cursor persistence.
   *
   * TODO: Confirm the exact KV API shape. Assuming get/set as per the
   * Workers Beta documentation.
   */
  kv: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
  }
  /**
   * Log a message to the Notion Workers runtime log.
   *
   * TODO: Confirm whether context.log() is the correct logging API or
   * whether console.log() is sufficient.
   */
  log(message: string): void
}

/**
 * Notion Workers Sync definition.
 *
 * A `sync` definition registers this worker as a continuous data sync
 * from UPG into Notion databases. Notion's Workers runtime schedules
 * the run() function at the specified interval.
 */
interface WorkerSyncDefinition {
  id: string
  name: string
  description: string
  schedule: {
    every: number
    unit: 'minutes' | 'hours' | 'days'
  }
  run(context: WorkerContext): Promise<unknown>
}

/** Notion Workers module export shape */
interface WorkerModule {
  syncs: WorkerSyncDefinition[]
}

// ─── KV cursor storage adapter ────────────────────────────────────────────────

/**
 * Wraps the Notion Workers KV store as a CursorStorage implementation.
 * Passed to sync() so the cursor persists across worker invocations.
 */
function wrapKVStorage(kv: WorkerContext['kv']): CursorStorage {
  return {
    get: (key: string) => kv.get(key),
    set: (key: string, value: string) => kv.set(key, value),
  }
}

// ─── Worker definition ────────────────────────────────────────────────────────

const worker: WorkerModule = {
  syncs: [
    {
      id: 'upg-notion-sync',
      name: 'UPG Product Graph Sync',
      description:
        'Keeps your Notion product knowledge databases in sync with your UPG graph. ' +
        'Runs every 5 minutes. Source: UPG graph. Target: Notion workspace.',

      schedule: { every: 5, unit: 'minutes' },

      async run(context: WorkerContext): Promise<unknown> {
        const { AUTH, PARENT_PAGE_ID, UPG_GRAPH, LOG_LEVEL = 'info' } = context.env

        if (!AUTH) {
          throw new Error('Missing required env var: AUTH (Notion integration token)')
        }
        if (!PARENT_PAGE_ID) {
          throw new Error('Missing required env var: PARENT_PAGE_ID')
        }

        // ── Load the UPG graph ────────────────────────────────────────────────

        let graphSource: Parameters<typeof loadUPGGraph>[0]

        if (UPG_GRAPH) {
          // Graph serialised into env var — useful for small graphs in dev/test
          try {
            graphSource = JSON.parse(UPG_GRAPH) as unknown as Parameters<typeof loadUPGGraph>[0]
          } catch {
            throw new Error('Failed to parse UPG_GRAPH env var as JSON')
          }
        } else {
          // TODO: Load from cloud MCP endpoint once @unified-product-graph/cloud-server exposes
          // a graph export route. For now, fail with a clear message.
          //
          //   graphSource = await fetchGraphFromCloud(context.env.CLOUD_ENDPOINT)
          //
          throw new Error(
            'No graph source configured. Set UPG_GRAPH env var with a JSON-serialised ' +
              'graph, or configure a cloud endpoint (CLOUD_ENDPOINT) once that integration ' +
              'is available.',
          )
        }

        const graph = await loadUPGGraph(graphSource as Parameters<typeof loadUPGGraph>[0])

        if (LOG_LEVEL === 'debug') {
          context.log(
            `Loaded UPG graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
          )
        }

        // ── Run the sync ──────────────────────────────────────────────────────

        const result = await sync(graph.nodes, graph.edges, {
          direction: 'push',
          parentPageId: PARENT_PAGE_ID,
          authToken: AUTH,
          cursorStorage: wrapKVStorage(context.kv),
          dryRun: false,
        })

        // ── Report ────────────────────────────────────────────────────────────

        const push = result.push
        if (push) {
          const summary =
            `Sync complete in ${result.duration_ms}ms — ` +
            `${push.databases_created} db(s) created, ` +
            `${push.databases_updated} db(s) updated, ` +
            `${push.pages_created} page(s) created, ` +
            `${push.pages_updated} page(s) updated, ` +
            `${push.relations_linked} relation(s) linked`

          context.log(summary)

          if (push.errors.length > 0) {
            context.log(`Sync errors (${push.errors.length}): ${push.errors.join('; ')}`)
          }
        }

        return result
      },
    },
  ],
}

export default worker
