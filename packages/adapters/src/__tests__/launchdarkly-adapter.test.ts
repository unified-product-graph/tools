/**
 * LaunchDarkly Adapter Tests
 *
 * Covers type mapping, service node creation, service_toggles_feature_flag
 * edge emission, status normalisation, skip cases, and the full catalog check.
 *
 * CRITICAL: The service node creation is the most important test; it ensures
 * the adapter creates a synthetic `service` node per project as the intermediary
 * for service_toggles_feature_flag edges.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { LaunchDarklyAdapter } from '../adapters/launchdarkly.js'
import type { SourceItem } from '../types.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

function makeItem(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: entityType,
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new LaunchDarklyAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('LaunchDarklyAdapter: entity type mapping', () => {
  it('feature_flag maps to feature_flag with high confidence', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'new-checkout-flow', 'feature_flag', {
        project_id: 'proj-1',
        project_name: 'Commerce',
      }),
    ]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode).toBeDefined()
    expect(flagNode?.mapping_confidence).toBe('high')
    expect(flagNode?.external_tool).toBe('launchdarkly')
  })

  it('experiment maps to experiment with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('e1', 'Checkout A/B test', 'experiment')]
    const result = await adapter.convert(items)
    const expNode = result.nodes.find((n) => n.type === 'experiment')
    expect(expNode).toBeDefined()
    expect(expNode?.mapping_confidence).toBe('medium')
  })

  it('metric maps to metric with high confidence', async () => {
    const items: SourceItem[] = [makeItem('m1', 'Conversion rate', 'metric')]
    const result = await adapter.convert(items)
    const metricNode = result.nodes.find((n) => n.type === 'metric')
    expect(metricNode).toBeDefined()
    expect(metricNode?.mapping_confidence).toBe('high')
  })

  it('segment maps to market_segment', async () => {
    const items: SourceItem[] = [makeItem('seg1', 'Power users', 'segment')]
    const result = await adapter.convert(items)
    const segNode = result.nodes.find((n) => n.type === 'market_segment')
    expect(segNode).toBeDefined()
  })

  it('project maps to project', async () => {
    const items: SourceItem[] = [makeItem('proj1', 'Commerce Platform', 'project')]
    const result = await adapter.convert(items)
    const projNode = result.nodes.find((n) => n.type === 'project')
    expect(projNode).toBeDefined()
  })
})

// ─── Service node creation ────────────────────────────────────────────────────

describe('LaunchDarklyAdapter: synthetic service node creation', () => {
  it('creates one service node when a feature_flag is imported', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'new-checkout-flow', 'feature_flag', {
        project_id: 'proj-abc',
        project_name: 'Commerce',
      }),
    ]
    const result = await adapter.convert(items)
    const serviceNode = result.nodes.find((n) => n.type === 'service')
    expect(serviceNode).toBeDefined()
    expect(serviceNode?.title).toContain('Commerce')
    expect(serviceNode?.title).toContain('LaunchDarkly')
    expect(serviceNode?.external_tool).toBe('launchdarkly')
  })

  it('creates only ONE service node for multiple flags in the same project', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'flag-a', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
      makeItem('ff2', 'flag-b', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
      makeItem('ff3', 'flag-c', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
    ]
    const result = await adapter.convert(items)
    const serviceNodes = result.nodes.filter((n) => n.type === 'service')
    expect(serviceNodes).toHaveLength(1)
  })

  it('creates separate service nodes for different projects', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'flag-a', 'feature_flag', { project_id: 'proj-1', project_name: 'App 1' }),
      makeItem('ff2', 'flag-b', 'feature_flag', { project_id: 'proj-2', project_name: 'App 2' }),
    ]
    const result = await adapter.convert(items)
    const serviceNodes = result.nodes.filter((n) => n.type === 'service')
    expect(serviceNodes).toHaveLength(2)
  })

  it('emits service node warning about synthetic node', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'flag-a', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('synthetic Service node')
    expect(warnText).toContain('service_toggles_feature_flag')
  })
})

// ─── service_toggles_feature_flag edge ───────────────────────────────────────

describe('LaunchDarklyAdapter: service_toggles_feature_flag edge', () => {
  it('emits service_toggles_feature_flag from service node to feature_flag node', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'new-checkout-flow', 'feature_flag', {
        project_id: 'proj-1',
        project_name: 'Commerce',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'service_toggles_feature_flag')
    const edge = result.edges.find((e) => e.type === 'service_toggles_feature_flag')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')

    // Source should be the service node
    const serviceNode = result.nodes.find((n) => n.type === 'service')
    expect(edge?.source).toBe(serviceNode?.id)

    // Target should be the feature_flag node
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(edge?.target).toBe(flagNode?.id)
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'flag-a', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
      makeItem('ff2', 'flag-b', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
      makeItem('e1', 'Checkout A/B', 'experiment'),
      makeItem('m1', 'Conversion rate', 'metric'),
      makeItem('seg1', 'Power users', 'segment'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'LaunchDarklyAdapter full fixture')
    // At least 2 service_toggles_feature_flag edges (one per flag)
    const serviceEdges = result.edges.filter((e) => e.type === 'service_toggles_feature_flag')
    expect(serviceEdges).toHaveLength(2)
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('LaunchDarklyAdapter: skip cases', () => {
  it('environment is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('env1', 'production', 'environment'),
      makeItem('ff1', 'flag-a', 'feature_flag', { project_id: 'proj-1', project_name: 'App' }),
    ]
    const result = await adapter.convert(items)
    const flagNodes = result.nodes.filter((n) => n.type === 'feature_flag')
    expect(flagNodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('environment')
  })

  it('webhook is skipped', async () => {
    const items: SourceItem[] = [makeItem('wh1', 'deploy-hook', 'webhook')]
    const result = await adapter.convert(items)
    // Only 0 product-knowledge nodes (no service node created; no feature_flag)
    const productNodes = result.nodes.filter((n) => n.type !== 'service')
    expect(productNodes).toHaveLength(0)
  })

  it('approval_request is skipped', async () => {
    const items: SourceItem[] = [makeItem('ar1', 'Enable dark mode', 'approval_request')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('LaunchDarklyAdapter: status normalisation', () => {
  it("status 'active' → 'on' (valid feature_flag phase)", async () => {
    // feature_flag lifecycle: off | rollout | on
    const items: SourceItem[] = [makeItem('ff1', 'Flag A', 'feature_flag', {
      project_id: 'p1', status: 'active',
    })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.status).toBe('on')
  })

  it("status 'archived' → 'off' (valid feature_flag phase)", async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Old Flag', 'feature_flag', {
      project_id: 'p1', status: 'archived',
    })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.status).toBe('off')
  })

  it("status 'new' → 'off' (valid feature_flag phase)", async () => {
    const items: SourceItem[] = [makeItem('ff1', 'New Flag', 'feature_flag', {
      project_id: 'p1', status: 'new',
    })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.status).toBe('off')
  })

  it("status 'launched' → 'on' (valid feature_flag phase)", async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Launched Flag', 'feature_flag', {
      project_id: 'p1', status: 'launched',
    })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.status).toBe('on')
  })

  it('flag_type and project_id are nested under properties, not top-level', async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Flag A', 'feature_flag', {
      project_id: 'proj-x', flag_type: 'boolean', rollout_percentage: 50,
    })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag') as Record<string, unknown>
    expect(flagNode?.flag_type).toBeUndefined()
    expect(flagNode?.project_id).toBeUndefined()
    expect(flagNode?.rollout_percentage).toBeUndefined()
    const props = flagNode?.properties as Record<string, unknown>
    expect(props?.flag_type).toBe('boolean')
    expect(props?.project_id).toBe('proj-x')
    expect(props?.rollout_percentage).toBe(50)
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('LaunchDarklyAdapter: source_map, external_tool, external_id', () => {
  it('external_tool is always launchdarkly', async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Flag A', 'feature_flag', { project_id: 'p1' })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.external_tool).toBe('launchdarkly')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('ld-flag-xyz', 'Flag', 'feature_flag', { project_id: 'p1' })]
    const result = await adapter.convert(items)
    const flagNode = result.nodes.find((n) => n.type === 'feature_flag')
    expect(flagNode?.external_id).toBe('ld-flag-xyz')
  })

  it('source_map contains feature_flag and its associated service entry', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'Flag A', 'feature_flag', { project_id: 'proj-x' }),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['ff1']).toBeDefined()
    expect(result.source_map['service-proj-x']).toBeDefined()
  })
})
