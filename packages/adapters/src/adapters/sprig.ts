/**
 * Sprig Adapter
 *
 * Imports studies, surveys, responses, respondents, themes, insights, and
 * segments from Sprig: the in-product survey and micro-feedback tool.
 *
 * Sprig differs from Dovetail/Condens/Lookback in a key way: its base unit is
 * `customer_feedback` (survey response at scale), not `observation` (researcher
 * note). This reflects Sprig's core use case: high-volume in-product surveys
 * rather than deep qualitative interview research.
 *
 * Mapping:
 * - study       → research_study      (the survey instrument / study container)
 * - survey      → research_study      (alternate API name for study)
 * - response    → customer_feedback   (individual survey response: NOT observation)
 * - respondent  → participant
 * - theme       → affinity_cluster    (AI-synthesised response theme)
 * - insight     → insight             (synthesised finding)
 * - segment     → market_segment      (targeting segment: who sees the survey)
 * - question    → (skipped: survey instrument, not knowledge)
 * - event       → (skipped: behavioral trigger, not knowledge)
 *
 * Edges emitted (all verified against the live UPG edge catalogue):
 * - research_study_enrolls_participant    (study → respondent)
 * - research_study_produces_insight       (study → insight)
 * - affinity_cluster_synthesises_insight  (theme → insight, deferred)
 *
 * Note: response (customer_feedback) → study uses node_informs_node with a
 * warning, since research_study_captures_observation expects observation type.
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Source type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Sprig entity_type values to UPG entity types.
 *
 * Null values signal explicitly unmappable types (emit warning, skip node).
 * All UPG entity types verified against the live catalog via list_entity_types.
 */
