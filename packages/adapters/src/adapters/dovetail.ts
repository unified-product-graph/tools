/**
 * Dovetail Adapter
 *
 * Imports projects, notes, highlights, themes, docs, and contacts from Dovetail.
 * Dovetail is a user research repository: its data model maps directly to UPG's
 * `user_research` domain (the highest structural overlap of any external tool).
 *
 * Mapping:
 * - Project    → research_study
 * - Data/Note  → observation     (formerly "note" in Dovetail UI)
 * - Highlight  → quote           (text passage or timestamped video/audio clip)
 * - Doc/Insight → insight        (Dovetail "Docs" are called "Insights" in the UI)
 * - Theme      → affinity_cluster
 * - Contact    → participant
 * - Channel    → feedback_program
 * - Topic      → feedback_theme
 *
 * Edges emitted (all verified against the live UPG edge catalogue):
 * - research_study_captures_observation       (project → data)
 * - observation_evidenced_by_quote            (data → highlight)
 * - research_study_clusters_into_affinity_cluster (project → theme)
 * - affinity_cluster_synthesises_insight      (theme → insight, deferred)
 * - research_study_enrolls_participant        (project → contact)
 * - observation_yields_insight                (data → insight)
 * - feedback_program_identifies_feedback_theme (channel → topic)
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Source type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Dovetail source_type values to UPG entity types.
 *
 * Null values signal explicitly unmappable types (emit warning, skip node).
 * Both canonical and legacy names are supported for API version compatibility.
 *
 * All UPG entity types verified against the live catalog via list_entity_types.
 */
