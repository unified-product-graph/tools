/**
 * Storybook Adapter
 *
 * Imports design system entities from Storybook: a component development
 * environment and documentation tool. Components and stories both map to
 * design_component; documentation pages map to document.
 *
 * Storybook's UPG story sits in the Design System region:
 * - component   → design_component (the reusable UI building block)
 * - story       → design_component (a documented variant of a component)
 * - docs_page   → document         (design system documentation)
 *
 *
 * Edges emitted:
 * - node_informs_node  (story → component: no specific story→component variant edge in catalog)
 *
 * Skipped with warnings:
 * - addon        : platform plugin, not product knowledge
 * - arg_type     : component API property metadata, skip
 * - decorator    : HOC wrapper for test context, skip
 * - play_function: interaction test definition, skip
 *
 * Note on status: Storybook entities don't have a meaningful status field :
 * a component exists (published) or doesn't (draft in development). The adapter
 * omits status rather than guessing.
 */

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Storybook entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 * Note: 'design_component' is confirmed in the entity catalog.
 */
export const STORYBOOK_TYPE_MAP: Record<string, string | null> = {
  component: 'design_component',  // a UI component: the reusable building block
  story: 'design_component',      // a story IS a component variant: same entity type
  docs_page: 'document',          // documentation page
  addon: null,                     // skip: platform plugin
  arg_type: null,                  // component API property: metadata, skip
  decorator: null,                 // HOC wrapper: skip
  play_function: null,             // interaction test: skip
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Storybook entity_type to a UPG entity type */
export function resolveStorybookType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in STORYBOOK_TYPE_MAP) {
    return STORYBOOK_TYPE_MAP[lower]
  }
  return undefined
}

/** Resolve mapping confidence for a Storybook entity type */
export function getStorybookConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'component':
    case 'docs_page':
      return 'high'
    case 'story':
      return 'high' // stories are well-defined documented variants
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

// ─── Storybook Adapter ────────────────────────────────────────────────────────

export class StorybookAdapter implements UPGAdapter {
  name = 'storybook'
  label = 'Storybook'
  description =
    'Import components and stories (as design_component) and documentation pages (as document) from Storybook. Stories link to their parent components via node_informs_node edges.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would read from the Storybook stories index:
    //   GET http://localhost:6006/stories.json  (or /index.json for Storybook 7+)
    //
    // The skill layer passes pre-fetched data via config.items when the
    // Storybook dev server is not directly accessible.
    throw new Error(
      'Storybook adapter requires access to a running Storybook instance or a pre-exported stories.json. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Storybook source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type "component"    → design_component (the reusable UI building block)
   * - entity_type "story"        → design_component (documented variant; linked to parent component
   *                                via node_informs_node edge when component_id is present)
   * - entity_type "docs_page"    → document (design system documentation page)
   * - entity_type "addon"        → SKIPPED (platform plugin, not product knowledge)
   * - entity_type "arg_type"     → SKIPPED (component API metadata)
   * - entity_type "decorator"    → SKIPPED (HOC wrapper, not product knowledge)
   * - entity_type "play_function"→ SKIPPED (interaction test definition)
   *
   * Status is not applicable to Storybook entities: omitted from all nodes.
   *
   * Warning emitted once: stories map to design_component and should be linked
   * to the UPG features they implement (design_component_implements_feature edge).
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedPlatform = 0
    let emittedStoryWarning = false

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `storybook-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveStorybookType(entityType)

      // Explicitly unmappable types: skip
      if (resolved === null) {
        // Platform / metadata types: batch count
        if (
          entityType === 'addon' ||
          entityType === 'arg_type' ||
          entityType === 'decorator' ||
          entityType === 'play_function'
        ) {
          skippedPlatform++
        } else {
          warnings.push(
            `Storybook entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Storybook entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getStorybookConfidence(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Story/component warning (emitted once for the batch) ───────────────
      if ((entityType === 'story' || entityType === 'component') && !emittedStoryWarning) {
        warnings.push(
          `Storybook stories map to design_component nodes. Each story represents a documented ` +
            `variant of a component. For richer component traceability, link these nodes to the ` +
            `UPG features they implement.`,
        )
        emittedStoryWarning = true
      }

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve story_kind as a tag for context
      const storyKind = meta.story_kind as string | undefined
      if (storyKind) {
        tags.push(`story_kind:${storyKind}`)
      }

      // ── Build the UPG node ─────────────────────────────────────────────────
      // Note: status is intentionally omitted: Storybook entities have no meaningful status
      const node: UPGBaseNode = {
        id: nodeId,
        type: upgEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'storybook',
        external_id: item.source_id,
      }

      nodes.push(node)
    }

    // Aggregate warning for skipped platform entities
    if (skippedPlatform > 0) {
      warnings.push(
        `${skippedPlatform} Storybook platform entit${skippedPlatform > 1 ? 'ies' : 'y'} skipped (addons, arg_types, decorators, play functions). Storybook platform infrastructure has no UPG product knowledge equivalent.`,
      )
    }

    // ── Pass 2: emit story → component edges (sourceMap is now complete) ──────
    //
    // When a story has a component_id, emit an edge from the story node to the
    // component node. Both are design_component: the story is a variant.
    //
    // UPG catalog note: there is no specific story→component variant edge.
    // node_informs_node is the canonical fallback here, as documented in the
    // storybook-mapping.md reference.
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const componentId = meta.component_id as string | undefined
      const parentId = meta.parent_id as string | undefined

      // Only process story entities that reference a parent component
      if (entityType !== 'story') continue

      // Skip stories that were not registered
      const storyNodeId = sourceMap[item.source_id]
      if (!storyNodeId) continue

      // Prefer component_id; fall back to parent_id
      const targetId = componentId ?? parentId
      if (!targetId) continue

      const componentNodeId = sourceMap[targetId]
      if (!componentNodeId) {
        warnings.push(
          `Storybook story "${item.title}" references component_id "${targetId}" which was not found ` +
            `in the imported set. Story→component edge skipped.`,
        )
        continue
      }

      // node_informs_node: story informs its parent component
      // No specific story→component edge exists in the UPG catalog.
      const edgeType = safeEdgeType(
        'node_informs_node',
        `Storybook: unexpected. node_informs_node not in catalog for "${item.title}".`,
        warnings,
      )

      edges.push({
        id: `edge-storybook-story-${storyNodeId}-${componentNodeId}`,
        source: storyNodeId,
        target: componentNodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedPlatform === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
