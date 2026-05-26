/**
 * Tests for export_edges and rename_edge_type PgStore
 * methods that back the two new handlers.
 *
 * Tests the store layer only, avoiding the handler imports which pull
 * in @unified-product-graph/mcp-tooling (not installed in this worktree's node_modules).
 */

import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'

// ── Mock pool factory ──────────────────────────────────────────────────────────

interface MockQuery {
  text: string
  values: unknown[]
}

function createMockPool(
  queryResponses: Map<string, { rows: unknown[]; rowCount?: number }> = new Map(),
) {
  const queries: MockQuery[] = []

  const mockClient = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values ?? [] })
      for (const [pattern, response] of queryResponses) {
        if (text.includes(pattern)) return response
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }

  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values ?? [] })
      for (const [pattern, response] of queryResponses) {
        if (text.includes(pattern)) return response
      }
      return { rows: [], rowCount: 0 }
    }),
    connect: vi.fn(async () => mockClient),
  } as unknown as Pool

  return { pool, queries, mockClient }
}

// ── PgStore.exportEdges ─────────────────────────────────────────────

describe('PgStore.exportEdges()', () => {
  it('returns all edges for a product when no type filter is given', async () => {
    const edgeRows = [
      { id: 'e_1', source: 'n_a', target: 'n_b', type: 'persona_pursues_job' },
      { id: 'e_2', source: 'n_b', target: 'n_c', type: 'job_surfaces_need' },
    ]
    const { pool, queries } = createMockPool(
      new Map([['FROM upg.edges', { rows: edgeRows }]]),
    )
    const store = new UPGPgStore(pool)

    const result = await store.exportEdges('p1')

    expect(result).toEqual(edgeRows)
    expect(queries).toHaveLength(1)
    expect(queries[0].text).toContain('FROM upg.edges')
    expect(queries[0].text).toContain('WHERE product_id = $1')
    expect(queries[0].values[0]).toBe('p1')
    // No type filter — second param should be null
    expect(queries[0].values[1]).toBeNull()
  })

  it('passes the types array when provided', async () => {
    const { pool, queries } = createMockPool(
      new Map([['FROM upg.edges', { rows: [] }]]),
    )
    const store = new UPGPgStore(pool)

    await store.exportEdges('p1', ['persona_pursues_job', 'job_surfaces_need'])

    expect(queries[0].values[1]).toEqual(['persona_pursues_job', 'job_surfaces_need'])
  })

  it('orders results by id', async () => {
    const { pool, queries } = createMockPool(
      new Map([['FROM upg.edges', { rows: [] }]]),
    )
    const store = new UPGPgStore(pool)

    await store.exportEdges('p1')

    expect(queries[0].text).toContain('ORDER BY id')
  })

  it('returns empty array when product has no edges', async () => {
    const { pool } = createMockPool(
      new Map([['FROM upg.edges', { rows: [] }]]),
    )
    const store = new UPGPgStore(pool)

    const result = await store.exportEdges('p1')

    expect(result).toEqual([])
  })

  it('uses ANY($2) for type filtering', async () => {
    const { pool, queries } = createMockPool(
      new Map([['FROM upg.edges', { rows: [] }]]),
    )
    const store = new UPGPgStore(pool)

    await store.exportEdges('p1', ['persona_pursues_job'])

    expect(queries[0].text).toContain('ANY($2)')
  })
})

// ── PgStore.renameEdgeType ──────────────────────────────────────────

describe('PgStore.renameEdgeType()', () => {
  it('dry_run=true: counts matching edges without updating', async () => {
    const { pool, queries, mockClient } = createMockPool(
      new Map([['COUNT(*)', { rows: [{ count: '5' }] }]]),
    )
    const store = new UPGPgStore(pool)

    const affected = await store.renameEdgeType('p1', 'old_type', 'new_type', true)

    expect(affected).toBe(5)
    // Pool.query (not client) is used — no transaction for dry run
    expect(queries.some((q) => q.text.includes('COUNT(*)'))).toBe(true)
    expect(queries.every((q) => !q.text.includes('UPDATE'))).toBe(true)
    expect(mockClient.query).not.toHaveBeenCalled()
  })

  it('dry_run is true by default', async () => {
    const { pool, queries } = createMockPool(
      new Map([['COUNT(*)', { rows: [{ count: '3' }] }]]),
    )
    const store = new UPGPgStore(pool)

    const affected = await store.renameEdgeType('p1', 'old_type', 'new_type')

    expect(affected).toBe(3)
    expect(queries.every((q) => !q.text.includes('UPDATE'))).toBe(true)
  })

  it('dry_run=false: updates edges in a transaction', async () => {
    const responses = new Map<string, { rows: unknown[]; rowCount?: number }>([
      ['BEGIN', { rows: [] }],
      ['UPDATE upg.edges', { rows: [], rowCount: 7 }],
      ['COMMIT', { rows: [] }],
    ])
    const { pool, mockClient } = createMockPool(responses)
    const store = new UPGPgStore(pool)

    const affected = await store.renameEdgeType('p1', 'old_type', 'new_type', false)

    expect(affected).toBe(7)
    const clientCalls = mockClient.query.mock.calls.map((c) => c[0] as string)
    expect(clientCalls[0]).toBe('BEGIN')
    expect(clientCalls.some((s) => s.includes('UPDATE upg.edges'))).toBe(true)
    expect(clientCalls[clientCalls.length - 1]).toBe('COMMIT')
    expect(mockClient.release).toHaveBeenCalled()
  })

  it('dry_run=false: rolls back on error', async () => {
    const { pool, mockClient } = createMockPool()
    // Override client.query to throw on UPDATE
    mockClient.query.mockImplementation(async (text: string) => {
      if (text === 'BEGIN') return { rows: [] }
      if (text.includes('UPDATE')) throw new Error('constraint violation')
      if (text === 'ROLLBACK') return { rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const store = new UPGPgStore(pool)

    await expect(store.renameEdgeType('p1', 'old_type', 'new_type', false))
      .rejects.toThrow('constraint violation')

    const clientCalls = mockClient.query.mock.calls.map((c) => c[0] as string)
    expect(clientCalls).toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })

  it('passes correct SQL values for the UPDATE', async () => {
    const responses = new Map<string, { rows: unknown[]; rowCount?: number }>([
      ['BEGIN', { rows: [] }],
      ['UPDATE upg.edges', { rows: [], rowCount: 2 }],
      ['COMMIT', { rows: [] }],
    ])
    const { pool, mockClient } = createMockPool(responses)
    const store = new UPGPgStore(pool)

    await store.renameEdgeType('p1', 'old_type', 'new_type', false)

    const updateCall = mockClient.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE'),
    )
    expect(updateCall).toBeDefined()
    const vals = updateCall![1] as unknown[]
    expect(vals[0]).toBe('p1')       // product_id ($1)
    expect(vals[1]).toBe('old_type') // from ($2)
    expect(vals[2]).toBe('new_type') // to ($3)
  })

  it('dry_run COUNT query uses correct parameters', async () => {
    const { pool, queries } = createMockPool(
      new Map([['COUNT(*)', { rows: [{ count: '0' }] }]]),
    )
    const store = new UPGPgStore(pool)

    await store.renameEdgeType('p1', 'my_type', 'other_type', true)

    const countQuery = queries.find((q) => q.text.includes('COUNT(*)'))
    expect(countQuery).toBeDefined()
    expect(countQuery!.values[0]).toBe('p1')       // product_id ($1)
    expect(countQuery!.values[1]).toBe('my_type')  // from type ($2)
  })
})
