/**
 * Canny Adapter
 *
 * Imports feature requests and feedback from Canny: a feature request and
 * feedback portal where customers submit, vote on, and track product requests.
 *
 * Canny sits at the boundary between customer feedback and product planning.
 * The core UPG bridge: Canny answers "what do customers want?" UPG adds "which
 * user problem does that request address?" via the opportunity layer.
 *
 *
 * Edges emitted:
 * - feature_request_creates_opportunity  (when parent is an opportunity)
 *
 * Skipped with warnings:
 * - board     : category container, skipped; board_name preserved as tag on posts
 * - changelog : release-level entity; import as releases instead
 * - comment   : collaboration layer, not product knowledge
 * - user      : individual submitter, not a knowledge entity
 * - vote      : behavioral signal; preserved as vote_count property on feature_request
 * - tag       : metadata; preserved as tags on nodes
 */

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Canny entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const CANNY_TYPE_MAP: Record<string, string | null> = {
  post: 'feature_request',  // a user-submitted feature request with votes
  board: null,              // category grouping: skip with warning
  changelog: null,          // release notes: skip (no UPG changelog entity at this level)
  comment: null,            // user comment: not product knowledge
  user: null,               // submitter: not a knowledge entity
  company: 'account',       // company the submitter belongs to
  tag: null,                // metadata
  vote: null,               // behavioral signal: preserve as vote_count property
}

// ─── Status normalisation ─────────────────────────────────────────────────────

export const CANNY_STATUS_MAP: Record<string, string> = {
  'open': 'draft',
  'under review': 'draft',
  'planned': 'active',
  'in progress': 'active',
  'complete': 'complete',
  'closed': 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Canny entity_type to a UPG entity type */
export function resolveCannyType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in CANNY_TYPE_MAP) {
    return CANNY_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Canny status string to a UPG status value */
export function normalizeCannyStatus(status: string): string {
  const lower = normalizeName(status)
  return CANNY_STATUS_MAP[lower] ?? status
}

/** Resolve confidence for a Canny entity_type → UPG type mapping */
export function getConfidenceForCannyType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'post':
    case 'company':
      return 'high'
    default:
      return 'low'
  }
}

/** Check if an edge type is in the UPG catalogue; fall back to node_informs_node if not */
function safeEdgeType(
  candidate: string,
  fallbackWarning: string,
  warnings: string[],
): UPGEdgeType {
  const edgeSet = new Set(UPG_EDGE_TYPES)
  if (edgeSet.has(candidate as UPGEdgeType)) {
    return candidate as UPGEdgeType
  }
  warnings.push(fallbackWarning)
  return 'node_informs_node' as UPGEdgeType
}

// ─── Canny Adapter ────────────────────────────────────────────────────────────

export class CannyAdapter implements UPGAdapter {
  name = 'canny'
  label = 'Canny'
  description =
    'Import posts (as feature_request, vote counts preserved), companies (as account), and optional opportunity edges from Canny.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Canny adapter requires Canny API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedChangelogs = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `canny-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveCannyType(entityType)

      // Explicitly unmappable types
      if (resolved === null) {
        if (entityType === 'board') {
          warnings.push(
            `Canny Board "${item.title}" skipped: category container with no UPG entity equivalent. Board name added as a tag on child posts.`,
          )
        } else if (entityType === 'changelog') {
          skippedChangelogs++
        } else if (entityType === 'comment' || entityType === 'user' || entityType === 'vote' || entityType === 'tag') {
          // Silent skip: these are operational/metadata entities
        } else {
          warnings.push(
            `Canny entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Canny entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getConfidenceForCannyType(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Status normalisation ───────────────────────────────────────────────
      const rawStatus = (meta.status as string | undefined) ?? ''
      const status = rawStatus ? normalizeCannyStatus(rawStatus) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Add board_name as a tag if present
      const boardName = meta.board_name as string | undefined
      if (boardName) {
        tags.push(boardName)
      }

      // ── Build the UPG node ─────────────────────────────────────────────────
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
        external_tool: 'canny',
        external_id: item.source_id,
        // Preserve vote_count on feature_request nodes
        ...(upgEntityType === 'feature_request' && meta.vote_count !== undefined
          ? { vote_count: meta.vote_count as number }
          : {}),
      }

      nodes.push(node)
    }

    // Aggregate changelog warning
    if (skippedChangelogs > 0) {
      warnings.push(
        `${skippedChangelogs} Canny Changelog${skippedChangelogs > 1 ? 's' : ''} skipped: UPG's changelog entity is release-level. Consider importing as releases.`,
      )
    }

    // ── Pass 2: emit hierarchy edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Canny entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve the UPG entity type for the current item
      const resolved = resolveCannyType(entityType)
      if (!resolved) continue

      const upgEntityType = resolved

      // Determine edge type based on parent entity type
      const parentItem = items.find((i) => i.source_id === parentId)
      if (!parentItem) continue

      const parentEntityType = (parentItem.metadata?.entity_type as string | undefined) ?? ''
      const parentResolved = resolveCannyType(parentEntityType)

      let edgeType: UPGEdgeType | null = null

      if (upgEntityType === 'feature_request') {
        if (parentResolved === 'opportunity' || parentEntityType === 'opportunity') {
          edgeType = safeEdgeType(
            'feature_request_creates_opportunity',
            `Canny: feature_request_creates_opportunity not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        }
      }

      if (edgeType === null) {
        edges.push({
          id: `edge-canny-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-canny-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedChangelogs === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
