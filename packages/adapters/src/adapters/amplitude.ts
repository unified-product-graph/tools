/**
 * Amplitude Adapter
 *
 * Imports analytical artifacts from Amplitude: a behavioural analytics tool.
 * Amplitude stores measurements, not product decisions. The adapter maps
 * Amplitude's analytical outputs into UPG's metric/experiment/validation nodes.
 *
 * Amplitude is unique in this series: it is a value pipeline, not an entity
 * translation. A named chart or funnel = a tracked metric. An experiment = an
 * experiment node. A cohort = a market segment. Raw events and individual user
 * records have no UPG equivalent and are skipped with warnings.
 *
 *
 * Edges emitted:
 * - key_result_tracked_by_metric  (when parent is a key_result)
 * - outcome_tracked_by_metric     (when parent is an outcome)
 *
 * Skipped with warnings:
 * - event    : raw telemetry, no UPG entity equivalent
 * - dashboard: view configuration, no UPG equivalent
 * - user     : individual user record, not product knowledge
 * - feature_flag: belongs to LaunchDarkly/PostHog, not Amplitude
 */

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Amplitude entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const AMPLITUDE_TYPE_MAP: Record<string, string | null> = {
  chart: 'metric',         // a named chart = a tracked metric
  dashboard: null,         // view config: skip with warning
  cohort: 'market_segment', // a named user segment
  experiment: 'experiment', // A/B test
  feature_flag: null,      // skip: feature flags belong to LaunchDarkly/PostHog
  annotation: 'observation', // a manually annotated event on a timeline
  event: null,             // raw events are behavioral data: skip with warning
  user: null,              // individual users: not product knowledge
  funnel: 'metric',        // a named funnel = a conversion metric
  retention: 'metric',     // retention chart = retention metric
}

// ─── Status normalisation ─────────────────────────────────────────────────────

export const AMPLITUDE_STATUS_MAP: Record<string, string> = {
  active: 'active',
  archived: 'abandoned',
  draft: 'draft',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve an Amplitude entity_type to a UPG entity type */
export function resolveAmplitudeType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in AMPLITUDE_TYPE_MAP) {
    return AMPLITUDE_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize an Amplitude status string to a UPG status value */
export function normalizeAmplitudeStatus(status: string): string {
  const lower = normalizeName(status)
  return AMPLITUDE_STATUS_MAP[lower] ?? status
}

/** Resolve confidence for an Amplitude entity_type → UPG type mapping */
export function getConfidenceForAmplitudeType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'experiment':
    case 'cohort':
      return 'high'
    case 'chart':
    case 'funnel':
    case 'retention':
    case 'annotation':
      return 'medium'
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

// ─── Amplitude Adapter ────────────────────────────────────────────────────────

export class AmplitudeAdapter implements UPGAdapter {
  name = 'amplitude'
  label = 'Amplitude'
  description =
    'Import charts, cohorts, experiments, funnels, and annotations from Amplitude as UPG metric, market_segment, experiment, and observation nodes.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Amplitude adapter requires Amplitude API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedEvents = 0
    let skippedDashboards = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `amplitude-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveAmplitudeType(entityType)

      // Explicitly unmappable types
      if (resolved === null) {
        if (entityType === 'event') {
          skippedEvents++
        } else if (entityType === 'dashboard') {
          skippedDashboards++
          warnings.push(
            `Amplitude dashboard "${item.title}" skipped: view configuration with no UPG equivalent.`,
          )
        } else if (entityType === 'feature_flag') {
          warnings.push(
            `Amplitude feature_flag "${item.title}" skipped: feature flags belong to the deployment tool (LaunchDarkly, PostHog). Import from there instead.`,
          )
        } else if (entityType === 'user') {
          // Silent skip: individual user records are not product knowledge
        } else {
          warnings.push(
            `Amplitude entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Amplitude entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getConfidenceForAmplitudeType(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Status normalisation ───────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeAmplitudeStatus(rawStatus) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      // ── Build the UPG node ─────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: upgEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'amplitude',
        external_id: item.source_id,
        // Metric-specific fields preserved for chart/funnel/retention entities
        ...(upgEntityType === 'metric'
          ? {
              ...(meta.current_value !== undefined ? { current_value: meta.current_value as number } : {}),
              ...(meta.target_value !== undefined ? { target_value: meta.target_value as number } : {}),
              ...(meta.unit !== undefined ? { unit: meta.unit as string } : {}),
            }
          : {}),
      }

      nodes.push(node)
    }

    // Emit aggregate warning for skipped events
    if (skippedEvents > 0) {
      warnings.push(
        `${skippedEvents} event${skippedEvents > 1 ? 's' : ''} skipped: Amplitude raw events are behavioral telemetry data with no UPG entity equivalent.`,
      )
    }

    // ── Pass 2: emit hierarchy edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Amplitude entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve the UPG entity type for the current item
      const resolved = resolveAmplitudeType(entityType)
      if (!resolved) continue

      const upgEntityType = resolved

      // Determine edge type based on parent entity type
      // We need the parent's UPG type; look it up via the parent item
      const parentItem = items.find((i) => i.source_id === parentId)
      if (!parentItem) continue

      const parentEntityType = (parentItem.metadata?.entity_type as string | undefined) ?? ''
      const parentResolved = resolveAmplitudeType(parentEntityType)

      let edgeType: UPGEdgeType | null = null

      if (upgEntityType === 'metric') {
        if (parentResolved === 'key_result' || parentEntityType === 'key_result') {
          edgeType = safeEdgeType(
            'key_result_tracked_by_metric',
            `Amplitude: key_result_tracked_by_metric not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        } else if (parentResolved === 'outcome' || parentEntityType === 'outcome') {
          edgeType = safeEdgeType(
            'outcome_tracked_by_metric',
            `Amplitude: outcome_tracked_by_metric not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        }
      }

      if (edgeType === null) {
        // Generic fallback for unrecognised parent→child pairs
        edges.push({
          id: `edge-amplitude-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-amplitude-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedEvents === 0 && skippedDashboards === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
