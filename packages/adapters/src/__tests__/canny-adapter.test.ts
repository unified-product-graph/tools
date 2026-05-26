/**
 * Canny Adapter Tests
 *
 * Covers all entity_type mappings, vote_count preservation, board_name tag,
 * edge emission, status normalisation, skip+warning cases, source_map integrity,
 * and external_tool tagging.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CannyAdapter } from '../adapters/canny.js'
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
    source_type: 'canny_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new CannyAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('CannyAdapter — entity_type → UPG type mapping', () => {
  it('post maps to feature_request with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Add dark mode', 'post')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature_request')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('canny')
  })

  it('company maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeItem('co1', 'Acme Corp', 'company')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('unknown entity_type defaults to document with low confidence and warning', async () => {
    const items: SourceItem[] = [makeItem('u1', 'Mystery', 'roadmap')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Skip + warning cases ─────────────────────────────────────────────────────

describe('CannyAdapter — skipped types + warnings', () => {
  it('board entities are skipped with per-entity warning about category container', async () => {
    const items: SourceItem[] = [
      makeItem('b1', 'Feature Requests', 'board'),
      makeItem('p1', 'Add dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature_request')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('category container')
    expect(warnText).toContain('Feature Requests')
    expect(warnText).toContain('skipped')
  })

  it('changelog entities are skipped with aggregate warning about releases', async () => {
    const items: SourceItem[] = [
      makeItem('cl1', 'New export feature', 'changelog'),
      makeItem('cl2', 'Improved search', 'changelog'),
      makeItem('p1', 'Add dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 Canny Changelog')
    expect(warnText).toContain('releases')
  })

  it('comment entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'Great idea!', 'comment'),
      makeItem('p1', 'Add dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['c1']).toBeUndefined()
  })

  it('user entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('u1', 'John Doe', 'user'),
      makeItem('p1', 'Add dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['u1']).toBeUndefined()
  })

  it('vote entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('v1', 'vote-123', 'vote'),
      makeItem('p1', 'Dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['v1']).toBeUndefined()
  })

  it('tag entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'ui', 'tag'),
      makeItem('p1', 'Dark mode', 'post'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['t1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('CannyAdapter — status normalisation', () => {
  it("status 'open' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Add dark mode', 'post', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'under review' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Add dark mode', 'post', { status: 'under review' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'planned' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Add dark mode', 'post', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'in progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Add dark mode', 'post', { status: 'in progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Dark mode shipped', 'post', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'closed' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Declined request', 'post', { status: 'closed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Vote count and board_name ────────────────────────────────────────────────

describe('CannyAdapter — vote_count and board_name', () => {
  it('vote_count is preserved on feature_request nodes', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Add dark mode', 'post', { vote_count: 247 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.vote_count).toBe(247)
  })

  it('vote_count is not carried onto non-feature_request nodes', async () => {
    const items: SourceItem[] = [
      makeItem('co1', 'Acme Corp', 'company', { vote_count: 99 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.vote_count).toBeUndefined()
  })

  it('board_name added as a tag on post nodes', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Add dark mode', 'post', {
        board_name: 'Feature Requests',
        tags: ['ui', 'accessibility'],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('Feature Requests')
    expect(result.nodes[0].tags).toContain('ui')
    expect(result.nodes[0].tags).toContain('accessibility')
  })

  it('tags array without board_name is preserved', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Dark mode', 'post', { tags: ['q2', 'ux'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['q2', 'ux'])
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('CannyAdapter — edge emission', () => {
  it('feature_request_creates_opportunity emitted when feature_request has opportunity parent', async () => {
    const items: SourceItem[] = [
      makeItem('opp1', 'Users need faster export', 'opportunity'),
      makeItem('p1', 'Add CSV export', 'post', {
        parent_id: 'opp1',
        parent_type: 'opportunity',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_request_creates_opportunity')
    const edge = result.edges.find((e) => e.type === 'feature_request_creates_opportunity')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('node_informs_node fallback emitted for unrecognised parent→child pair', async () => {
    const items: SourceItem[] = [
      makeItem('co1', 'Acme Corp', 'company'),
      makeItem('p1', 'Add dark mode', 'post', { parent_id: 'co1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'fallback edge')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('warning emitted when parent_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Add dark mode', 'post', { parent_id: 'missing-opp-id' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('missing-opp-id')
    expect(warnText).toContain('Edge skipped')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('opp1', 'Faster export needed', 'opportunity'),
      makeItem('opp2', 'Better customisation needed', 'opportunity'),
      makeItem('p1', 'Add CSV export', 'post', {
        parent_id: 'opp1',
        vote_count: 312,
        board_name: 'Feature Requests',
        status: 'planned',
      }),
      makeItem('p2', 'Add white-label branding', 'post', {
        parent_id: 'opp2',
        vote_count: 187,
        status: 'open',
      }),
      makeItem('co1', 'Acme Corp', 'company'),
      makeItem('p3', 'Add dark mode', 'post', { vote_count: 421 }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'CannyAdapter full fixture')
    // 2 feature_request_creates_opportunity edges
    const oppEdges = result.edges.filter((e) => e.type === 'feature_request_creates_opportunity')
    expect(oppEdges).toHaveLength(2)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('CannyAdapter — source_map', () => {
  it('source_map contains entries for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Dark mode', 'post'),
      makeItem('co1', 'Acme', 'company'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['p1']).toBeDefined()
    expect(result.source_map['co1']).toBeDefined()
  })

  it('skipped board is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('b1', 'Feature Requests', 'board')]
    const result = await adapter.convert(items)
    expect(result.source_map['b1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('CannyAdapter — external_tool and external_id', () => {
  it('external_tool is always canny', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Dark mode', 'post')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('canny')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('canny-post-999', 'Dark mode', 'post')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('canny-post-999')
  })
})
