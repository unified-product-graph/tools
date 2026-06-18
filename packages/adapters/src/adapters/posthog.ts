/**
 * PostHog Adapter
 *
 * Imports product analytics entities from PostHog: an open-source analytics
 * platform with native experiment/hypothesis support.
 *
 * PostHog's unique feature: the `hypothesis` field on Experiments.
 * This is the only analytics tool in the series with a native hypothesis
 * concept, making it the richest integration for UPG's validation chain.
 *
 *
 * Edges emitted:
 * - key_result_quantified_by_metric      (when metric parent is a key_result)
 * - outcome_measured_by_metric         (when metric parent is an outcome)
 * - feature_tests_hypothesis          (experiment → hypothesis_claim node)
 *
 * Skipped with warnings:
 * - event    : raw telemetry, no UPG entity equivalent
 * - dashboard: view configuration, no UPG equivalent
 * - person   : individual user record, not product knowledge
 * - recording: session recording, no UPG entity equivalent
 *
 * Special: When an experiment has metadata.hypothesis, a linked hypothesis_claim
 * node is created and a feature_tests_hypothesis edge is emitted.
 */

import { UPG_EDGE_TYPES, getLifecycleForType } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps PostHog entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const POSTHOG_TYPE_MAP: Record<string, string | null> = {
  feature_flag: 'feature_flag',    // a PostHog flag IS a UPG feature_flag (the toggle), distinct from the feature it gates
  experiment: 'experiment',        // A/B test with hypothesis field
  insight: 'metric',               // a named analytics insight/chart = tracked metric
  dashboard: null,                 // view config: skip
  action: 'metric',                // a named user action used as a metric
  cohort: 'market_segment',        // named user segment
  survey: 'customer_feedback',     // survey responses
  notebook: 'document',            // PostHog notebook = analysis doc
  person: null,                    // individual person: not product knowledge
  event: null,                     // raw events: skip with warning
  recording: null,                 // session recording: skip
  early_access_feature: 'feature', // a beta feature opted into via an early-access program → the feature itself
}

// ─── Status normalisation ─────────────────────────────────────────────────────

