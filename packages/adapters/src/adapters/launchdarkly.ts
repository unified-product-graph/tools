/**
 * LaunchDarkly Adapter
 *
 * Imports feature flags, experiments, metrics, and segments from LaunchDarkly :
 * the dominant feature flag and experimentation platform.
 *
 * CRITICAL STRUCTURAL NOTE:
 * There is no direct feature_flag → feature edge in the UPG catalog. The
 * connection routes through a `service` node: service_toggles_feature_flag.
 * This adapter creates a synthetic `service` node as intermediary (one per
 * LaunchDarkly project). The PM should rename this service node to their actual
 * service/product name after import.
 *
 *
 * Key edges (all verified in UPG catalog):
 * - service_toggles_feature_flag: service → feature_flag
 * - experiment_plan_ran_as_experiment_run: experiment_plan → experiment_run
 * - experiment_run_validates_hypothesis: experiment_run → hypothesis
 * - experiment_plan_targets_metric: experiment_plan → metric
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Maps LaunchDarkly entity types to UPG entity types.
 * Null = skip with warning.
 */
export const LAUNCHDARKLY_TYPE_MAP: Record<string, string | null> = {
  feature_flag: 'feature_flag', // the feature capability being toggled: exact match
  project: 'project', // LaunchDarkly project
  environment: null, // skip: operational config (prod/staging/dev)
  segment: 'market_segment', // named user segment for targeting
  metric: 'metric', // experiment metric
  experiment: 'experiment', // A/B test
  holdout: null, // holdout group: skip
  approval_request: null, // workflow item: skip
  webhook: null, // infrastructure: skip
}

/**
 * Maps LaunchDarkly status values to UPG status values.
 */
export const LAUNCHDARKLY_STATUS_MAP: Record<string, string> = {
  active: 'active',
  inactive: 'abandoned',
  new: 'draft',
  launched: 'complete', // feature fully rolled out
  archived: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

export function normalizeLaunchDarklyStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  const lower = normalizeName(status)
  return LAUNCHDARKLY_STATUS_MAP[lower] ?? status
}

export function getConfidenceForLDType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'feature_flag':
    case 'metric':
      return 'high'
    case 'experiment':
    case 'segment':
    case 'project':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── LaunchDarkly Adapter ─────────────────────────────────────────────────────

export class LaunchDarklyAdapter implements UPGAdapter {
  name = 'launchdarkly'
  label = 'LaunchDarkly'
  description =
    'Import feature flags, experiments, metrics, and segments from LaunchDarkly. Routes through a synthetic service node via service_toggles_feature_flag.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'LaunchDarkly adapter requires LaunchDarkly API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Track created service nodes by project_id to avoid duplicates
    const createdServiceNodes = new Set<string>()

    let counter = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `ld-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      const resolved = LAUNCHDARKLY_TYPE_MAP[normalizeName(entityType)]

      // Explicitly null types: skip
      if (resolved === null) {
        warnings.push(
          `LaunchDarkly item "${item.title}" has entity_type "${entityType}" which has no UPG ` +
            `equivalent (operational config not tracked in UPG). Item skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let upgType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `LaunchDarkly item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgType = 'document'
        mappingConfidence = 'low'
      } else {
        upgType = resolved
        mappingConfidence = getConfidenceForLDType(entityType)
      }

      sourceMap[item.source_id] = nodeId

      // CRITICAL: For feature_flag items, create a synthetic service node per project
      if (upgType === 'feature_flag') {
        const projectId = (meta.project_id as string | undefined) ?? 'default'
        const projectName = (meta.project_name as string | undefined) ?? 'Service'
        const serviceKey = `service-${projectId}`

        if (!createdServiceNodes.has(serviceKey)) {
          createdServiceNodes.add(serviceKey)
          const serviceNodeId = `ld-service-${projectId}`
          const serviceNode: UPGBaseNode = {
            id: serviceNodeId,
            type: 'service' as UPGEntityType,
            title: `${projectName} (LaunchDarkly)`,
            external_tool: 'launchdarkly',
            source_id: `service-${projectId}`,
            source_type: 'service',
            mapping_confidence: 'medium',
            external_id: `service-${projectId}`,
          }
          nodes.push(serviceNode)
          sourceMap[serviceKey] = serviceNodeId

          warnings.push(
            `LaunchDarkly Feature Flags route through a synthetic Service node via ` +
              `\`service_toggles_feature_flag\`. The UPG catalog routes feature_flag through service rather than direct to feature. ` +
              `The Service node was created automatically for project ` +
              `"${projectName}". Review and set its name to your actual service name.`,
          )
        }
      }

      const rawStatus = meta.status as string | undefined
      const status = normalizeLaunchDarklyStatus(rawStatus)

      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'launchdarkly',
        external_id: item.source_id,
        ...(meta.flag_type ? { flag_type: meta.flag_type as string } : {}),
        ...(meta.project_id ? { project_id: meta.project_id as string } : {}),
      }

      nodes.push(node)
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const projectId = (meta.project_id as string | undefined) ?? 'default'

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const upgType = LAUNCHDARKLY_TYPE_MAP[normalizeName(entityType)]

      // feature_flag → emit service_toggles_feature_flag from service node
      if (upgType === 'feature_flag') {
        const serviceNodeId = sourceMap[`service-${projectId}`]
        if (serviceNodeId) {
          edges.push({
            id: `edge-ld-service-${nodeId}`,
            source: serviceNodeId,
            target: nodeId,
            type: 'service_toggles_feature_flag' as UPGEdgeType,
            mapping_confidence: 'high',
          })
        }
      }

      // Parent-based edges for other types
      if (!parentId) continue
      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `LaunchDarkly item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // experiment → experiment_run: experiment_plan_ran_as_experiment_run
      // (parent = experiment, child = experiment_run/iteration)
      const parentResolved = LAUNCHDARKLY_TYPE_MAP[normalizeName((meta.parent_type as string | undefined) ?? '')]
      if (parentResolved === 'experiment' && upgType === 'experiment') {
        edges.push({
          id: `edge-ld-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'experiment_plan_ran_as_experiment_run' as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      } else {
        // Generic fallback
        edges.push({
          id: `edge-ld-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
      }
    }

    if (nodes.length === 0) {
      warnings.push('No LaunchDarkly items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
