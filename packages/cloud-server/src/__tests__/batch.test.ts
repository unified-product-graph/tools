/**
 * Atomic batch tool tests.
 *
 * Covers:
 *  - Happy path: verify the correct SQL statements are issued in the correct
 *    order (BEGIN, mutations, COMMIT).
 *  - Transaction rollback: when the mock pool throws mid-batch, ROLLBACK
 *    is issued and the error propagates.
 *  - Input validation: missing/empty/oversized inputs are rejected before
 *    any database call is made.
 *
 * Pattern follows pg-store.test.ts: a lightweight mock Pool + PoolClient
 * with pattern-matched query responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import {
  batchCreateNodes,
  batchUpdateNodes,
  batchDeleteNodes,
  batchCreateEdges,
  batchDeleteEdges,
  batchMoveNodes,
} from '../tools/batch.js'
import type { CloudContext } from '../lib/server-context.js'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockQuery {
  text: string
  values: unknown[]
}

/**
 * Creates a mock pool + client pair. The `clientResponses` map is consulted
 * on every `client.query(text)` call; `pool.query` is used for existence
 * checks before the transaction opens.
 */
function createMockPool(opts: {
  poolResponses?: Map<string, { rows: unknown[]; rowCount?: number }>
  clientResponses?: Map<string, { rows: unknown[]; rowCount?: number }>
  /** If set, client.query throws this error on calls containing this text. */
  throwOn?: string
} = {}) {
  const clientQueries: MockQuery[] = []
  const poolQueries: MockQuery[] = []

  const mockClient: PoolClient = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values: values ?? [] })
      if (opts.throwOn && text.includes(opts.throwOn)) {
        throw new Error(`Simulated DB error on: ${opts.throwOn}`)
      }
      for (const [pattern, response] of (opts.clientResponses ?? new Map())) {
        if (text.includes(pattern)) return response
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  } as unknown as PoolClient

  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      poolQueries.push({ text, values: values ?? [] })
      for (const [pattern, response] of (opts.poolResponses ?? new Map())) {
        if (text.includes(pattern)) return response
      }
      return { rows: [], rowCount: 0 }
    }),
    connect: vi.fn(async () => mockClient),
  } as unknown as Pool

  return { pool, poolQueries, clientQueries, mockClient }
}

/**
 * Creates a CloudContext backed by a mock pool. The store's private `pool`
 * field is set directly so the batch handlers can access it via `(store as any).pool`.
 */
function createCtx(pool: Pool): CloudContext {
  const store = new UPGPgStore(pool)
  return { store }
}

// Convenience: extract the ordered SQL texts from client queries
function clientTexts(queries: MockQuery[]): string[] {
  return queries.map((q) => q.text)
}

// ─── batch_create_nodes ───────────────────────────────────────────────────────

