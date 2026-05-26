/**
 * Aha! Adapter
 *
 * Imports strategy, delivery, and customer intelligence entities from Aha!
 * into the Unified Product Graph.
 *
 * Aha! has the deepest strategic coverage of any PM tool in this series :
 * Vision, Initiatives, Goals with Key Results, all the way to Requirements.
 * The key gap is the discovery layer: Aha! moves directly from Initiative to
 * Feature with no typed `opportunity` or `solution` node in between.
 *
 *
 * Key structural notes:
 * - Idea (customer feedback with votes) → feature_request
 * - When an Idea is promoted to a Feature, a stub opportunity node is created:
 *   feature_request → stub opportunity → feature
 * - Key Result fields (target, current, unit) are preserved on the node
 * - Requirement → acceptance_criterion (not story_statement: Aha! Requirements
 *   are verifiable conditions, not user narratives)
 * - Product Line: no direct UPG equivalent: treated as grouping context, not emitted
 * - Scorecard Metric: stored as priority_score property, not as metric nodes
 *
 * Hierarchy edges emitted:
 * - initiative_drives_outcome           (initiative → goal/objective)
 * - objective_achieved_through_key_result (goal → key_result)
 * - key_result_tracked_by_metric        (key_result → metric child)
 * - release_contains_feature            (release → feature)
 * - feature_decomposed_into_epic        (feature → epic)
 * - epic_specified_by_story_statement   (epic → requirement/acceptance_criterion)
 * - feature_request_creates_opportunity (idea → stub opportunity)
 * - outcome_delivered_by_feature        (goal/objective → feature)
 * - product_targets_persona             (product → persona)
 * - product_invests_in_initiative       (product → initiative)
 * - opportunity_drives_solution         (stub opportunity → feature, approximation)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Aha! entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const AHA_TYPE_MAP: Record<string, string | null> = {
  // Strategy
  initiative: 'initiative',
  goal: 'objective',
  key_result: 'key_result',
  vision: 'vision',
  positioning: 'positioning',
  // Delivery
  release: 'release',
  epic: 'epic',
  feature: 'feature',
  requirement: 'acceptance_criterion',
  // Customer intelligence
  idea: 'feature_request',
  persona: 'persona',
  competitor: 'competitor',
  // Content
  notes: 'document',
  note: 'document',
  // Meta
  product: 'product',
  product_line: null, // no direct UPG equivalent: treated as grouping context
  team: 'team',
  // Explicitly skip
  scorecard: null, // platform computation
  capacity_scenario: null, // planning simulation
  workflow: null,
  roadmap_view: null,
  board_view: null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Aha! status values to UPG status values.
 */
export const AHA_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  'under-consideration': 'draft',
  planned: 'active',
  'in-progress': 'active',
  'in progress': 'active',
  shipped: 'complete',
  released: 'complete',
  'will-not-implement': 'abandoned',
  "won't implement": 'abandoned',
  cancelled: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve an Aha! entity_type to a UPG entity type */
