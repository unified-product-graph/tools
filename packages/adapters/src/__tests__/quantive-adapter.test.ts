/**
 * Quantive Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation, key result value field preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { QuantiveAdapter } from '../adapters/quantive.js'
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

function makeEntity(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new QuantiveAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('QuantiveAdapter: entity_type → UPG type mapping', () => {
  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('quantive')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'Activation rate ≥ 60%', 'key_result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key-result (hyphen variant) maps to key_result', async () => {
    const items: SourceItem[] = [makeEntity('kr2', 'Retention ≥ 80%', 'key-result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('metric maps to metric with confidence high', async () => {
    const items: SourceItem[] = [
      makeEntity('m1', 'Revenue', 'metric', {
        current_value: 100000,
        target_value: 150000,
        unit: 'USD',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(100000)
    expect(node.target_value).toBe(150000)
    expect(node.unit).toBe('USD')
  })

  it('kpi also maps to metric with value fields preserved', async () => {
    const items: SourceItem[] = [
      makeEntity('kpi1', 'Activation Rate', 'kpi', {
        current_value: 42,
        target_value: 60,
        unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(42)
    expect(node.target_value).toBe(60)
    expect(node.unit).toBe('%')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('init1', 'Onboarding revamp', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('task maps to task with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('task1', 'Write copy for onboarding wizard', 'task')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('team maps to team with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('team1', 'Product Growth Team', 'team')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Key Result value fields ──────────────────────────────────────────────────

describe('QuantiveAdapter: key_result value fields', () => {
  it('current_value, target_value, start_value, and unit are preserved on key_result', async () => {
    const items: SourceItem[] = [
      makeEntity('kr1', 'Activation Rate', 'key_result', {
        current_value: 45,
        target_value: 70,
        start_value: 30,
        unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(45)
    expect(node.target_value).toBe(70)
    expect(node.start_value).toBe(30)
    expect(node.unit).toBe('%')
  })

  it('value fields are omitted when not present', async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'Bare KR', 'key_result')]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
    expect(node.start_value).toBeUndefined()
    expect(node.unit).toBeUndefined()
  })

  it('value fields are NOT added to non-KR / non-metric entity types', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Grow retention', 'objective', {
        current_value: 99,
        target_value: 100,
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
  })
})

// ─── Session / check-in skipped ───────────────────────────────────────────────

describe('QuantiveAdapter: session and check-in skipped with warnings', () => {
  it('session entities are skipped and batch warning emitted', async () => {
    const items: SourceItem[] = [
      makeEntity('s1', 'Q1 2026', 'session'),
      makeEntity('s2', '2026 Annual', 'session'),
      makeEntity('obj1', 'Real Objective', 'objective'),
    ]
    const result = await adapter.convert(items)
    // Only the objective should be in nodes
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Session')
    expect(warnText).toContain('timeframe container')
    expect(warnText).toContain('2 sessions were skipped')
  })

  it('check_in entities are skipped and batch warning emitted', async () => {
    const items: SourceItem[] = [
      makeEntity('ci1', 'Weekly check-in', 'check_in'),
      makeEntity('kr1', 'Activation Rate', 'key_result', { current_value: 55 }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('key_result')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Check-in')
    expect(warnText).toContain('operational data')
    expect(warnText).toContain('current_value')
  })

  it('check-in (hyphen variant) is also skipped', async () => {
    const items: SourceItem[] = [
      makeEntity('ci1', 'Monthly check-in', 'check-in'),
      makeEntity('obj1', 'Objective', 'objective'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Check-in')
  })

  it('session is not added to the source_map', async () => {
    const items: SourceItem[] = [makeEntity('s1', 'Q2 2026', 'session')]
    const result = await adapter.convert(items)
    expect(result.source_map['s1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('QuantiveAdapter: status normalisation', () => {
  it("status 'not_started' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Upcoming objective', 'objective', { status: 'not_started' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'not-started' (hyphen) normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Upcoming objective', 'objective', { status: 'not-started' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'upcoming' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Upcoming', 'objective', { status: 'upcoming' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'on_track' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'KR on track', 'key_result', { status: 'on_track' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'at_risk' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'KR at risk', 'key_result', { status: 'at_risk' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'behind' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'KR behind', 'key_result', { status: 'behind' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'in_progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('init1', 'Initiative in progress', 'initiative', { status: 'in_progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'achieved' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeEntity('kr1', 'KR achieved', 'key_result', { status: 'achieved' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'closed' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Closed objective', 'objective', { status: 'closed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'abandoned' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeEntity('init1', 'Abandoned initiative', 'initiative', { status: 'abandoned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("status 'cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Cancelled', 'objective', { status: 'cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('QuantiveAdapter: edge emission', () => {
  it('objective_achieved_through_key_result emitted when key_result has objective parent', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Grow retention', 'objective'),
      makeEntity('kr1', 'Retention ≥ 80%', 'key_result', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('key_result_tracked_by_metric emitted when metric has key_result parent', async () => {
    const items: SourceItem[] = [
      makeEntity('kr1', 'Activation Rate ≥ 60%', 'key_result'),
      makeEntity('m1', 'Activation Rate', 'metric', {
        parent_id: 'kr1',
        parent_type: 'key_result',
        current_value: 45,
        target_value: 60,
        unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'key_result_tracked_by_metric')
    const edge = result.edges.find((e) => e.type === 'key_result_tracked_by_metric')
    expect(edge).toBeDefined()
  })

  it('kpi parent type also resolves key_result_tracked_by_metric edge', async () => {
    const items: SourceItem[] = [
      makeEntity('kr1', 'Revenue KR', 'key_result'),
      makeEntity('kpi1', 'Revenue', 'kpi', {
        parent_id: 'kr1',
        parent_type: 'key_result',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'key_result_tracked_by_metric via kpi')
    const edge = result.edges.find((e) => e.type === 'key_result_tracked_by_metric')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted for key_result→initiative with approximation warning', async () => {
    const items: SourceItem[] = [
      makeEntity('kr1', 'Activation ≥ 60%', 'key_result'),
      makeEntity('init1', 'Onboarding revamp', 'initiative', {
        parent_id: 'kr1',
        parent_type: 'key_result',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome (kr→initiative)')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('approximation')
    expect(warnText).toContain('outcome proxy')
  })

  it('initiative_drives_outcome emitted for key_result→task with approximation warning', async () => {
    const items: SourceItem[] = [
      makeEntity('kr1', 'Activation ≥ 60%', 'key_result'),
      makeEntity('task1', 'Write onboarding copy', 'task', {
        parent_id: 'kr1',
        parent_type: 'key_result',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome (kr→task)')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('approximation')
  })

  it('team_okr_aligns_with_objective emitted for cascading objective→objective', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Company: Grow retention', 'objective'),
      makeEntity('obj2', 'Team: Improve activation', 'objective', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'team_okr_aligns_with_objective')
    const edge = result.edges.find((e) => e.type === 'team_okr_aligns_with_objective')
    expect(edge).toBeDefined()
  })

  it('team_targets_team_okr emitted when objective has team parent', async () => {
    const items: SourceItem[] = [
      makeEntity('team1', 'Product Growth Team', 'team'),
      makeEntity('obj1', 'Grow retention', 'objective', {
        parent_id: 'team1',
        parent_type: 'team',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'team_targets_team_okr')
    const edge = result.edges.find((e) => e.type === 'team_targets_team_okr')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full OKR fixture)', async () => {
    const items: SourceItem[] = [
      makeEntity('team1', 'Product Team', 'team'),
      makeEntity('obj1', 'Grow retention', 'objective', {
        parent_id: 'team1',
        parent_type: 'team',
      }),
      makeEntity('kr1', 'Retention ≥ 80%', 'key_result', {
        parent_id: 'obj1',
        parent_type: 'objective',
        current_value: 70,
        target_value: 80,
        unit: '%',
      }),
      makeEntity('m1', 'Retention Metric', 'metric', {
        parent_id: 'kr1',
        parent_type: 'key_result',
      }),
      makeEntity('init1', 'Onboarding revamp', 'initiative', {
        parent_id: 'kr1',
        parent_type: 'key_result',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'QuantiveAdapter full OKR fixture')
    // team→objective, objective→key_result, key_result→metric, key_result→initiative
    expect(result.edges.length).toBe(4)
    expect(result.nodes.length).toBe(5)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('QuantiveAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Objective', 'objective'),
      makeEntity('kr1', 'Key Result', 'key_result'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['obj1']).toBeDefined()
    expect(result.source_map['kr1']).toBeDefined()
  })

  it('skipped session entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeEntity('s1', 'Q1 2026', 'session')]
    const result = await adapter.convert(items)
    expect(result.source_map['s1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('QuantiveAdapter: external_tool and external_id', () => {
  it('external_tool is always quantive', async () => {
    const items: SourceItem[] = [makeEntity('obj1', 'Objective', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('quantive')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeEntity('entity-999', 'Objective', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('entity-999')
  })
})
