/**
 * Productboard Adapter
 *
 * Imports features, feedback (Notes), releases, and strategy entities from
 * Productboard into the Unified Product Graph.
 *
 * Productboard is the layer between customer feedback and delivery. Its core
 * innovation: the Note-to-Feature link: maps to the UPG evidence chain:
 * customer_feedback → feature_request → opportunity → feature.
 *
 *
 * Key structural notes:
 * - Feature type discrimination: type=feature → feature, type=bug → bug, type=chore → task
 * - Sub-feature → epic (sub-features decompose features)
 * - Component → feature_area
 * - Note-to-Feature chain: Note linked to features emits customer_feedback edge
 *   with a warning that the intermediate feature_request node was not created
 * - Roadmap and Board: view configs: skipped
 *
 * Hierarchy edges emitted:
 * - feature_area_contains_feature       (component → feature)
 * - product_organises_into_feature_area (product → component)
 * - feature_decomposed_into_epic        (feature → sub-feature mapped as epic)
 * - release_contains_feature            (release → feature)
 * - customer_feedback_becomes_feature_request  (note → feature approximation)
 * - initiative_drives_outcome           (initiative → objective approximation)
 * - outcome_delivered_by_feature        (objective → feature)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Productboard entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const PRODUCTBOARD_TYPE_MAP: Record<string, string | null> = {
  // Product hierarchy
  feature: 'feature',
  bug: 'bug',
  chore: 'task',
  sub_feature: 'epic',
  component: 'feature_area',
  product: 'product',
  release: 'release',
  release_group: 'roadmap',
  // Strategy
  objective: 'objective',
  initiative: 'initiative',
  // Feedback
  note: 'customer_feedback',
  feedback: 'customer_feedback',
  user: 'participant',
  company: 'account',
  // No UPG equivalent
  roadmap: null, // view config
  board: null, // view config
  webhook: null,
  tag: null,
  scorecard: null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Productboard status values to UPG status values.
 */
export const PRODUCTBOARD_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  'under-consideration': 'draft',
  planned: 'active',
  'in-progress': 'active',
  released: 'complete',
  "won't do": 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Productboard entity_type to a UPG entity type */
export function resolveProductboardType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in PRODUCTBOARD_TYPE_MAP) {
    return PRODUCTBOARD_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Productboard status string to a UPG status value */
export function normalizeProductboardStatus(status: string): string {
  const lower = normalizeName(status)
  return PRODUCTBOARD_STATUS_MAP[lower] ?? status
}

/** Get confidence for a Productboard entity type → UPG entity type mapping */
export function getConfidenceForProductboardType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'feature':
    case 'bug':
    case 'component':
    case 'product':
    case 'release':
    case 'objective':
    case 'initiative':
    case 'note':
    case 'feedback':
      return 'high'
    case 'chore':
    case 'sub_feature':
    case 'user':
    case 'company':
    case 'release_group':
      return 'medium'
    default:
      return 'low'
  }
}

/**
 * Resolve the discriminated entity type for a Feature item.
 * Productboard Feature has a `feature_type` property: 'feature' | 'bug' | 'chore'
 */
export function resolveFeatureType(featureType: string | undefined): string {
  if (!featureType) return 'feature'
  const lower = normalizeName(featureType)
  switch (lower) {
    case 'bug':
      return 'bug'
    case 'chore':
      return 'task'
    default:
      return 'feature'
  }
}

// ─── Productboard Adapter ─────────────────────────────────────────────────────

export class ProductboardAdapter implements UPGAdapter {
  name = 'productboard'
  label = 'Productboard'
  description =
    'Import features, feedback notes, releases, and strategy entities from Productboard. Covers Feature hierarchy, Note evidence chain, and Initiative/Objective strategy.'

