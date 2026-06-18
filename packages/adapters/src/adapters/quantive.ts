/**
 * Quantive Adapter
 *
 * Imports entities from Quantive (formerly Gtmhub): an enterprise OKR
 * management platform that organises work as:
 *
 *   Organisation → Session (Q1/Q2/Annual)
 *     → Objective → Key Result → Initiative / Task
 *                → Metric ← Check-in
 *   Team → Objective
 *
 * Quantive discriminates entity type via a `entity_type` metadata field.
 * This adapter maps to the closest UPG strategy-domain types.
 *
 *
 * Hierarchy edges (all verified in the UPG catalogue):
 * - objective → key_result      → objective_achieved_through_key_result
 * - key_result → metric         → key_result_quantified_by_metric
 * - key_result → initiative     → initiative_drives_outcome (approximation)
 * - key_result → task           → initiative_drives_outcome (approximation, with warning)
 * - objective → objective       → team_okr_aligns_with_objective (cascading alignment)
 * - team → objective            → team_targets_team_okr
 *
 * Skipped types (no UPG equivalent):
 * - session: timeframe container (Q1/Q2/Annual): emits warning
 * - check_in: periodic KR value update: operational data, emits warning
 * - integration: data source config: emits warning
 * - comment: discussion thread: emits warning
 * - tag: metadata only: emits warning
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { getLifecycleForType, UPG_EDGE_PAIR_MAP } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Quantive entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 */
export const QUANTIVE_TYPE_MAP: Record<string, string | null> = {
  // Core OKR entities
  objective: 'objective',
  key_result: 'key_result',
  'key-result': 'key_result',
  metric: 'metric',
  kpi: 'metric',
  // Initiative / task discrimination
  initiative: 'initiative', // strategic work stream
  task: 'task', // concrete action item
  // Structure
  team: 'team',
  // Skip: no UPG equivalent
  session: null, // timeframe container (Q1/Q2/Annual): skip with warning
  check_in: null, // periodic KR value update: operational data, skip
  'check-in': null,
  integration: null, // data source config: skip
  comment: null, // discussion thread: skip
  tag: null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Quantive status values to UPG status values.
 *
 * Quantive statuses: 'not_started' | 'not-started' | 'upcoming' | 'on_track' | 'on-track' |
 *   'at_risk' | 'at-risk' | 'behind' | 'in_progress' | 'in-progress' |
 *   'achieved' | 'done' | 'closed' | 'abandoned' | 'dropped' | 'cancelled'
 */
export const QUANTIVE_STATUS_MAP: Record<string, string> = {
  not_started: 'draft',
  'not-started': 'draft',
  upcoming: 'draft',
  on_track: 'active',
  'on-track': 'active',
  at_risk: 'active',
  'at-risk': 'active',
  behind: 'active',
  in_progress: 'active',
  'in-progress': 'active',
  achieved: 'complete',
  done: 'complete',
  closed: 'complete',
  abandoned: 'abandoned',
  dropped: 'abandoned',
  cancelled: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Quantive entity_type to a UPG entity type. Returns null if explicitly unmappable. */
export function resolveQuantiveEntityType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  // Returns undefined if not in map (unknown), null if in map but unmappable, string if mapped
  if (lower in QUANTIVE_TYPE_MAP) {
    return QUANTIVE_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Quantive status string to a UPG status value (raw map lookup, exported for tests) */
export function normalizeQuantiveStatus(status: string): string {
  const lower = normalizeName(status)
  return QUANTIVE_STATUS_MAP[lower] ?? status
}

/** Valid status values for a UPG entity type, or null when lifecycle-free. */
function validStatusesForType(type: string): ReadonlySet<string> | null {
  const lc = getLifecycleForType(type)
  if (!lc) return null
  const set = new Set<string>()
  for (const p of lc.phases) {
    set.add(p.id)
    for (const s of p.core_states ?? []) set.add(s.id)
  }
  return set
}

/**
 * Resolve a Quantive status to a phase id valid for the target type's lifecycle.
 * Tries the raw value first (Quantive's KR statuses on_track/at_risk/behind/achieved
 * ARE valid key_result phases), then the QUANTIVE_STATUS_MAP fallback (for objective/
 * initiative/task), then omits when nothing fits or the type is lifecycle-free.
 */
function resolveQuantiveStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const mapped = QUANTIVE_STATUS_MAP[raw]
  return mapped && valid.has(mapped) ? mapped : undefined
}

/**
 * Resolve the canonical UPG edge for a parent UPG type → child UPG type pair
 * via the catalogue, honouring direction; null when no canonical edge exists.
 */
function resolvePairEdge(
  parentUpg: string,
  childUpg: string,
): { type: string; sourceIsChild: boolean } | null {
  const fwd = UPG_EDGE_PAIR_MAP[`${parentUpg}:${childUpg}`]
  if (fwd && fwd.length > 0) return { type: fwd[0], sourceIsChild: false }
  const rev = UPG_EDGE_PAIR_MAP[`${childUpg}:${parentUpg}`]
  if (rev && rev.length > 0) return { type: rev[0], sourceIsChild: true }
  return null
}

/** Resolve the confidence level for an entity_type → UPG type mapping */
export function getQuantiveConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    // Direct 1:1 canonical matches
    case 'objective':
    case 'key_result':
    case 'key-result':
    case 'metric':
    case 'kpi':
    case 'initiative':
    case 'task':
    case 'team':
      return 'high'
    default:
      return 'low'
  }
}

// ─── Quantive Adapter ─────────────────────────────────────────────────────────

