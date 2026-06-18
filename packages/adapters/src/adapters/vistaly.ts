/**
 * Vistaly Adapter
 *
 * Imports the discovery tree from Vistaly, a continuous-discovery tool that
 * organises product work as a tree of typed "cards".
 *
 * Grounded in Vistaly's live OpenAPI spec (api.vistaly.com/v1/swagger.json,
 * spec version 2025-06-21). The real card model and endpoints — captured in
 * packages/upg-cli/src/__tests__/fixtures/vistaly/SCHEMA.md — are:
 *
 *   Enumerate:  GET /beta/cards/{rootCardId}/context?direction=descendants
 *               → { context: EnrichedCardContext[], metadata }
 *   Card type:  `cardType` ∈ assumption | experiment | kpi | objective |
 *               opportunity | outcome | problem | product | solution
 *   Hierarchy:  each card lists its child cardIds in `children[]`
 *
 * (There is NO /v1/workspaces or list-all-cards endpoint — enumeration walks
 * the context tree from a known root card.)
 *
 * Card type → UPG entity type:
 *   outcome→outcome · objective→objective · opportunity→opportunity ·
 *   solution→solution · assumption→assumption · experiment→experiment ·
 *   kpi→metric · product→product · problem→need
 *
 * Hierarchy edges (all verified against the canonical catalogue):
 *   objective → outcome      → objective_advances_outcome
 *   outcome   → kpi/metric   → outcome_measured_by_metric
 *   outcome   → opportunity  → opportunity_pursues_outcome   (opportunity is source)
 *   outcome   → product      → product_pursues_outcome       (product is source)
 *   opportunity → solution   → opportunity_drives_solution
 *   opportunity → problem    → opportunity_addresses_need
 *   problem   → solution     → solution_addresses_need        (solution is source)
 * Pairs with no direct edge (e.g. solution/assumption → experiment, which UPG
 * routes through a hypothesis) fall back to a generic node_informs_node link
 * with a warning.
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

const VISTALY_API_BASE = 'https://api.vistaly.com'

// ─── Card type → UPG entity type ─────────────────────────────────────────────

/**
 * Maps Vistaly `cardType` values to UPG entity types. Keys are exactly the
 * values in Vistaly's `CardType` enum; nothing else is a real card type.
 */
export const VISTALY_TYPE_MAP: Record<string, string> = {
  outcome: 'outcome',
  objective: 'objective',
  opportunity: 'opportunity',
  solution: 'solution',
  assumption: 'assumption',
  experiment: 'experiment',
  kpi: 'metric',
  product: 'product',
  problem: 'need', // Vistaly problems are user problems → UPG need
}

// ─── Status normalisation (per target entity type) ───────────────────────────

/**
 * Maps Vistaly card statuses to UPG statuses, keyed by the RESOLVED UPG entity
 * type. UPG statuses are per-type lifecycle phases, so a single global map is
 * wrong: a status is normalised against the target type's lifecycle, and any
 * status that does not map to a valid phase is omitted rather than emitted
 * invalid. Types with no entry (metric is lifecycle-free, product carries a
 * `stage` property not a status) never emit a status.
 */
export const VISTALY_STATUS_BY_TYPE: Record<string, Record<string, string>> = {
  opportunity: {
    identified: 'identified',
    next: 'identified',
    now: 'validated',
    addressed: 'validated',
    later: 'deferred',
    'not now': 'deferred',
  },
  need: {
    identified: 'raw',
    next: 'raw',
    later: 'raw',
    'not now': 'raw',
    now: 'validated',
    addressed: 'validated',
    validated: 'validated',
    prioritized: 'prioritized',
  },
  solution: {
    idea: 'proposed',
    next: 'proposed',
    now: 'in_progress',
    done: 'shipped',
    later: 'deferred',
    'not now': 'deferred',
  },
  outcome: {
    uncommitted: 'identified',
    'at risk': 'measuring',
    progressing: 'measuring',
    'on track': 'measuring',
  },
  experiment: {
    developing: 'planned',
    pending: 'planned',
    running: 'running',
    failed: 'done',
    passed: 'done',
  },
  objective: {
    draft: 'draft',
    active: 'active',
    now: 'active',
    achieved: 'achieved',
    missed: 'missed',
    'not now': 'deferred',
  },
  assumption: {
    untested: 'untested',
    testing: 'testing',
    pending: 'testing',
    validated: 'validated',
    passed: 'validated',
    failed: 'invalidated',
    invalidated: 'invalidated',
  },
}

// ─── Hierarchy edges (parentUpg → childUpg) ──────────────────────────────────