export const DOVETAIL_TYPE_MAP: Record<string, string | null> = {
  // Core research hierarchy: 1:1 structural matches
  project: 'research_study',
  data: 'observation',       // Current Dovetail API name for data entries
  note: 'observation',       // Legacy name support (older Dovetail versions)
  highlight: 'quote',
  doc: 'insight',            // Dovetail "Docs" are called "Insights" in the UI
  insight: 'insight',        // Legacy/alternate name support
  theme: 'affinity_cluster',
  contact: 'participant',

  // Feedback domain
  channel: 'feedback_program',
  topic: 'feedback_theme',

  // Narrative presentations: map to document (reasonable fallback)
  story: 'document',

  // No UPG equivalent: skip with warning
  reel: null,    // Video compilation reel: no UPG equivalent
  board: null,   // Visual arrangement board: no UPG equivalent
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Base confidence by source type.
 *
 * Dovetail has one of the cleanest mappings to UPG: every core type maps
 * directly to the user_research domain. Base confidence is high for every
 * core research object.
 *
 * Modifiers applied at conversion time:
 * - ai_generated: true → downgrade to 'medium' (synthesis was automated)
 * - is_video_clip: true → downgrade to 'medium' (content inferred from timestamp)
 * - null/unknown type → 'low'
 */
export const BASE_CONFIDENCE_MAP: Record<string, 'high' | 'medium' | 'low'> = {
  project: 'high',
  data: 'high',
  note: 'high',
  highlight: 'high',
  doc: 'high',
  insight: 'high',
  theme: 'high',
  contact: 'high',
  channel: 'high',
  topic: 'high',
  story: 'medium',   // narrative presentation, somewhat indirect mapping
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve Dovetail source_type to a UPG entity type. Returns null if unmappable. */
export function resolveDovetailType(sourceType: string): string | null {
  const lower = sourceType.toLowerCase().trim()
  if (lower in DOVETAIL_TYPE_MAP) {
    return DOVETAIL_TYPE_MAP[lower]
  }
  return undefined as unknown as null  // unknown type: caller handles
}

/** Get base confidence for a Dovetail source type */
export function getBaseConfidence(sourceType: string): 'high' | 'medium' | 'low' {
  const lower = sourceType.toLowerCase().trim()
  return BASE_CONFIDENCE_MAP[lower] ?? 'low'
}

/** Apply Dovetail-specific confidence modifiers */
function applyConfidenceModifiers(
  base: 'high' | 'medium' | 'low',
  isAiGenerated: boolean,
  isVideoClip: boolean,
): 'high' | 'medium' | 'low' {
  if (isAiGenerated || isVideoClip) {
    // Downgrade: high → medium, medium → medium (floor at medium for known types)
    if (base === 'high') return 'medium'
  }
  return base
}

// ─── Dovetail Adapter ─────────────────────────────────────────────────────────

export class DovetailAdapter implements UPGAdapter {
  name = 'dovetail'
  label = 'Dovetail'
  description = 'Import projects, notes, highlights, themes, and contacts from Dovetail'

  /**
   * List available Dovetail items.
   *
   * Requires Dovetail API access and pre-fetched data to be passed via config.
   * The adapter is designed to be called from within a skill that has
   * already fetched items via the Dovetail API.
   *
   * Config options:
   * - `project_id` (string): specific project to import
   * - `include_archived` (boolean): whether to include archived items
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const apiKey = config.api_key as string
    if (!apiKey) throw new Error('Dovetail adapter requires config.api_key (DOVETAIL_API_KEY)')

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    const baseUrl = 'https://dovetail.com/api/v1'
    const items: SourceItem[] = []

    // Projects
    const projectsRes = await fetch(`${baseUrl}/projects`, { headers })
    if (!projectsRes.ok) throw new Error(`Dovetail projects fetch failed: ${projectsRes.status}`)
    const projects = await projectsRes.json() as { data: Array<{ id: string; title: string; created_at: string }> }

    for (const project of projects.data) {
      items.push({
        source_id: project.id,
        source_type: 'project',
        title: project.title,
        metadata: { entity_kind: 'project', entity_type: 'project' },
      })

      // Data items (notes/transcripts)
      const dataRes = await fetch(`${baseUrl}/projects/${project.id}/data`, { headers })
      if (dataRes.ok) {
        const data = await dataRes.json() as { data: Array<{ id: string; title: string; type: string; content?: string }> }
        for (const item of data.data) {
          items.push({
            source_id: item.id,
            source_type: item.type ?? 'note',
            title: item.title,
            content: item.content,
            metadata: { entity_type: item.type ?? 'note', parent_id: project.id, parent_type: 'project' },
          })
        }
      }

      // Highlights
      const highlightsRes = await fetch(`${baseUrl}/projects/${project.id}/highlights`, { headers })
      if (highlightsRes.ok) {
        const highlights = await highlightsRes.json() as { data: Array<{ id: string; content: string; data_id: string }> }
        for (const h of highlights.data) {
          items.push({
            source_id: h.id,
            source_type: 'highlight',
            title: h.content.slice(0, 80),
            content: h.content,
            metadata: { entity_type: 'highlight', parent_id: h.data_id, parent_type: 'note' },
          })
        }
      }

      // Themes
      const themesRes = await fetch(`${baseUrl}/projects/${project.id}/themes`, { headers })
      if (themesRes.ok) {
        const themes = await themesRes.json() as { data: Array<{ id: string; name: string; description?: string }> }
        for (const t of themes.data) {
          items.push({
            source_id: t.id,
            source_type: 'theme',
            title: t.name,
            content: t.description,
            metadata: { entity_type: 'theme', parent_id: project.id, parent_type: 'project' },
          })
        }
      }
    }

    return items
  }

  /**
   * Convert Dovetail source items to UPG entities.
   *
   * Mapping logic:
   * - source_type drives entity type via DOVETAIL_TYPE_MAP
   * - metadata.project_id → research_study_captures_observation edge (data)
   * - metadata.datum_id → observation_evidenced_by_quote edge (highlight)
   * - metadata.project_id → research_study_clusters_into_affinity_cluster (theme)
   * - metadata.project_id → research_study_enrolls_participant (contact)
   * - metadata.datum_id → observation_yields_insight (doc/insight)
   * - metadata.channel_id → feedback_program_identifies_feedback_theme (topic)
   * - theme→insight edges: deferred resolution after all nodes exist
   * - metadata.published → normalised status (complete/draft)
   * - metadata.ai_generated: true → confidence downgraded to 'medium'
   * - metadata.is_video_clip: true → confidence downgraded to 'medium'
   * - reel / board source types → skipped with warning
   * - Insight nodes created → warning to link to opportunities
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Deferred theme→insight pairs: resolved after all nodes are built
    // so that both IDs are available in sourceMap.
    // Populated by insight nodes that have a theme_ids list in metadata.
    const deferredThemeInsights: Array<{
      themeSourceId: string
      insightSourceId: string
    }> = []

    // Track insight count for the "link to opportunity" warning
    let insightCount = 0

    let counter = 0

    for (const item of items) {
      const sourceType = item.source_type.toLowerCase().trim()
      const meta = item.metadata ?? {}

      // ── Resolve entity type ──────────────────────────────────────────────────
      const typeKey = sourceType in DOVETAIL_TYPE_MAP ? sourceType : null

      if (typeKey === null || !(sourceType in DOVETAIL_TYPE_MAP)) {
        // Completely unknown source type
        warnings.push(
          `Unknown Dovetail source type "${item.source_type}" for "${item.title}". Skipped. ` +
            `Add it to DOVETAIL_TYPE_MAP if this is a new Dovetail entity type.`,
        )
        continue
      }

      const ugpType = DOVETAIL_TYPE_MAP[sourceType]

      if (ugpType === null) {
        // Explicitly unmappable type (reel, board)
        warnings.push(
          `Dovetail "${item.source_type}" items have no UPG equivalent and were skipped. ` +
            `Item: "${item.title}". ${sourceType === 'reel' ? 'Video reels are media compilations, separate from structured research data.' : 'Visual boards are layout artefacts, separate from structured research data.'}`,
        )
        continue
      }

      // ── Build node ID ────────────────────────────────────────────────────────
      counter++
      const nodeId = `dovetail-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      // ── Extract metadata ─────────────────────────────────────────────────────
      const isAiGenerated = Boolean(meta.ai_generated)
      const isVideoClip = Boolean(meta.is_video_clip)
      const published = meta.published as boolean | undefined
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : []
      const projectId = meta.project_id as string | undefined
      const datumId = meta.datum_id as string | undefined
      const channelId = meta.channel_id as string | undefined
      const themeIds = Array.isArray(meta.theme_ids) ? (meta.theme_ids as string[]) : []
      const startS = meta.start_s as number | undefined
      const endS = meta.end_s as number | undefined

      // ── Confidence scoring ───────────────────────────────────────────────────
      const baseConfidence = getBaseConfidence(sourceType)
      const confidence = applyConfidenceModifiers(baseConfidence, isAiGenerated, isVideoClip)

      // ── Status normalisation ─────────────────────────────────────────────────
      // Dovetail docs have published/draft states. Everything else has no status.
      let status: string | undefined
      if (ugpType === 'insight' || ugpType === 'document') {
        if (published === true) status = 'complete'
        else if (published === false) status = 'draft'
      }

      // ── Special handling: video/audio clips ──────────────────────────────────
      let title = item.title
      let description = item.content
      const extraProperties: Record<string, unknown> = {}

      if (isVideoClip && startS !== undefined && endS !== undefined) {
        title = `Clip ${startS}s–${endS}s`
        description = item.content ?? 'Video/audio clip'
        extraProperties.start_timestamp_s = startS
        extraProperties.end_timestamp_s = endS
        extraProperties.media_type = 'video'
      }

      // ── Build UPG node ───────────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: ugpType as UPGEntityType,
        title,
        ...(description ? { description } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: confidence,
        external_tool: 'dovetail',
        external_id: item.source_id,
        ...(Object.keys(extraProperties).length > 0 ? { properties: extraProperties } : {}),
      }

      nodes.push(node)

      // ── Track insights for opportunity warning ───────────────────────────────
      if (ugpType === 'insight') {
        insightCount++

        // Register deferred theme→insight edges
        // theme_ids = the themes this insight was synthesised from
        for (const themeId of themeIds) {
          deferredThemeInsights.push({
            themeSourceId: themeId,
            insightSourceId: item.source_id,
          })
        }
      }

      // ── Emit structural edges ─────────────────────────────────────────────────
      // These are immediate (parent IDs available from metadata, not from sourceMap)
      // We defer resolution to post-loop so sourceMap is fully populated.
      // Store pending edges by description: resolved below.
    }

    // ── Second pass: emit structural edges (all nodes now in sourceMap) ────────
    // We re-iterate the original items to emit edges using the completed sourceMap.
    for (const item of items) {
      const sourceType = item.source_type.toLowerCase().trim()
      if (!(sourceType in DOVETAIL_TYPE_MAP)) continue
      const ugpType = DOVETAIL_TYPE_MAP[sourceType]
      if (ugpType === null) continue

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const meta = item.metadata ?? {}
      const projectId = meta.project_id as string | undefined
      const datumId = meta.datum_id as string | undefined
      const channelId = meta.channel_id as string | undefined

      // research_study_captures_observation (project → data/note)
      if (ugpType === 'observation' && projectId) {
        const projectNodeId = sourceMap[projectId]
        if (projectNodeId) {
          edges.push({
            id: `edge-dt-${projectNodeId}-${nodeId}`,
            source: projectNodeId,
            target: nodeId,
            type: 'research_study_captures_observation',
            mapping_confidence: 'high',
          })
        }
      }

      // observation_evidenced_by_quote (data → highlight)
      if (ugpType === 'quote' && datumId) {
        const datumNodeId = sourceMap[datumId]
        if (datumNodeId) {
          edges.push({
            id: `edge-dt-${datumNodeId}-${nodeId}`,
            source: datumNodeId,
            target: nodeId,
            type: 'observation_evidenced_by_quote',
            mapping_confidence: 'high',
          })
        }
      }

      // research_study_clusters_into_affinity_cluster (project → theme)
      if (ugpType === 'affinity_cluster' && projectId) {
        const projectNodeId = sourceMap[projectId]
        if (projectNodeId) {
          const isAiGenerated = Boolean(meta.ai_generated)
          edges.push({
            id: `edge-dt-${projectNodeId}-${nodeId}`,
            source: projectNodeId,
            target: nodeId,
            type: 'research_study_clusters_into_affinity_cluster',
            mapping_confidence: isAiGenerated ? 'medium' : 'high',
          })
        }
      }

      // research_study_enrolls_participant (project → contact)
      if (ugpType === 'participant' && projectId) {
        const projectNodeId = sourceMap[projectId]
        if (projectNodeId) {
          edges.push({
            id: `edge-dt-${projectNodeId}-${nodeId}`,
            source: projectNodeId,
            target: nodeId,
            type: 'research_study_enrolls_participant',
            mapping_confidence: 'high',
          })
        }
      }

      // observation_yields_insight (data → insight, when insight is linked to a datum)
      if (ugpType === 'insight' && datumId) {
        const datumNodeId = sourceMap[datumId]
        if (datumNodeId) {
          edges.push({
            id: `edge-dt-${datumNodeId}-${nodeId}`,
            source: datumNodeId,
            target: nodeId,
            type: 'observation_yields_insight',
            mapping_confidence: 'high',
          })
        }
      }

      // feedback_program_identifies_feedback_theme (channel → topic)
      if (ugpType === 'feedback_theme' && channelId) {
        const channelNodeId = sourceMap[channelId]
        if (channelNodeId) {
          edges.push({
            id: `edge-dt-${channelNodeId}-${nodeId}`,
            source: channelNodeId,
            target: nodeId,
            type: 'feedback_program_identifies_feedback_theme',
            mapping_confidence: 'high',
          })
        }
      }
    }

    // ── Resolve deferred theme→insight edges ──────────────────────────────────
    // Processed after all nodes are built so sourceMap is complete.
    for (const { themeSourceId, insightSourceId } of deferredThemeInsights) {
      const themeNodeId = sourceMap[themeSourceId]
      const insightNodeId = sourceMap[insightSourceId]

      if (!themeNodeId) {
        warnings.push(
          `Insight "${insightSourceId}" references theme "${themeSourceId}" which was not found in ` +
            `this batch. affinity_cluster_synthesises_insight edge skipped. ` +
            `Import the theme in the same batch to auto-resolve this edge.`,
        )
        continue
      }

      if (!insightNodeId) continue  // shouldn't happen (we just built it)

      edges.push({
        id: `edge-dt-deferred-${themeNodeId}-${insightNodeId}`,
        source: themeNodeId,
        target: insightNodeId,
        type: 'affinity_cluster_synthesises_insight',
        mapping_confidence: 'medium',  // deferred = synthesised relationship, medium confidence
      })
    }

    // ── Insight → opportunity warning ─────────────────────────────────────────
    // The insight_informs_opportunity edge cannot be auto-generated: it requires
    // a PM to explicitly link the insight to an opportunity in the UPG graph.
    if (insightCount > 0) {
      warnings.push(
        `${insightCount} insight${insightCount === 1 ? ' was' : 's were'} captured from Dovetail. ` +
          `Link ${insightCount === 1 ? 'it' : 'them'} to opportunities via the UPG graph ` +
          `to complete the research chain (insight_informs_opportunity). ` +
          `This edge requires explicit PM judgement.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
