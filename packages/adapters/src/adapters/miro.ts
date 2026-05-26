/**
 * Miro Adapter
 *
 * Imports items from Miro: the visual whiteboard platform used for affinity
 * mapping, workshops, wireframing, and retrospectives.
 *
 * Miro boards are unstructured by default. Entity type is inferred from:
 * 1. The frame label the item is contained within (highest priority for sticky notes)
 * 2. The item's own type (sticky_note, card, etc.)
 *
 *
 * Critical behaviors:
 * - When frame_label matches MIRO_FRAME_TYPE_MAP, that overrides the default type
 *   for all sticky notes within that frame
 * - Miro connectors cannot be auto-mapped to typed UPG edges: they are skipped
 *   with a count-based warning
 * - Items without a recognised frame label default to 'observation' with a warning
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Frame labels → entity type for all sticky notes within the frame.
 * Keys are lowercase for matching; values are UPG entity types or null to skip.
 */
export const MIRO_FRAME_TYPE_MAP: Record<string, string | null> = {
  outcomes: 'outcome',
  opportunities: 'opportunity',
  solutions: 'solution',
  hypotheses: 'hypothesis_claim',
  assumptions: 'assumption',
  insights: 'insight',
  observations: 'observation',
  personas: 'persona',
  competitors: 'competitor',
  features: 'feature',
  jobs: 'job',
  needs: 'need',
  risks: null, // skip risk items
  'parking lot': null, // skip parking lot items
}

/**
 * Miro item entity types → UPG entity types.
 * Used when no matching frame label is present.
 * Null = skip (connector, text, image, etc.)
 */
export const MIRO_ENTITY_TYPE_MAP: Record<string, string | null> = {
  sticky_note: 'observation', // default for sticky notes without a matching frame label
  card: 'task', // Miro card (with title + description)
  frame: null, // frame itself is a container: skip, but use label to type its children
  shape: null, // generic shape: skip unless it has text
  connector: null, // visual connector: edges must be inferred from context
  text: null, // free text: skip
  image: null, // skip
  mindmap_node: 'observation',
  app_card: null, // embedded external content: skip (already in source tool)
  embed: null, // embedded external content: skip
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Resolve the UPG type for a Miro item.
 *
 * Priority:
 * 1. If entity_type is 'sticky_note' and frame_label matches MIRO_FRAME_TYPE_MAP → use frame type
 * 2. Otherwise use MIRO_ENTITY_TYPE_MAP
 */
export function resolveMiroType(
  entityType: string,
  frameLabel: string | undefined,
): string | null | undefined {
  const lower = normalizeName(entityType)

  // Frame-label override for sticky notes and mindmap nodes
  if ((lower === 'sticky_note' || lower === 'mindmap_node') && frameLabel) {
    const frameLower = normalizeName(frameLabel)
    // Check for exact or prefix match
    for (const [key, type] of Object.entries(MIRO_FRAME_TYPE_MAP)) {
      if (frameLower === key || frameLower.startsWith(key)) {
        return type // may be null (skip) or a type string
      }
    }
    // No matching frame label: default remains 'observation' for sticky notes
    return 'observation'
  }

  // Entity type map lookup
  if (lower in MIRO_ENTITY_TYPE_MAP) {
    return MIRO_ENTITY_TYPE_MAP[lower]
  }

  return undefined
}

// ─── Miro Adapter ─────────────────────────────────────────────────────────────

export class MiroAdapter implements UPGAdapter {
  name = 'miro'
  label = 'Miro'
  description =
    'Import sticky notes, cards, and frames from Miro whiteboards into the UPG research and design domains.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Miro adapter requires Miro API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedConnectors = 0
    let unmatchedFrameLabel = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `miro-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const frameLabel = (meta.frame_label as string | undefined) ?? undefined

      // Count connectors separately
      if (normalizeName(entityType) === 'connector') {
        skippedConnectors++
        continue
      }

      const resolved = resolveMiroType(entityType, frameLabel)

      // Explicitly null (skip) types
      if (resolved === null) {
        warnings.push(
          `Miro item "${item.title}" has entity_type "${entityType}" which has no UPG equivalent. Item skipped.`,
        )
        continue
      }

      // Unknown type
      let upgType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Miro item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "observation". Update the adapter if this type should be mapped.`,
        )
        upgType = 'observation'
        mappingConfidence = 'low'
      } else {
        upgType = resolved
        // Track items without a recognized frame label that defaulted
        const lower = normalizeName(entityType)
        if (
          (lower === 'sticky_note' || lower === 'mindmap_node') &&
          frameLabel &&
          resolved === 'observation'
        ) {
          // Check if this was a default (no match) vs explicit frame match
          const frameLower = normalizeName(frameLabel)
          const hasExplicitMatch = Object.keys(MIRO_FRAME_TYPE_MAP).some(
            (k) => frameLower === k || frameLower.startsWith(k),
          )
          if (!hasExplicitMatch) {
            unmatchedFrameLabel++
          }
        } else if ((lower === 'sticky_note' || lower === 'mindmap_node') && !frameLabel) {
          unmatchedFrameLabel++
        }
        mappingConfidence = upgType === 'observation' ? 'medium' : 'high'
      }

      sourceMap[item.source_id] = nodeId

      // Miro has no status: omit
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Include color as a tag (e.g. sticky note color as a theme signal)
      if (meta.color && typeof meta.color === 'string') {
        tags.push(`color:${meta.color}`)
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'miro',
        external_id: item.source_id,
      }

      nodes.push(node)
    }

    // Emit connector warning once
    if (skippedConnectors > 0) {
      warnings.push(
        `${skippedConnectors} connector${skippedConnectors === 1 ? '' : 's'} (Miro arrows between stickies) ` +
          `${skippedConnectors === 1 ? 'was' : 'were'} skipped. Connectors require manual review to map to typed UPG edges. ` +
          `Add edges manually based on the relationships you drew.`,
      )
    }

    // Emit frame label warning once
    if (unmatchedFrameLabel > 0) {
      warnings.push(
        `${unmatchedFrameLabel} Miro item${unmatchedFrameLabel === 1 ? '' : 's'} without a ` +
          `recognized frame label were mapped to 'observation' by default. Add frame labels ` +
          `matching UPG entity types (e.g. 'Opportunities', 'Insights', 'Solutions') for more accurate mapping.`,
      )
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Miro item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Parent–child relationship: sticky note in a frame → research_study_clusters_into_affinity_cluster
      // Default: emit node_informs_node (Miro structure is heuristic)
      edges.push({
        id: `edge-miro-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: 'node_informs_node' as UPGEdgeType,
        mapping_confidence: 'low',
      })
    }

    if (nodes.length === 0 && skippedConnectors === 0) {
      warnings.push('No Miro items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