describe('batchCreateNodes', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateNodes({ nodes: [{ type: 'feature', title: 'X' }] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('validates missing nodes array', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateNodes({ product_id: 'p1' }, ctx)
    expect(result.content[0].text).toContain('nodes')
  })

  it('validates empty nodes array', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateNodes({ product_id: 'p1', nodes: [] }, ctx)
    expect(result.content[0].text).toContain('empty')
  })

  it('rejects batches over 50 nodes', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const nodes = Array.from({ length: 51 }, (_, i) => ({ type: 'feature', title: `F${i}` }))
    const result = await batchCreateNodes({ product_id: 'p1', nodes }, ctx)
    expect(result.content[0].text).toContain('50')
  })

  it('validates missing type on a node', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateNodes({ product_id: 'p1', nodes: [{ title: 'X' }] }, ctx)
    expect(result.content[0].text).toContain('type')
  })

  it('validates missing title on a node', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateNodes({ product_id: 'p1', nodes: [{ type: 'feature' }] }, ctx)
    expect(result.content[0].text).toContain('title')
  })

  it('happy path: BEGIN, INSERT per node, COMMIT', async () => {
    const { pool, clientQueries } = createMockPool()
    const ctx = createCtx(pool)

    const result = await batchCreateNodes(
      {
        product_id: 'p1',
        nodes: [
          { type: 'feature', title: 'Login' },
          { type: 'persona', title: 'Admin' },
        ],
      },
      ctx,
    )

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.filter((t) => t.includes('INSERT INTO upg.nodes'))).toHaveLength(2)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(2)
    expect(body.created).toHaveLength(2)
    expect(body.created[0]).toMatchObject({ type: 'feature', title: 'Login' })
    expect(body.created[1]).toMatchObject({ type: 'persona', title: 'Admin' })
  })

  it('happy path: node with parent_id also inserts an edge', async () => {
    const parentRow = {
      id: 'n_parent',
      product_id: 'p1',
      type: 'product_area',
      title: 'Core',
      description: null,
      status: null,
      tags: null,
      data: null,
    }
    const { pool, clientQueries } = createMockPool({
      clientResponses: new Map([['FROM upg.nodes WHERE id', { rows: [parentRow] }]]),
    })
    const ctx = createCtx(pool)

    await batchCreateNodes(
      {
        product_id: 'p1',
        nodes: [{ type: 'feature', title: 'Login', parent_id: 'n_parent' }],
      },
      ctx,
    )

    const texts = clientTexts(clientQueries)
    const edgeInserts = texts.filter((t) => t.includes('INSERT INTO upg.edges'))
    expect(edgeInserts).toHaveLength(1)
  })

  it('rollback on DB error mid-batch', async () => {
    const { pool, clientQueries, mockClient } = createMockPool({
      throwOn: 'INSERT INTO upg.nodes',
    })
    const ctx = createCtx(pool)

    await expect(
      batchCreateNodes(
        { product_id: 'p1', nodes: [{ type: 'feature', title: 'X' }] },
        ctx,
      ),
    ).rejects.toThrow('Simulated DB error')

    const texts = clientTexts(clientQueries)
    expect(texts).toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

// ─── batch_update_nodes ───────────────────────────────────────────────────────

describe('batchUpdateNodes', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchUpdateNodes({ nodes: [{ id: 'n1', title: 'X' }] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('validates missing id on a node item', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'F',
      description: null, status: null, tags: null, data: null,
    }
    const { pool } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
    })
    const ctx = createCtx(pool)
    const result = await batchUpdateNodes({ product_id: 'p1', nodes: [{ title: 'X' }] }, ctx)
    expect(result.content[0].text).toContain('id')
  })

  it('rejects when node not found', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchUpdateNodes({ product_id: 'p1', nodes: [{ id: 'n_missing', title: 'X' }] }, ctx)
    expect(result.content[0].text).toContain('not found')
  })

  it('happy path: BEGIN, UPDATE per node, COMMIT', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'Feature',
      description: null, status: null, tags: null, data: null,
    }
    const { pool, clientQueries } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
      clientResponses: new Map([['UPDATE upg.nodes SET', { rows: [nodeRow] }]]),
    })
    const ctx = createCtx(pool)

    const result = await batchUpdateNodes(
      { product_id: 'p1', nodes: [{ id: 'n1', title: 'Updated Feature' }] },
      ctx,
    )

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('UPDATE upg.nodes SET'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.updated).toContain('n1')
  })

  it('rollback on DB error during update', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'Feature',
      description: null, status: null, tags: null, data: null,
    }
    const { pool, clientQueries, mockClient } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
      throwOn: 'UPDATE upg.nodes SET',
    })
    const ctx = createCtx(pool)

    await expect(
      batchUpdateNodes({ product_id: 'p1', nodes: [{ id: 'n1', title: 'X' }] }, ctx),
    ).rejects.toThrow('Simulated DB error')

    expect(clientTexts(clientQueries)).toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

// ─── batch_delete_nodes ───────────────────────────────────────────────────────