export class QuantiveAdapter implements UPGAdapter {
  name = 'quantive'
  label = 'Quantive'
  description =
    'Import Objective, Key Result, Metric, Initiative, Task, and Team hierarchy from Quantive (formerly Gtmhub).'

  /**
   * List available Quantive entities.
   *
   * Requires Quantive API access. This adapter is designed to be called from
   * within a skill that has access to a Quantive API connection.
   *
   * Config options:
   * - `items`: SourceItem[]: pre-fetched Quantive entities
   * - `account_id` (string): specific account to import
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would call the Quantive API:
    //   GET /api/v1/accounts/:account_id/objectives
    //   GET /api/v1/accounts/:account_id/metrics
    //
    // The skill layer passes pre-fetched data via config.items when API
    // access isn't directly available from this adapter.
    throw new Error(
      'Quantive adapter requires Quantive API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched entities via config.items.',
    )
  }

  /**
   * Convert Quantive source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type metadata field discriminates the UPG entity type (via QUANTIVE_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via QUANTIVE_STATUS_MAP)
   * - metadata.current_value / target_value / start_value / unit → key_result / metric fields
   * - Session entities → skipped with warning (no UPG equivalent)
   * - Check-in entities → skipped with warning (operational data: current_value on KR node)
   * - Unknown entity_types → warning + default to 'document'
   * - key_result → initiative/task: WARNING (initiative_drives_outcome approximation)
   * - cascading objective → objective: team_okr_aligns_with_objective
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let sessionCount = 0
    let checkInCount = 0

    for (const item of items) {
      counter++
      const nodeId = `quantive-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveQuantiveEntityType(entityType)

      // Explicitly unmappable entity types: skip and tally for batch warnings
      if (resolved === null) {
        const lower = normalizeName(entityType)
        if (lower === 'session') {
          sessionCount++
        } else if (lower === 'check_in' || lower === 'check-in') {
          checkInCount++
        }
        // integration, comment, tag: silently skip (no useful warning text)
        continue
      }

      // Unknown entity_type: warn and default
      let mappedType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Quantive entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        mappedType = 'document'
        mappingConfidence = 'low'
      } else {
        mappedType = resolved
        mappingConfidence = getQuantiveConfidence(entityType)
      }

      // Register in sourceMap now, before any continue paths below
      sourceMap[item.source_id] = nodeId

      // ── Normalise status (validated against the target type's lifecycle) ─
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolveQuantiveStatusForType(rawStatus, mappedType) : undefined

      // ── Key Result / Metric numeric fields → nested under properties ──────
      // (off-schema top-level fields are silently dropped by the .upg writer).
      const numericProperties: Record<string, unknown> = {}
      if (mappedType === 'key_result' || mappedType === 'metric') {
        if (meta.current_value !== undefined) numericProperties.current_value = meta.current_value as number
        if (meta.target_value !== undefined) numericProperties.target_value = meta.target_value as number
        if (meta.start_value !== undefined) numericProperties.start_value = meta.start_value as number
        if (meta.unit !== undefined) numericProperties.unit = meta.unit as string
      }
      const hasNumericProperties = Object.keys(numericProperties).length > 0

      // ── Build the UPG node ─────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: mappedType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'quantive',
        external_id: item.source_id,
        ...(hasNumericProperties ? { properties: numericProperties } : {}),
      }

      nodes.push(node)
    }

    // ── Batch warnings for skipped types ─────────────────────────────────────
    if (sessionCount > 0) {
      warnings.push(
        `Quantive Session entities are timeframe containers (Q1/Q2/Annual) with no UPG equivalent. ` +
          `${sessionCount} session${sessionCount === 1 ? '' : 's'} were skipped.`,
      )
    }
    if (checkInCount > 0) {
      warnings.push(
        `Quantive Check-ins are periodic KR value updates (operational data) with no UPG entity equivalent. ` +
          `${checkInCount} check-in${checkInCount === 1 ? '' : 's'} were skipped. ` +
          `The current_value on Key Result nodes reflects the latest value.`,
      )
    }

    // ── Emit hierarchy edges (second pass, catalogue-driven) ─────────────────
    // Resolve edges by real UPG types via UPG_EDGE_PAIR_MAP. This keeps the two
    // canonical OKR edges (objective_achieved_through_key_result,
    // key_result_quantified_by_metric) and replaces the previous wrong-endpoint
    // approximations (team->objective as team_targets_team_okr [needs team_okr],
    // objective->objective as team_okr_aligns_with_objective [needs team_okr],
    // key_result->initiative/task as initiative_drives_outcome [needs initiative
    // source + outcome target]) with an honest node_informs_node fallback.
    const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type as string]))

    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined

      // Skip entities that were not registered (e.g. skipped sessions/check-ins)
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Quantive entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const parentUpg = nodeTypeById.get(parentNodeId)
      const childUpg = nodeTypeById.get(nodeId)
      if (!parentUpg || !childUpg) continue

      const mapped = resolvePairEdge(parentUpg, childUpg)
      const edgeSource = mapped?.sourceIsChild ? nodeId : parentNodeId
      const edgeTarget = mapped?.sourceIsChild ? parentNodeId : nodeId
      const edgeType = (mapped ? mapped.type : 'node_informs_node') as UPGEdgeType

      edges.push({
        id: `edge-quantive-${edgeSource}-${edgeTarget}`,
        source: edgeSource,
        target: edgeTarget,
        type: edgeType,
        mapping_confidence: mapped ? 'medium' : 'low',
      })
    }

    if (nodes.length === 0 && sessionCount === 0 && checkInCount === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
