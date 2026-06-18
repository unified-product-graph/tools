/**
 * LaunchDarkly end-to-end import audit (convert-only adapter).
 *
 * LaunchDarkly's list() requires a live API connection; convert() is the full
 * import story so spec conformance IS the audit. Representative LD records
 * (flags, experiments, metrics, segments, projects) run through
 * convert -> writeToUPGFile -> reload, then conformanceIssues() asserts the
 * result is spec-clean: valid types, per-type statuses, no off-schema fields,
 * catalogued edges with correct endpoint types, clean round-trip.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { LaunchDarklyAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new LaunchDarklyAdapter() as unknown as AdapterLike

/**
 * Fixture grounded in the LaunchDarkly REST API payload shapes:
 * - feature_flag:  /api/v2/flags/{projectKey}/{featureKey}
 * - experiment:    /api/v2/projects/{projectKey}/experiments/{experimentKey}
 * - metric:        /api/v2/metrics/{projectKey}/{metricKey}
 * - segment:       /api/v2/segments/{projectKey}/{environmentKey}/{segmentKey}
 * - project:       /api/v2/projects/{projectKey}
 * Skipped: environment (null), webhook (null).
 */
const ITEMS = [
  {
    source_id: 'ld-flag-new-dashboard',
    source_type: 'launchdarkly',
    title: 'new-dashboard-ui',
    content: 'Gradual rollout of the redesigned dashboard experience.',
    metadata: {
      entity_type: 'feature_flag',
      project_id: 'proj-commerce',
      project_name: 'Commerce Platform',
      status: 'active', // maps to 'on' for feature_flag lifecycle
      flag_type: 'boolean',
      rollout_percentage: 25,
      tags: ['dashboard', 'beta'],
    },
  },
  {
    source_id: 'ld-flag-search-v2',
    source_type: 'launchdarkly',
    title: 'search-v2',
    metadata: {
      entity_type: 'feature_flag',
      project_id: 'proj-commerce',
      project_name: 'Commerce Platform',
      status: 'inactive', // maps to 'off' for feature_flag lifecycle
      flag_type: 'boolean',
    },
  },
  {
    source_id: 'ld-exp-dashboard-ab',
    source_type: 'launchdarkly',
    title: 'Dashboard redesign A/B test',
    content: 'Testing whether the new dashboard increases task completion.',
    metadata: {
      entity_type: 'experiment',
      project_id: 'proj-commerce',
      status: 'running', // valid experiment phase
      variation_count: 2,
    },
  },
  {
    source_id: 'ld-metric-task-completion',
    source_type: 'launchdarkly',
    title: 'Task completion rate',
    content: 'Percentage of users completing at least one task within 7 days.',
    metadata: {
      entity_type: 'metric',
      project_id: 'proj-commerce',
      // metric is lifecycle-free: no status
    },
  },
  {
    source_id: 'ld-seg-power-users',
    source_type: 'launchdarkly',
    title: 'Power users',
    metadata: {
      entity_type: 'segment',
      project_id: 'proj-commerce',
      // market_segment is lifecycle-free: no status
    },
  },
  {
    source_id: 'ld-proj-commerce',
    source_type: 'launchdarkly',
    title: 'Commerce Platform',
    metadata: { entity_type: 'project' },
  },
  // Skipped types: included to confirm warnings, not nodes
  {
    source_id: 'ld-env-prod',
    source_type: 'launchdarkly',
    title: 'production',
    metadata: { entity_type: 'environment' },
  },
  {
    source_id: 'ld-webhook-deploy',
    source_type: 'launchdarkly',
    title: 'deploy-hook',
    metadata: { entity_type: 'webhook' },
  },
]

describe('LaunchDarkly e2e — convert conformance', () => {
  it('produces a spec-conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps the core LD types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const bySourceId = Object.fromEntries(
        out.result.nodes.map((n) => [n.source_id as string, n.type as string]),
      )
      expect(bySourceId['ld-flag-new-dashboard']).toBe('feature_flag')
      expect(bySourceId['ld-flag-search-v2']).toBe('feature_flag')
      expect(bySourceId['ld-exp-dashboard-ab']).toBe('experiment')
      expect(bySourceId['ld-metric-task-completion']).toBe('metric')
      expect(bySourceId['ld-seg-power-users']).toBe('market_segment')
      expect(bySourceId['ld-proj-commerce']).toBe('project')
    } finally {
      await out.cleanup()
    }
  })

  it('maps feature_flag statuses to valid feature_flag lifecycle phases', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const flagOn = out.result.nodes.find((n) => n.source_id === 'ld-flag-new-dashboard')
      const flagOff = out.result.nodes.find((n) => n.source_id === 'ld-flag-search-v2')
      // 'active' -> 'on'; 'inactive' -> 'off' (both valid feature_flag phases)
      expect(flagOn?.status).toBe('on')
      expect(flagOff?.status).toBe('off')
    } finally {
      await out.cleanup()
    }
  })

  it('does not set status on lifecycle-free types (metric, market_segment)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const metric = out.result.nodes.find((n) => n.source_id === 'ld-metric-task-completion')
      const segment = out.result.nodes.find((n) => n.source_id === 'ld-seg-power-users')
      expect(metric?.status).toBeUndefined()
      expect(segment?.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('nests flag_type and rollout_percentage under properties (not top-level)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const flagRaw = out.rawDoc.nodes.find(
        (n) => n.source_id === 'ld-flag-new-dashboard',
      ) as Record<string, unknown>
      expect(flagRaw).toBeDefined()
      expect(flagRaw.flag_type).toBeUndefined()
      expect(flagRaw.project_id).toBeUndefined()
      expect(flagRaw.rollout_percentage).toBeUndefined()
      const props = flagRaw.properties as Record<string, unknown>
      expect(props.flag_type).toBe('boolean')
      expect(props.rollout_percentage).toBe(25)
    } finally {
      await out.cleanup()
    }
  })

  it('emits service_toggles_feature_flag edge with correct endpoint types', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const serviceEdges = out.rawDoc.edges.filter((e) => e.type === 'service_toggles_feature_flag')
      // 2 flags in the same project -> 2 service->flag edges, 1 service node
      expect(serviceEdges.length).toBe(2)
      const nodeTypeById = new Map(out.rawDoc.nodes.map((n) => [n.id as string, n.type as string]))
      for (const edge of serviceEdges) {
        expect(nodeTypeById.get(edge.source as string)).toBe('service')
        expect(nodeTypeById.get(edge.target as string)).toBe('feature_flag')
      }
    } finally {
      await out.cleanup()
    }
  })

  it('creates exactly one synthetic service node per project', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const serviceNodes = out.result.nodes.filter((n) => n.type === 'service')
      expect(serviceNodes).toHaveLength(1)
      expect(serviceNodes[0]?.title).toContain('Commerce Platform')
    } finally {
      await out.cleanup()
    }
  })

  it('skips environment and webhook with warnings but no nodes', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const warnText = out.result.warnings?.join(' ') ?? ''
      expect(warnText).toContain('environment')
      expect(warnText).toContain('webhook')
      const envNodes = out.result.nodes.filter(
        (n) => n.source_id === 'ld-env-prod' || n.source_id === 'ld-webhook-deploy',
      )
      expect(envNodes).toHaveLength(0)
    } finally {
      await out.cleanup()
    }
  })
})
