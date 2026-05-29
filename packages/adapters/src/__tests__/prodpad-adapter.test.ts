/**
 * ProdPad Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * vote_count preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ProdpadAdapter } from '../adapters/prodpad.js'
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

const adapter = new ProdpadAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('ProdpadAdapter: entity_type → UPG type mapping', () => {
  it('idea maps to feature_request with confidence high', async () => {
    const items: SourceItem[] = [makeItem('id1', 'Add dark mode', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature_request')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('prodpad')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('init1', 'Activation initiative', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeItem('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('product maps to product with confidence high', async () => {
    const items: SourceItem[] = [makeItem('prod1', 'My SaaS', 'product')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('product')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('persona maps to persona with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Power User', 'persona')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('persona')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feedback maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeItem('fb1', 'User wants dark mode', 'feedback')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('spec maps to document with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('sp1', 'Dark mode spec', 'spec')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('canvas maps to document with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Lean Canvas', 'canvas')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('roadmap is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeItem('rm1', 'Q2 Roadmap', 'roadmap'),
      makeItem('id1', 'Real idea', 'idea'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature_request')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('roadmap')
  })

  it('tag is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('t1', 'mobile', 'tag')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('tag')
  })

  it('unknown entity_type defaults to document with warning', async () => {
    const items: SourceItem[] = [makeItem('x1', 'Unknown', 'custom_type')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Vote count preservation ──────────────────────────────────────────────────

describe('ProdpadAdapter: vote_count preservation', () => {
  it('vote_count is preserved on idea (feature_request) nodes', async () => {
    const items: SourceItem[] = [
      makeItem('id1', 'Add dark mode', 'idea', { vote_count: 142 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.vote_count).toBe(142)
  })

  it('vote_count is NOT added to non-feature_request nodes', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Objective', 'objective', { vote_count: 10 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.vote_count).toBeUndefined()
  })

  it('idea without vote_count is still converted successfully', async () => {
    const items: SourceItem[] = [makeItem('id1', 'Add dark mode', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_request')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.vote_count).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ProdpadAdapter: status normalisation', () => {
  it("status 'active' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('id1', 'Active idea', 'idea', { status: 'active' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'parked' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('id1', 'Parked idea', 'idea', { status: 'parked' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'completed' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('id1', 'Done', 'idea', { status: 'completed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('id1', 'Archived', 'idea', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('ProdpadAdapter: edge emission', () => {
  it('initiative_drives_outcome emitted when objective has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Activation initiative', 'initiative'),
      makeItem('obj1', 'Grow activation', 'objective', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted when idea has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Activation initiative', 'initiative'),
      makeItem('id1', 'Dark mode idea', 'idea', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome (initiative→idea)')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('feature_request_creates_opportunity emitted when idea has feedback parent', async () => {
    const items: SourceItem[] = [
      makeItem('fb1', 'Users want dark mode', 'feedback'),
      makeItem('id1', 'Dark mode idea', 'idea', {
        parent_id: 'fb1',
        parent_type: 'feedback',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_request_creates_opportunity')
    const edge = result.edges.find((e) => e.type === 'feature_request_creates_opportunity')
    expect(edge).toBeDefined()
  })

  it('product_targets_persona emitted when persona has product parent', async () => {
    const items: SourceItem[] = [
      makeItem('prod1', 'My SaaS', 'product'),
      makeItem('p1', 'Power User', 'persona', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_targets_persona')
    const edge = result.edges.find((e) => e.type === 'product_targets_persona')
    expect(edge).toBeDefined()
  })

  it('missing parent_id results in no edge and a warning', async () => {
    const items: SourceItem[] = [
      makeItem('id1', 'Orphan idea', 'idea', {
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
      makeItem('init1', 'Activation initiative', 'initiative'),
      makeItem('obj1', 'Grow activation', 'objective', { parent_id: 'init1', parent_type: 'initiative' }),
      makeItem('fb1', 'User wants dark mode', 'feedback'),
      makeItem('id1', 'Dark mode idea', 'idea', { parent_id: 'fb1', parent_type: 'feedback' }),
      makeItem('prod1', 'My SaaS', 'product'),
      makeItem('p1', 'Power User', 'persona', { parent_id: 'prod1', parent_type: 'product' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ProdpadAdapter full fixture')
    expect(result.edges.length).toBe(3)
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('ProdpadAdapter: tags', () => {
  it('tags are set on the node', async () => {
    const items: SourceItem[] = [
      makeItem('id1', 'Idea with tags', 'idea', { tags: ['mobile', 'q3'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['mobile', 'q3'])
  })
})

// ─── Source map and identity ──────────────────────────────────────────────────

describe('ProdpadAdapter: source_map and identity', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Initiative', 'initiative'),
      makeItem('id1', 'Idea', 'idea'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['init1']).toBeDefined()
    expect(result.source_map['id1']).toBeDefined()
  })

  it('skipped entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('rm1', 'Roadmap', 'roadmap')]
    const result = await adapter.convert(items)
    expect(result.source_map['rm1']).toBeUndefined()
  })

  it('external_tool is always prodpad', async () => {
    const items: SourceItem[] = [makeItem('id1', 'Idea', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('prodpad')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('prodpad-abc', 'Idea', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('prodpad-abc')
  })
})
