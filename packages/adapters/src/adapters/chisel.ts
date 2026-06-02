/**
 * Chisel Adapter
 *
 * Imports discovery, alignment, and planning entities from Chisel :
 * a discovery + roadmap tool with team alignment OKRs. Chisel's Ideation
 * layer maps directly to UPG opportunities: its Ideas are not backlog items
 * but explicit candidate product opportunities ("what problem should we solve?").
 *
 *
 * Key structural notes:
 * - Chisel "Idea" → UPG "opportunity" (the most semantically precise mapping
 *   in this category: Chisel explicitly positions Ideas as discovery entities)
 * - A NOTE is emitted when this mapping is applied so teams know their Idea
 *   backlog is a discovery backlog in UPG
 * - impact_score + effort_score preserved as properties on opportunity nodes
 * - Sprint skipped: delivery execution, not product knowledge
 * - Roadmap Item maps to feature (delivery-state wrapper)
 *
 * Hierarchy edges:
 * - pillar (initiative) → goal (objective)  → initiative_drives_outcome
 * - idea (opportunity) → feature            → opportunity_drives_solution
 * - feedback → idea                         → feature_request_creates_opportunity
 * - product/team → persona                  → product_targets_persona
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Chisel entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const CHISEL_TYPE_MAP: Record<string, string | null> = {
  goal: 'objective',              // team alignment goal
  pillar: 'initiative',           // strategic pillar / theme
  idea: 'opportunity',            // Chisel's ideation layer = UPG opportunity
  feature: 'feature',
  user_story: 'user_story',
  persona: 'persona',
  feedback: 'customer_feedback',
  insight: 'insight',
  roadmap_item: 'feature',
  sprint: null,                   // skip
  team: 'team',
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Chisel status values to UPG status values.
 */
export const CHISEL_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  in_progress: 'active',
  done: 'complete',
  archived: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Chisel entity_type to a UPG entity type */
export function resolveChiselType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in CHISEL_TYPE_MAP) {
    return CHISEL_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Chisel status string to a UPG status value */
export function normalizeChiselStatus(status: string): string {
  const lower = normalizeName(status)
  return CHISEL_STATUS_MAP[lower] ?? status
}

/** Get confidence for a Chisel entity type → UPG entity type mapping */
export function getChiselConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'goal':
    case 'pillar':
    case 'idea':
    case 'feature':
    case 'persona':
    case 'feedback':
    case 'insight':
      return 'high'
    case 'user_story':
    case 'team':
    case 'roadmap_item':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Chisel Adapter ───────────────────────────────────────────────────────────

export class ChiselAdapter implements UPGAdapter {
  name = 'chisel'
  label = 'Chisel'
  description =
    'Import Goal, Pillar, Idea (Opportunity), Feature, User Story, Persona, Feedback, Insight, and Team entities from Chisel.'

  /**
   * List available Chisel entities.
   *
   * Requires Chisel API access. This adapter is designed to be called from
   * within a skill that has access to a Chisel API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Chisel adapter requires Chisel API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Chisel source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   *   - Chisel Ideas are mapped to UPG opportunity with a NOTE
   *   - impact_score + effort_score preserved on opportunity nodes
   * Pass 2: emit hierarchy edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via CHISEL_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via CHISEL_STATUS_MAP)
   * - metadata.impact_score + metadata.effort_score → preserved on opportunity nodes
   * - metadata.tags → node tags
   * - Sprint → skipped with warning
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
      const nodeId = `chisel-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = resolveChiselType(entityType)

      if (resolved === null) {
        warnings.push(
          `Chisel entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent ` +
            `(sprint is a delivery execution construct not tracked in UPG). Entity skipped.`,
        )
        continue
      }

      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Chisel entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getChiselConfidence(entityType)
      }

      // Emit NOTE for Idea → opportunity mapping
      if (normalizeName(entityType) === 'idea') {
        warnings.push(
          `Chisel Idea "${item.title}" mapped to UPG opportunity. ` +
            `Chisel's ideation layer is semantically a product opportunity (a user problem worth solving).`,
        )
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeChiselStatus(rawStatus) : undefined

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
        external_tool: 'chisel',
        external_id: item.source_id,
        // Preserve ICE scoring values on opportunity nodes
        ...(upgEntityType === 'opportunity' && meta.impact_score !== undefined
          ? { impact_score: meta.impact_score as number }
          : {}),
        ...(upgEntityType === 'opportunity' && meta.effort_score !== undefined
          ? { effort_score: meta.effort_score as number }
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
          `Chisel entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveChiselEdge(parentType, entityType, item.title, warnings)

      if (!edgeType || edgeType === 'warning-only') continue

      edgeCounter++
      edges.push({
        id: `edge-chisel-${edgeCounter}`,
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
 * Resolve the canonical UPG edge for a Chisel parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveChiselEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  _warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // pillar (initiative) → goal (objective) or other outcomes
  if (parent === 'pillar' && child === 'goal') {
    return 'initiative_drives_outcome'
  }

  // pillar (initiative) → idea (opportunity)
  if (parent === 'pillar' && child === 'idea') {
    return 'initiative_drives_outcome'
  }

  // idea (opportunity) → feature (solution/delivery)
  if (parent === 'idea' && child === 'feature') {
    return 'opportunity_drives_solution'
  }

  // idea (opportunity) → roadmap_item (feature)
  if (parent === 'idea' && child === 'roadmap_item') {
    return 'opportunity_drives_solution'
  }

  // feedback → idea (opportunity): customer_feedback_becomes_feature_request is the closest
  // but since idea maps to opportunity (not feature_request), we use feature_request_creates_opportunity
  // as an approximation. The semantic is: feedback surfaced this opportunity.
  if (parent === 'feedback' && child === 'idea') {
    return 'feature_request_creates_opportunity'
  }

  // product/team → persona
  if ((parent === 'product' || parent === 'team') && child === 'persona') {
    return 'product_targets_persona'
  }

  // insight → idea (opportunity)
  if (parent === 'insight' && child === 'idea') {
    return 'insight_informs_opportunity'
  }

  void itemTitle
  return null
}
