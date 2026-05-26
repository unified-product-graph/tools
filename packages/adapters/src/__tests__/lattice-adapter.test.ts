/**
 * Lattice Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * key_result metric value preservation, individual goal warning, and
 * the OKR cascade hierarchy.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { LatticeAdapter } from '../adapters/lattice.js'
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

const adapter = new LatticeAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('LatticeAdapter — entity_type → UPG entity type mapping', () => {
  it('goal maps to objective with confidence high (company level)', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Grow ARR by 40%', 'goal', { level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('lattice')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'Increase NPS to 50', 'key_result', {
        current_value: 42,
        target_value: 50,
        unit: 'points',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key_result preserves current_value, target_value, and unit', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'Revenue target', 'key_result', {
        current_value: 850000,
        target_value: 1000000,
        unit: 'USD',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(850000)
    expect(node.target_value).toBe(1000000)
    expect(node.unit).toBe('USD')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('init1', 'Launch enterprise tier', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('team maps to team with confidence high', async () => {
    const items: SourceItem[] = [makeItem('team1', 'Product Team', 'team')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('department maps to team with confidence high', async () => {
    const items: SourceItem[] = [makeItem('dept1', 'Engineering Department', 'department')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('review maps to observation with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('rev1', 'Q2 Performance Review', 'review')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('survey maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('surv1', 'Q2 Engagement Survey', 'survey')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('individual_goal maps to objective with confidence medium', async () => {
    const items: SourceItem[] = [
      makeItem('ig1', 'Learn TypeScript generics', 'individual_goal', { level: 'individual' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Individual goal warning ──────────────────────────────────────────────────

describe('LatticeAdapter — individual goal warning', () => {
  it('emits warning when level is individual for goal entity', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Personal growth goal', 'goal', { level: 'individual' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('individual')
    expect(warnText).toContain('team_okr_aligns_with_objective')
  })

  it('does NOT emit individual warning for company-level goal', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Company OKR', 'goal', { level: 'company' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).not.toContain('individual OKRs connect')
  })
})

// ─── Skipped entities ─────────────────────────────────────────────────────────

describe('LatticeAdapter — skipped entity types', () => {
  it('update, competency, praise, one_on_one are silently batched', async () => {
    const items: SourceItem[] = [
      makeItem('upd1', 'Weekly progress update', 'update'),
      makeItem('comp1', 'Problem Solving', 'competency'),
      makeItem('pr1', 'Great work!', 'praise'),
      makeItem('oo1', 'Weekly sync', 'one_on_one'),
      makeItem('g1', 'Company goal', 'goal', { level: 'company' }),
    ]
    const result = await adapter.convert(items)
    // Only the goal should be converted
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    // A batch warning about HR entities should be emitted
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('skipped')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('LatticeAdapter — status normalisation', () => {
  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Draft goal', 'goal', { status: 'draft', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'on_track' normalises to 'active'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'On track goal', 'goal', { status: 'on_track', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'at_risk' normalises to 'active'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'At risk goal', 'goal', { status: 'at_risk', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'behind' normalises to 'active'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Behind goal', 'goal', { status: 'behind', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Completed goal', 'goal', { status: 'complete', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'abandoned' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Abandoned goal', 'goal', { status: 'abandoned', level: 'company' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Level tag preservation ───────────────────────────────────────────────────

describe('LatticeAdapter — level tag preservation', () => {
  it('level is preserved as a tag on the node', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Team OKR', 'goal', { level: 'team' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('level:team')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('LatticeAdapter — edge emission', () => {
  it('objective_achieved_through_key_result emitted when key_result has goal parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Grow ARR', 'goal', { level: 'company' }),
      makeItem('kr1', 'Close 50 enterprise deals', 'key_result', {
        parent_id: 'g1',
        parent_type: 'goal',
        current_value: 32,
        target_value: 50,
        unit: 'deals',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('initiative_drives_outcome emitted when initiative has goal parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Improve retention', 'goal', { level: 'company' }),
      makeItem('init1', 'Onboarding revamp', 'initiative', {
        parent_id: 'g1',
        parent_type: 'goal',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('warning emitted when parent_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'Orphaned KR', 'key_result', {
        parent_id: 'missing-goal',
        parent_type: 'goal',
      }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('missing-goal')
    expect(warnText).toContain('Edge skipped')
  })

  it('team_okr_aligns_with_objective emitted when team goal has company goal parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Company ARR goal', 'goal', { level: 'company' }),
      makeItem('g2', 'Product team OKR', 'goal', {
        level: 'team',
        parent_id: 'g1',
        parent_type: 'goal',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'team_okr_aligns_with_objective')
    const edge = result.edges.find((e) => e.type === 'team_okr_aligns_with_objective')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full OKR cascade fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Grow ARR by 40%', 'goal', { level: 'company', status: 'on_track' }),
      makeItem('kr1', 'Close 50 enterprise deals', 'key_result', {
        parent_id: 'g1',
        parent_type: 'goal',
        current_value: 32,
        target_value: 50,
        unit: 'deals',
      }),
      makeItem('init1', 'Sales outreach programme', 'initiative', {
        parent_id: 'g1',
        parent_type: 'goal',
      }),
      makeItem('g2', 'Product team KPIs', 'goal', {
        level: 'team',
        parent_id: 'g1',
        parent_type: 'goal',
      }),
      makeItem('team1', 'Product Team', 'team'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'LatticeAdapter full OKR cascade fixture')
    expect(result.nodes.length).toBeGreaterThanOrEqual(4)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('LatticeAdapter — source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Goal', 'goal', { level: 'company' }),
      makeItem('kr1', 'Key Result', 'key_result'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['g1']).toBeDefined()
    expect(result.source_map['kr1']).toBeDefined()
  })

  it('skipped praise is NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('pr1', 'Great work!', 'praise')]
    const result = await adapter.convert(items)
    expect(result.source_map['pr1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('LatticeAdapter — external_tool and external_id', () => {
  it('external_tool is always lattice', async () => {
    const items: SourceItem[] = [makeItem('g1', 'Goal', 'goal', { level: 'company' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('lattice')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('lattice-5678', 'Goal', 'goal', { level: 'company' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('lattice-5678')
  })
})
