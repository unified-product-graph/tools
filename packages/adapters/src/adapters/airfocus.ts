/**
 * Airfocus Adapter
 *
 * Imports strategy, planning, and research entities from Airfocus :
 * a prioritisation + roadmapping platform with optional OKR support
 * and a scoring engine.
 *
 * Airfocus's core entity is the polymorphic "Item": a planning entity
 * that can represent a feature, bug, task, or idea depending on workspace
 * configuration. The adapter discriminates by explicit `entity_type` metadata.
 *
 *
 * Key structural notes:
 * - Item with entity_type "item" defaults to "feature" (roadmap context)
 * - priority_score preserved on feature nodes (internal scoring signal, not a UPG metric)
 * - Workspace + board containers skipped: view/access concerns only
 * - Sprint skipped: delivery execution, not product knowledge
 *
 * Hierarchy edges:
 * - objective → key_result   → objective_achieved_through_key_result
 * - initiative → objective   → initiative_drives_outcome
 * - initiative → feature     → outcome_delivered_by_feature
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Airfocus entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const AIRFOCUS_TYPE_MAP: Record<string, string | null> = {
  objective: 'objective',
  key_result: 'key_result',
  initiative: 'initiative',
  item: 'feature',         // roadmap item: the core entity
  feature: 'feature',
  milestone: 'milestone',
  sprint: null,            // skip
  insight: 'insight',
  workspace: null,         // container: skip
  board: null,             // view config: skip
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Airfocus status values to UPG status values.
 */
export const AIRFOCUS_STATUS_MAP: Record<string, string> = {
  backlog: 'draft',
  planned: 'active',
  in_progress: 'active',
  complete: 'complete',
  cancelled: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve an Airfocus entity_type to a UPG entity type */
export function resolveAirfocusType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in AIRFOCUS_TYPE_MAP) {
    return AIRFOCUS_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize an Airfocus status string to a UPG status value */
export function normalizeAirfocusStatus(status: string): string {
  const lower = normalizeName(status)
  return AIRFOCUS_STATUS_MAP[lower] ?? status
}

/** Get confidence for an Airfocus entity type → UPG entity type mapping */
export function getAirfocusConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'objective':
    case 'key_result':
    case 'initiative':
    case 'feature':
    case 'milestone':
      return 'high'
    case 'item':
    case 'insight':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Airfocus Adapter ─────────────────────────────────────────────────────────

export class AirfocusAdapter implements UPGAdapter {
  name = 'airfocus'
  label = 'Airfocus'
  description =
    'Import Objective, Key Result, Initiative, Item (Feature), Milestone, and Insight entities from Airfocus.'

  /**
   * List available Airfocus entities.
   *
   * Requires Airfocus API access. This adapter is designed to be called from
   * within a skill that has access to an Airfocus API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Airfocus adapter requires Airfocus API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Airfocus source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   *   - priority_score on feature nodes is preserved as a property
   * Pass 2: emit hierarchy edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via AIRFOCUS_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via AIRFOCUS_STATUS_MAP)
   * - metadata.priority_score → preserved on feature nodes
   * - metadata.tags → node tags
   * - Workspace + board + sprint cards → skipped with warning
   * - Unknown entity_types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    // ── Pass 1: Build nodes ──────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `airfocus-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = resolveAirfocusType(entityType)

      if (resolved === null) {
        warnings.push(
          `Airfocus entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent ` +
            `(workspace/board/sprint are operational constructs not tracked in UPG). Entity skipped.`,
        )
        continue
      }

      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Airfocus entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getAirfocusConfidence(entityType)
      }

      // Emit NOTE for polymorphic item type
      if (normalizeName(entityType) === 'item') {
        warnings.push(
          `Airfocus Item "${item.title}" mapped to UPG feature. ` +
            `Airfocus Items are polymorphic; this assumes a roadmap/feature context. ` +
            `Set entity_type to "feature" explicitly if correct.`,
        )
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeAirfocusStatus(rawStatus) : undefined

      // Tags
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      // Build base node
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
        external_tool: 'airfocus',
        external_id: item.source_id,
        // Preserve priority_score on feature nodes
        ...(upgEntityType === 'feature' && meta.priority_score !== undefined
          ? { priority_score: meta.priority_score as number }
          : {}),
      }

      nodes.push(node)
    }

    // ── Pass 2: Emit edges ───────────────────────────────────────────────────
    let edgeCounter = 0

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
          `Airfocus entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveAirfocusEdge(parentType, entityType, item.title, warnings)

      if (!edgeType || edgeType === 'warning-only') continue

      edgeCounter++
      edges.push({
        id: `edge-airfocus-${edgeCounter}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType as UPGEdgeType,
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
 * Resolve the canonical UPG edge for an Airfocus parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveAirfocusEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // objective → key_result
  if (parent === 'objective' && child === 'key_result') {
    return 'objective_achieved_through_key_result'
  }

  // initiative → objective / key_result
  if (parent === 'initiative' && (child === 'objective' || child === 'key_result')) {
    return 'initiative_drives_outcome'
  }

  // initiative → feature / item
  if (parent === 'initiative' && (child === 'feature' || child === 'item')) {
    return 'outcome_delivered_by_feature'
  }

  // objective → feature / item (goal drives feature delivery)
  if (parent === 'objective' && (child === 'feature' || child === 'item')) {
    return 'outcome_delivered_by_feature'
  }

  // insight → feature / item (approximation: no opportunity node present)
  if (parent === 'insight' && (child === 'feature' || child === 'item')) {
    warnings.push(
      `Airfocus Insight→${childType} hierarchy for "${itemTitle}": ` +
        `UPG canonical path goes via opportunity (insight → opportunity → feature). ` +
        `Emitting insight_informs_opportunity as an approximation. ` +
        `Consider adding an opportunity node to complete the chain.`,
    )
    return 'insight_informs_opportunity'
  }

  void itemTitle
  return null
}
