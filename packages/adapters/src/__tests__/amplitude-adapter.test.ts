/**
 * Amplitude Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation, metric field preservation, skip+warning cases,
 * source_map integrity, and external_tool tagging.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { AmplitudeAdapter } from '../adapters/amplitude.js'
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
    source_type: 'amplitude_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new AmplitudeAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('AmplitudeAdapter: entity_type → UPG type mapping', () => {
  it('chart maps to metric with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Weekly Active Users', 'chart')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    expect(result.nodes[0].external_tool).toBe('amplitude')
  })

  it('funnel maps to metric with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Signup Funnel', 'funnel')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('retention maps to metric with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('r1', '30-day Retention', 'retention')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('cohort maps to market_segment with confidence high', async () => {
    const items: SourceItem[] = [makeItem('coh1', 'Power Users', 'cohort')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('market_segment')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('experiment maps to experiment with confidence high', async () => {
    const items: SourceItem[] = [makeItem('exp1', 'Onboarding A/B', 'experiment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('experiment')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('annotation maps to observation with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('ann1', 'Product launch', 'annotation')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('unknown entity_type defaults to document with confidence low and warning', async () => {
    const items: SourceItem[] = [makeItem('u1', 'Mystery entity', 'workspace_config')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
    expect(warnText).toContain('document')
  })
})

// ─── Skip + warning cases ─────────────────────────────────────────────────────

describe('AmplitudeAdapter: skipped types + warnings', () => {
  it('event entities are skipped with aggregate warning', async () => {
    const items: SourceItem[] = [
      makeItem('e1', 'Button Clicked', 'event'),
      makeItem('e2', 'Page Viewed', 'event'),
      makeItem('c1', 'WAU Chart', 'chart'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('metric')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('behavioral telemetry')
    expect(warnText).toContain('2 event')
  })

  it('dashboard entities are skipped with per-entity warning', async () => {
    const items: SourceItem[] = [
      makeItem('d1', 'Growth Dashboard', 'dashboard'),
      makeItem('c1', 'WAU Chart', 'chart'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('view configuration')
    expect(warnText).toContain('Growth Dashboard')
  })

  it('user entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('usr1', 'user-abc123', 'user'),
      makeItem('c1', 'Retention', 'retention'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['usr1']).toBeUndefined()
  })

  it('feature_flag entities are skipped with a warning about deployment tools', async () => {
    const items: SourceItem[] = [makeItem('ff1', 'new-onboarding-flag', 'feature_flag')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('feature flags')
    expect(warnText).toContain('PostHog')
  })

  it('skipped event entries are NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('e1', 'Button Clicked', 'event')]
    const result = await adapter.convert(items)
    expect(result.source_map['e1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('AmplitudeAdapter: status normalisation', () => {
  it("status 'active' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('c1', 'WAU', 'chart', { status: 'active' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('c1', 'Old Chart', 'chart', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('c1', 'Draft Chart', 'chart', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it('absent status produces no status property', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Chart', 'chart')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Metric value fields ──────────────────────────────────────────────────────

describe('AmplitudeAdapter: metric value fields', () => {
  it('chart with current_value, target_value, unit preserved on node', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'WAU', 'chart', {
        current_value: 12500,
        target_value: 20000,
        unit: 'users',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(12500)
    expect(node.target_value).toBe(20000)
    expect(node.unit).toBe('users')
  })

  it('funnel preserves metric value fields', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Signup Funnel', 'funnel', {
        current_value: 0.34,
        target_value: 0.5,
        unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(0.34)
    expect(node.target_value).toBe(0.5)
    expect(node.unit).toBe('%')
  })

  it('non-metric entities do not carry metric fields even if present in metadata', async () => {
    const items: SourceItem[] = [
      makeItem('coh1', 'Power Users', 'cohort', {
        current_value: 999,
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('AmplitudeAdapter: edge emission', () => {
  it('outcome_tracked_by_metric emitted when metric has outcome parent', async () => {
    const items: SourceItem[] = [
      makeItem('out1', 'Increase Activation', 'outcome'),
      makeItem('c1', 'Activation Rate', 'chart', {
        parent_id: 'out1',
        current_value: 42,
        target_value: 60,
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_tracked_by_metric')
    const edge = result.edges.find((e) => e.type === 'outcome_tracked_by_metric')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('key_result_tracked_by_metric emitted when metric has key_result parent', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'WAU hits 20k', 'key_result'),
      makeItem('c1', 'WAU Chart', 'chart', {
        parent_id: 'kr1',
        current_value: 12500,
        target_value: 20000,
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'key_result_tracked_by_metric')
    const edge = result.edges.find((e) => e.type === 'key_result_tracked_by_metric')
    expect(edge).toBeDefined()
  })

  it('node_informs_node emitted as fallback for unrecognised parent→child pair', async () => {
    const items: SourceItem[] = [
      makeItem('exp1', 'Onboarding Test', 'experiment'),
      makeItem('ann1', 'Launch note', 'annotation', { parent_id: 'exp1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'fallback node_informs_node')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('warning emitted when parent_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'WAU Chart', 'chart', { parent_id: 'nonexistent-kr' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent-kr')
    expect(warnText).toContain('Edge skipped')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('out1', 'Increase Retention', 'outcome'),
      makeItem('kr1', 'D30 Retention 40%', 'key_result'),
      makeItem('c1', 'Retention Chart', 'retention', { parent_id: 'out1', current_value: 35 }),
      makeItem('c2', 'WAU', 'chart', { parent_id: 'kr1', current_value: 15000 }),
      makeItem('exp1', 'New Onboarding Flow', 'experiment'),
      makeItem('coh1', 'Power Users', 'cohort'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'AmplitudeAdapter full fixture')
    expect(result.nodes.length).toBeGreaterThanOrEqual(4)
    expect(result.edges.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('AmplitudeAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'WAU', 'chart'),
      makeItem('exp1', 'Onboarding Test', 'experiment'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['c1']).toBeDefined()
    expect(result.source_map['exp1']).toBeDefined()
  })

  it('skipped event entries are absent from source_map', async () => {
    const items: SourceItem[] = [makeItem('ev1', 'Button Clicked', 'event')]
    const result = await adapter.convert(items)
    expect(result.source_map['ev1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('AmplitudeAdapter: external_tool and external_id', () => {
  it('external_tool is always amplitude', async () => {
    const items: SourceItem[] = [makeItem('c1', 'WAU', 'chart')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('amplitude')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('amplitude-chart-999', 'WAU', 'chart')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('amplitude-chart-999')
  })
})