  /**
   * List available Productboard entities.
   *
   * Requires Productboard API access. This adapter is designed to be called from
   * within a skill that has access to a Productboard API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Productboard adapter requires Productboard API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Productboard source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   * Pass 2: emit hierarchy edges + Note-to-Feature edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type
   * - metadata.feature_type further discriminates Feature sub-types (feature/bug/chore)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via PRODUCTBOARD_STATUS_MAP)
   * - metadata.note_linked_feature_ids → Note-to-Feature evidence chain
   * - metadata.user_impact_score → preserved on feature node
   * - Roadmap / Board → skipped with warning
   * - Unknown entity types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    // ── Pass 1: Build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `productboard-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const featureType = meta.feature_type as string | undefined

      // Discriminate Feature sub-types
      const effectiveType = entityType === 'feature' && featureType
        ? featureType
        : entityType

      const resolved = resolveProductboardType(effectiveType)

      if (resolved === null) {
        warnings.push(
          `Productboard entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent. Entity skipped.`,
        )
        continue
      }

      let ugpEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Productboard entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        ugpEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        ugpEntityType = resolved
        mappingConfidence = getConfidenceForProductboardType(effectiveType)
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeProductboardStatus(rawStatus) : undefined

      // Build node
      const node: UPGBaseNode = {
        id: nodeId,
        type: ugpEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'productboard',
        external_id: item.source_id,
      }

      nodes.push(node)
    }

    // ── Pass 2: Emit edges ─────────────────────────────────────────────────────
    let edgeCounter = 0

    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const featureType = meta.feature_type as string | undefined
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const effectiveType = entityType === 'feature' && featureType ? featureType : entityType

      // ── Parent hierarchy edge ──────────────────────────────────────────────
      if (parentId) {
        const parentNodeId = sourceMap[parentId]
        if (!parentNodeId) {
          warnings.push(
            `Productboard entity "${item.title}" references parent_id "${parentId}" which was not found in the imported set. Edge skipped.`,
          )
        } else {
          const edgeResult = resolveProductboardHierarchyEdge(
            parentType,
            effectiveType,
            item.title,
            warnings,
          )
          if (edgeResult && edgeResult !== 'warning-only') {
            edgeCounter++
            edges.push({
              id: `edge-pb-${edgeCounter}`,
              source: parentNodeId,
              target: nodeId,
              type: edgeResult as UPGEdgeType,
              mapping_confidence: 'medium',
            })
          }
        }
      }

      // ── Note-to-Feature evidence chain ─────────────────────────────────────
      if (entityType === 'note' || entityType === 'feedback') {
        const linkedFeatureIds = meta.note_linked_feature_ids as string[] | undefined
        if (Array.isArray(linkedFeatureIds) && linkedFeatureIds.length > 0) {
          warnings.push(
            `Productboard Note "${item.title}" is linked to feature(s). UPG canonical path is ` +
              `customer_feedback → feature_request → opportunity → feature. The feature_request stub was omitted. ` +
              `Consider adding feature_request nodes to complete the evidence chain.`,
          )
          for (const featureId of linkedFeatureIds) {
            const featureNodeId = sourceMap[featureId]
            if (!featureNodeId) continue
            edgeCounter++
            edges.push({
              id: `edge-pb-${edgeCounter}`,
              source: nodeId,
              target: featureNodeId,
              type: 'customer_feedback_becomes_feature_request' as UPGEdgeType,
              mapping_confidence: 'low',
            })
          }
        }
      }
    }

    if (nodes.length === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution helpers ──────────────────────────────────────────────────

/**
 * Resolve the canonical UPG hierarchy edge for a Productboard parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveProductboardHierarchyEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // component → feature/bug/chore
  if (parent === 'component') {
    if (child === 'feature' || child === 'bug' || child === 'chore' || child === 'sub_feature') {
      return 'feature_area_contains_feature'
    }
  }

  // product → component
  if (parent === 'product' && child === 'component') {
    return 'product_organises_into_feature_area'
  }

  // feature → sub_feature (feature decomposed into epic)
  if (parent === 'feature' && child === 'sub_feature') {
    return 'feature_decomposed_into_epic'
  }

  // release → feature/bug/chore/sub_feature
  if (parent === 'release') {
    if (child === 'feature' || child === 'chore' || child === 'sub_feature') {
      return 'release_contains_feature'
    }
    if (child === 'bug') {
      return 'release_contains_bug'
    }
  }

  // initiative → objective
  if (parent === 'initiative' && child === 'objective') {
    warnings.push(
      `Productboard Initiative→Objective relationship for "${itemTitle}": ` +
        `mapped as initiative_drives_outcome (approximation). ` +
        `UPG connects Initiative to Outcome, not directly to Objective. ` +
        `Consider adding an outcome node to complete the chain.`,
    )
    return 'initiative_drives_outcome'
  }

  // objective → feature (outcome_delivered_by_feature)
  if (parent === 'objective') {
    if (child === 'feature' || child === 'bug' || child === 'chore') {
      return 'outcome_delivered_by_feature'
    }
  }

  void itemTitle
  return null
}
