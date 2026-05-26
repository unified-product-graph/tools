/**
 * Tests for (move_node) and (create_area + get_area_context).
 *
 * Covers:
 * - PgStore.moveNode: transaction semantics, old edge deletion, new edge insert
 * - moveNode handler: validation, ownership checks, self-move guard
 * - createArea handler: node creation with product_id, title, description
 * - getAreaContext handler: entity counts, child area count, missing-node error
 */
import { describe, it, expect, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import { moveNode } from '../tools/nodes.js'
import { createArea, getAreaContext } from '../tools/areas.js'
import type { CloudContext } from '../lib/server-context.js'

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<{
  id: string
  product_id: string
  type: string
  title: string
  description: string | null
  status: string | null
  tags: string[] | null
  data: unknown
}> = {}) {
  return {
    id: overrides.id ?? 'n_default',
    product_id: overrides.product_id ?? 'p1',
    type: overrides.type ?? 'feature',
    title: overrides.title ?? 'Default Node',
    description: overrides.description ?? null,
    status: overrides.status ?? null,
    tags: overrides.tags ?? null,
    data: overrides.data ?? null,
  }
}

/**
 * Build a mock Pool where `pool.query` and `client.query` both match
 * patterns in the responses map and fall back to `{ rows: [], rowCount: 0 }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockClient(queryFn: (...args: any[]) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 })) {
  const mockClient = {
    query: vi.fn(queryFn),
    release: vi.fn(),
  }
  return mockClient
}

function createMockPool(queryResponses: Map<string, { rows: unknown[]; rowCount?: number }> = new Map()) {
  const defaultQueryFn = async (text: string) => {
    for (const [pattern, response] of queryResponses) {
      if (text.includes(pattern)) return response
    }
    return { rows: [], rowCount: 0 }
  }

  const mockClient = makeMockClient(defaultQueryFn)

  const pool = {
    query: vi.fn(defaultQueryFn),
    connect: vi.fn(async () => mockClient as unknown as PoolClient),
  } as unknown as Pool

  return { pool, mockClient }
}

function makeCtx(pool: Pool): CloudContext {
  return { store: new UPGPgStore(pool) }
}

// ── PgStore.moveNode ──────────────────────────────────────────────────────────

describe('PgStore.moveNode()', () => {
  it('runs inside a transaction (BEGIN / COMMIT)', async () => {
    const { pool, mockClient } = createMockPool(
      new Map([
        ['DELETE FROM upg.edges', { rows: [{ id: 'e_old', source: 'n_parent_old' }] }],
        ['INSERT INTO upg.edges', { rows: [], rowCount: 1 }],
      ]),
    )
    const store = new UPGPgStore(pool)

    await store.moveNode('p1', 'n_child', 'n_parent_new', 'area_contains_feature', 'e_new')

    const clientCalls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as string))
    expect(clientCalls[0]).toBe('BEGIN')
    expect(clientCalls[clientCalls.length - 1]).toBe('COMMIT')
  })

  it('deletes containment edges targeting the node before inserting the new one', async () => {
    const { pool, mockClient } = createMockPool(
      new Map([
        ['DELETE FROM upg.edges', { rows: [{ id: 'e_old', source: 'n_old_parent' }] }],
        ['INSERT INTO upg.edges', { rows: [], rowCount: 1 }],
      ]),
    )
    const store = new UPGPgStore(pool)

    await store.moveNode('p1', 'n_child', 'n_new_parent', 'area_contains_feature', 'e_new')

    const clientQueries = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => ({ text: c[0] as string, values: c[1] as unknown[] | undefined }),
    )
    const deleteCall = clientQueries.find((q) => q.text.includes('DELETE FROM upg.edges'))
    expect(deleteCall).toBeDefined()
    expect(deleteCall!.values).toContain('p1')
    expect(deleteCall!.values).toContain('n_child')

    const insertCall = clientQueries.find((q) => q.text.includes('INSERT INTO upg.edges'))
    expect(insertCall).toBeDefined()
    expect(insertCall!.values).toContain('e_new')
    expect(insertCall!.values).toContain('n_new_parent')
    expect(insertCall!.values).toContain('n_child')
    expect(insertCall!.values).toContain('area_contains_feature')
  })

  it('returns old_parent_id as null when no prior edge existed', async () => {
    const { pool } = createMockPool(
      new Map([
        ['DELETE FROM upg.edges', { rows: [] }],
        ['INSERT INTO upg.edges', { rows: [], rowCount: 1 }],
      ]),
    )
    const store = new UPGPgStore(pool)

    const result = await store.moveNode('p1', 'n_orphan', 'n_new_parent', 'area_contains_feature', 'e_new')

    expect(result.old_parent_id).toBeNull()
    expect(result.new_parent_id).toBe('n_new_parent')
    expect(result.node_id).toBe('n_orphan')
  })

  it('returns the old_parent_id when a prior edge existed', async () => {
    const { pool } = createMockPool(
      new Map([
        ['DELETE FROM upg.edges', { rows: [{ id: 'e_old', source: 'n_old_parent' }] }],
        ['INSERT INTO upg.edges', { rows: [], rowCount: 1 }],
      ]),
    )
    const store = new UPGPgStore(pool)

    const result = await store.moveNode('p1', 'n_child', 'n_new_parent', 'area_contains_feature', 'e_new')

    expect(result.old_parent_id).toBe('n_old_parent')
  })

  it('returns the edge_created shape', async () => {
    const { pool } = createMockPool(
      new Map([
        ['DELETE FROM upg.edges', { rows: [] }],
        ['INSERT INTO upg.edges', { rows: [], rowCount: 1 }],
      ]),
    )
    const store = new UPGPgStore(pool)

    const result = await store.moveNode('p1', 'n_child', 'n_parent', 'area_contains_feature', 'e_new_id')

    expect(result.edge_created).toEqual({
      id: 'e_new_id',
      source: 'n_parent',
      target: 'n_child',
      type: 'area_contains_feature',
    })
  })

  it('rolls back on error and rethrows', async () => {
    const { pool, mockClient } = createMockPool()
    ;(mockClient.query as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      if (text === 'BEGIN') return { rows: [] }
      if (text.includes('DELETE FROM upg.edges')) throw new Error('DB error')
      return { rows: [] }
    })
    const store = new UPGPgStore(pool)

    await expect(
      store.moveNode('p1', 'n_child', 'n_parent', 'area_contains_feature', 'e_new'),
    ).rejects.toThrow('DB error')

    const clientCalls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as string))
    expect(clientCalls).toContain('ROLLBACK')
  })
})

// ── moveNode handler ──────────────────────────────────────────────────────────

describe('moveNode handler', () => {
  it('errors when product_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await moveNode({ node_id: 'n_1', new_parent_id: 'n_2' }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('errors when node_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', new_parent_id: 'n_2' }, ctx)
    expect(result.content[0].text).toContain('node_id')
  })

  it('errors when new_parent_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_1' }, ctx)
    expect(result.content[0].text).toContain('new_parent_id')
  })

  it('errors when node_id equals new_parent_id (self-move)', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_1', new_parent_id: 'n_1' }, ctx)
    expect(result.content[0].text).toContain('itself')
  })

  it('errors when node does not exist', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_missing', new_parent_id: 'n_parent' }, ctx)
    expect(result.content[0].text).toContain('not found')
  })

  it('errors when node belongs to a different product', async () => {
    const nodeRow = makeNode({ id: 'n_1', product_id: 'p_other', type: 'feature' })
    const { pool } = createMockPool(
      new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
    )
    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_1', new_parent_id: 'n_parent' }, ctx)
    expect(result.content[0].text).toContain('does not belong to product')
  })

  it('errors when new_parent belongs to a different product', async () => {
    const nodeRow = makeNode({ id: 'n_child', product_id: 'p1', type: 'feature' })
    const parentRow = makeNode({ id: 'n_parent', product_id: 'p_other', type: 'area' })

    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [nodeRow] })
        .mockResolvedValueOnce({ rows: [parentRow] })
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      })),
    } as unknown as Pool

    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_child', new_parent_id: 'n_parent' }, ctx)
    expect(result.content[0].text).toContain('does not belong to product')
  })

  it('returns move result on success', async () => {
    const nodeRow = makeNode({ id: 'n_child', product_id: 'p1', type: 'feature' })
    // product_area → feature is canonical (product_area_contains_feature).
    // Catalog-strict inference refuses non-canonical pairs, so the parent must
    // be a real containment parent for the child type.
    const parentRow = makeNode({ id: 'n_parent', product_id: 'p1', type: 'product_area' })

    const mockClientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'e_old', source: 'n_old' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })

    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [nodeRow] })
        .mockResolvedValueOnce({ rows: [parentRow] })
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({
        query: mockClientQuery,
        release: vi.fn(),
      })),
    } as unknown as Pool

    const ctx = makeCtx(pool)
    const result = await moveNode({ product_id: 'p1', node_id: 'n_child', new_parent_id: 'n_parent' }, ctx)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.node_id).toBe('n_child')
    expect(parsed.new_parent_id).toBe('n_parent')
    expect(parsed.old_parent_id).toBe('n_old')
    expect(parsed.edge_created).toMatchObject({
      source: 'n_parent',
      target: 'n_child',
    })
  })
})

// ── createArea handler ────────────────────────────────────────────────────────

describe('createArea handler', () => {
  it('errors when product_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await createArea({ title: 'My Area' }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('errors when title is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await createArea({ product_id: 'p1' }, ctx)
    expect(result.content[0].text).toContain('title')
  })

  it('creates an area node with type "area"', async () => {
    const returnedRow = makeNode({ id: 'n_area1', product_id: 'p1', type: 'area', title: 'Growth' })
    // addNode now runs inside a transaction, so the INSERT lands on the client.
    const clientQuery = vi.fn(async (text: string, _values?: unknown[]) =>
      text.includes('INSERT INTO upg.nodes') ? { rows: [returnedRow] } : { rows: [] },
    )
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    } as unknown as Pool
    const ctx = makeCtx(pool)

    const result = await createArea({ product_id: 'p1', title: 'Growth' }, ctx)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.node).toBeDefined()
    expect(parsed.node.type).toBe('area')
    expect(parsed.node.title).toBe('Growth')

    const insertCall = clientQuery.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO upg.nodes'),
    )
    expect(insertCall).toBeDefined()
    expect(insertCall![1]).toContain('area')
    expect(insertCall![1]).toContain('p1')
    expect(insertCall![1]).toContain('Growth')
    // UPG-552: the create must write an audit row in the same transaction.
    expect(clientQuery.mock.calls.some((c: unknown[]) => (c[0] as string).includes('INSERT INTO upg.audit_log'))).toBe(true)
  })

  it('passes description when provided', async () => {
    const returnedRow = makeNode({
      id: 'n_area2',
      product_id: 'p1',
      type: 'area',
      title: 'Engagement',
      description: 'User engagement area',
    })
    const clientQuery = vi.fn(async (text: string, _values?: unknown[]) =>
      text.includes('INSERT INTO upg.nodes') ? { rows: [returnedRow] } : { rows: [] },
    )
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    } as unknown as Pool
    const ctx = makeCtx(pool)

    await createArea({ product_id: 'p1', title: 'Engagement', description: 'User engagement area' }, ctx)

    const insertCall = clientQuery.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO upg.nodes'),
    )
    expect(insertCall![1]).toContain('User engagement area')
  })
})

// ── getAreaContext handler ────────────────────────────────────────────────────

describe('getAreaContext handler', () => {
  it('errors when product_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await getAreaContext({ area_id: 'n_a1' }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('errors when area_id is missing', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await getAreaContext({ product_id: 'p1' }, ctx)
    expect(result.content[0].text).toContain('area_id')
  })

  it('errors when area node does not exist', async () => {
    const { pool } = createMockPool()
    const ctx = makeCtx(pool)
    const result = await getAreaContext({ product_id: 'p1', area_id: 'n_missing' }, ctx)
    expect(result.content[0].text).toContain('not found')
  })

  it('errors when area node belongs to a different product', async () => {
    const areaRow = makeNode({ id: 'n_a1', product_id: 'p_other', type: 'area' })
    const { pool } = createMockPool(
      new Map([['FROM upg.nodes WHERE id', { rows: [areaRow] }]]),
    )
    const ctx = makeCtx(pool)
    const result = await getAreaContext({ product_id: 'p1', area_id: 'n_a1' }, ctx)
    expect(result.content[0].text).toContain('does not belong to product')
  })

  it('returns entity counts and child_areas from the subgraph', async () => {
    const areaRow = makeNode({ id: 'n_a1', product_id: 'p1', type: 'area', title: 'Growth' })

    // getDescendantTypeCounts returns type+count rows (excluding root)
    const typeCountRows = [
      { type: 'feature', count: '2' },
      { type: 'product_area', count: '1' },
    ]

    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [areaRow] })       // getNode (ownership check)
        .mockResolvedValueOnce({ rows: typeCountRows })   // getDescendantTypeCounts CTE
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      })),
    } as unknown as Pool

    const ctx = makeCtx(pool)
    const result = await getAreaContext({ product_id: 'p1', area_id: 'n_a1' }, ctx)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.area.id).toBe('n_a1')
    expect(parsed.area.title).toBe('Growth')
    expect(parsed.entity_counts.feature).toBe(2)
    expect(parsed.entity_counts.product_area).toBe(1)
    expect(parsed.total_entities).toBe(3)
    expect(parsed.child_areas).toBe(1)
  })

  it('returns zero counts when area has no children', async () => {
    const areaRow = makeNode({ id: 'n_a1', product_id: 'p1', type: 'area', title: 'Empty Area' })

    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [areaRow] }) // getNode (ownership)
        .mockResolvedValueOnce({ rows: [] })         // getDescendantTypeCounts: no children
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      })),
    } as unknown as Pool

    const ctx = makeCtx(pool)
    const result = await getAreaContext({ product_id: 'p1', area_id: 'n_a1' }, ctx)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.total_entities).toBe(0)
    expect(parsed.child_areas).toBe(0)
    expect(parsed.entity_counts).toEqual({})
  })
})
