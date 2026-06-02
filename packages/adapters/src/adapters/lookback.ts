/**
 * Lookback Adapter
 *
 * Imports projects, sessions, moments, notes, insights, and participants
 * from Lookback: the user interview and session recording platform.
 *
 * Lookback is session-centric: the platform facilitates live and self-guided
 * sessions, records participant screen and audio/video, and captures researcher
 * notes in real time. The UPG mapping is clean for all knowledge entities;
 * binary artifacts (recordings, screenshares) are explicitly skipped.
 *
 * Mapping:
 * - project     → research_study
 * - session     → research_study    (recorded interview session, child of project)
 * - recording   → (skipped: binary video file, not a knowledge entity)
 * - moment      → quote             (tagged timestamp/clip in the recording)
 * - note        → observation       (researcher note at a timestamp)
 * - tag         → (skipped: metadata property)
 * - insight     → insight           (synthesised research finding)
 * - participant → participant
 * - screenshare → (skipped: operational video artifact)
 *
 * Edges emitted (all verified against the live UPG edge catalogue):
 * - research_study_captures_observation   (session → note)
 * - observation_evidenced_by_quote        (session/note → moment)
 * - research_study_produces_insight       (project/session → insight)
 * - research_study_enrolls_participant    (project/session → participant)
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Source type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Lookback entity_type values to UPG entity types.
 *
 * Null values signal explicitly unmappable types (emit warning, skip node).
 * All UPG entity types verified against the live catalog via list_entity_types.
 */
export const LOOKBACK_TYPE_MAP: Record<string, string | null> = {
  // Core research hierarchy
  project: 'research_study',
  session: 'research_study',      // recorded interview session
  recording: null,                // video file: skip (binary data)
  moment: 'quote',                // a tagged moment/clip in the recording
  note: 'observation',
  tag: null,                      // metadata property: skip
  insight: 'insight',
  participant: 'participant',
  screenshare: null,              // skip: operational artifact
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Lookback status values to UPG status values.
 */
export const LOOKBACK_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  live: 'active',
  complete: 'complete',
  archived: 'abandoned',
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

export const LOOKBACK_CONFIDENCE_MAP: Record<string, 'high' | 'medium' | 'low'> = {
  project: 'high',
  session: 'high',
  moment: 'high',
  note: 'high',
  insight: 'high',
  participant: 'high',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(value: string): string {
  return value.toLowerCase().trim()
}

export function resolveLookbackType(entityType: string): string | null | undefined {
  const lower = normalize(entityType)
  if (lower in LOOKBACK_TYPE_MAP) {
    return LOOKBACK_TYPE_MAP[lower]
  }
  return undefined
}

export function normalizeLookbackStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  return LOOKBACK_STATUS_MAP[normalize(status)] ?? status
}

export function getLookbackConfidence(entityType: string): 'high' | 'medium' | 'low' {
  return LOOKBACK_CONFIDENCE_MAP[normalize(entityType)] ?? 'low'
}

// ─── Lookback Adapter ─────────────────────────────────────────────────────────

export class LookbackAdapter implements UPGAdapter {
  name = 'lookback'
  label = 'Lookback'
  description =
    'Import research projects, sessions, moments, notes, insights, and participants from Lookback (a user interview and session recording platform).'

  /**
   * List available Lookback items.
   *
   * Requires Lookback API access and pre-fetched data via config.
   * The adapter is designed to be called from within a skill that has
   * already fetched items via the Lookback API.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Lookback adapter requires Lookback API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Lookback source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type drives entity type via LOOKBACK_TYPE_MAP
   * - metadata.parent_id + parent_type → structural edges in second pass
   * - metadata.status → normalised status via LOOKBACK_STATUS_MAP
   * - metadata.timestamp_seconds → preserved on moment (quote) nodes
   * - recording/screenshare → skipped with warning (binary artifacts)
   * - tag → skipped with warning (metadata only)
   * - Insight nodes → warning to link to opportunity
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let insightCount = 0
    let counter = 0

    // ── Pass 1: build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const entityTypeLower = normalize(rawEntityType)

      const resolved = resolveLookbackType(rawEntityType)

      if (resolved === undefined) {
        warnings.push(
          `Unknown Lookback entity_type "${rawEntityType}" for "${item.title}". Skipped. ` +
            `Add it to LOOKBACK_TYPE_MAP if this is a new Lookback entity type.`,
        )
        continue
      }

      if (resolved === null) {
        // Explicitly unmappable (recording, screenshare, tag)
        const reason =
          entityTypeLower === 'recording'
            ? 'Video recordings are binary media files, not structured research knowledge.'
            : entityTypeLower === 'screenshare'
              ? 'Screen recordings are operational video artifacts, not structured research knowledge.'
              : 'Tags are metadata labels preserved as properties on observation/quote nodes.'
        warnings.push(
          `Lookback "${rawEntityType}" items have no UPG equivalent and were skipped. ` +
            `Item: "${item.title}". ${reason}`,
        )
        continue
      }

      counter++
      const nodeId = `lookback-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : []
      const rawStatus = meta.status as string | undefined
      const status = normalizeLookbackStatus(rawStatus)
      const confidence = getLookbackConfidence(entityTypeLower)
      const timestampSeconds = meta.timestamp_seconds as number | undefined

      if (resolved === 'insight') {
        insightCount++
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
        external_tool: 'lookback',
        external_id: item.source_id,
        // Preserve timestamp for moment (quote) nodes: key Lookback-specific field
        ...(resolved === 'quote' && timestampSeconds !== undefined
          ? { timestamp_seconds: timestampSeconds }
          : {}),
      }

      nodes.push(node)
    }

    // ── Pass 2: emit structural edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const resolved = LOOKBACK_TYPE_MAP[normalize(rawEntityType)]
      if (resolved === null || resolved === undefined) continue

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const parentId = meta.parent_id as string | undefined
      const parentType = normalize((meta.parent_type as string | undefined) ?? '')

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Lookback item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeType = resolveLookbackEdge(parentType, normalize(rawEntityType))

      edges.push({
        id: `edge-lookback-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType as UPGEdge['type'],
        mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'high',
      })
    }

    // ── Insight → opportunity warning ──────────────────────────────────────────
    if (insightCount > 0) {
      warnings.push(
        `${insightCount} insight${insightCount === 1 ? ' was' : 's were'} captured from Lookback. ` +
          `Link ${insightCount === 1 ? 'it' : 'them'} to opportunities via the UPG graph ` +
          `to complete the research chain (insight_informs_opportunity). ` +
          `This edge requires explicit PM judgement.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No Lookback items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the UPG edge for a Lookback parent_type → entity_type pair.
 * All returned edge types verified against the UPG catalog.
 */
function resolveLookbackEdge(parentType: string, childType: string): string {
  // project/session → observation (note)
  if (
    (parentType === 'project' || parentType === 'session') &&
    childType === 'note'
  ) {
    return 'research_study_captures_observation'
  }

  // session/note → quote (moment)
  if (
    (parentType === 'session' || parentType === 'note') &&
    childType === 'moment'
  ) {
    return 'observation_evidenced_by_quote'
  }

  // project/session → insight
  if (
    (parentType === 'project' || parentType === 'session') &&
    childType === 'insight'
  ) {
    return 'research_study_produces_insight'
  }

  // project/session → participant
  if (
    (parentType === 'project' || parentType === 'session') &&
    childType === 'participant'
  ) {
    return 'research_study_enrolls_participant'
  }

  // Fallback
  return 'node_informs_node'
}
