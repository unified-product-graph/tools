/**
 * Portfolio family + repair_dangling_edges unit tests.
 *
 * Tests store methods and tool handlers for cross-product edges. Uses the
 * same mock-pool pattern as pg-store.test.ts; no real Postgres needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import { listPortfolios, listPortfolioCrossEdges, createCrossProductEdge, repairDanglingEdges } from '../tools/portfolio.js'
import type { CloudContext } from '../lib/server-context.js'

// ── Mock pool factory ──────────────────────────────────────────────────────

interface MockQuery {
  text: string
  values: unknown[]
}

function createMockPool(queryResponses: Map<string, { rows: unknown[]; rowCount?: number }> = new Map()) {
  const queries: MockQuery[] = []

  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values ?? [] })
      for (const [pattern, response] of queryResponses) {
        if (text.includes(pattern)) return response
      }
      return { rows: [], rowCount: 0 }
    }),
    connect: vi.fn(),
  } as unknown as Pool

  return { pool, queries }
}

function makeContext(pool: Pool): CloudContext {
  return { store: new UPGPgStore(pool) }
}

// ── Store: cross-product edge methods ─────────────────────────────────────

describe('UPGPgStore: cross-product edges', () => {
  describe('listCrossProductEdges()', () => {
    it('queries by created_by_product_id and returns edges', async () => {
      const edgeRows = [
        { id: 'e_1', source: 'p1/n1', target: 'p2/n2', type: 'shares_persona', created_by_product_id: 'p1', created_at: '2026-01-01' },
        { id: 'e_2', source: 'p1/n3', target: 'p2/n4', type: 'depends_on_product', created_by_product_id: 'p1', created_at: '2026-01-02' },
      ]
      const { pool, queries } = createMockPool(
        new Map([['FROM upg.cross_product_edges', { rows: edgeRows }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.listCrossProductEdges('p1')

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('e_1')
      expect(result[0].type).toBe('shares_persona')
      expect(queries[0].values).toEqual(['p1'])
      expect(queries[0].text).toContain('created_by_product_id = $1')
    })

    it('returns empty array when no edges found', async () => {
      const { pool } = createMockPool()
      const store = new UPGPgStore(pool)

      const result = await store.listCrossProductEdges('p_unknown')
      expect(result).toEqual([])
    })
  })

  describe('addCrossProductEdge()', () => {
    it('inserts with correct fields', async () => {
      const returned = {
        id: 'e_new',
        source: 'p1/n1',
        target: 'p2/n2',
        type: 'shares_competitor',
        created_by_product_id: 'p1',
        created_at: '2026-01-01',
      }
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.cross_product_edges', { rows: [returned] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.addCrossProductEdge('e_new', 'p1', 'p1/n1', 'p2/n2', 'shares_competitor')

      expect(result.id).toBe('e_new')
      expect(result.source).toBe('p1/n1')
      expect(result.target).toBe('p2/n2')
      expect(result.type).toBe('shares_competitor')
      expect(result.created_by_product_id).toBe('p1')

      const vals = queries[0].values
      expect(vals[0]).toBe('e_new')       // id
      expect(vals[1]).toBe('p1/n1')       // source
      expect(vals[2]).toBe('p2/n2')       // target
      expect(vals[3]).toBe('shares_competitor') // type
      expect(vals[4]).toBe('p1')          // created_by_product_id
    })
  })

  describe('deleteCrossProductEdge()', () => {
    it('deletes and returns the edge', async () => {
      const returned = {
        id: 'e_del',
        source: 'p1/n1',
        target: 'p2/n2',
        type: 'shares_persona',
        created_by_product_id: 'p1',
        created_at: '2026-01-01',
      }
      const { pool } = createMockPool(
        new Map([['DELETE FROM upg.cross_product_edges WHERE id', { rows: [returned] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.deleteCrossProductEdge('e_del')
      expect(result.id).toBe('e_del')
    })

    it('throws when edge not found', async () => {
      const { pool } = createMockPool()
      const store = new UPGPgStore(pool)

      await expect(store.deleteCrossProductEdge('e_missing'))
        .rejects.toThrow('Cross-product edge not found: e_missing')
    })
  })

  describe('productExists()', () => {
    it('returns true when product is found', async () => {
      const { pool } = createMockPool(
        new Map([['SELECT EXISTS', { rows: [{ exists: true }] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.productExists('p1')
      expect(result).toBe(true)
    })

    it('returns false when product is not found', async () => {
      const { pool } = createMockPool(
        new Map([['SELECT EXISTS', { rows: [{ exists: false }] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.productExists('p_ghost')
      expect(result).toBe(false)
    })
  })
})

// ── Tool handlers ─────────────────────────────────────────────────────────

describe('listPortfolios handler', () => {
  it('returns all products wrapped in a single portfolio', async () => {
    const products = [
      { id: 'p1', title: 'Alpha', stage: 'mvp' },
      { id: 'p2', title: 'Beta', stage: 'idea' },
    ]
    const { pool } = createMockPool(
      new Map([['SELECT id, title, description, stage FROM upg.products', { rows: products }]]),
    )
    const ctx = makeContext(pool)

    const result = await listPortfolios({}, ctx)
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.portfolios).toHaveLength(1)
    expect(parsed.portfolios[0].id).toBe('default')
    expect(parsed.portfolios[0].products).toHaveLength(2)
    expect(parsed.total).toBe(1)
  })
})

describe('listPortfolioCrossEdges handler', () => {
  it('requires product_id', async () => {
    const { pool } = createMockPool()
    const ctx = makeContext(pool)

    const result = await listPortfolioCrossEdges({}, ctx)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Missing required parameter: product_id')
  })

  it('returns edges for the given product', async () => {
    const edgeRows = [
      { id: 'e_1', source: 'p1/n1', target: 'p2/n2', type: 'shares_persona', created_by_product_id: 'p1', created_at: '2026-01-01' },
    ]
    const { pool } = createMockPool(
      new Map([['FROM upg.cross_product_edges', { rows: edgeRows }]]),
    )
    const ctx = makeContext(pool)

    const result = await listPortfolioCrossEdges({ product_id: 'p1' }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0].id).toBe('e_1')
    expect(parsed.edges[0].type).toBe('shares_persona')
    expect(parsed.total).toBe(1)
  })
})

describe('createCrossProductEdge handler', () => {
  it('requires all parameters', async () => {
    const { pool } = createMockPool()
    const ctx = makeContext(pool)

    let result = await createCrossProductEdge({}, ctx)
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter: product_id')

    result = await createCrossProductEdge({ product_id: 'p1' }, ctx)
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter: source')

    result = await createCrossProductEdge({ product_id: 'p1', source: 'p1/n1' }, ctx)
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter: target')

    result = await createCrossProductEdge({ product_id: 'p1', source: 'p1/n1', target: 'p2/n2' }, ctx)
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter: type')
  })

  it('rejects a resident cross-edge type (both endpoints non-shared)', async () => {
    const { pool } = createMockPool()
    const ctx = makeContext(pool)

    // persona_pursues_job is resident under the 3-state gate (0.18.0): neither
    // persona nor job is portfolio-shared, so it is hard-rejected cross-product.
    const result = await createCrossProductEdge({
      product_id: 'p1', source: 'p1/n1', target: 'p2/n2', type: 'persona_pursues_job',
    }, ctx)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('is not authorable across product graphs')
  })

  it('creates edge with valid cross-edge type', async () => {
    const returned = {
      id: 'e_new',
      source: 'p1/n1',
      target: 'p2/n2',
      type: 'shares_persona',
      created_by_product_id: 'p1',
      created_at: '2026-01-01',
    }
    const { pool } = createMockPool(
      new Map([['INSERT INTO upg.cross_product_edges', { rows: [returned] }]]),
    )
    const ctx = makeContext(pool)

    const result = await createCrossProductEdge({
      product_id: 'p1', source: 'p1/n1', target: 'p2/n2', type: 'shares_persona',
    }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.edge.id).toBe('e_new')
    expect(parsed.edge.type).toBe('shares_persona')
  })

  it('accepts all 8 valid cross-edge types', async () => {
    const validTypes = ['shares_persona', 'shares_competitor', 'shares_metric', 'depends_on_product', 'cannibalises', 'succeeds', 'hosts', 'contributes_to']
    for (const type of validTypes) {
      const returned = { id: 'e_x', source: 'p1/n1', target: 'p2/n2', type, created_by_product_id: 'p1', created_at: '2026-01-01' }
      const { pool } = createMockPool(
        new Map([['INSERT INTO upg.cross_product_edges', { rows: [returned] }]]),
      )
      const ctx = makeContext(pool)

      const result = await createCrossProductEdge({ product_id: 'p1', source: 'p1/n1', target: 'p2/n2', type }, ctx)
      const parsed = JSON.parse((result.content[0] as { text: string }).text)
      expect(parsed.edge.type).toBe(type)
    }
  })
})

describe('repairDanglingEdges handler', () => {
  it('requires product_id', async () => {
    const { pool } = createMockPool()
    const ctx = makeContext(pool)

    const result = await repairDanglingEdges({}, ctx)
    expect((result.content[0] as { text: string }).text).toContain('Missing required parameter: product_id')
  })

  it('dry_run=true (default) reports dangling edges without deleting', async () => {
    // Edge with target product that does not exist
    const edgeRows = [
      { id: 'e_1', source: 'p1/n1', target: 'p_ghost/n2', type: 'shares_persona', created_by_product_id: 'p1', created_at: '2026-01-01' },
    ]
    const responses = new Map<string, { rows: unknown[] }>([
      ['FROM upg.cross_product_edges', { rows: edgeRows }],
      ['SELECT EXISTS', { rows: [{ exists: false }] }],  // target product doesn't exist
    ])
    const { pool, queries } = createMockPool(responses)
    const ctx = makeContext(pool)

    const result = await repairDanglingEdges({ product_id: 'p1' }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.dangling_count).toBe(1)
    expect(parsed.dangling[0].id).toBe('e_1')
    expect(parsed.dry_run).toBe(true)
    expect(parsed.dropped).toBe(0)
    // Should NOT have issued a DELETE
    const deleteQuery = queries.find((q) => q.text.includes('DELETE FROM upg.cross_product_edges'))
    expect(deleteQuery).toBeUndefined()
  })

  it('dry_run=false + drop deletes dangling edges', async () => {
    const edgeRows = [
      { id: 'e_1', source: 'p1/n1', target: 'p_ghost/n2', type: 'shares_persona', created_by_product_id: 'p1', created_at: '2026-01-01' },
    ]
    const deletedEdge = { ...edgeRows[0] }
    const responses = new Map<string, { rows: unknown[] }>([
      ['FROM upg.cross_product_edges', { rows: edgeRows }],
      ['SELECT EXISTS', { rows: [{ exists: false }] }],
      ['DELETE FROM upg.cross_product_edges WHERE id', { rows: [deletedEdge] }],
    ])
    const { pool } = createMockPool(responses)
    const ctx = makeContext(pool)

    const result = await repairDanglingEdges({
      product_id: 'p1', dry_run: false, drop: ['dangling_cross_edges'],
    }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.dangling_count).toBe(1)
    expect(parsed.dry_run).toBe(false)
    expect(parsed.dropped).toBe(1)
  })

  it('returns empty dangling when all target products exist', async () => {
    const edgeRows = [
      { id: 'e_1', source: 'p1/n1', target: 'p2/n2', type: 'shares_persona', created_by_product_id: 'p1', created_at: '2026-01-01' },
    ]
    const responses = new Map<string, { rows: unknown[] }>([
      ['FROM upg.cross_product_edges', { rows: edgeRows }],
      ['SELECT EXISTS', { rows: [{ exists: true }] }],  // target product exists
    ])
    const { pool } = createMockPool(responses)
    const ctx = makeContext(pool)

    const result = await repairDanglingEdges({ product_id: 'p1' }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.dangling_count).toBe(0)
    expect(parsed.dangling).toEqual([])
  })

  it('classifies malformed target (no slash) as dangling', async () => {
    const edgeRows = [
      { id: 'e_bad', source: 'p1/n1', target: 'MALFORMED', type: 'cannibalises', created_by_product_id: 'p1', created_at: '2026-01-01' },
    ]
    const { pool } = createMockPool(
      new Map([['FROM upg.cross_product_edges', { rows: edgeRows }]]),
    )
    const ctx = makeContext(pool)

    const result = await repairDanglingEdges({ product_id: 'p1' }, ctx)
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.dangling_count).toBe(1)
    expect(parsed.dangling[0].id).toBe('e_bad')
  })
})
