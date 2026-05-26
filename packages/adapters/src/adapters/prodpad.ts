/**
 * ProdPad Adapter
 *
 * Imports backlog and strategy entities from ProdPad: a product backlog +
 * strategy tool that explicitly separates customer wants (Ideas) from product
 * decisions (Features). ProdPad positions its Idea as a backlog item that
 * customers ask for: this maps to UPG's feature_request, not opportunity.
 *
 *
 * Key structural notes:
 * - ProdPad Idea → feature_request (NOT opportunity): a customer-voiced want,
 *   not a validated problem statement. The adapter uses feature_request_creates_opportunity
 *   to signal the next step the team should take.
 * - vote_count preserved on feature_request nodes (customer portal signals)
 * - Spec + Canvas → document (reasoning artefacts)
 * - Roadmap + tag → skipped (view/meta concerns)
 *
 * Hierarchy edges:
 * - initiative → objective       → initiative_drives_outcome
 * - feedback → idea              → feature_request_creates_opportunity
 * - product → persona            → product_targets_persona
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Entity type → UPG entity type ───────────────────────────────────────────

/**
 * Maps ProdPad entity_type values to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const PRODPAD_TYPE_MAP: Record<string, string | null> = {
  idea: 'feature_request',        // a backlog idea: maps to feature_request not opportunity
  initiative: 'initiative',
  objective: 'objective',
  product: 'product',
  persona: 'persona',
  feedback: 'customer_feedback',
  spec: 'document',               // product spec attached to an idea
  canvas: 'document',             // lean canvas
  roadmap: null,                  // view config: skip
  tag: null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps ProdPad status values to UPG status values.
 */
export const PRODPAD_STATUS_MAP: Record<string, string> = {
  active: 'active',
  parked: 'draft',
  completed: 'complete',
  archived: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a ProdPad entity_type to a UPG entity type */
export function resolveProdpadType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in PRODPAD_TYPE_MAP) {
    return PRODPAD_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a ProdPad status string to a UPG status value */
export function normalizeProdpadStatus(status: string): string {
  const lower = normalizeName(status)
  return PRODPAD_STATUS_MAP[lower] ?? status
}

/** Get confidence for a ProdPad entity type → UPG entity type mapping */
export function getProdpadConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'idea':
    case 'initiative':
    case 'objective':
    case 'product':
    case 'persona':
    case 'feedback':
      return 'high'
    case 'spec':
    case 'canvas':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── ProdPad Adapter ──────────────────────────────────────────────────────────

export class ProdpadAdapter implements UPGAdapter {
  name = 'prodpad'
  label = 'ProdPad'
  description =
    'Import Idea (Feature Request), Initiative, Objective, Product, Persona, Feedback, Spec, and Canvas entities from ProdPad.'

  /**
   * List available ProdPad entities.
   *
   * Requires ProdPad API access. This adapter is designed to be called from
   * within a skill that has access to a ProdPad API connection.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'ProdPad adapter requires ProdPad API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert ProdPad source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   *   - ProdPad Ideas are mapped to UPG feature_request
   *   - vote_count preserved on feature_request nodes
   *   - Spec + Canvas → document nodes
   * Pass 2: emit hierarchy edges
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via PRODPAD_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via PRODPAD_STATUS_MAP)
   * - metadata.vote_count → preserved on feature_request nodes
   * - metadata.tags → node tags
   * - Roadmap + tag → skipped with warning
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
      const nodeId = `prodpad-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = resolveProdpadType(entityType)

      if (resolved === null) {
        warnings.push(
          `ProdPad entity "${item.title}" has entity_type "${entityType}" which has no UPG equivalent ` +
            `(roadmap/tag are view/meta constructs not tracked in UPG). Entity skipped.`,
        )
        continue
      }

      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `ProdPad entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getProdpadConfidence(entityType)
      }

      sourceMap[item.source_id] = nodeId

      // Normalise status
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeProdpadStatus(rawStatus) : undefined

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
        external_tool: 'prodpad',
        external_id: item.source_id,
        // Preserve vote_count on feature_request nodes
        ...(upgEntityType === 'feature_request' && meta.vote_count !== undefined
          ? { vote_count: meta.vote_count as number }
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
          `ProdPad entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveProdpadEdge(parentType, entityType, item.title, warnings)

      if (!edgeType || edgeType === 'warning-only') continue

      edgeCounter++
      edges.push({
        id: `edge-prodpad-${edgeCounter}`,
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
 * Resolve the canonical UPG edge for a ProdPad parent_type → child_type pair.
 *
 * Returns:
 * - A UPG edge type string
 * - 'warning-only': warns but does not emit an edge
 * - null: unknown pair or no edge needed
 */
function resolveProdpadEdge(
  parentType: string,
  childType: string,
  itemTitle: string,
  _warnings: string[],
): string | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // initiative → objective / key_result
  if (parent === 'initiative' && child === 'objective') {
    return 'initiative_drives_outcome'
  }

  // initiative → idea (feature_request)
  if (parent === 'initiative' && child === 'idea') {
    return 'initiative_drives_outcome'
  }

  // feedback → idea (customer_feedback → feature_request)
  // Canonical: feature_request_creates_opportunity is the next step;
  // for the feedback→idea link, we use feature_request_creates_opportunity
  // as an approximation since the idea is the feature_request in this context.
  if (parent === 'feedback' && child === 'idea') {
    return 'feature_request_creates_opportunity'
  }

  // product → persona
  if (parent === 'product' && child === 'persona') {
    return 'product_targets_persona'
  }

  // idea (feature_request) → spec / canvas (document)
  // No typed edge in catalogue for feature_request → document; fall through
  if (parent === 'idea' && (child === 'spec' || child === 'canvas')) {
    return null
  }

  void itemTitle
  return null
}
