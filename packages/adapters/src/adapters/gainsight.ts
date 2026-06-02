/**
 * Gainsight Adapter
 *
 * Imports entities from Gainsight: the leading customer success platform.
 * Gainsight invented the vocabulary that UPG formalised: health score, playbook,
 * success plan, CTA (call to action). The conceptual overlap is the highest of
 * any tool in the UPG ecosystem.
 *
 * Gainsight tracks account health, manages CSM workflows, orchestrates customer
 * journeys, and connects customer outcomes to product decisions.
 *
 *
 * Edges:
 * - objective → success_plan child:       objective_achieved_through_key_result
 * - success_plan → objective:             initiative_drives_outcome
 * - survey_response → feature context:    customer_feedback_becomes_feature_request
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Gainsight entity types to UPG entity types.
 *
 * Null = no UPG equivalent, skip with warning.
 * All UPG entity types verified against the live catalog.
 */
export const GAINSIGHT_TYPE_MAP: Record<string, string | null> = {
  account: 'account',
  contact: 'participant',
  objective: 'objective', // customer objective (NOT product OKR)
  success_plan: 'initiative', // a structured plan to achieve customer objectives
  cta: 'task', // call-to-action: a triggered task
  timeline_activity: 'observation', // a logged interaction/observation
  survey_response: 'customer_feedback',
  nps_response: 'customer_feedback',
  health_score: 'metric', // customer health score
  relationship: null, // Gainsight C360 relationship: skip
  risk: null, // risk/churn signal: operational
  renewal: null, // renewal record: operational
  usage_data: null, // behavioral analytics: skip
  playbook: null, // CS playbook template: not product knowledge
  journey_orchestrator: null, // automation: skip
  milestone: 'milestone', // customer milestone
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Gainsight status values to UPG status values.
 *
 * Covers CTA statuses, Success Plan statuses, and Objective statuses.
 */
export const GAINSIGHT_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  in_progress: 'active',
  open: 'active',
  overdue: 'active',
  closed: 'complete',
  success: 'complete',
  at_risk: 'active',
  cancelled: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Gainsight entity type to a UPG entity type */
export function resolveGainsightType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in GAINSIGHT_TYPE_MAP) {
    return GAINSIGHT_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Gainsight status string to a UPG status value */
export function normalizeGainsightStatus(status: string): string {
  const lower = normalizeName(status)
  return GAINSIGHT_STATUS_MAP[lower] ?? status
}

/** Resolve mapping confidence for a Gainsight entity type */
export function getGainsightConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'account':
    case 'objective':
    case 'health_score':
    case 'milestone':
    case 'nps_response':
    case 'survey_response':
      return 'high'
    case 'contact':
    case 'success_plan':
    case 'cta':
    case 'timeline_activity':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Gainsight Adapter ────────────────────────────────────────────────────────

export class GainsightAdapter implements UPGAdapter {
  name = 'gainsight'
  label = 'Gainsight'
  description =
    'Import Account, Objective, Success Plan, CTA, Timeline Activity, Survey Response, Health Score, and Milestone entities from Gainsight.'

  /**
   * List available Gainsight entities.
   *
   * Requires Gainsight REST API v2 Bearer token. Pre-fetched items
   * may be passed via config.items when API access is not available.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Gainsight adapter requires Gainsight API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Gainsight source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via GAINSIGHT_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status
   * - metadata.health_score → current_value / target_value / unit on metric nodes
   * - metadata.nps_score → preserved as tag
   * - metadata.tags → node tags
   * - Operational types (risk, renewal, usage_data, playbook) → skipped with warning
   * - Unknown types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    for (const item of items) {
      counter++
      const nodeId = `gainsight-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ──────────────────────────────────────────────
      const resolved = resolveGainsightType(entityType)

      // Explicitly unmappable types: skip
      if (resolved === null) {
        warnings.push(
          `Gainsight entity "${item.title}" has type "${entityType}" which has no UPG equivalent ` +
            `(operational records like risk signals, renewals, usage data, and playbook templates ` +
            `are not product knowledge). Entity skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Gainsight entity "${item.title}" has unknown type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getGainsightConfidence(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Normalise status ─────────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeGainsightStatus(rawStatus) : undefined

      // ── Tags ─────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve NPS score as a tag for customer_feedback nodes
      if (meta.nps_score !== undefined) {
        tags.push(`nps:${meta.nps_score as number}`)
      }

      // ── Build the UPG node ───────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: upgEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'gainsight',
        external_id: item.source_id,
        // Health score metric fields
        ...(upgEntityType === 'metric' && meta.health_score !== undefined
          ? { current_value: meta.health_score as number, target_value: 100, unit: 'health' }
          : {}),
      }

      nodes.push(node)
    }

    // ── Second pass: emit hierarchy edges ────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Gainsight entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeResult = resolveGainsightEdge(parentType, entityType, item.title, warnings)

      if (edgeResult === null) {
        // Unrecognised pair: emit generic informational edge with low confidence
        edges.push({
          id: `edge-gainsight-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-gainsight-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeResult as UPGEdgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Gainsight parent_type → entity_type pair.
 *
 * Returns a UPG edge type string, or null for unrecognised pairs
 * (caller emits node_informs_node fallback).
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveGainsightEdge(
  parentType: string,
  childType: string,
  _itemTitle: string,
  _warnings: string[],
): string | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // objective → success_plan child: objective achieved through a key result
  // success_plan maps to initiative; objective remains objective
  // objective_achieved_through_key_result: source=objective, target=key_result
  // Here child=success_plan (maps to initiative). Best canonical edge available.
  if (parent === 'objective' && child === 'success_plan') {
    return 'objective_achieved_through_key_result'
  }

  // success_plan → objective: initiative drives an outcome
  // initiative_drives_outcome: source=initiative, target=outcome
  // objective maps to objective (not outcome), but this is the closest structural edge
  // for a success plan driving a customer objective.
  if (parent === 'success_plan' && child === 'objective') {
    return 'initiative_drives_outcome'
  }

  // survey_response / nps_response → feature context
  // customer_feedback_becomes_feature_request: source=customer_feedback, target=feature_request
  if (
    (parent === 'survey_response' || parent === 'nps_response') &&
    (child === 'feature_request' || child === 'cta')
  ) {
    return 'customer_feedback_becomes_feature_request'
  }

  // account → health_score: product health scored via customer health score
  if (parent === 'account' && child === 'health_score') {
    return null // no direct account→health_score edge in catalog; use fallback
  }

  // health_score → cta: playbook triggered by health score
  // This requires the playbook entity: cta maps to task, not playbook.
  // Use node_informs_node fallback.
  if (parent === 'health_score' && child === 'cta') {
    return null
  }

  // account → milestone
  if (parent === 'account' && child === 'milestone') {
    return null
  }

  return null
}