export function resolveAhaType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in AHA_TYPE_MAP) {
    return AHA_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize an Aha! status string to a UPG status value */
export function normalizeAhaStatus(status: string): string {
  const lower = normalizeName(status)
  return AHA_STATUS_MAP[lower] ?? status
}

/** Get confidence for an Aha! entity type → UPG entity type mapping */
export function getConfidenceForAhaType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'initiative':
    case 'goal':
    case 'key_result':
    case 'feature':
    case 'epic':
    case 'release':
    case 'idea':
    case 'persona':
    case 'competitor':
    case 'product':
      return 'high'
    case 'requirement':
    case 'vision':
    case 'positioning':
    case 'notes':
    case 'note':
    case 'team':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Aha! Adapter ─────────────────────────────────────────────────────────────

export class AhaAdapter implements UPGAdapter {
  name = 'aha'
  label = 'Aha!'
  description =
    'Import Vision, Initiative, Goal, Key Result, Release, Epic, Feature, Requirement, Idea, Persona, and Competitor entities from Aha!.'

  /**
   * List available Aha! entities.
   *
   * Requires Aha! API access. This adapter is designed to be called from
   * within a skill that has access to an Aha! API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Aha! adapter requires Aha! API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Aha! source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   *   - For Ideas with idea_promoted_to_feature_id: create a stub opportunity node
   * Pass 2: emit hierarchy edges + promoted-idea opportunity edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via AHA_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via AHA_STATUS_MAP)
   * - metadata.key_result_target / current / unit → key_result node fields
   * - metadata.idea_promoted_to_feature_id → creates stub opportunity + edges
   * - Product Line → skipped with warning (no UPG equivalent)
   * - Unknown entity_types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    // Track stub opportunity nodes: ideaNodeId → stubOpportunityNodeId
    const ideaOpportunityStubs: Map<string, string> = new Map()

    // ── Pass 1: Build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `aha-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = resolveAhaType(entityType)

      if (resolved === null) {
        if (normalizeName(entityType) === 'product_line') {
          warnings.push(
            `Aha! Product Line "${item.title}" has no direct UPG equivalent. Treated as grouping context. Entity skipped.`,
          )
        } else {
          warnings.push(
            `Aha! entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent. Entity skipped.`,
          )
        }
        continue
      }

      let ugpEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Aha! entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        ugpEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        ugpEntityType = resolved
        mappingConfidence = getConfidenceForAhaType(entityType)
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeAhaStatus(rawStatus) : undefined

      // Build base node
      const node: UPGBaseNode = {
        id: nodeId,
        type: ugpEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'aha',
        external_id: item.source_id,
        // Key Result-specific fields
        ...(ugpEntityType === 'key_result' && meta.key_result_current !== undefined
          ? { current_value: meta.key_result_current as number }
          : {}),
        ...(ugpEntityType === 'key_result' && meta.key_result_target !== undefined
          ? { target_value: meta.key_result_target as number }
          : {}),
        ...(ugpEntityType === 'key_result' && meta.key_result_unit !== undefined
          ? { unit: meta.key_result_unit as string }
          : {}),
      }

      nodes.push(node)

      // Idea → stub opportunity pattern
      const ideaPromotedToFeatureId = meta.idea_promoted_to_feature_id as string | undefined
      if (ugpEntityType === 'feature_request' && ideaPromotedToFeatureId) {
        counter++
        const stubId = `aha-import-${Date.now()}-${counter}`
        const stubNode: UPGBaseNode = {
          id: stubId,
          type: 'opportunity' as UPGEntityType,
          title: `Opportunity: ${item.title}`,
          description:
            'Stub opportunity created from Aha! Idea promotion. Fill in the actual problem statement to complete the evidence chain.',
          source_id: `${item.source_id}-stub-opportunity`,
          source_type: item.source_type,
          mapping_confidence: 'low',
          external_tool: 'aha',
          external_id: `${item.source_id}-stub-opportunity`,
        }
        nodes.push(stubNode)
        sourceMap[`${item.source_id}-stub-opportunity`] = stubId
        ideaOpportunityStubs.set(nodeId, stubId)

        warnings.push(
          `Aha! Idea "${item.title}" was promoted to a feature. A stub opportunity node was created. ` +
            `fill in the actual problem statement to complete the evidence chain.`,
        )
      }
    }

    // ── Pass 2: Emit edges ─────────────────────────────────────────────────────
    let edgeCounter = 0

    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const resolvedType = resolveAhaType(entityType) ?? 'document'

      // ── Parent hierarchy edge ──────────────────────────────────────────────
      if (parentId) {
        const parentNodeId = sourceMap[parentId]
        if (!parentNodeId) {
          warnings.push(
            `Aha! entity "${item.title}" references parent_id "${parentId}" which was not found in the imported set. Edge skipped.`,
          )
        } else {
          const edgeResult = resolveAhaHierarchyEdge(parentType, entityType, item.title, warnings)
          if (edgeResult && edgeResult !== 'warning-only') {
            edgeCounter++
            edges.push({
              id: `edge-aha-${edgeCounter}`,
              source: parentNodeId,
              target: nodeId,
              type: edgeResult as UPGEdgeType,
              mapping_confidence: 'medium',
            })
          }
        }
      }

      // ── Stub opportunity edges (for promoted ideas) ────────────────────────
      const stubOpportunityId = ideaOpportunityStubs.get(nodeId)
      if (stubOpportunityId) {
        const ideaPromotedToFeatureId = meta.idea_promoted_to_feature_id as string | undefined

        // feature_request → stub opportunity
        edgeCounter++
        edges.push({
          id: `edge-aha-${edgeCounter}`,
          source: nodeId,
          target: stubOpportunityId,
          type: 'feature_request_creates_opportunity' as UPGEdgeType,
          mapping_confidence: 'medium',
        })

        // stub opportunity → feature (approximation)
        if (ideaPromotedToFeatureId) {
          const featureNodeId = sourceMap[ideaPromotedToFeatureId]
          if (featureNodeId) {
            edgeCounter++
            edges.push({
              id: `edge-aha-${edgeCounter}`,
              source: stubOpportunityId,
              target: featureNodeId,
              type: 'opportunity_drives_solution' as UPGEdgeType,
              mapping_confidence: 'low',
            })
          }
        }
      }

      void resolvedType
    }

    if (nodes.length === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution helpers ──────────────────────────────────────────────────

/**
 * Resolve the canonical UPG hierarchy edge for an Aha! parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveAhaHierarchyEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  _warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // initiative → goal/objective
  if (parent === 'initiative' && child === 'goal') {
    return 'initiative_drives_outcome'
  }

  // goal → key_result
  if (parent === 'goal' && child === 'key_result') {
    return 'objective_achieved_through_key_result'
  }

  // goal → feature (outcome_delivered_by_feature)
  if (parent === 'goal' && child === 'feature') {
    return 'outcome_delivered_by_feature'
  }

  // release → feature
  if (parent === 'release' && child === 'feature') {
    return 'release_contains_feature'
  }

  // feature → epic (feature decomposed into epic)
  if (parent === 'feature' && child === 'epic') {
    return 'feature_decomposed_into_epic'
  }

  // epic → requirement (acceptance_criterion)
  if (parent === 'epic' && child === 'requirement') {
    return 'epic_specified_by_story_statement'
  }

  // product → persona
  if (parent === 'product' && child === 'persona') {
    return 'product_targets_persona'
  }

  // product → initiative
  if (parent === 'product' && child === 'initiative') {
    return 'product_invests_in_initiative'
  }

  // key_result → metric (if metric tracked by key result)
  if (parent === 'key_result' && child === 'metric') {
    return 'key_result_tracked_by_metric'
  }

  void itemTitle
  return null
}