describe('batchDeleteNodes', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchDeleteNodes({ node_ids: ['n1'] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('rejects when a node is not found', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchDeleteNodes({ product_id: 'p1', node_ids: ['n_missing'] }, ctx)
    expect(result.content[0].text).toContain('not found')
  })

  it('happy path: BEGIN, DELETE edges, DELETE node, COMMIT', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'F',
      description: null, status: null, tags: null, data: null,
    }
    const { pool, clientQueries } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
    })
    const ctx = createCtx(pool)

    const result = await batchDeleteNodes({ product_id: 'p1', node_ids: ['n1'] }, ctx)

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('DELETE FROM upg.edges'))).toBe(true)
    expect(texts.some((t) => t.includes('DELETE FROM upg.nodes WHERE id'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.deleted).toContain('n1')
  })

  it('rollback on DB error during delete', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'F',
      description: null, status: null, tags: null, data: null,
    }
    const { pool, clientQueries, mockClient } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
      throwOn: 'DELETE FROM upg.edges',
    })
    const ctx = createCtx(pool)

    await expect(
      batchDeleteNodes({ product_id: 'p1', node_ids: ['n1'] }, ctx),
    ).rejects.toThrow('Simulated DB error')

    expect(clientTexts(clientQueries)).toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

// ─── batch_create_edges ───────────────────────────────────────────────────────

