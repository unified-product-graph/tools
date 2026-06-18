/**
 * Figma Adapter
 *
 * Imports design artifacts from Figma: the design layer of the product stack.
 * Figma files contain screens, components, and design tokens. This adapter
 * creates anchors in the UPG design domain that PMs and researchers can then
 * connect to the product knowledge graph (features, opportunities, outcomes).
 *
 *
 * Key hierarchy edges:
 * - product_contains_screen: product → screen (file contains frame)
 * - screen_surfaces_feature: screen → feature (cross-domain, requires PM input)
 *
 * Note: `feature_expressed_by_screen` is NOT in the UPG edge catalog.
 * Falls back to `node_informs_node` with low confidence + warning for unknown
 * parent/child pairs.
 *
 * Variables and Styles are skipped: design tokens are properties, not
 * knowledge entities at the UPG level. A warning is emitted with a count.
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { getLifecycleForType, UPG_EDGE_PAIR_MAP } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Maps Figma entity types to UPG entity types.
 *
 * Null values are explicitly skipped with warnings.
 * `feature_expressed_by_screen` is NOT in the UPG catalog: use
 * `product_contains_screen` (product→screen) or `screen_surfaces_feature`
 * (screen→feature) instead.
 */
export const FIGMA_TYPE_MAP: Record<string, string | null> = {
  file: 'document', // a Figma file = a design document
  frame: 'screen', // a top-level frame = a product screen
  component: 'design_component', // a Figma component: verified in catalog
  component_set: 'design_component', // component set (variants): same UPG type
  variable: null, // design token: skip (metadata only, no UPG entity)
  style: null, // design style: skip
  page: null, // Figma page = structural container within a file, skip
  prototype: 'prototype', // prototype flow: verified in catalog
  section: null, // section within a file: skip
  branch: null, // version control branch: skip
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Figma entity type to a UPG entity type */
export function resolveFigmaType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in FIGMA_TYPE_MAP) {
    return FIGMA_TYPE_MAP[lower]
  }
  return undefined
}

/** Confidence for a Figma entity type mapping */
export function getConfidenceForFigmaType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'frame':
    case 'component':
    case 'component_set':
      return 'high'
    case 'file':
    case 'prototype':
      return 'medium'
    default:
      return 'low'
  }
}

/** Map Figma status to a candidate UPG status (pre-lifecycle-validation).
 *  `archived` → `deprecated` (a real phase for screen/design_component). `active`
 *  has no clean UPG target across the design lifecycles, so it is dropped. */
export function normalizeFigmaStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  const lower = normalizeName(status)
  if (lower === 'archived') return 'deprecated'
  return undefined
}

/** Valid status values for a UPG entity type, or null when lifecycle-free. */
function validStatusesForType(type: string): ReadonlySet<string> | null {
  const lc = getLifecycleForType(type)
  if (!lc) return null
  const set = new Set<string>()
  for (const p of lc.phases) {
    set.add(p.id)
    for (const s of p.core_states ?? []) set.add(s.id)
  }
  return set
}

/** Resolve a Figma status to one valid for the target type's lifecycle (omit otherwise). */
function resolveFigmaStatusForType(rawStatus: string | undefined, upgType: string): string | undefined {
  const mapped = normalizeFigmaStatus(rawStatus)
  if (!mapped) return undefined
  const valid = validStatusesForType(upgType)
  return valid && valid.has(mapped) ? mapped : undefined
}

/**
 * Resolve the canonical UPG edge for a parent UPG type → child UPG type pair via
 * the catalogue, honouring direction. Returns the edge type + whether the child
 * is the source, or null when no canonical edge exists.
 */
