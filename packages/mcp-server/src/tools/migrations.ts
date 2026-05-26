/**
 * Migration tools that live outside the node/edge handler files.
 *
 * Today: `migrate_status` — applies `UPG_STATUS_MIGRATIONS` to rewrite
 * legacy status values to canonical lifecycle phases. Mirrors the
 * dry-run / commit envelope used by `migrate_type` and `migrate_properties`.
 *
 * Sibling to the type/edge/property migrators in `nodes.ts`; pulled out
 * here so the status migrator can grow (per-type batches, value-set
 * filters) without bloating the node-handler file further.
 */

import {
  UPG_STATUS_MIGRATIONS,
  migrateStatusValue,
  getLifecycleForType,
} from '@unified-product-graph/core'
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import type {
  MigrateStatusResult,
  MigrateStatusNodeChange,
} from '@unified-product-graph/mcp-tooling'

/**
 * Walk every loaded node and rewrite invalid `status` values to their
 * canonical replacement from `UPG_STATUS_MIGRATIONS`. Sibling to
 * `migrate_type` (entity renames + cascading edges) and
 * `migrate_properties` (property-shape evolution); fills the third axis:
 * lifecycle-phase value drift.
 *
 * **Filters (all optional, all AND-composed):**
 *  - `entity_type` — only consider nodes of this canonical type.
 *  - `from_status` — only consider nodes whose current `status` matches.
 *    (Useful for surgical rewrites — "fix the 173 service:active rows".)
 *  - `to_status` — required when `from_status` is provided; overrides the
 *    registry lookup with an explicit target.
 *
 * **Selection rule (when `from_status` is NOT provided):**
 *  - Status must be a non-empty string.
 *  - The node's `entity_type` must have a registered lifecycle (otherwise
 *    `valid_phases` is meaningless and there's nothing to migrate TO).
 *  - The current `status` must NOT be in the lifecycle's `valid_phases`
 *    (the invariant `validate_graph` uses for `lifecycle_drift`).
 *  - `UPG_STATUS_MIGRATIONS[type][status]` must resolve to a canonical
 *    replacement that DIFFERS from the current value.
 *
 * Nodes whose status is invalid but has no registered migration are
 * counted in `skipped_no_migration` so callers know what residue remains.
 *
 * @returns JSON: `MigrateStatusResult`.
 * @throws Returns a textError when `from_status` is provided without
 *   `to_status`, or when `entity_type` is provided but isn't a string.
 * @atomicity per-node. Status writes go through `store.updateNode`
 *   one at a time. Dry-run is read-only.
 * @warning Default is `dry_run: true`. Pass `dry_run: false` to commit.
 *   Idempotent on retry — re-running after a successful commit reports
 *   zero changes (canonical statuses pass the validity check).
 * @see migrate_type
 * @see migrate_properties
 * @see validate_graph
 * @see list_lifecycles
 */
export const migrateStatus: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx

  const entityTypeFilter = args.entity_type as string | undefined
  const fromStatusFilter = args.from_status as string | undefined
  const toStatusOverride = args.to_status as string | undefined
  // Default `dry_run` to true — mirror `migrate_properties`. Safer than
  // `migrate_type`'s default (false) because status writes are more
  // ambiguous; callers should preview before committing.
  const dryRun = (args.dry_run as boolean) ?? true

  if (entityTypeFilter !== undefined && typeof entityTypeFilter !== 'string') {
    return textError('entity_type must be a string when provided')
  }
  if (fromStatusFilter !== undefined && typeof fromStatusFilter !== 'string') {
    return textError('from_status must be a string when provided')
  }
  if (toStatusOverride !== undefined && typeof toStatusOverride !== 'string') {
    return textError('to_status must be a string when provided')
  }
  // `to_status` only has meaning paired with `from_status` — without
  // a `from`, there's nothing to scope the override to.
  if (fromStatusFilter !== undefined && toStatusOverride === undefined) {
    return textError(
      'to_status is required when from_status is provided',
    )
  }

  const changes: MigrateStatusNodeChange[] = []
  let skipped = 0

  for (const node of store.getAllNodes()) {
    const nodeType = node.type as string
    const nodeStatus = node.status as string | undefined

    // Entity-type filter — narrows the scope when set.
    if (entityTypeFilter && nodeType !== entityTypeFilter) continue

    // Empty / missing status is not drift — nothing to migrate.
    if (typeof nodeStatus !== 'string' || nodeStatus.length === 0) continue

    // ── Resolve the target replacement ─────────────────────────────────
    let target: string | null

    if (fromStatusFilter !== undefined) {
      // Surgical mode: caller specified from→to explicitly. Honour that
      // override regardless of the registry.
      if (nodeStatus !== fromStatusFilter) continue
      target = toStatusOverride ?? null
    } else {
      // Auto mode: scope to invalid-for-lifecycle nodes, then resolve
      // via the registry. Skip nodes whose type has no lifecycle
      // (nothing to validate against).
      const lifecycle = getLifecycleForType(nodeType)
      if (!lifecycle) continue
      const validPhases = lifecycle.phases.map((p) => p.id)
      if (validPhases.includes(nodeStatus)) continue
      target = migrateStatusValue(nodeType, nodeStatus)
      if (target === null) {
        skipped += 1
        continue
      }
    }

    // Identity mapping — registered but no-op, don't count it as work.
    if (target === null || target === nodeStatus) continue

    changes.push({ id: node.id, type: nodeType, from: nodeStatus, to: target })
  }

  if (!dryRun) {
    for (const change of changes) {
      store.updateNode(change.id, { status: change.to })
    }
  }

  const response: MigrateStatusResult = {
    migrated_nodes: changes.length,
    skipped_no_migration: skipped,
    changes,
    dry_run: dryRun,
  }
  return text(JSON.stringify(response, null, 2))
}

// Re-export the spec helpers for callers that want to introspect the map
// without round-tripping through `@unified-product-graph/core`.
export { UPG_STATUS_MIGRATIONS, migrateStatusValue }