describe('batchCreateEdges', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateEdges({ edges: [{ source_id: 'a', target_id: 'b' }] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('validates missing source_id on an edge', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'persona', title: 'P',
      description: null, status: null, tags: null, data: null,
    }
    const { pool } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
    })
    const ctx = createCtx(pool)
    const result = await batchCreateEdges({ product_id: 'p1', edges: [{ target_id: 'n1' }] }, ctx)
    expect(result.content[0].text).toContain('source_id')
  })

  it('rejects when source node not found', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchCreateEdges(
      { product_id: 'p1', edges: [{ source_id: 'n_missing', target_id: 'n_other' }] },
      ctx,
    )
    expect(result.content[0].text).toContain('not found')
  })

  it('happy path: BEGIN, INSERT per edge, COMMIT', async () => {
    const sourceRow = {
      id: 'n_src', product_id: 'p1', type: 'persona', title: 'P',
      description: null, status: null, tags: null, data: null,
    }
    const targetRow = {
      id: 'n_tgt', product_id: 'p1', type: 'jtbd', title: 'J',
      description: null, status: null, tags: null, data: null,
    }

    // pool.query is used for pre-validation lookups of source/target nodes
    let callCount = 0
    const poolWithMultiple = {
      query: vi.fn(async () => {
        callCount++
        if (callCount === 1) return { rows: [sourceRow] }
        if (callCount === 2) return { rows: [targetRow] }
        return { rows: [] }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const clientQueries: MockQuery[] = []
    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        clientQueries.push({ text, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    ;(poolWithMultiple.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    const ctx = createCtx(poolWithMultiple)

    const result = await batchCreateEdges(
      {
        product_id: 'p1',
        edges: [{ source_id: 'n_src', target_id: 'n_tgt' }],
      },
      ctx,
    )

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('INSERT INTO upg.edges'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.created[0]).toMatchObject({ source_id: 'n_src', target_id: 'n_tgt' })
    expect(body.created[0].type).toBeTruthy()
  })

  it('uses explicit type when provided', async () => {
    const sourceRow = {
      id: 'n_src', product_id: 'p1', type: 'persona', title: 'P',
      description: null, status: null, tags: null, data: null,
    }
    const targetRow = {
      id: 'n_tgt', product_id: 'p1', type: 'jtbd', title: 'J',
      description: null, status: null, tags: null, data: null,
    }

    let callCount = 0
    const poolWithMultiple = {
      query: vi.fn(async () => {
        callCount++
        if (callCount === 1) return { rows: [sourceRow] }
        if (callCount === 2) return { rows: [targetRow] }
        return { rows: [] }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const clientQueries: MockQuery[] = []
    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        clientQueries.push({ text, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    ;(poolWithMultiple.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    const ctx = createCtx(poolWithMultiple)

    const result = await batchCreateEdges(
      {
        product_id: 'p1',
        edges: [{ source_id: 'n_src', target_id: 'n_tgt', type: 'my_custom_edge' }],
      },
      ctx,
    )

    const body = JSON.parse(result.content[0].text)
    expect(body.created[0].type).toBe('my_custom_edge')
  })

  it('rollback on DB error during edge insert', async () => {
    const sourceRow = {
      id: 'n_src', product_id: 'p1', type: 'persona', title: 'P',
      description: null, status: null, tags: null, data: null,
    }
    const targetRow = {
      id: 'n_tgt', product_id: 'p1', type: 'jtbd', title: 'J',
      description: null, status: null, tags: null, data: null,
    }

    let callCount = 0
    const poolWithMultiple = {
      query: vi.fn(async () => {
        callCount++
        if (callCount === 1) return { rows: [sourceRow] }
        if (callCount === 2) return { rows: [targetRow] }
        return { rows: [] }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const clientQueries: MockQuery[] = []
    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        clientQueries.push({ text, values: values ?? [] })
        if (text.includes('INSERT INTO upg.edges')) throw new Error('Simulated DB error on: INSERT INTO upg.edges')
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    ;(poolWithMultiple.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    const ctx = createCtx(poolWithMultiple)

    await expect(
      batchCreateEdges(
        { product_id: 'p1', edges: [{ source_id: 'n_src', target_id: 'n_tgt' }] },
        ctx,
      ),
    ).rejects.toThrow('Simulated DB error')

    expect(clientTexts(clientQueries)).toContain('ROLLBACK')
    expect((mockClient.release as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })
})

// ─── batch_delete_edges ───────────────────────────────────────────────────────

describe('batchDeleteEdges', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchDeleteEdges({ edge_ids: ['e1'] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('validates empty edge_ids', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchDeleteEdges({ product_id: 'p1', edge_ids: [] }, ctx)
    expect(result.content[0].text).toContain('empty')
  })

  it('rejects when an edge is not found in the product', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchDeleteEdges({ product_id: 'p1', edge_ids: ['e_missing'] }, ctx)
    expect(result.content[0].text).toContain('not found')
  })

  it('happy path: BEGIN, DELETE per edge, COMMIT', async () => {
    const edgeRow = { id: 'e1' }
    const { pool, clientQueries } = createMockPool({
      poolResponses: new Map([['FROM upg.edges WHERE id', { rows: [edgeRow] }]]),
    })
    const ctx = createCtx(pool)

    const result = await batchDeleteEdges({ product_id: 'p1', edge_ids: ['e1'] }, ctx)

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('DELETE FROM upg.edges WHERE id'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.deleted).toContain('e1')
  })

  it('rollback on DB error during edge delete', async () => {
    const edgeRow = { id: 'e1' }
    const { pool, clientQueries, mockClient } = createMockPool({
      poolResponses: new Map([['FROM upg.edges WHERE id', { rows: [edgeRow] }]]),
      throwOn: 'DELETE FROM upg.edges WHERE id',
    })
    const ctx = createCtx(pool)

    await expect(
      batchDeleteEdges({ product_id: 'p1', edge_ids: ['e1'] }, ctx),
    ).rejects.toThrow('Simulated DB error')

    expect(clientTexts(clientQueries)).toContain('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

// ─── batch_move_nodes ─────────────────────────────────────────────────────────

describe('batchMoveNodes', () => {
  it('validates missing product_id', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchMoveNodes({ moves: [{ node_id: 'n1', new_parent_id: 'n2' }] }, ctx)
    expect(result.content[0].text).toContain('product_id')
  })

  it('validates missing node_id in a move', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'F',
      description: null, status: null, tags: null, data: null,
    }
    const { pool } = createMockPool({
      poolResponses: new Map([['FROM upg.nodes WHERE id', { rows: [nodeRow] }]]),
    })
    const ctx = createCtx(pool)
    const result = await batchMoveNodes({ product_id: 'p1', moves: [{ new_parent_id: 'n2' }] }, ctx)
    expect(result.content[0].text).toContain('node_id')
  })

  it('rejects when node not found', async () => {
    const { pool } = createMockPool()
    const ctx = createCtx(pool)
    const result = await batchMoveNodes(
      { product_id: 'p1', moves: [{ node_id: 'n_missing', new_parent_id: 'n_parent' }] },
      ctx,
    )
    expect(result.content[0].text).toContain('not found')
  })

  it('happy path: BEGIN, DELETE old edges, INSERT new edge, COMMIT', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'Feature',
      description: null, status: null, tags: null, data: null,
    }
    const parentRow = {
      id: 'n_parent', product_id: 'p1', type: 'product_area', title: 'Area',
      description: null, status: null, tags: null, data: null,
    }

    // Pre-validation uses store.getNode which goes through pool.query.
    // Then inside the tx, client.query fetches node types.
    let poolCallCount = 0
    const pool = {
      query: vi.fn(async () => {
        poolCallCount++
        // First call: getNode(node_id), second: getNode(new_parent_id)
        if (poolCallCount === 1) return { rows: [nodeRow] }
        if (poolCallCount === 2) return { rows: [parentRow] }
        return { rows: [] }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const clientQueries: MockQuery[] = []
    let clientCallCount = 0
    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        clientQueries.push({ text, values: values ?? [] })
        clientCallCount++
        // Inside tx: first SELECT is node type, second SELECT is parent type
        if (text.includes('SELECT type FROM upg.nodes') && clientCallCount === 2) return { rows: [{ type: 'feature' }] }
        if (text.includes('SELECT type FROM upg.nodes') && clientCallCount === 3) return { rows: [{ type: 'product_area' }] }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    ;(pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    const ctx = createCtx(pool)

    const result = await batchMoveNodes(
      { product_id: 'p1', moves: [{ node_id: 'n1', new_parent_id: 'n_parent' }] },
      ctx,
    )

    const texts = clientTexts(clientQueries)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.some((t) => t.includes('DELETE FROM upg.edges'))).toBe(true)
    expect(texts.some((t) => t.includes('INSERT INTO upg.edges'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')

    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.moved[0]).toMatchObject({ node_id: 'n1', new_parent_id: 'n_parent' })
  })

  it('rollback on DB error during move', async () => {
    const nodeRow = {
      id: 'n1', product_id: 'p1', type: 'feature', title: 'F',
      description: null, status: null, tags: null, data: null,
    }
    const parentRow = {
      id: 'n_parent', product_id: 'p1', type: 'product_area', title: 'A',
      description: null, status: null, tags: null, data: null,
    }

    let poolCallCount = 0
    const pool = {
      query: vi.fn(async () => {
        poolCallCount++
        if (poolCallCount === 1) return { rows: [nodeRow] }
        if (poolCallCount === 2) return { rows: [parentRow] }
        return { rows: [] }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const clientQueries: MockQuery[] = []
    let clientCallCount = 0
    const mockClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        clientQueries.push({ text, values: values ?? [] })
        clientCallCount++
        if (text.includes('SELECT type FROM upg.nodes') && clientCallCount === 2) return { rows: [{ type: 'feature' }] }
        if (text.includes('SELECT type FROM upg.nodes') && clientCallCount === 3) return { rows: [{ type: 'product_area' }] }
        if (text.includes('DELETE FROM upg.edges')) throw new Error('Simulated DB error on: DELETE FROM upg.edges')
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    ;(pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient)

    const ctx = createCtx(pool)

    await expect(
      batchMoveNodes(
        { product_id: 'p1', moves: [{ node_id: 'n1', new_parent_id: 'n_parent' }] },
        ctx,
      ),
    ).rejects.toThrow('Simulated DB error')

    expect(clientTexts(clientQueries)).toContain('ROLLBACK')
    expect((mockClient.release as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })
})
