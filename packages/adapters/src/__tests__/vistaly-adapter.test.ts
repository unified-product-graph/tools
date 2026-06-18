/**
 * Vistaly Adapter Tests (real contract, grounded in the live OpenAPI spec).
 *
 * Covers card_type → entity mapping, per-type status normalisation, metric
 * values under properties, hierarchy edge emission with correct direction, and
 * warning emission. All emitted edge types must be in the UPG catalogue.
 *
 * These exercise convert() against SourceItems shaped exactly as list()
 * produces them from a real /beta/cards/{id}/context response (card_type,
 * status, parent_id, parent_type, metric_* in metadata).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { VistalyAdapter } from '../adapters/vistaly.js'
import type { SourceItem } from '../types.js'

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
    metadata: { card_type: cardType, ...overrides },
  }
}

const adapter = new VistalyAdapter()

// ─── Card type mapping ────────────────────────────────────────────────────────

describe('VistalyAdapter: card_type → entity type (real CardType enum)', () => {
  const cases: Array<[string, string, 'high' | 'medium']> = [
    ['outcome', 'outcome', 'high'],
    ['objective', 'objective', 'high'],
    ['opportunity', 'opportunity', 'high'],
    ['solution', 'solution', 'high'],
    ['assumption', 'assumption', 'high'],
    ['experiment', 'experiment', 'high'],
    ['kpi', 'metric', 'high'],
    ['product', 'product', 'medium'],
    ['problem', 'need', 'medium'],
  ]

  for (const [cardType, upgType, confidence] of cases) {
    it(`${cardType} → ${upgType} (confidence ${confidence})`, async () => {
      const result = await adapter.convert([makeCard('c1', `A ${cardType}`, cardType)])
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].type).toBe(upgType)
      expect(result.nodes[0].mapping_confidence).toBe(confidence)
      expect(result.nodes[0].external_tool).toBe('vistaly')
      expect(result.nodes[0].external_id).toBe('c1')
    })
  }

  it('unknown card_type → document with a warning', async () => {
    const result = await adapter.convert([makeCard('c1', 'Mystery', 'sprint')])
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    expect(result.warnings?.join(' ')).toContain('unknown card_type')
  })
})

// ─── Status normalisation (per target type) ───────────────────────────────────

describe('VistalyAdapter: per-type status normalisation', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['outcome', 'on track', 'measuring'],
    ['outcome', 'uncommitted', 'identified'],
    ['opportunity', 'now', 'validated'],
    ['opportunity', 'identified', 'identified'],
    ['solution', 'idea', 'proposed'],
    ['solution', 'done', 'shipped'],
    ['experiment', 'running', 'running'],
    ['experiment', 'passed', 'done'],
    ['assumption', 'pending', 'testing'],
    ['problem', 'identified', 'raw'], // problem → need lifecycle (raw/validated/prioritized)
  ]

  for (const [cardType, vistalyStatus, upgStatus] of cases) {
    it(`${cardType} "${vistalyStatus}" → ${upgStatus}`, async () => {
      const result = await adapter.convert([
        makeCard('c1', 'x', cardType, { status: vistalyStatus }),
      ])
      expect(result.nodes[0].status).toBe(upgStatus)
    })
  }

  it('kpi/metric is lifecycle-free → no status emitted', async () => {
    const result = await adapter.convert([makeCard('c1', 'KPI', 'kpi', { status: 'within limits' })])
    expect(result.nodes[0].status).toBeUndefined()
  })

  it('an unmappable status is omitted (never persisted invalid)', async () => {
    const result = await adapter.convert([makeCard('c1', 'x', 'opportunity', { status: 'banana' })])
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Metric values under properties ──────────────────────────────────────────

describe('VistalyAdapter: metric values nested under properties', () => {
  it('kpi metric values go under node.properties (canonical), not top-level', async () => {
    const result = await adapter.convert([
      makeCard('k1', 'Activation rate', 'kpi', {
        metric_current_value: 42,
        metric_target_value: 60,
        metric_unit: '%',
      }),
    ])
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.type).toBe('metric')
    expect(node.properties).toEqual({ current_value: 42, target_value: 60, unit: '%' })
    // Not emitted as off-schema top-level fields anymore.
    expect(node.current_value).toBeUndefined()
  })
})

// ─── Hierarchy edges (type + direction) ───────────────────────────────────────

describe('VistalyAdapter: hierarchy edges with correct direction', () => {
  it('objective → outcome emits objective_advances_outcome (no longer a gap)', async () => {
    const items = [
      makeCard('obj', 'Objective', 'objective'),
      makeCard('out', 'Outcome', 'outcome', { parent_id: 'obj', parent_type: 'objective' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'objective_advances_outcome')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['obj'])
    expect(edge?.target).toBe(result.source_map['out'])
    assertAllEdgesCatalogued(result.edges, 'objective→outcome')
  })

  it('outcome → kpi emits outcome_measured_by_metric (outcome is source)', async () => {
    const items = [
      makeCard('out', 'Outcome', 'outcome'),
      makeCard('kpi', 'KPI', 'kpi', { parent_id: 'out', parent_type: 'outcome' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'outcome_measured_by_metric')
    expect(edge?.source).toBe(result.source_map['out'])
    expect(edge?.target).toBe(result.source_map['kpi'])
  })

  it('outcome → opportunity emits opportunity_pursues_outcome (opportunity is source)', async () => {
    const items = [
      makeCard('out', 'Outcome', 'outcome'),
      makeCard('opp', 'Opportunity', 'opportunity', { parent_id: 'out', parent_type: 'outcome' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'opportunity_pursues_outcome')
    // Direction flips: the child (opportunity) is the edge source.
    expect(edge?.source).toBe(result.source_map['opp'])
    expect(edge?.target).toBe(result.source_map['out'])
  })

  it('opportunity → solution emits opportunity_drives_solution', async () => {
    const items = [
      makeCard('opp', 'Opportunity', 'opportunity'),
      makeCard('sol', 'Solution', 'solution', { parent_id: 'opp', parent_type: 'opportunity' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'opportunity_drives_solution')
    expect(edge?.source).toBe(result.source_map['opp'])
    expect(edge?.target).toBe(result.source_map['sol'])
  })

  it('opportunity → problem emits opportunity_addresses_need', async () => {
    const items = [
      makeCard('opp', 'Opportunity', 'opportunity'),
      makeCard('prb', 'Problem', 'problem', { parent_id: 'opp', parent_type: 'opportunity' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'opportunity_addresses_need')
    expect(edge?.source).toBe(result.source_map['opp'])
    expect(edge?.target).toBe(result.source_map['prb'])
  })

  it('solution → experiment has no canonical edge → node_informs_node + warning', async () => {
    const items = [
      makeCard('sol', 'Solution', 'solution'),
      makeCard('exp', 'Experiment', 'experiment', { parent_id: 'sol', parent_type: 'solution' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(result.warnings?.join(' ')).toContain('No canonical UPG edge')
    assertAllEdgesCatalogued(result.edges, 'solution→experiment fallback')
  })

  it('a parent_id not in the imported set is skipped with a warning', async () => {
    const items = [makeCard('sol', 'Solution', 'solution', { parent_id: 'ghost', parent_type: 'opportunity' })]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    expect(result.warnings?.join(' ')).toContain('was not')
  })
})

// ─── Provenance + source map ──────────────────────────────────────────────────

describe('VistalyAdapter: provenance and source map', () => {
  it('external_ref is set from the card URL when present', async () => {
    const result = await adapter.convert([
      makeCard('c1', 'x', 'outcome', { card_url: 'https://app.vistaly.com/ws/cards/c1' }),
    ])
    expect(result.nodes[0].external_ref).toBe('https://app.vistaly.com/ws/cards/c1')
  })

  it('source_map maps every converted card to its node id', async () => {
    const result = await adapter.convert([
      makeCard('a', 'A', 'outcome'),
      makeCard('b', 'B', 'opportunity'),
    ])
    expect(result.source_map['a']).toBeDefined()
    expect(result.source_map['b']).toBeDefined()
  })
})
