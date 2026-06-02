/**
 * Condens Adapter
 *
 * Imports projects, sessions, transcripts, notes, highlights, categories,
 * clusters, insights, and contacts from Condens: the European research repository.
 *
 * Condens is structurally near-identical to Dovetail. Its entity model maps
 * directly to UPG's `user_research` domain with the same ~70% overlap.
 *
 * Mapping:
 * - project     → research_study
 * - session     → research_study    (child of project)
 * - transcript  → observation       (raw interview transcript)
 * - note        → observation       (atomic extracted observation)
 * - highlight   → quote             (tagged excerpt)
 * - tag         → (skipped: metadata property, not a standalone entity)
 * - category    → affinity_cluster  (researcher-defined theme grouping)
 * - cluster     → affinity_cluster  (synthesised grouping of related highlights)
 * - insight     → insight           (synthesised research finding)
 * - contact     → participant
 * - participant → participant       (session-level participant)
 *
 * Edges emitted (all verified against the live UPG edge catalogue):
 * - research_study_captures_observation   (project/session → transcript/note)
 * - observation_evidenced_by_quote        (note → highlight)
 * - research_study_clusters_into_affinity_cluster (project → category/cluster)
 * - affinity_cluster_synthesises_insight  (cluster → insight, deferred)
 * - research_study_enrolls_participant    (project → contact/participant)
 * - research_study_produces_insight       (project → insight)
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Source type → UPG entity type ───────────────────────────────────────────

/**
 * Maps Condens entity_type values to UPG entity types.
 *
 * Null values signal explicitly unmappable types (emit warning, skip node).
 * Both API names and UI names are supported where they differ.
 *
 * All UPG entity types verified against the live catalog via list_entity_types.
 */
