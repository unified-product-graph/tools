/**
 * Craft.io Adapter
 *
 * Imports strategy, planning, and user intelligence entities from Craft.io :
 * a product strategy platform with OKR + roadmap + feedback + persona support.
 *
 * Craft.io carries persona support as a native concept and exposes an explicit
 * observation/data layer (Data Items) alongside structured feedback.
 *
 *
 * Key structural notes:
 * - Story maps to user_story (user narrative form)
 * - Data Item maps to observation (raw research input)
 * - Feedback maps to customer_feedback
 * - Roadmap + workspace → skipped (view/access concerns)
 *
 * Hierarchy edges:
 * - objective → key_result    → objective_achieved_through_key_result
 * - initiative → objective    → initiative_drives_outcome
 * - release → feature         → release_contains_feature
 * - product → persona         → product_targets_persona
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Craft.io entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const CRAFTIO_TYPE_MAP: Record<string, string | null> = {
  objective: 'objective',
  key_result: 'key_result',
  initiative: 'initiative',
  feature: 'feature',
  story: 'user_story',
  milestone: 'milestone',
  release: 'release',
  persona: 'persona',
  feedback: 'customer_feedback',
  data_item: 'observation',
  roadmap: null,            // view config: skip
  workspace: null,          // container: skip
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Craft.io status values to UPG status values.
 */
export const CRAFTIO_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  planned: 'active',
  in_progress: 'active',
  done: 'complete',
  cancelled: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Craft.io entity_type to a UPG entity type */
export function resolveCraftioType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in CRAFTIO_TYPE_MAP) {
    return CRAFTIO_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Craft.io status string to a UPG status value */
export function normalizeCraftioStatus(status: string): string {
  const lower = normalizeName(status)
  return CRAFTIO_STATUS_MAP[lower] ?? status
}

/** Get confidence for a Craft.io entity type → UPG entity type mapping */
export function getCraftioConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'objective':
    case 'key_result':
    case 'initiative':
    case 'feature':
    case 'release':
    case 'persona':
    case 'feedback':
      return 'high'
    case 'story':
    case 'milestone':
    case 'data_item':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Craft.io Adapter ─────────────────────────────────────────────────────────

export class CraftioAdapter implements UPGAdapter {
  name = 'craftio'
  label = 'Craft.io'
  description =
    'Import Objective, Key Result, Initiative, Feature, Story, Release, Milestone, Persona, Feedback, and Data Item entities from Craft.io.'

  /**
   * List available Craft.io entities.
   *
   * Requires Craft.io API access. This adapter is designed to be called from
   * within a skill that has access to a Craft.io API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Craft.io adapter requires Craft.io API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Craft.io source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   * Pass 2: emit hierarchy edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via CRAFTIO_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via CRAFTIO_STATUS_MAP)
   * - metadata.tags → node tags
   * - Roadmap + workspace → skipped with warning
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
      const nodeId = `craftio-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = resolveCraftioType(entityType)

      if (resolved === null) {
        warnings.push(
          `Craft.io entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent ` +
            `(roadmap/workspace are operational constructs not tracked in UPG). Entity skipped.`,
        )
        continue
      }

      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Craft.io entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getCraftioConfidence(entityType)
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeCraftioStatus(rawStatus) : undefined

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
        external_tool: 'craftio',
        external_id: item.source_id,
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
          `Craft.io entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveCraftioEdge(parentType, entityType, item.title, warnings)

      if (!edgeType || edgeType === 'warning-only') continue

      edgeCounter++
      edges.push({
        id: `edge-craftio-${edgeCounter}`,
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
 * Resolve the canonical UPG edge for a Craft.io parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveCraftioEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  _warnings: string[],
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

  // initiative → feature
  if (parent === 'initiative' && child === 'feature') {
    return 'outcome_delivered_by_feature'
  }

  // release → feature
  if (parent === 'release' && child === 'feature') {
    return 'release_contains_feature'
  }

  // product → persona
  if (parent === 'product' && child === 'persona') {
    return 'product_targets_persona'
  }

  // feature → story (story is sub-entity of feature)
  // UPG does not have a direct feature→user_story edge; use node_informs_node
  if (parent === 'feature' && child === 'story') {
    return null // fall through to node_informs_node in caller if needed
  }

  void itemTitle
  return null
}
