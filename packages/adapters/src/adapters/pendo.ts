/**
 * Pendo Adapter
 *
 * Imports entities from Pendo: the product analytics + in-app guidance platform.
 *
 * What sets Pendo apart: it tracks named Feature entities. A Pendo `Feature` is a
 * tagged UI element that Pendo measures adoption for. This creates a direct UPG
 * `feature` mapping with adoption data intact.
 *
 * Amplitude, PostHog, and Mixpanel track events rather than named features. The
 * Pendo-to-UPG path therefore carries adoption data straight through to outcome
 * metrics.
 *
 *
 * Edges:
 * - product/app → screen:         product_contains_screen (if in catalog, else node_informs_node)
 * - feedback → opportunity:       feature_request_creates_opportunity
 * - feature → outcome (parent):   outcome_delivered_by_feature
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Pendo entity types to UPG entity types.
 *
 * Null = no UPG equivalent, skip with warning.
 * All UPG entity types verified against the live catalog.
 */
export const PENDO_TYPE_MAP: Record<string, string | null> = {
  feature: 'feature', // DIRECT MATCH: Pendo Feature = product feature adoption entity
  page: 'screen', // a tracked page/screen in the product
  nps_response: 'customer_feedback',
  feedback: 'feature_request', // Pendo Feedback = feature request
  guide: null, // in-app guidance/tooltip: not product knowledge
  portfolio: 'product', // portfolio = the product being tracked
  segment: 'market_segment', // named user segment
  event: null, // behavioral event: skip with warning
  path: null, // usage path analysis: skip
  report: null, // analytics report: skip
  app: 'product', // Pendo app = product
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Pendo status values to UPG status values.
 */
export const PENDO_STATUS_MAP: Record<string, string> = {
  active: 'active',
  inactive: 'abandoned',
  draft: 'draft',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Pendo entity type to a UPG entity type */
export function resolvePendoType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in PENDO_TYPE_MAP) {
    return PENDO_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Pendo status string to a UPG status value */
export function normalizePendoStatus(status: string): string {
  const lower = normalizeName(status)
  return PENDO_STATUS_MAP[lower] ?? status
}

/** Resolve mapping confidence for a Pendo entity type */
export function getPendoConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'feature': // direct match: uniquely strong
    case 'nps_response':
    case 'feedback':
    case 'app':
    case 'portfolio':
      return 'high'
    case 'page':
    case 'segment':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Pendo Adapter ────────────────────────────────────────────────────────────

export class PendoAdapter implements UPGAdapter {
  name = 'pendo'
  label = 'Pendo'
  description =
    'Import Feature (adoption), Page/Screen, NPS Response, Feedback (feature request), Segment, and App/Portfolio entities from Pendo.'

  /**
   * List available Pendo entities.
   *
   * Requires Pendo integration key or API access. Pre-fetched items
   * may be passed via config.items when API access is not available.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Pendo adapter requires Pendo API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Pendo source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via PENDO_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status
   * - metadata.adoption_rate → preserved on feature nodes
   * - metadata.avg_time_on_page → preserved as a tag on screen nodes
   * - metadata.tags → node tags
   * - Pendo Feature → UPG `feature` with adoption data note (unique in analytics tools)
   * - Behavioral events, paths, reports → skipped with warning
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
      const nodeId = `pendo-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ──────────────────────────────────────────────
      const resolved = resolvePendoType(entityType)

      // Explicitly unmappable types (guide, event, path, report): skip
      if (resolved === null) {
        const skipReason =
          entityType === 'event'
            ? 'behavioral events are analytics signals, not product knowledge entities'
            : entityType === 'guide'
              ? 'in-app guides are delivery mechanisms, not product knowledge'
              : 'analytics computation artifacts are not product knowledge'
        warnings.push(
          `Pendo entity "${item.title}" has type "${entityType}" which has no UPG equivalent ` +
            `(${skipReason}). Entity skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Pendo entity "${item.title}" has unknown type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getPendoConfidence(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Feature adoption note: the unique Pendo differentiator ─────────
      if (entityType === 'feature' && meta.adoption_rate !== undefined) {
        warnings.push(
          `Pendo Feature "${item.title}" has adoption data. ` +
            `Pendo is the only analytics tool with first-class feature entities. ` +
            `This makes Pendo→UPG traceability uniquely complete: ` +
            `feature adoption connects directly to outcome metrics.`,
        )
      }

      // ── Normalise status ─────────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizePendoStatus(rawStatus) : undefined

      // ── Tags ─────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve avg_time_on_page as a tag for screen nodes
      if (upgEntityType === 'screen' && meta.avg_time_on_page !== undefined) {
        tags.push(`avg_time_on_page:${meta.avg_time_on_page as number}s`)
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
        external_tool: 'pendo',
        external_id: item.source_id,
        // Feature adoption data: unique to Pendo
        ...(upgEntityType === 'feature' && meta.adoption_rate !== undefined
          ? { adoption_rate: meta.adoption_rate as number }
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
          `Pendo entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeResult = resolvePendoEdge(parentType, entityType, item.title, warnings)

      if (edgeResult === null) {
        // Unrecognised pair: emit generic informational edge with low confidence
        edges.push({
          id: `edge-pendo-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-pendo-${parentNodeId}-${nodeId}`,
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
 * Resolve the canonical UPG edge for a Pendo parent_type → entity_type pair.
 *
 * Returns a UPG edge type string, or null for unrecognised pairs
 * (caller emits node_informs_node fallback).
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolvePendoEdge(
  parentType: string,
  childType: string,
  _itemTitle: string,
  _warnings: string[],
): string | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // portfolio/app (product) → page (screen): product_contains_screen
  if ((parent === 'portfolio' || parent === 'app') && child === 'page') {
    return 'product_contains_screen'
  }

  // feedback (feature_request) → opportunity: feature_request_creates_opportunity
  // feature_request_creates_opportunity: source=feature_request, target=opportunity
  if (parent === 'feedback' && child === 'opportunity') {
    return 'feature_request_creates_opportunity'
  }

  // feature → outcome (when feature is a child of an outcome parent):
  // outcome_delivered_by_feature: source=outcome, target=feature
  // Since the parent is outcome and child is feature in Pendo hierarchy,
  // we emit this edge correctly.
  if (parent === 'outcome' && child === 'feature') {
    return 'outcome_delivered_by_feature'
  }

  // page (screen) → feature: screen_surfaces_feature
  // screen_surfaces_feature: source=screen, target=feature
  if (parent === 'page' && child === 'feature') {
    return 'screen_surfaces_feature'
  }

  return null
}