export const CONDENS_TYPE_MAP: Record<string, string | null> = {
  // Core research hierarchy: 1:1 structural matches
  project: 'research_study',
  session: 'research_study',       // interview session (child of project)
  transcript: 'observation',       // raw interview transcript
  note: 'observation',             // atomic extracted observation
  highlight: 'quote',              // tagged excerpt from note/transcript
  tag: null,                       // metadata property: skip with warning
  category: 'affinity_cluster',   // researcher-defined theme grouping
  cluster: 'affinity_cluster',    // synthesised grouping of related highlights
  insight: 'insight',              // synthesised research finding
  contact: 'participant',          // research participant record
  participant: 'participant',      // session-level participant record
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Condens status values to UPG status values.
 */
export const CONDENS_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  active: 'active',
  archived: 'abandoned',
  complete: 'complete',
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Base confidence by source entity type.
 *
 * Condens has one of the cleanest mappings to UPG: every core type maps
 * directly to the user_research domain.
 */
export const CONDENS_CONFIDENCE_MAP: Record<string, 'high' | 'medium' | 'low'> = {
  project: 'high',
  session: 'high',
  transcript: 'high',
  note: 'high',
  highlight: 'high',
  category: 'high',
  cluster: 'high',
  insight: 'high',
  contact: 'high',
  participant: 'high',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(value: string): string {
  return value.toLowerCase().trim()
}

export function resolveCondensType(entityType: string): string | null | undefined {
  const lower = normalize(entityType)
  if (lower in CONDENS_TYPE_MAP) {
    return CONDENS_TYPE_MAP[lower]
  }
  return undefined  // unknown type
}

export function normalizeCondensStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  return CONDENS_STATUS_MAP[normalize(status)] ?? status
}

export function getCondensConfidence(entityType: string): 'high' | 'medium' | 'low' {
  return CONDENS_CONFIDENCE_MAP[normalize(entityType)] ?? 'low'
}

// ─── Condens Adapter ──────────────────────────────────────────────────────────

export class CondensAdapter implements UPGAdapter {
  name = 'condens'
  label = 'Condens'
  description =
    'Import research projects, sessions, transcripts, notes, highlights, categories, clusters, insights, and contacts from Condens (a European research repository).'

  /**
   * List available Condens items.
   *
   * Requires Condens API access and pre-fetched data via config.
   * The adapter is designed to be called from within a skill that has
   * already fetched items via the Condens API.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Condens adapter requires Condens API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Condens source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type drives entity type via CONDENS_TYPE_MAP
   * - metadata.parent_id + parent_type → structural edges in second pass
   * - metadata.status → normalised status via CONDENS_STATUS_MAP
   * - metadata.tags[] → node tags property
   * - metadata.contact_ids[] → research_study_enrolls_participant edges
   * - tag source type → skipped with warning (metadata only)
   * - Insight nodes → warning to link to opportunity
   * - cluster→insight deferred edges resolved after all nodes built
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Deferred cluster→insight pairs: resolved after all nodes are built
    const deferredClusterInsights: Array<{
      clusterSourceId: string
      insightSourceId: string
    }> = []

    let insightCount = 0
    let counter = 0

    // ── Pass 1: build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const entityTypeLower = normalize(rawEntityType)

      // Resolve UPG type
      const resolved = resolveCondensType(rawEntityType)

      if (resolved === undefined) {
        // Unknown type
        warnings.push(
          `Unknown Condens entity_type "${rawEntityType}" for "${item.title}". Skipped. ` +
            `Add it to CONDENS_TYPE_MAP if this is a new Condens entity type.`,
        )
        continue
      }

      if (resolved === null) {
        // Explicitly unmappable (tag)
        warnings.push(
          `Condens "${rawEntityType}" items are metadata labels and have no UPG equivalent. ` +
            `"${item.title}" skipped: tags are preserved as properties on observation/quote nodes.`,
        )
        continue
      }

      counter++
      const nodeId = `condens-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : []
      const rawStatus = meta.status as string | undefined
      const status = normalizeCondensStatus(rawStatus)
      const confidence = getCondensConfidence(entityTypeLower)

      // Deferred cluster→insight edge registration
      if (resolved === 'insight') {
        insightCount++
        const clusterIds = Array.isArray(meta.cluster_ids)
          ? (meta.cluster_ids as string[])
          : []
        for (const clusterId of clusterIds) {
          deferredClusterInsights.push({
            clusterSourceId: clusterId,
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
        external_tool: 'condens',
        external_id: item.source_id,
      }

      nodes.push(node)
    }

    // ── Pass 2: emit structural edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const rawEntityType = (meta.entity_type as string | undefined) ?? item.source_type
      const resolved = CONDENS_TYPE_MAP[normalize(rawEntityType)]
      if (resolved === null || resolved === undefined) continue

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const parentId = meta.parent_id as string | undefined
      const parentType = normalize((meta.parent_type as string | undefined) ?? '')
      const contactIds = Array.isArray(meta.contact_ids) ? (meta.contact_ids as string[]) : []

      if (parentId) {
        const parentNodeId = sourceMap[parentId]
        if (!parentNodeId) {
          warnings.push(
            `Condens item "${item.title}" references parent_id "${parentId}" which was not found ` +
              `in the imported set. Edge skipped.`,
          )
        } else {
          const edgeType = resolveCondensEdge(parentType, normalize(rawEntityType))
          edges.push({
            id: `edge-condens-${parentNodeId}-${nodeId}`,
            source: parentNodeId,
            target: nodeId,
            type: edgeType as UPGEdge['type'],
            mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'high',
          })
        }
      }

      // research_study_enrolls_participant from contact_ids on project/session nodes
      if (
        (resolved === 'research_study') &&
        contactIds.length > 0
      ) {
        for (const contactId of contactIds) {
          const contactNodeId = sourceMap[contactId]
          if (contactNodeId) {
            edges.push({
              id: `edge-condens-enroll-${nodeId}-${contactNodeId}`,
              source: nodeId,
              target: contactNodeId,
              type: 'research_study_enrolls_participant',
              mapping_confidence: 'high',
            })
          }
        }
      }
    }

    // ── Resolve deferred cluster→insight edges ─────────────────────────────────
    for (const { clusterSourceId, insightSourceId } of deferredClusterInsights) {
      const clusterNodeId = sourceMap[clusterSourceId]
      const insightNodeId = sourceMap[insightSourceId]

      if (!clusterNodeId) {
        warnings.push(
          `Condens insight "${insightSourceId}" references cluster "${clusterSourceId}" which was ` +
            `not found in this batch. affinity_cluster_synthesises_insight edge skipped. ` +
            `Import the cluster in the same batch to auto-resolve this edge.`,
        )
        continue
      }

      if (!insightNodeId) continue

      edges.push({
        id: `edge-condens-deferred-${clusterNodeId}-${insightNodeId}`,
        source: clusterNodeId,
        target: insightNodeId,
        type: 'affinity_cluster_synthesises_insight',
        mapping_confidence: 'medium',  // deferred = synthesised relationship
      })
    }

    // ── Insight → opportunity warning ──────────────────────────────────────────
    if (insightCount > 0) {
      warnings.push(
        `${insightCount} insight${insightCount === 1 ? ' was' : 's were'} captured from Condens. ` +
          `Link ${insightCount === 1 ? 'it' : 'them'} to opportunities via the UPG graph ` +
          `to complete the research chain (insight_informs_opportunity). ` +
          `This edge requires explicit PM judgement.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No Condens items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the UPG edge for a Condens parent_type → entity_type pair.
 * All returned edge types verified against the UPG catalog.
 */
function resolveCondensEdge(parentType: string, childType: string): string {
  // project/session → observation (transcript, note)
  if (
    (parentType === 'project' || parentType === 'session') &&
    (childType === 'transcript' || childType === 'note')
  ) {
    return 'research_study_captures_observation'
  }

  // note/transcript → quote (highlight)
  if (
    (parentType === 'note' || parentType === 'transcript') &&
    childType === 'highlight'
  ) {
    return 'observation_evidenced_by_quote'
  }

  // project → affinity_cluster (category, cluster)
  if (
    parentType === 'project' &&
    (childType === 'category' || childType === 'cluster')
  ) {
    return 'research_study_clusters_into_affinity_cluster'
  }

  // project → insight
  if (parentType === 'project' && childType === 'insight') {
    return 'research_study_produces_insight'
  }

  // project/session → participant (contact, participant)
  if (
    (parentType === 'project' || parentType === 'session') &&
    (childType === 'contact' || childType === 'participant')
  ) {
    return 'research_study_enrolls_participant'
  }

  // category/cluster → insight
  if (
    (parentType === 'category' || parentType === 'cluster') &&
    childType === 'insight'
  ) {
    return 'affinity_cluster_synthesises_insight'
  }

  // Fallback
  return 'node_informs_node'
}
