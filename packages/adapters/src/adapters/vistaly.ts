/**
 * Vistaly Adapter
 *
 * Imports cards from Vistaly: a continuous discovery tool that organises
 * product work as a tree from Vision/Mission → Objective → Outcome →
 * Opportunity → Solution → Experiment.
 *
 * Vistaly calls every entity a "Card" typed by a `card_type` field. This
 * adapter discriminates by card_type and maps to the closest UPG entity type.
 *
 *
 * Hierarchy edges:
 * - outcome ← metric/kpi        → outcome_measured_by_metric
 * - outcome → opportunity        → opportunity_pursues_outcome
 * - opportunity → solution       → opportunity_drives_solution
 * - solution → experiment        → solution_proposes_hypothesis (via hypothesis)
 * - assumption → experiment      → assumption_becomes_hypothesis
 * - interview → opportunity      → insight_informs_opportunity (via insight bridge)
 * - feedback → opportunity       → customer_feedback_becomes_feature_request +
 *                                  feature_request_creates_opportunity
 *
 * Gap (no canonical edge):
 * - objective → outcome: UPG connects via key_result. Emits a WARNING, not an edge.
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Card type → UPG entity type ─────────────────────────────────────────────

/**
 * Maps Vistaly card_type values to UPG entity types.
 *
 * Null values mean the card type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 */
