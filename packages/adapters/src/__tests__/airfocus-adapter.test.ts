/**
 * Airfocus Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * priority_score preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { AirfocusAdapter } from '../adapters/airfocus.js'
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
    source_type: 'item',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new AirfocusAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('AirfocusAdapter: entity_type → UPG type mapping', () => {
  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeItem('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('airfocus')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const items: SourceItem[] = [makeItem('kr1', 'Activation Rate 60%', 'key_result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('init1', 'Onboarding revamp', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feature maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Onboarding wizard', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('item maps to feature with confidence medium and emits a note', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Roadmap item', 'item')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('polymorphic')
  })

  it('milestone maps to milestone with confidence high', async () => {
    const items: SourceItem[] = [makeItem('m1', 'Q2 launch', 'milestone')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('milestone')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('insight maps to insight with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('ins1', 'Users want faster onboarding', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('sprint is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeItem('sp1', 'Sprint 12', 'sprint'),
      makeItem('f1', 'Real feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('sprint')
    expect(warnText).toContain('no UPG equivalent')
  })

  it('workspace is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('ws1', 'My Workspace', 'workspace')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('workspace')
  })

  it('board is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('b1', 'Roadmap Board', 'board')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('unknown entity_type defaults to document with a warning', async () => {
    const items: SourceItem[] = [makeItem('x1', 'Unknown thing', 'custom_widget')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Priority score preservation ─────────────────────────────────────────────

describe('AirfocusAdapter: priority_score preservation', () => {
  it('priority_score is preserved on feature nodes', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Wizard feature', 'feature', { priority_score: 82 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.priority_score).toBe(82)
  })

  it('priority_score is preserved on item (mapped to feature) nodes', async () => {
    const items: SourceItem[] = [
      makeItem('i1', 'Roadmap item', 'item', { priority_score: 65 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.priority_score).toBe(65)
  })

  it('priority_score is NOT added to non-feature nodes', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Objective', 'objective', { priority_score: 100 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.priority_score).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('AirfocusAdapter: status normalisation', () => {
  it("status 'backlog' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Backlog item', 'feature', { status: 'backlog' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'planned' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Planned', 'feature', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'in_progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'In progress', 'feature', { status: 'in_progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Done', 'feature', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Dropped', 'feature', { status: 'cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('AirfocusAdapter: edge emission', () => {
  it('objective_achieved_through_key_result emitted when key_result has objective parent', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Grow retention', 'objective'),
      makeItem('kr1', 'Activation Rate 60%', 'key_result', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted when key_result has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('kr1', 'Activation Rate', 'key_result', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('outcome_delivered_by_feature emitted when feature has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_delivered_by_feature')
    const edge = result.edges.find((e) => e.type === 'outcome_delivered_by_feature')
    expect(edge).toBeDefined()
  })

  it('outcome_delivered_by_feature emitted when feature has objective parent', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Grow retention', 'objective'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_delivered_by_feature')
    const edge = result.edges.find((e) => e.type === 'outcome_delivered_by_feature')
    expect(edge).toBeDefined()
  })

  it('insight_informs_opportunity emitted when feature has insight parent (with warning)', async () => {
    const items: SourceItem[] = [
      makeItem('ins1', 'Users want faster onboarding', 'insight'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'ins1',
        parent_type: 'insight',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'insight_informs_opportunity')
    const edge = result.edges.find((e) => e.type === 'insight_informs_opportunity')
    expect(edge).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('opportunity')
  })

  it('missing parent_id results in no edge and a warning', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Orphan feature', 'feature', {
        parent_id: 'nonexistent',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('not found')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Grow retention', 'objective'),
      makeItem('kr1', 'Activation Rate', 'key_result', { parent_id: 'obj1', parent_type: 'objective' }),
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('f1', 'Wizard', 'feature', { parent_id: 'init1', parent_type: 'initiative' }),
      makeItem('m1', 'Q2 launch', 'milestone'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'AirfocusAdapter full fixture')
    expect(result.edges.length).toBe(2)
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('AirfocusAdapter: tags', () => {
  it('tags are set on the node', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Feature with tags', 'feature', { tags: ['q2', 'discovery'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['q2', 'discovery'])
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('AirfocusAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Objective', 'objective'),
      makeItem('f1', 'Feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['obj1']).toBeDefined()
    expect(result.source_map['f1']).toBeDefined()
  })

  it('skipped entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('sp1', 'Sprint 12', 'sprint')]
    const result = await adapter.convert(items)
    expect(result.source_map['sp1']).toBeUndefined()
  })

  it('external_tool is always airfocus', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('airfocus')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('airfocus-999', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('airfocus-999')
  })
})