function resolvePairEdge(parentUpg: string, childUpg: string): { type: string; sourceIsChild: boolean } | null {
  const fwd = UPG_EDGE_PAIR_MAP[`${parentUpg}:${childUpg}`]
  if (fwd && fwd.length > 0) return { type: fwd[0], sourceIsChild: false }
  const rev = UPG_EDGE_PAIR_MAP[`${childUpg}:${parentUpg}`]
  if (rev && rev.length > 0) return { type: rev[0], sourceIsChild: true }
  return null
}

// ─── Figma Adapter ────────────────────────────────────────────────────────────

export class FigmaAdapter implements UPGAdapter {
  name = 'figma'
  label = 'Figma'
  description =
    'Import screens, components, and design documents from Figma into the UPG design domain.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Figma adapter requires Figma API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedVariables = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `figma-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // Count skipped design tokens for summary warning
      if (entityType === 'variable' || entityType === 'style') {
        skippedVariables++
        continue
      }

      const resolved = resolveFigmaType(entityType)

      // Explicitly unmappable types
      if (resolved === null) {
        warnings.push(
          `Figma item "${item.title}" has entity_type "${entityType}" which is a structural ` +
            `container with no UPG equivalent. Item skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let upgType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Figma item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgType = 'document'
        mappingConfidence = 'low'
      } else {
        upgType = resolved
        mappingConfidence = getConfidenceForFigmaType(entityType)
      }

      // Register before any continue paths
      sourceMap[item.source_id] = nodeId

      const rawStatus = meta.status as string | undefined
      const status = resolveFigmaStatusForType(rawStatus, upgType)

      // Figma-specific identifiers belong under properties (canonical), not as
      // top-level node fields, so they survive the .upg round-trip.
      const figmaProps: Record<string, unknown> = {}
      if (meta.file_key) figmaProps.file_key = meta.file_key as string
      if (meta.node_id) figmaProps.node_id = meta.node_id as string
      if (meta.thumbnail_url) figmaProps.thumbnail_url = meta.thumbnail_url as string

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(meta.component_description
          ? { description: (meta.component_description as string) }
          : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'figma',
        external_id: item.source_id,
        ...(Object.keys(figmaProps).length > 0 ? { properties: figmaProps } : {}),
      }

      nodes.push(node)
    }

    // Emit design token skip warning once with count
    if (skippedVariables > 0) {
      warnings.push(
        `${skippedVariables} variable${skippedVariables === 1 ? '' : 's'} skipped. ` +
          `Figma Variables/Tokens map to properties on entity nodes, separate from knowledge entities themselves.`,
      )
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
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
          `Figma item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Catalogue-driven: resolve the parent/child UPG-type pair to its canonical
      // edge (correct type + direction), or fall back to a generic link. This
      // fixes file→frame / file→component, which previously emitted
      // product_contains_screen / design_system_contains_design_component from a
      // `document` node (a Figma file maps to document, not product/design_system).
      const childUpg = (resolveFigmaType(entityType) as string | null | undefined) ?? 'document'
      const parentUpg = (resolveFigmaType(parentType) as string | null | undefined) ?? 'document'
      const mapped = resolvePairEdge(parentUpg, childUpg)
      if (mapped) {
        const source = mapped.sourceIsChild ? nodeId : parentNodeId
        const target = mapped.sourceIsChild ? parentNodeId : nodeId
        edges.push({
          id: `edge-figma-${parentNodeId}-${nodeId}`,
          source,
          target,
          type: mapped.type as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      } else {
        edges.push({
          id: `edge-figma-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        warnings.push(
          `No canonical UPG edge for Figma ${parentType || 'parent'} -> ${entityType || 'child'} ` +
            `(${parentUpg} -> ${childUpg}); emitted node_informs_node.`,
        )
      }
    }

    if (nodes.length === 0 && skippedVariables === 0) {
      warnings.push('No Figma items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// Edge resolution is catalogue-driven via resolvePairEdge(): every emitted edge
// type and direction comes from UPG_EDGE_PAIR_MAP, with a node_informs_node
// fallback when no canonical edge exists for the (parent, child) UPG-type pair.