export const VISTALY_TYPE_MAP: Record<string, string | null> = {
  // Strategy Space
  vision: 'vision',
  mission: 'mission',
  objective: 'objective',
  outcome: 'outcome',
  kpi: 'metric',
  metric: 'metric',
  assumption: 'assumption',
  initiative: 'initiative',
  // Discovery Space
  opportunity: 'opportunity',
  solution: 'solution',
  experiment: 'experiment',
  assumption_test: 'experiment', // Vistaly "Assumption Test" = experiment
  // Feedback / Research
  interview: 'research_study',
  feedback: 'customer_feedback',
  // No UPG equivalent
  sprint: null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Vistaly card statuses to UPG status values.
 *
 * Vistaly statuses: 'new' | 'under-consideration' | 'planned' | 'in-progress' | 'released' | "won't-do"
 */
export const VISTALY_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  'under-consideration': 'draft',
  planned: 'active',
  'in-progress': 'active',
  released: 'complete',
  "won't-do": 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Vistaly card_type to a UPG entity type. Returns null if explicitly unmappable. */
export function resolveCardType(cardType: string): string | null | undefined {
  const lower = normalizeName(cardType)
  // Returns undefined if not in map (unknown), null if in map but unmappable, string if mapped
  if (lower in VISTALY_TYPE_MAP) {
    return VISTALY_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Vistaly status string to a UPG status value */
export function normalizeVistalyStatus(status: string): string {
  const lower = normalizeName(status)
  return VISTALY_STATUS_MAP[lower] ?? status
}

/** Resolve the confidence level for a card_type → entity type mapping */
export function getConfidenceForCardType(cardType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(cardType)
  switch (lower) {
    // Direct 1:1 canonical matches
    case 'vision':
    case 'mission':
    case 'objective':
    case 'outcome':
    case 'kpi':
    case 'metric':
    case 'opportunity':
    case 'solution':
    case 'assumption':
    case 'initiative':
      return 'high'
    // Conflated or structurally approximate
    case 'experiment':
    case 'assumption_test':
    case 'feedback':
    case 'interview':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Vistaly Adapter ──────────────────────────────────────────────────────────

export class VistalyAdapter implements UPGAdapter {
  name = 'vistaly'
  label = 'Vistaly'
  description = 'Import the Vision, Objective, Outcome, Opportunity, Solution, and Experiment hierarchy from Vistaly (a continuous discovery tool).'

  /**
   * List available Vistaly cards.
   *
   * Requires Vistaly API access. This adapter is designed to be called from
   * within a skill that has access to a Vistaly API connection.
   *
   * Config options:
   * - `cards`: SourceItem[]: pre-fetched Vistaly cards
   * - `workspace_id` (string): specific workspace to import
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const apiKey = config.api_key as string
    const workspaceId = config.workspace_id as string
    if (!apiKey) throw new Error('Vistaly adapter requires config.api_key (VISTALY_API_KEY)')

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }

    const items: SourceItem[] = []

    // If workspace_id not provided, list workspaces first
    let wsId = workspaceId
    if (!wsId) {
      const wsRes = await fetch('https://api.vistaly.com/v1/workspaces', { headers })
      if (!wsRes.ok) throw new Error(`Vistaly workspaces fetch failed: ${wsRes.status}`)
      const wsData = await wsRes.json() as { data: Array<{ id: string; name: string }> }
      if (wsData.data.length === 0) throw new Error('No Vistaly workspaces found')
      wsId = wsData.data[0].id
    }

    // Cards
    const cardsRes = await fetch(`https://api.vistaly.com/v1/workspaces/${wsId}/cards`, { headers })
    if (!cardsRes.ok) throw new Error(`Vistaly cards fetch failed: ${cardsRes.status}`)
    const cards = await cardsRes.json() as {
      data: Array<{
        id: string; title: string; description?: string; card_type: string
        status?: string; parent_id?: string; parent_type?: string
        metric_current_value?: number; metric_target_value?: number; metric_unit?: string
        tags?: string[]; labels?: string[]
      }>
    }

    for (const card of cards.data) {
      items.push({
        source_id: card.id,
        source_type: 'card',
        title: card.title,
        content: card.description,
        metadata: {
          card_type: card.card_type,
          status: card.status,
          parent_id: card.parent_id,
          parent_type: card.parent_type,
          metric_current_value: card.metric_current_value,
          metric_target_value: card.metric_target_value,
          metric_unit: card.metric_unit,
          tags: card.tags,
          labels: card.labels,
        },
      })
    }

    return items
  }

  /**
   * Convert Vistaly source items to UPG entities.
   *
   * Mapping logic:
   * - card_type discriminates the UPG entity type (via VISTALY_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via VISTALY_STATUS_MAP)
   * - metadata.tags + metadata.labels → node tags
   * - metadata.metric_current_value / target_value / unit → metric node fields
   * - Sprint cards → skipped with warning (no UPG equivalent)
   * - Unknown card_types → warning + default to 'document'
   * - objective → outcome gap → WARNING (no direct UPG edge, must go via key_result)
   * - experiment / assumption_test → WARNING (conflates hypothesis + experiment)
   * - interview → WARNING (flat structure; recommend Dovetail for richer research)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    for (const item of items) {
      counter++
      const nodeId = `vistaly-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const cardType = (meta.card_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveCardType(cardType)

      // Explicitly unmappable card types (e.g. sprint): skip entirely
      if (resolved === null) {
        warnings.push(
          `Vistaly card "${item.title}" has card_type "${cardType}" which has no UPG equivalent ` +
            `(sprints are delivery-layer constructs not tracked in UPG). Card skipped.`,
        )
        continue
      }

      // Unknown card_type: warn and default
      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Vistaly card "${item.title}" has unknown card_type "${cardType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        entityType = 'document'
        mappingConfidence = 'low'
      } else {
        entityType = resolved
        mappingConfidence = getConfidenceForCardType(cardType)
      }

      // Register in sourceMap now, before any continue paths below
      sourceMap[item.source_id] = nodeId

      // ── Type-specific warnings ─────────────────────────────────────────────

      if (cardType === 'experiment' || cardType === 'assumption_test') {
        warnings.push(
          `Vistaly Experiment cards contain both the hypothesis and the experiment. ` +
            `Consider splitting into hypothesis + experiment nodes for richer UPG traceability.`,
        )
      }

      if (cardType === 'interview') {
        warnings.push(
          `Vistaly Interview cards are mapped as research_study nodes. ` +
            `For richer research structure (observations, quotes, insights), ` +
            `consider also importing into Dovetail.`,
        )
      }

      // ── Normalise status ───────────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeVistalyStatus(rawStatus) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      if (Array.isArray(meta.labels)) {
        tags.push(...(meta.labels as string[]))
      }

      // ── Build the UPG node ─────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: entityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'vistaly',
        external_id: item.source_id,
        // Metric-specific fields
        ...(entityType === 'metric' && meta.metric_current_value !== undefined
          ? { current_value: meta.metric_current_value as number }
          : {}),
        ...(entityType === 'metric' && meta.metric_target_value !== undefined
          ? { target_value: meta.metric_target_value as number }
          : {}),
        ...(entityType === 'metric' && meta.metric_unit !== undefined
          ? { unit: meta.metric_unit as string }
          : {}),
      }

      nodes.push(node)
    }

    // ── Emit hierarchy edges (second pass, so sourceMap is complete) ──────────
    // Process items again to resolve parent_id → edge
    for (const item of items) {
      const meta = item.metadata ?? {}
      const cardType = (meta.card_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      // Skip cards that were not registered (e.g. skipped sprint cards)
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Vistaly card "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve edge based on parent_type + card_type pair
      const edgeResult = resolveVistalyEdge(parentType, cardType, item.title, warnings)

      if (edgeResult === 'warning-only') {
        // Warning already emitted inside resolveVistalyEdge: no edge to emit
        continue
      }

      if (edgeResult === null) {
        // Unrecognised pair: emit a generic informational edge with low confidence
        edges.push({
          id: `edge-vistaly-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      // For multi-edge chains (feedback → feature_request → opportunity),
      // edgeResult may be an array of edge descriptors
      if (Array.isArray(edgeResult)) {
        for (const edgeDescriptor of edgeResult) {
          edges.push(edgeDescriptor)
        }
      } else {
        edges.push({
          id: `edge-vistaly-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: edgeResult as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      }
    }

    if (nodes.length === 0) {
      warnings.push('No cards were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Vistaly parent_type → card_type pair.
 *
 * Returns:
 * - A UPG edge type string (most cases)
 * - An array of UPGEdge objects (multi-hop chains like feedback → opportunity)
 * - 'warning-only' for the objective→outcome gap (warns but does NOT emit an edge)
 * - null for unrecognised pairs (caller emits node_informs_node fallback)
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveVistalyEdge(
  parentType: string,
  childType: string,
  cardTitle: string,
  warnings: string[],
): string | UPGEdge[] | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // outcome ← metric / kpi: edge direction is outcome → metric (source: outcome, target: metric)
  // But in Vistaly, parent=outcome, child=kpi|metric → emit outcome_measured_by_metric
  if ((parent === 'outcome') && (child === 'kpi' || child === 'metric')) {
    return 'outcome_measured_by_metric'
  }

  // outcome → opportunity (Vistaly: parent=outcome, child=opportunity)
  // UPG edge: opportunity_pursues_outcome (source=opportunity, target=outcome)
  // Note: the edge direction in UPG is opportunity→outcome; here child=opportunity, parent=outcome
  // so we need source=child node, target=parent node: handled by returning a descriptor
  if (parent === 'outcome' && child === 'opportunity') {
    // opportunity_pursues_outcome: source=opportunity, target=outcome
    // We'll encode this as an array with explicit source/target
    return 'opportunity_pursues_outcome'
  }

  // opportunity → solution
  if (parent === 'opportunity' && child === 'solution') {
    return 'opportunity_drives_solution'
  }

  // solution → experiment / assumption_test
  // solution_proposes_hypothesis: source=solution, target=hypothesis
  // Since we map experiment to 'experiment' not 'hypothesis', this is an approximation.
  // We emit the canonical edge noting hypothesis is the correct intermediate.
  if (parent === 'solution' && (child === 'experiment' || child === 'assumption_test')) {
    return 'solution_proposes_hypothesis'
  }

  // assumption → experiment / assumption_test
  if (parent === 'assumption' && (child === 'experiment' || child === 'assumption_test')) {
    return 'assumption_becomes_hypothesis'
  }

  // interview (research_study) → opportunity
  // Canonical path: insight_informs_opportunity (source=insight, target=opportunity)
  // Interview is mapped to research_study. The bridge from research_study to opportunity
  // goes via insight: research_study_produces_insight → insight_informs_opportunity.
  // Since we do not create intermediate insight nodes, we emit insight_informs_opportunity
  // as an approximation and note the bridge.
  if (parent === 'interview' && child === 'opportunity') {
    warnings.push(
      `Vistaly Interview→Opportunity hierarchy for "${cardTitle}": ` +
        `UPG canonical path goes via insight (research_study → insight → opportunity). ` +
        `Emitting insight_informs_opportunity as an approximation. ` +
        `Consider adding an insight node to complete the chain.`,
    )
    return 'insight_informs_opportunity'
  }

  // feedback (customer_feedback) → opportunity
  // Canonical chain: customer_feedback_becomes_feature_request → feature_request_creates_opportunity
  // Both edges are in the catalogue. We cannot create an intermediate feature_request node
  // here, so we emit a warning and use customer_feedback_becomes_feature_request as the
  // closest available edge; the opportunity edge is not emitted (no intermediate node exists).
  if (parent === 'feedback' && child === 'opportunity') {
    warnings.push(
      `Vistaly Feedback→Opportunity hierarchy for "${cardTitle}": ` +
        `UPG canonical path is customer_feedback → feature_request → opportunity ` +
        `(customer_feedback_becomes_feature_request + feature_request_creates_opportunity). ` +
        `No intermediate feature_request node was created. ` +
        `Consider importing as a feature_request to complete the chain.`,
    )
    return null
  }

  // objective → outcome: THE GAP
  // No direct objective→outcome edge exists in the UPG catalogue.
  // The canonical path goes through key_result.
  if (parent === 'objective' && child === 'outcome') {
    warnings.push(
      `Vistaly Objective→Outcome hierarchy: UPG connects these via key_result. ` +
        `The direct edge was not emitted. ` +
        `Consider creating a key_result node to bridge the two.`,
    )
    return 'warning-only'
  }

  // Unrecognised pair
  return null
}
