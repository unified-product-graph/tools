/**
 * Vistaly Adapter Tests
 *
 * Covers all card_type mappings, edge emission from parent/child relationships,
 * status normalisation, metric field preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { VistalyAdapter } from '../adapters/vistaly.js'
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

function makeCard(
  id: string,
  title: string,
  cardType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'card',
    title,
    metadata: {
      card_type: cardType,
      ...overrides,
    },
  }
}

const adapter = new VistalyAdapter()

// ─── Card type mapping ────────────────────────────────────────────────────────

describe('VistalyAdapter: card_type → entity type mapping', () => {
  it('vision card maps to vision with confidence high', async () => {
    const items: SourceItem[] = [makeCard('v1', 'Our Vision', 'vision')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('vision')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('vistaly')
  })

  it('outcome card maps to outcome', async () => {
    const items: SourceItem[] = [makeCard('o1', 'Increase Activation', 'outcome')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('outcome')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('KPI card maps to metric with current_value and target_value preserved', async () => {
    const items: SourceItem[] = [
      makeCard('k1', 'Activation Rate', 'kpi', {
        metric_current_value: 42,
        metric_target_value: 60,
        metric_unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    // Metric-specific fields should be preserved on the node
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(42)
    expect(node.target_value).toBe(60)
    expect(node.unit).toBe('%')
  })

  it('metric card type also maps to metric', async () => {
    const items: SourceItem[] = [
      makeCard('m1', 'Revenue', 'metric', {
        metric_current_value: 100000,
        metric_target_value: 150000,
        metric_unit: 'USD',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(100000)
    expect(node.target_value).toBe(150000)
    expect(node.unit).toBe('USD')
  })

  it('opportunity card maps to opportunity', async () => {
    const items: SourceItem[] = [makeCard('op1', 'Users struggle with onboarding', 'opportunity')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('solution card maps to solution', async () => {
    const items: SourceItem[] = [makeCard('s1', 'Progressive onboarding wizard', 'solution')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('solution')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('experiment card maps to experiment with confidence medium and a warning about splitting', async () => {
    const items: SourceItem[] = [makeCard('e1', 'Test wizard vs checklist', 'experiment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('experiment')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('hypothesis')
    expect(warnText).toContain('splitting')
  })

  it('assumption_test card maps to experiment', async () => {
    const items: SourceItem[] = [makeCard('at1', 'Users will complete the wizard', 'assumption_test')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('experiment')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('interview card maps to research_study with a warning about flat structure', async () => {
    const items: SourceItem[] = [makeCard('i1', 'Customer discovery interview', 'interview')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('research_study')
    expect(warnText).toContain('Dovetail')
  })

  it('feedback card maps to customer_feedback', async () => {
    const items: SourceItem[] = [makeCard('f1', 'Users want dark mode', 'feedback')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('objective card maps to objective', async () => {
    const items: SourceItem[] = [makeCard('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('initiative card maps to initiative', async () => {
    const items: SourceItem[] = [makeCard('init1', 'Onboarding revamp', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('assumption card maps to assumption', async () => {
    const items: SourceItem[] = [makeCard('a1', 'Users value speed over features', 'assumption')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('assumption')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Sprint card skipped ──────────────────────────────────────────────────────

describe('VistalyAdapter: sprint card skipped with warning', () => {
  it('sprint card is skipped and a warning is emitted', async () => {
    const items: SourceItem[] = [
      makeCard('sp1', 'Sprint 12', 'sprint'),
      makeCard('op1', 'Real opportunity', 'opportunity'),
    ]
    const result = await adapter.convert(items)
    // Only the opportunity should be in nodes
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('opportunity')
    // Warning about sprint
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('sprint')
    expect(warnText).toContain('no UPG equivalent')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('VistalyAdapter: status normalisation', () => {
  it("status 'released' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'Shipped outcome', 'outcome', { status: 'released' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'new' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'New opportunity', 'opportunity', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'under-consideration' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'Considered', 'opportunity', { status: 'under-consideration' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'planned' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'Planned', 'outcome', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'in-progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'In flight', 'outcome', { status: 'in-progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'won't-do' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeCard('o1', 'Dropped idea', 'opportunity', { status: "won't-do" })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Hierarchy edge emission ──────────────────────────────────────────────────

describe('VistalyAdapter: edge emission', () => {
  it('opportunity_pursues_outcome emitted when opportunity has outcome parent', async () => {
    const items: SourceItem[] = [
      makeCard('out1', 'Increase activation', 'outcome'),
      makeCard('opp1', 'Users stuck in onboarding', 'opportunity', {
        parent_id: 'out1',
        parent_type: 'outcome',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'opportunity_pursues_outcome')
    const edge = result.edges.find((e) => e.type === 'opportunity_pursues_outcome')
    expect(edge).toBeDefined()
    // Edge confidence should be medium
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('opportunity_drives_solution emitted when solution has opportunity parent', async () => {
    const items: SourceItem[] = [
      makeCard('opp1', 'Users stuck in onboarding', 'opportunity'),
      makeCard('sol1', 'Progressive wizard', 'solution', {
        parent_id: 'opp1',
        parent_type: 'opportunity',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'opportunity_drives_solution')
    const edge = result.edges.find((e) => e.type === 'opportunity_drives_solution')
    expect(edge).toBeDefined()
  })

  it('solution_proposes_hypothesis emitted when experiment has solution parent', async () => {
    const items: SourceItem[] = [
      makeCard('sol1', 'Progressive wizard', 'solution'),
      makeCard('exp1', 'Test wizard format', 'experiment', {
        parent_id: 'sol1',
        parent_type: 'solution',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'solution_proposes_hypothesis')
    const edge = result.edges.find((e) => e.type === 'solution_proposes_hypothesis')
    expect(edge).toBeDefined()
  })

  it('assumption_becomes_hypothesis emitted when experiment has assumption parent', async () => {
    const items: SourceItem[] = [
      makeCard('ass1', 'Users value speed', 'assumption'),
      makeCard('exp1', 'Speed vs features test', 'experiment', {
        parent_id: 'ass1',
        parent_type: 'assumption',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'assumption_becomes_hypothesis')
    const edge = result.edges.find((e) => e.type === 'assumption_becomes_hypothesis')
    expect(edge).toBeDefined()
  })

  it('outcome_measured_by_metric emitted when kpi has outcome parent', async () => {
    const items: SourceItem[] = [
      makeCard('out1', 'Improve activation', 'outcome'),
      makeCard('kpi1', 'Activation Rate', 'kpi', {
        parent_id: 'out1',
        parent_type: 'outcome',
        metric_current_value: 42,
        metric_target_value: 60,
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_measured_by_metric')
    const edge = result.edges.find((e) => e.type === 'outcome_measured_by_metric')
    expect(edge).toBeDefined()
  })

  it('insight_informs_opportunity emitted when opportunity has interview parent (with warning)', async () => {
    const items: SourceItem[] = [
      makeCard('int1', 'Customer interview', 'interview'),
      makeCard('opp1', 'Pain point from research', 'opportunity', {
        parent_id: 'int1',
        parent_type: 'interview',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'insight_informs_opportunity')
    const edge = result.edges.find((e) => e.type === 'insight_informs_opportunity')
    expect(edge).toBeDefined()
    // Should warn about the insight bridge
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('insight')
  })

  it('objective→outcome relationship emits a warning and no direct edge', async () => {
    const items: SourceItem[] = [
      makeCard('obj1', 'Grow retention', 'objective'),
      makeCard('out1', 'Users complete core action', 'outcome', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    // No edge should be emitted for objective→outcome
    const directEdge = result.edges.find(
      (e) => e.type !== 'node_informs_node',
    )
    expect(directEdge).toBeUndefined()
    // Warning must mention key_result
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('key_result')
  })

  it('all emitted edges are in the UPG catalogue (full tree fixture)', async () => {
    const items: SourceItem[] = [
      makeCard('out1', 'Increase activation', 'outcome'),
      makeCard('kpi1', 'Activation Rate', 'kpi', { parent_id: 'out1', parent_type: 'outcome' }),
      makeCard('opp1', 'Onboarding drop-off', 'opportunity', { parent_id: 'out1', parent_type: 'outcome' }),
      makeCard('sol1', 'Progressive wizard', 'solution', { parent_id: 'opp1', parent_type: 'opportunity' }),
      makeCard('exp1', 'A/B test wizard vs checklist', 'experiment', { parent_id: 'sol1', parent_type: 'solution' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'VistalyAdapter full tree fixture')
    // Should have 4 edges: kpi←outcome, opportunity→outcome, solution←opportunity, experiment←solution
    expect(result.edges.length).toBe(4)
  })
})

// ─── Tags + labels ────────────────────────────────────────────────────────────

describe('VistalyAdapter: tags and labels', () => {
  it('tags and labels are merged into node tags', async () => {
    const items: SourceItem[] = [
      makeCard('op1', 'Opportunity with labels', 'opportunity', {
        tags: ['discovery', 'q2'],
        labels: ['urgent'],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['discovery', 'q2', 'urgent'])
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('VistalyAdapter: source_map', () => {
  it('source_map contains an entry for each converted card', async () => {
    const items: SourceItem[] = [
      makeCard('v1', 'Vision', 'vision'),
      makeCard('o1', 'Outcome', 'outcome'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['v1']).toBeDefined()
    expect(result.source_map['o1']).toBeDefined()
  })

  it('skipped sprint cards are NOT in the source_map', async () => {
    const items: SourceItem[] = [
      makeCard('sp1', 'Sprint 12', 'sprint'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['sp1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('VistalyAdapter: external_tool and external_id', () => {
  it('external_tool is always vistaly', async () => {
    const items: SourceItem[] = [makeCard('v1', 'Vision', 'vision')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('vistaly')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeCard('card-999', 'Vision', 'vision')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('card-999')
  })
})
