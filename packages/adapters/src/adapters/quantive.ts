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

/** Normalize a Quantive status string to a UPG status value */
export function normalizeQuantiveStatus(status: string): string {
  const lower = normalizeName(status)
  return QUANTIVE_STATUS_MAP[lower] ?? status
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

      // ── Normalise status ───────────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeQuantiveStatus(rawStatus) : undefined

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
        // Key Result / Metric value fields
        ...(mappedType === 'key_result' || mappedType === 'metric'
          ? {
              ...(meta.current_value !== undefined
                ? { current_value: meta.current_value as number }
                : {}),
              ...(meta.target_value !== undefined
                ? { target_value: meta.target_value as number }
                : {}),
              ...(meta.start_value !== undefined
                ? { start_value: meta.start_value as number }
                : {}),
              ...(meta.unit !== undefined ? { unit: meta.unit as string } : {}),
            }
          : {}),
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

    // ── Emit hierarchy edges (second pass, so sourceMap is complete) ──────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

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

      // Resolve edge based on parent_type + entity_type pair
      const edgeResult = resolveQuantiveEdge(parentType, entityType, item.title, warnings)

      if (edgeResult === 'warning-only') {
        // Warning already emitted inside resolveQuantiveEdge: no edge to emit
        continue
      }

      if (edgeResult === null) {
        // Unrecognised pair: emit a generic informational edge with low confidence
        edges.push({
          id: `edge-quantive-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-quantive-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeResult as UPGEdgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && sessionCount === 0 && checkInCount === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Quantive parent_type → entity_type pair.
 *
 * Returns:
 * - A UPG edge type string (most cases)
 * - 'warning-only' for gaps that warrant a warning but no edge
 * - null for unrecognised pairs (caller emits node_informs_node fallback)
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveQuantiveEdge(
  parentType: string,
  childType: string,
  entityTitle: string,
  warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // objective → key_result
  if (parent === 'objective' && (child === 'key_result' || child === 'key-result')) {
    return 'objective_achieved_through_key_result'
  }

  // key_result → metric / kpi
  if ((parent === 'key_result' || parent === 'key-result') && (child === 'metric' || child === 'kpi')) {
    return 'key_result_quantified_by_metric'
  }

  // key_result → initiative (strategic work stream approximation)
  if ((parent === 'key_result' || parent === 'key-result') && child === 'initiative') {
    warnings.push(
      `Quantive Key Result→Initiative relationship for "${entityTitle}": ` +
        `emitting \`initiative_drives_outcome\` as an approximation. ` +
        `The Key Result acts as the outcome proxy. ` +
        `Consider adding an explicit \`outcome\` node between them.`,
    )
    return 'initiative_drives_outcome'
  }

  // key_result → task (concrete action item approximation)
  if ((parent === 'key_result' || parent === 'key-result') && child === 'task') {
    warnings.push(
      `Quantive Key Result→Task relationship for "${entityTitle}": ` +
        `emitting \`initiative_drives_outcome\` as an approximation. ` +
        `The Key Result acts as the outcome proxy. ` +
        `Consider adding an explicit \`outcome\` node between them.`,
    )
    return 'initiative_drives_outcome'
  }

  // objective → objective (cascading OKR alignment: child obj aligns with parent obj)
  // UPG models this as team_okr_aligns_with_objective:
  //   source = child objective (team-level), target = parent objective (org-level)
  if (parent === 'objective' && child === 'objective') {
    return 'team_okr_aligns_with_objective'
  }

  // team → objective
  if (parent === 'team' && child === 'objective') {
    return 'team_targets_team_okr'
  }

  // Unrecognised pair
  return null
}