/**
 * Canonical UPG edge for a Vistaly parent→child pair, keyed by
 * `${parentUpgType}__${childUpgType}`. `sourceIsChild` flips the edge so the
 * emitted source/target match the catalogue's declared direction (e.g.
 * opportunity_pursues_outcome has the opportunity as source even though the
 * opportunity is the child in Vistaly's tree). Every edge type here is in the
 * UPG catalogue.
 */
const VISTALY_EDGE_MAP: Record<string, { type: string; sourceIsChild: boolean }> = {
  objective__outcome: { type: 'objective_advances_outcome', sourceIsChild: false },
  outcome__metric: { type: 'outcome_measured_by_metric', sourceIsChild: false },
  outcome__opportunity: { type: 'opportunity_pursues_outcome', sourceIsChild: true },
  outcome__product: { type: 'product_pursues_outcome', sourceIsChild: true },
  opportunity__solution: { type: 'opportunity_drives_solution', sourceIsChild: false },
  opportunity__need: { type: 'opportunity_addresses_need', sourceIsChild: false },
  need__solution: { type: 'solution_addresses_need', sourceIsChild: true },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Vistaly card_type to a UPG entity type. undefined if unknown. */
export function resolveCardType(cardType: string): string | undefined {
  return VISTALY_TYPE_MAP[normalizeName(cardType)]
}

/**
 * Normalise a Vistaly status to a UPG status for the given UPG entity type.
 * Returns undefined when the type has no lifecycle (metric/product) or the
 * status has no valid mapping — callers then omit status rather than persist
 * an out-of-lifecycle value.
 */
export function normalizeVistalyStatus(status: string, upgType: string): string | undefined {
  return VISTALY_STATUS_BY_TYPE[upgType]?.[normalizeName(status)]
}

/** Resolve the confidence level for a card_type → entity type mapping */
export function getConfidenceForCardType(cardType: string): 'high' | 'medium' | 'low' {
  switch (normalizeName(cardType)) {
    case 'outcome':
    case 'objective':
    case 'opportunity':
    case 'solution':
    case 'assumption':
    case 'experiment':
    case 'kpi':
      return 'high'
    // Semantic shift: Vistaly product/problem → UPG product/need
    case 'product':
    case 'problem':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Real Vistaly API shapes (from the OpenAPI spec) ──────────────────────────

interface VistalyEnrichedCard {
  cardId: string
  cardTitle: string
  cardType: string
  cardStatus?: string
  cardDetails?: string
  cardUrl?: string
  level?: number
  children?: string[]
  organizationId?: string
  workspaceId?: string
  metricCurrent?: number
  metricTarget?: number
  metricUnit?: string
}

interface VistalyContextResponse {
  context?: VistalyEnrichedCard[]
  metadata?: { direction?: string; cardCount?: number; maxLevel?: number }
}

// ─── Vistaly Adapter ──────────────────────────────────────────────────────────

export class VistalyAdapter implements UPGAdapter {
  name = 'vistaly'
  label = 'Vistaly'
  description =
    'Import the Vision/Objective → Outcome → Opportunity → Solution → Experiment discovery tree from Vistaly (a continuous discovery tool).'

  /**
   * List Vistaly cards by walking the context tree from a root card.
   *
   * Vistaly has no list-all-cards endpoint; enumeration uses
   * GET /beta/cards/{rootCardId}/context?direction=descendants. Parent→child
   * links are reconstructed from each card's `children[]`.
   *
   * Config:
   * - `api_key` (string, required): Vistaly API key (VISTALY_API_KEY)
   * - `root_card_id` (string, required): the card to walk from (e.g. the
   *   workspace root or a top outcome)
   * - `base_url` (string, optional): override the API base (default
   *   https://api.vistaly.com)
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const apiKey = config.api_key as string
    const rootCardId = config.root_card_id as string
    const baseUrl = (config.base_url as string) || VISTALY_API_BASE

    if (!apiKey) throw new Error('Vistaly adapter requires config.api_key (VISTALY_API_KEY)')
    if (!rootCardId) {
      throw new Error(
        'Vistaly adapter requires config.root_card_id. The Vistaly API has no ' +
          'list-all-cards endpoint; enumeration walks GET /beta/cards/{id}/context ' +
          'from a known root card (e.g. the workspace root or a top outcome).',
      )
    }

    const params = new URLSearchParams({
      direction: 'descendants',
      maxLevels: '10',
      includeDescriptions: 'true',
    })
    const url = `${baseUrl}/beta/cards/${encodeURIComponent(rootCardId)}/context?${params.toString()}`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Vistaly card context fetch failed: ${res.status}`)

    const body = (await res.json()) as VistalyContextResponse
    const cards = body.context ?? []

    // Reconstruct child → parent from each card's children[].
    const parentOf = new Map<string, { id: string; type: string }>()
    for (const card of cards) {
      for (const childId of card.children ?? []) {
        parentOf.set(childId, { id: card.cardId, type: card.cardType })
      }
    }

    return cards.map((card) => {
      const parent = parentOf.get(card.cardId)
      return {
        source_id: card.cardId,
        source_type: 'card',
        title: card.cardTitle,
        ...(card.cardDetails ? { content: card.cardDetails } : {}),
        metadata: {
          card_type: card.cardType,
          status: card.cardStatus,
          parent_id: parent?.id,
          parent_type: parent?.type,
          metric_current_value: card.metricCurrent,
          metric_target_value: card.metricTarget,
          metric_unit: card.metricUnit,
          card_url: card.cardUrl,
        },
      }
    })
  }

  /**
   * Convert Vistaly source items to UPG entities.
   *
   * - card_type → UPG entity type (VISTALY_TYPE_MAP)
   * - status → per-type normalised UPG status (omitted when unmappable)
   * - metric values → node.properties.{current_value,target_value,unit}
   * - parent_id/parent_type + children → typed hierarchy edges
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    for (const item of items) {
      counter++
      const meta = item.metadata ?? {}
      const cardType = (meta.card_type as string | undefined) ?? ''

      const resolved = resolveCardType(cardType)
      let entityType: string
      let confidence: 'high' | 'medium' | 'low'
      if (resolved === undefined) {
        warnings.push(
          `Vistaly card "${item.title}" has unknown card_type "${cardType}". ` +
            `Defaulting to "document". Update VISTALY_TYPE_MAP if this should be mapped.`,
        )
        entityType = 'document'
        confidence = 'low'
      } else {
        entityType = resolved
        confidence = getConfidenceForCardType(cardType)
      }

      const nodeId = `vistaly-import-${counter}`
      sourceMap[item.source_id] = nodeId

      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeVistalyStatus(rawStatus, entityType) : undefined

      // Metric values belong under properties (canonical), not as top-level
      // node fields, so the .upg writer persists them.
      let properties: Record<string, unknown> | undefined
      if (entityType === 'metric') {
        const p: Record<string, unknown> = {}
        if (meta.metric_current_value !== undefined) p.current_value = meta.metric_current_value
        if (meta.metric_target_value !== undefined) p.target_value = meta.metric_target_value
        if (meta.metric_unit !== undefined) p.unit = meta.metric_unit
        if (Object.keys(p).length > 0) properties = p
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: entityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: confidence,
        external_tool: 'vistaly',
        external_id: item.source_id,
        ...(meta.card_url ? { external_ref: meta.card_url as string } : {}),
        ...(properties ? { properties } : {}),
      }
      nodes.push(node)
    }

    // Hierarchy edges (second pass, so sourceMap is complete).
    for (const item of items) {
      const meta = item.metadata ?? {}
      const childType = (meta.card_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined

      const childNodeId = sourceMap[item.source_id]
      if (!childNodeId || !parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Vistaly card "${item.title}" references parent_id "${parentId}" which was not ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const parentType = (meta.parent_type as string | undefined) ?? ''
      const childUpg = resolveCardType(childType) ?? 'document'
      const parentUpg = resolveCardType(parentType) ?? 'document'

      const mapped = VISTALY_EDGE_MAP[`${parentUpg}__${childUpg}`]
      if (mapped) {
        const source = mapped.sourceIsChild ? childNodeId : parentNodeId
        const target = mapped.sourceIsChild ? parentNodeId : childNodeId
        edges.push({
          id: `edge-vistaly-${source}-${target}`,
          source,
          target,
          type: mapped.type as UPGEdgeType,
          mapping_confidence: 'high',
        })
      } else {
        // No canonical edge for this pair (e.g. solution/assumption → experiment,
        // which UPG routes through a hypothesis). Emit a generic link + warning.
        edges.push({
          id: `edge-vistaly-${parentNodeId}-${childNodeId}`,
          source: parentNodeId,
          target: childNodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        warnings.push(
          `No canonical UPG edge for Vistaly ${parentType || 'card'} → ${childType || 'card'} ` +
            `(${parentUpg} → ${childUpg}); emitted node_informs_node as a generic link.`,
        )
      }
    }

    if (nodes.length === 0) {
      warnings.push('No cards were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
