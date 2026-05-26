/**
 * Maze Adapter
 *
 * Imports research studies, participants, test plans, observations, and
 * insights from Maze: the unmoderated user testing platform.
 *
 * Maze's unique value: it sits at the intersection of UPG's user_research and
 * validation domains. The `prototype_tests_hypothesis` edge: one of the few
 * tools with an explicit prototype→hypothesis link: is the anchor edge.
 *
 *
 * Key edges (all verified in UPG catalog):
 * - prototype_tests_hypothesis: prototype → hypothesis
 * - research_study_produces_insight: research_study → insight
 * - research_study_enrolls_participant: research_study → participant
 * - research_study_captures_observation: research_study → observation
 * - observation_evidenced_by_quote: observation → quote (for clips)
 *
 * IMPORTANT: insight_informs_opportunity is NEVER auto-emitted.
 * It always emits a warning asking the PM to create the link manually.
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Maps Maze entity types to UPG entity types.
 * Null = skip (clips, heatmaps: behavioral data, not entities).
 */
export const MAZE_TYPE_MAP: Record<string, string | null> = {
  maze: 'research_study', // a Maze study/project
  study: 'research_study',
  mission: 'test_plan', // a test mission/task within a maze: verified in catalog
  block: 'test_plan', // a block/task within the maze
  tester: 'participant', // study participant
  clip: null, // video clip: skip (behavioral data)
  heatmap: null, // skip
  result: 'observation', // a test result/answer
  insight: 'insight', // a synthesized maze insight
  prototype: 'prototype', // the prototype being tested: verified in catalog
}

/**
 * Maps Maze status values to UPG status values.
 */
export const MAZE_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  running: 'active',
  complete: 'complete',
  closed: 'complete',
  archived: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

export function normalizeMazeStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  const lower = normalizeName(status)
  return MAZE_STATUS_MAP[lower] ?? status
}

export function getConfidenceForMazeType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'maze':
    case 'study':
    case 'tester':
    case 'insight':
      return 'high'
    case 'mission':
    case 'block':
    case 'prototype':
    case 'result':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Maze Adapter ─────────────────────────────────────────────────────────────

export class MazeAdapter implements UPGAdapter {
  name = 'maze'
  label = 'Maze'
  description =
    'Import user research studies, test plans, participants, observations, and insights from Maze (an unmoderated usability testing platform).'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Maze adapter requires Maze API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `maze-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = MAZE_TYPE_MAP[normalizeName(entityType)]

      // Explicitly null types
      if (resolved === null) {
        warnings.push(
          `Maze item "${item.title}" has entity_type "${entityType}" which is behavioral data ` +
            `(not a knowledge entity). Item skipped.`,
        )
        continue
      }

      // Unknown type
      let upgType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Maze item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "observation". Update the adapter if this type should be mapped.`,
        )
        upgType = 'observation'
        mappingConfidence = 'low'
      } else {
        upgType = resolved
        mappingConfidence = getConfidenceForMazeType(entityType)
      }

      sourceMap[item.source_id] = nodeId

      const rawStatus = meta.status as string | undefined
      const status = normalizeMazeStatus(rawStatus)

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'maze',
        external_id: item.source_id,
        ...(meta.prototype_url
          ? { prototype_url: meta.prototype_url as string }
          : {}),
        ...(meta.task_success_rate !== undefined
          ? { task_success_rate: meta.task_success_rate as number }
          : {}),
        ...(meta.completion_rate !== undefined
          ? { completion_rate: meta.completion_rate as number }
          : {}),
      }

      nodes.push(node)

      // Insight nodes always get the warning about manual PM linking
      if (upgType === 'insight') {
        warnings.push(
          `Maze Insight "${item.title}" captured as an insight node. Link it to an opportunity ` +
            `node to complete the research-to-product chain (insight_informs_opportunity requires PM judgment).`,
        )
      }
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const upgType = MAZE_TYPE_MAP[normalizeName(entityType)]

      // Emit prototype_tests_hypothesis warning for prototype nodes
      // (the actual edge requires a hypothesis node in the graph: PM must create it)
      if (upgType === 'prototype' && meta.prototype_url) {
        warnings.push(
          `Maze prototype "${item.title}" has a prototype_url. ` +
            `To complete the validation chain, link this prototype node to a hypothesis node ` +
            `via prototype_tests_hypothesis. This edge requires PM judgment about which ` +
            `hypothesis the prototype was designed to test.`,
        )
      }

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Maze item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve edge based on parent_type + entity_type pair
      const edgeType = resolveMazeEdge(parentType, entityType)

      edges.push({
        id: `edge-maze-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType as UPGEdgeType,
        mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'high',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No Maze items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the UPG edge for a Maze parent_type → entity_type pair.
 * All returned edge types are verified against the UPG catalog.
 */
function resolveMazeEdge(parentType: string, childType: string): string {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // research_study → participant
  if ((parent === 'maze' || parent === 'study') && child === 'tester') {
    return 'research_study_enrolls_participant'
  }

  // research_study → observation (block result)
  if ((parent === 'maze' || parent === 'study') && (child === 'result' || child === 'block')) {
    return 'research_study_captures_observation'
  }

  // research_study → insight
  if ((parent === 'maze' || parent === 'study') && child === 'insight') {
    return 'research_study_produces_insight'
  }

  // research_study → test_plan (mission/block)
  if ((parent === 'maze' || parent === 'study') && (child === 'mission' || child === 'block')) {
    return 'research_study_captures_observation'
  }

  // observation → quote (clip)
  if (parent === 'result' && child === 'clip') {
    return 'observation_evidenced_by_quote'
  }

  // prototype → hypothesis (prototype_tests_hypothesis)
  // Note: this edge is NOT auto-emitted from parent/child: it requires PM judgment.
  // If explicitly provided, emit it.
  if (parent === 'hypothesis' && child === 'prototype') {
    return 'prototype_tests_hypothesis'
  }

  // Fallback
  return 'node_informs_node'
}