export const POSTHOG_STATUS_MAP: Record<string, string> = {
  // Experiment statuses
  draft: 'draft',
  running: 'active',
  complete: 'complete',
  archived: 'abandoned',
  // Feature flag states → feature_flag phases (off | rollout | on)
  active: 'on',
  enabled: 'on',
  inactive: 'off',
  disabled: 'off',
  rollout: 'rollout',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a PostHog entity_type to a UPG entity type */
export function resolvePostHogType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in POSTHOG_TYPE_MAP) {
    return POSTHOG_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a PostHog status string to a UPG status value */
export function normalizePostHogStatus(status: string): string {
  const lower = normalizeName(status)
  return POSTHOG_STATUS_MAP[lower] ?? status
}

/** Valid status values for a UPG entity type, or null when lifecycle-free. */
function validStatusesForType(type: string): ReadonlySet<string> | null {
  const lc = getLifecycleForType(type)
  if (!lc) return null
  const set = new Set<string>()
  for (const p of lc.phases) {
    set.add(p.id)
    for (const s of p.core_states ?? []) set.add(s.id)
  }
  return set
}

/**
 * Resolve a PostHog status to a status valid for the TARGET UPG type's
 * lifecycle. Tries the raw value first (e.g. an experiment's `running` is a real
 * experiment phase), then the normalised value, and omits anything that does not
 * fit the target lifecycle rather than persisting an invalid status. Returns
 * undefined for lifecycle-free types.
 */
function resolvePostHogStatus(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const mapped = POSTHOG_STATUS_MAP[raw]
  if (mapped && valid.has(mapped)) return mapped
  return undefined
}

/** Resolve confidence for a PostHog entity_type → UPG type mapping */
export function getConfidenceForPostHogType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'feature_flag':
    case 'early_access_feature':
    case 'cohort':
    case 'experiment':
      return 'high'
    case 'insight':
    case 'action':
    case 'survey':
    case 'notebook':
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

// ─── PostHog Adapter ──────────────────────────────────────────────────────────

export class PostHogAdapter implements UPGAdapter {
  name = 'posthog'
  label = 'PostHog'
  description =
    'Import feature flags, experiments (with hypothesis), insights, cohorts, surveys, and notebooks from PostHog. PostHog is the only analytics platform with a native hypothesis field on experiments.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'PostHog adapter requires PostHog API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Maps experiment source_id → hypothesis node id (for edge pass)
    const hypothesisMap: Record<string, string> = {}

    let counter = 0
    let skippedEvents = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `posthog-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolvePostHogType(entityType)

      // Explicitly unmappable types
      if (resolved === null) {
        if (entityType === 'event') {
          skippedEvents++
        } else if (entityType === 'dashboard') {
          warnings.push(
            `PostHog dashboard "${item.title}" skipped: view configuration with no UPG equivalent.`,
          )
        } else if (entityType === 'recording') {
          // Silent skip: session recordings are media, not product knowledge entities
        } else if (entityType === 'person') {
          // Silent skip: individual person records are not product knowledge
        } else {
          warnings.push(
            `PostHog entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `PostHog entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getConfidenceForPostHogType(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Status normalisation (validated against the target lifecycle) ──────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolvePostHogStatus(rawStatus, upgEntityType) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      // ── Off-schema source fields → properties (canonical) so they persist ──
      let nodeProps: Record<string, unknown> | undefined
      if (upgEntityType === 'metric') {
        const p: Record<string, unknown> = {}
        if (meta.current_value !== undefined) p.current_value = meta.current_value as number
        if (meta.target_value !== undefined) p.target_value = meta.target_value as number
        if (meta.unit !== undefined) p.unit = meta.unit as string
        if (Object.keys(p).length > 0) nodeProps = p
      } else if (upgEntityType === 'feature_flag') {
        // Preserve the flag's own identity: key, rollout %, and lifecycle classification.
        const p: Record<string, unknown> = {}
        if (meta.key !== undefined) p.key = meta.key as string
        if (meta.rollout_pct !== undefined) p.rollout_pct = meta.rollout_pct as number
        if (meta.rollout_percentage !== undefined) p.rollout_pct = meta.rollout_percentage as number
        if (meta.flag_type !== undefined) p.flag_type = meta.flag_type as string
        if (Object.keys(p).length > 0) nodeProps = p
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
        external_tool: 'posthog',
        external_id: item.source_id,
        ...(nodeProps ? { properties: nodeProps } : {}),
      }

      nodes.push(node)

      // ── SPECIAL: hypothesis field on experiments ───────────────────────────
      // When an experiment has a hypothesis field, create a linked hypothesis_claim node
      if (entityType === 'experiment') {
        const hypothesisText = meta.hypothesis as string | undefined
        if (hypothesisText) {
          counter++
          const hypId = `posthog-hyp-${Date.now()}-${counter}`
          const hypNode: UPGBaseNode = {
            id: hypId,
            type: 'hypothesis' as UPGEntityType,
            title: hypothesisText.slice(0, 120),
            external_tool: 'posthog',
            external_id: `${item.source_id}-hypothesis`,
            mapping_confidence: 'high',
            source_id: `${item.source_id}-hypothesis`,
            source_type: 'hypothesis',
          }
          nodes.push(hypNode)
          hypothesisMap[item.source_id] = hypId
          warnings.push(
            `PostHog Experiment "${item.title}": hypothesis field found and captured as a hypothesis node. Link it to outcomes and experiments to complete the validation chain.`,
          )
        }
      }
    }

    // Emit aggregate warning for skipped events
    if (skippedEvents > 0) {
      warnings.push(
        `${skippedEvents} event${skippedEvents > 1 ? 's' : ''} skipped: PostHog raw events are behavioral telemetry data with no UPG entity equivalent.`,
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

      // ── Experiment → hypothesis_claim edge ────────────────────────────────
      const hypNodeId = hypothesisMap[item.source_id]
      if (hypNodeId) {
        // Canonical direction: hypothesis → experiment (the experiment tests the
        // hypothesis). hypothesis_tested_by_experiment, source = hypothesis.
        const edgeType = safeEdgeType(
          'hypothesis_tested_by_experiment',
          `PostHog: hypothesis_tested_by_experiment not in catalog. Falling back to node_informs_node for hypothesis → experiment "${item.title}".`,
          warnings,
        )
        edges.push({
          id: `edge-posthog-hyp-${hypNodeId}-${nodeId}`,
          source: hypNodeId,
          target: nodeId,
          type: edgeType,
          mapping_confidence: 'high',
        })
      }

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `PostHog entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve the UPG entity type for the current item
      const resolved = resolvePostHogType(entityType)
      if (!resolved) continue

      const upgEntityType = resolved

      // Determine edge type based on parent entity type
      const parentItem = items.find((i) => i.source_id === parentId)
      if (!parentItem) continue

      const parentEntityType = (parentItem.metadata?.entity_type as string | undefined) ?? ''
      const parentResolved = resolvePostHogType(parentEntityType)

      let edgeType: UPGEdgeType | null = null

      if (upgEntityType === 'metric') {
        if (parentResolved === 'key_result' || parentEntityType === 'key_result') {
          edgeType = safeEdgeType(
            'key_result_quantified_by_metric',
            `PostHog: key_result_quantified_by_metric not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        } else if (parentResolved === 'outcome' || parentEntityType === 'outcome') {
          edgeType = safeEdgeType(
            'outcome_measured_by_metric',
            `PostHog: outcome_measured_by_metric not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        }
      }

      if (edgeType === null) {
        edges.push({
          id: `edge-posthog-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-posthog-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedEvents === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
