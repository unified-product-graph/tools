/**
 * PostHog Adapter Tests
 *
 * Covers all entity_type mappings, hypothesis node creation, edge emission,
 * status normalisation, metric field preservation, skip+warning cases,
 * source_map integrity, and external_tool tagging.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { PostHogAdapter } from '../adapters/posthog.js'
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
    source_type: 'posthog_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new PostHogAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('PostHogAdapter: entity_type → UPG type mapping', () => {
  it('feature_flag maps to feature_flag (the toggle), not feature, with confidence high', async () => {
    // The flag is the toggle mechanism; UPG models it as its own feature_flag
    // entity (which gates a feature), distinct from the feature itself.
    const items: SourceItem[] = [makeItem('ff1', 'new-onboarding', 'feature_flag')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature_flag')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('posthog')
  })

  it('early_access_feature maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeItem('eaf1', 'AI Suggestions Beta', 'early_access_feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('experiment maps to experiment with confidence high', async () => {
    const items: SourceItem[] = [makeItem('exp1', 'Onboarding A/B', 'experiment')]
    const result = await adapter.convert(items)
    // Experiment without hypothesis → just the experiment node
    expect(result.nodes[0].type).toBe('experiment')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('insight maps to metric with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('ins1', 'WAU Trend', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('action maps to metric with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('act1', 'Signed Up', 'action')]
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

  it('survey maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('sur1', 'NPS Survey Q2', 'survey')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('notebook maps to document with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('nb1', 'Onboarding Analysis', 'notebook')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('unknown entity_type defaults to document with low confidence and warning', async () => {
    const items: SourceItem[] = [makeItem('u1', 'Mystery', 'plugin_config')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── SPECIAL: hypothesis field ────────────────────────────────────────────────

describe('PostHogAdapter: hypothesis field on experiments', () => {
  it('experiment with hypothesis creates an extra hypothesis_claim node', async () => {
    const items: SourceItem[] = [
      makeItem('exp1', 'Wizard vs Checklist', 'experiment', {
        hypothesis: 'Users who see the wizard complete onboarding at a higher rate',
      }),
    ]
    const result = await adapter.convert(items)
    // Should have 2 nodes: experiment + hypothesis (canonical; hypothesis_claim is deprecated)
    expect(result.nodes).toHaveLength(2)
    const hyp = result.nodes.find((n) => n.type === 'hypothesis')
    expect(hyp).toBeDefined()
    expect(hyp?.title).toContain('Users who see the wizard')
    expect(hyp?.external_tool).toBe('posthog')
  })

  it('hypothesis title is truncated to 120 characters', async () => {
    const longText = 'A'.repeat(200)
    const items: SourceItem[] = [
      makeItem('exp1', 'Long Hypothesis Experiment', 'experiment', {
        hypothesis: longText,
      }),
    ]
    const result = await adapter.convert(items)
    const hyp = result.nodes.find((n) => n.type === 'hypothesis')
    expect(hyp?.title.length).toBe(120)
  })

  it('hypothesis_tested_by_experiment edge emitted (hypothesis → experiment direction)', async () => {
    const items: SourceItem[] = [
      makeItem('exp1', 'Wizard A/B', 'experiment', {
        hypothesis: 'Wizard improves activation',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'hypothesis_tested_by_experiment')
    const edge = result.edges.find((e) => e.type === 'hypothesis_tested_by_experiment')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')
    // Canonical direction: source is the hypothesis, target is the experiment.
    const exp = result.nodes.find((n) => n.type === 'experiment')
    const hyp = result.nodes.find((n) => n.type === 'hypothesis')
    expect(edge?.source).toBe(hyp?.id)
    expect(edge?.target).toBe(exp?.id)
  })

  it('experiment without hypothesis creates only one node and no hypothesis edge', async () => {
    const items: SourceItem[] = [
      makeItem('exp1', 'Onboarding Test', 'experiment'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('experiment')
    const hypEdge = result.edges.find((e) => e.type === 'hypothesis_tested_by_experiment')
    expect(hypEdge).toBeUndefined()
  })

  it('hypothesis warning is emitted when hypothesis field is found', async () => {
    const items: SourceItem[] = [
      makeItem('exp1', 'Test', 'experiment', { hypothesis: 'Users want X' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('hypothesis field found')
    expect(warnText).toContain('hypothesis node')
  })
})

// ─── Skip + warning cases ─────────────────────────────────────────────────────

describe('PostHogAdapter: skipped types + warnings', () => {
  it('event entities are skipped with aggregate warning', async () => {
    const items: SourceItem[] = [
      makeItem('e1', 'button_click', 'event'),
      makeItem('e2', 'page_view', 'event'),
      makeItem('ff1', 'new-onboarding', 'feature_flag'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('behavioral telemetry')
    expect(warnText).toContain('2 event')
  })

  it('dashboard entities are skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('d1', 'Growth Dashboard', 'dashboard'),
      makeItem('ins1', 'WAU', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('view configuration')
  })

  it('recording entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('rec1', 'session-abc123', 'recording'),
      makeItem('ins1', 'WAU', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['rec1']).toBeUndefined()
  })

  it('person entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('per1', 'user@example.com', 'person'),
      makeItem('ins1', 'WAU', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['per1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('PostHogAdapter: status normalisation (validated against target lifecycle)', () => {
  it("experiment 'running' passes through (a real experiment phase)", async () => {
    const items: SourceItem[] = [makeItem('exp1', 'Test', 'experiment', { status: 'running' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('running')
  })

  it("experiment 'complete' maps to the STUDY 'complete' phase", async () => {
    // experiment folded onto the STUDY template (0.21.0); 'complete' is now its
    // terminal phase, so the value is persisted rather than dropped as invalid.
    const items: SourceItem[] = [makeItem('exp1', 'Done Test', 'experiment', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("a feature_flag status with no matching feature phase is omitted (never persisted invalid)", async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Flag', 'feature_flag', { status: 'running' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it("metric (insight) is lifecycle-free → no status emitted", async () => {
    const items: SourceItem[] = [makeItem('ins1', 'Old Insight', 'insight', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Metric value fields ──────────────────────────────────────────────────────

describe('PostHogAdapter: metric values under properties', () => {
  it('insight metric values are nested under properties (survive the round-trip)', async () => {
    const items: SourceItem[] = [
      makeItem('ins1', 'WAU', 'insight', {
        current_value: 8500,
        target_value: 12000,
        unit: 'users',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.properties).toEqual({ current_value: 8500, target_value: 12000, unit: 'users' })
    expect(node.current_value).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('PostHogAdapter: edge emission', () => {
  it('outcome_measured_by_metric emitted when metric has outcome parent', async () => {
    const items: SourceItem[] = [
      makeItem('out1', 'Improve Activation', 'outcome'),
      makeItem('ins1', 'Activation Rate', 'insight', { parent_id: 'out1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_measured_by_metric')
    const edge = result.edges.find((e) => e.type === 'outcome_measured_by_metric')
    expect(edge).toBeDefined()
  })

  it('key_result_quantified_by_metric emitted when metric has key_result parent', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'WAU 20k', 'key_result'),
      makeItem('ins1', 'WAU Chart', 'insight', { parent_id: 'kr1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'key_result_quantified_by_metric')
    const edge = result.edges.find((e) => e.type === 'key_result_quantified_by_metric')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('out1', 'Increase Activation', 'outcome'),
      makeItem('kr1', 'D7 Activation 60%', 'key_result'),
      makeItem('ins1', 'Activation Rate', 'insight', { parent_id: 'out1', current_value: 42 }),
      makeItem('ins2', 'WAU', 'insight', { parent_id: 'kr1', current_value: 15000 }),
      makeItem('exp1', 'Wizard Test', 'experiment', { hypothesis: 'Wizard improves activation' }),
      makeItem('ff1', 'new-wizard', 'feature_flag'),
      makeItem('coh1', 'Activated Users', 'cohort'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'PostHogAdapter full fixture')
    // Should have: 2 metric edges + 1 hypothesis edge
    expect(result.edges.length).toBeGreaterThanOrEqual(3)
    // experiment node + hypothesis_claim node + other nodes
    expect(result.nodes.length).toBeGreaterThanOrEqual(7)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('PostHogAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('ff1', 'Flag', 'feature_flag'),
      makeItem('ins1', 'WAU', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['ff1']).toBeDefined()
    expect(result.source_map['ins1']).toBeDefined()
  })

  it('skipped dashboard is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('d1', 'Dashboard', 'dashboard')]
    const result = await adapter.convert(items)
    expect(result.source_map['d1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('PostHogAdapter: external_tool and external_id', () => {
  it('external_tool is always posthog', async () => {
    const items: SourceItem[] = [makeItem('ff1', 'Flag', 'feature_flag')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('posthog')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('posthog-flag-42', 'Flag', 'feature_flag')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('posthog-flag-42')
  })
})