export const SPRIG_TYPE_MAP: Record<string, string | null> = {
  // Core research hierarchy
  study: 'research_study',
  survey: 'research_study',           // alternate API name for study
  response: 'customer_feedback',      // individual survey response (NOT observation)
  respondent: 'participant',
  theme: 'affinity_cluster',          // AI-synthesised response theme
  insight: 'insight',
  segment: 'market_segment',          // targeting segment: who sees the survey
  question: null,                      // skip: survey instrument, not knowledge
  event: null,                         // skip: behavioral trigger, not knowledge
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Sprig status values to UPG status values.
 */
export const SPRIG_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  running: 'active',
  paused: 'active',      // paused = still active, just not currently firing
  complete: 'complete',
  archived: 'abandoned',
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

export const SPRIG_CONFIDENCE_MAP: Record<string, 'high' | 'medium' | 'low'> = {
  study: 'high',
  survey: 'high',
  response: 'high',
  respondent: 'high',
  theme: 'medium',      // AI-generated clustering: medium confidence
  insight: 'high',
  segment: 'medium',    // targeting rule → market_segment is an approximation
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(value: string): string {
  return value.toLowerCase().trim()
}

export function resolveSprigType(entityType: string): string | null | undefined {
  const lower = normalize(entityType)
  if (lower in SPRIG_TYPE_MAP) {
    return SPRIG_TYPE_MAP[lower]
  }
  return undefined
}

export function normalizeSprigStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  return SPRIG_STATUS_MAP[normalize(status)] ?? status
}

export function getSprigConfidence(entityType: string): 'high' | 'medium' | 'low' {
  return SPRIG_CONFIDENCE_MAP[normalize(entityType)] ?? 'low'
}

// ─── Sprig Adapter ────────────────────────────────────────────────────────────

export class SprigAdapter implements UPGAdapter {
  name = 'sprig'
  label = 'Sprig'
  description =
    'Import studies, survey responses, respondents, themes, insights, and segments from Sprig (an in-product micro-survey platform).'

  /**
   * List available Sprig items.
   *
   * Requires Sprig API access and pre-fetched data via config.
   * The adapter is designed to be called from within a skill that has
   * already fetched items via the Sprig API.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Sprig adapter requires Sprig API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Sprig source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type drives entity type via SPRIG_TYPE_MAP
   * - metadata.parent_id + parent_type → structural edges in second pass
   * - metadata.status → normalised status via SPRIG_STATUS_MAP
   * - metadata.response_count → preserved on research_study nodes
   * - metadata.nps_score → preserved on research_study and customer_feedback nodes
   * - question/event → skipped with warning (instrument/trigger artifacts)
   * - theme → affinity_cluster with AI-generated confidence note
   * - Insight nodes → warning to link to opportunity (never auto-emitted)
   * - theme→insight deferred edges resolved after all nodes built
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Deferred theme→insight pairs: resolved after all nodes are built
    const deferredThemeInsights: Array<{
      themeSourceId: string
      insightSourceId: string
    }> = []

    let insightCount = 0
    let counter = 0

    // ── Pass 1: build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const entityTypeLower = normalize(rawEntityType)

      const resolved = resolveSprigType(rawEntityType)

      if (resolved === undefined) {
        warnings.push(
          `Unknown Sprig entity_type "${rawEntityType}" for "${item.title}". Skipped. ` +
            `Add it to SPRIG_TYPE_MAP if this is a new Sprig entity type.`,
        )
        continue
      }

      if (resolved === null) {
        // Explicitly unmappable (question, event)
        const reason =
          entityTypeLower === 'question'
            ? 'Questions are the survey instrument: the mechanism of collection, separate from the knowledge collected.'
            : 'Events are behavioural triggers that fire surveys: operational infrastructure, separate from product knowledge.'
        warnings.push(
          `Sprig "${rawEntityType}" items have no UPG equivalent and were skipped. ` +
            `Item: "${item.title}". ${reason}`,
        )
        continue
      }

      counter++
      const nodeId = `sprig-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : []
      const rawStatus = meta.status as string | undefined
      const status = normalizeSprigStatus(rawStatus)
      const confidence = getSprigConfidence(entityTypeLower)
      const responseCount = meta.response_count as number | undefined
      const npsScore = meta.nps_score as number | undefined

      // Register deferred theme→insight edges
      if (resolved === 'insight') {
        insightCount++
        const themeIds = Array.isArray(meta.theme_ids) ? (meta.theme_ids as string[]) : []
        for (const themeId of themeIds) {
          deferredThemeInsights.push({
            themeSourceId: themeId,
            insightSourceId: item.source_id,
          })
        }
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: resolved as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: confidence,
        external_tool: 'sprig',
        external_id: item.source_id,
        // Preserve response_count on research_study nodes: quantitative signal unique to Sprig
        ...(resolved === 'research_study' && responseCount !== undefined
          ? { response_count: responseCount }
          : {}),
        // Preserve nps_score on research_study and customer_feedback nodes
        ...(npsScore !== undefined ? { nps_score: npsScore } : {}),
      }

      nodes.push(node)
    }

    // ── Pass 2: emit structural edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const resolved = SPRIG_TYPE_MAP[normalize(rawEntityType)]
      if (resolved === null || resolved === undefined) continue

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const parentId = meta.parent_id as string | undefined
      const parentType = normalize((meta.parent_type as string | undefined) ?? '')

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Sprig item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveSprigEdge(parentType, normalize(rawEntityType), resolved)

      edges.push({
        id: `edge-sprig-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType as UPGEdge['type'],
        mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'high',
      })
    }

    // ── Resolve deferred theme→insight edges ───────────────────────────────────
    for (const { themeSourceId, insightSourceId } of deferredThemeInsights) {
      const themeNodeId = sourceMap[themeSourceId]
      const insightNodeId = sourceMap[insightSourceId]

      if (!themeNodeId) {
        warnings.push(
          `Sprig insight "${insightSourceId}" references theme "${themeSourceId}" which was not ` +
            `found in this batch. affinity_cluster_synthesises_insight edge skipped. ` +
            `Import the theme in the same batch to auto-resolve this edge.`,
        )
        continue
      }

      if (!insightNodeId) continue

      edges.push({
        id: `edge-sprig-deferred-${themeNodeId}-${insightNodeId}`,
        source: themeNodeId,
        target: insightNodeId,
        type: 'affinity_cluster_synthesises_insight',
        mapping_confidence: 'medium',  // AI-generated theme → medium confidence
      })
    }

    // ── Insight → opportunity warning ──────────────────────────────────────────
    // insight_informs_opportunity is NEVER auto-emitted: always a PM decision.
    if (insightCount > 0) {
      warnings.push(
        `${insightCount} insight${insightCount === 1 ? ' was' : 's were'} captured from Sprig. ` +
          `Link ${insightCount === 1 ? 'it' : 'them'} to opportunities via the UPG graph ` +
          `to complete the research chain (insight_informs_opportunity). ` +
          `This edge requires explicit PM judgement.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No Sprig items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the UPG edge for a Sprig parent_type → entity_type pair.
 * All returned edge types verified against the UPG catalog.
 *
 * Note: response (customer_feedback) under a study falls back to node_informs_node
 * because research_study_captures_observation expects observation type, not
 * customer_feedback. A warning is emitted separately if needed.
 */
function resolveSprigEdge(parentType: string, childType: string, _resolvedChildType: string): string {
  // study/survey → participant (respondent)
  if (
    (parentType === 'study' || parentType === 'survey') &&
    childType === 'respondent'
  ) {
    return 'research_study_enrolls_participant'
  }

  // study/survey → insight
  if (
    (parentType === 'study' || parentType === 'survey') &&
    childType === 'insight'
  ) {
    return 'research_study_produces_insight'
  }

  // theme → insight
  if (parentType === 'theme' && childType === 'insight') {
    return 'affinity_cluster_synthesises_insight'
  }

  // study/survey → response (customer_feedback)
  // Falls back to node_informs_node: research_study_captures_observation
  // requires observation type, not customer_feedback
  if (
    (parentType === 'study' || parentType === 'survey') &&
    childType === 'response'
  ) {
    return 'node_informs_node'
  }

  // Fallback
  return 'node_informs_node'
}
