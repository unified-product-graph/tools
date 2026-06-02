import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type { UPGEdge } from '@unified-product-graph/core'
import { UPGPgStore } from '../store/pg-store.js'

// ── Mock pool factory ──────────────────────────────────────────────────────

interface MockQuery {
  text: string
  values: unknown[]
}

function createMockPool(queryResponses: Map<string, { rows: unknown[]; rowCount?: number }> = new Map()) {
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

/** First recorded query whose SQL contains `substr` (mutations now run inside a
 *  BEGIN/…/COMMIT transaction, so index-0 is no longer the mutation). */
function findQuery(queries: MockQuery[], substr: string): MockQuery {
  const found = queries.find((q) => q.text.includes(substr))
  if (!found) throw new Error(`No recorded query matching: ${substr}`)
  return found
}

/** True iff an audit row was written (every mutation must record one). */
function wroteAudit(queries: MockQuery[]): boolean {
  return queries.some((q) => q.text.includes('INSERT INTO upg.audit_log'))
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UPGPgStore', () => {
  // ── Products ─────────────────────────────────────────────────────────────

  describe('listProducts()', () => {
    it('returns products from the query', async () => {
      const products = [
        { id: 'p1', title: 'Alpha', description: 'First product', stage: 'mvp' },
        { id: 'p2', title: 'Beta', description: null, stage: 'idea' },
      ]
      const { pool, queries } = createMockPool(
        new Map([['upg.products ORDER BY title', { rows: products }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.listProducts()

      expect(result).toEqual(products)
      expect(queries).toHaveLength(1)
      expect(queries[0].text).toContain('SELECT id, title, description, stage FROM upg.products')
    })
  })

  describe('createProduct()', () => {
    it('inserts product with correct fields', async () => {
      const created = { id: 'n_abc123', title: 'My Product', description: 'desc', stage: 'idea' }
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.products', { rows: [created] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.createProduct('My Product', 'desc', 'idea')

      expect(result).toEqual(created)
      const insert = findQuery(queries, 'INSERT INTO upg.products')
      // Values: [id, title, description, stage]
      expect(insert.values[1]).toBe('My Product')
      expect(insert.values[2]).toBe('desc')
      expect(insert.values[3]).toBe('idea')
      expect(wroteAudit(queries), 'createProduct must write an audit row').toBe(true)
    })

    it('passes null for optional fields when omitted', async () => {
      const created = { id: 'n_abc123', title: 'Minimal', description: null, stage: null }
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.products', { rows: [created] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.createProduct('Minimal')

      const insert = findQuery(queries, 'INSERT INTO upg.products')
      expect(insert.values[2]).toBeNull() // description
      expect(insert.values[3]).toBeNull() // stage
    })
  })

  // ── Nodes ────────────────────────────────────────────────────────────────

  describe('getNode()', () => {
    it('returns a node mapped from the row', async () => {
      const row = {
        id: 'n_123',
        product_id: 'p1',
        type: 'persona',
        title: 'Power User',
        description: 'A power user',
        status: 'active',
        tags: ['core'],
        data: { age_range: '25-35' },
      }
      const { pool, queries } = createMockPool(
        new Map([['FROM upg.nodes WHERE id', { rows: [row] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.getNode('n_123')

      expect(result).toBeDefined()
      expect(result!.id).toBe('n_123')
      expect(result!.type).toBe('persona')
      expect(result!.title).toBe('Power User')
      expect(result!.description).toBe('A power user')
      expect(result!.status).toBe('active')
      expect(result!.tags).toEqual(['core'])
      // data column maps to properties
      expect(result!.properties).toEqual({ age_range: '25-35' })
      expect(queries[0].values).toEqual(['n_123'])
    })

    it('returns undefined when node does not exist', async () => {
      const { pool } = createMockPool()
      const store = new UPGPgStore(pool)

      const result = await store.getNode('n_nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('addNode()', () => {
    it('inserts a node with correct productId, type, title, and properties', async () => {
      const returnedRow = {
        id: 'n_new',
        product_id: 'p1',
        type: 'opportunity',
        title: 'Expand market',
        description: null,
        status: null,
        tags: null,
        data: { impact: 'high' },
      }
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.nodes', { rows: [returnedRow] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.addNode('p1', {
        id: 'n_new',
        type: 'opportunity' as any,
        title: 'Expand market',
        properties: { impact: 'high' },
      })

      expect(result.id).toBe('n_new')
      expect(result.type).toBe('opportunity')
      expect(result.properties).toEqual({ impact: 'high' })

      // Verify SQL values: [id, productId, type, title, description, status, tags, data]
      const vals = findQuery(queries, 'INSERT INTO upg.nodes').values
      expect(vals[0]).toBe('n_new')      // id
      expect(vals[1]).toBe('p1')          // product_id
      expect(vals[2]).toBe('opportunity') // type
      expect(vals[3]).toBe('Expand market') // title
      expect(vals[4]).toBeNull()          // description
      expect(vals[5]).toBeNull()          // status
      expect(vals[6]).toBeNull()          // tags
      expect(vals[7]).toBe(JSON.stringify({ impact: 'high' })) // data (stringified)
      expect(wroteAudit(queries), 'addNode must write an audit row').toBe(true)
    })

    it('generates an ID when node has no id', async () => {
      const returnedRow = {
        id: 'n_generated',
        product_id: 'p1',
        type: 'feature',
        title: 'New feature',
        description: null,
        status: null,
        tags: null,
        data: null,
      }
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.nodes', { rows: [returnedRow] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.addNode('p1', {
        id: '',
        type: 'feature' as any,
        title: 'New feature',
      })

      // ID should be a generated UUID (the upg.nodes.id column is UUID).
      const insertedId = findQuery(queries, 'INSERT INTO upg.nodes').values[0] as string
      expect(insertedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })
  })

  describe('updateNode()', () => {
    it('builds UPDATE SQL with only changed fields', async () => {
      const returnedRow = {
        id: 'n_1',
        product_id: 'p1',
        type: 'persona',
        title: 'Updated Title',
        description: 'New desc',
        status: null,
        tags: null,
        data: null,
      }
      const { pool, queries } = createMockPool(
        new Map([['UPDATE upg.nodes SET', { rows: [returnedRow] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.updateNode('n_1', { title: 'Updated Title', description: 'New desc' })

      const update = findQuery(queries, 'UPDATE upg.nodes SET')
      const sql = update.text
      expect(sql).toContain('title = $1')
      expect(sql).toContain('description = $2')
      expect(sql).toContain('WHERE id = $3')
      // Should NOT contain status, tags, or data
      expect(sql).not.toContain('status =')
      expect(sql).not.toContain('tags =')
      expect(sql).not.toContain('data =')

      expect(update.values).toEqual(['Updated Title', 'New desc', 'n_1'])
      expect(wroteAudit(queries), 'updateNode must write an audit row').toBe(true)
    })

    it('merges properties into existing data with COALESCE', async () => {
      const returnedRow = {
        id: 'n_1',
        product_id: 'p1',
        type: 'persona',
        title: 'Persona',
        description: null,
        status: null,
        tags: null,
        data: { age_range: '25-35', role: 'engineer' },
      }
      const { pool, queries } = createMockPool(
        new Map([['UPDATE upg.nodes SET', { rows: [returnedRow] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.updateNode('n_1', { properties: { role: 'engineer' } })

      const update = findQuery(queries, 'UPDATE upg.nodes SET')
      expect(update.text).toContain('COALESCE(data,')
      expect(update.text).toContain('::jsonb')
      expect(update.values[0]).toBe(JSON.stringify({ role: 'engineer' }))
    })

    it('throws when node not found', async () => {
      const { pool } = createMockPool()
      const store = new UPGPgStore(pool)

      await expect(store.updateNode('n_missing', { title: 'X' }))
        .rejects.toThrow('Node not found: n_missing')
    })

    it('returns existing node when patch is empty', async () => {
      const existingRow = {
        id: 'n_1',
        product_id: 'p1',
        type: 'persona',
        title: 'Existing',
        description: null,
        status: null,
        tags: null,
        data: null,
      }
      const { pool } = createMockPool(
        new Map([['FROM upg.nodes WHERE id', { rows: [existingRow] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.updateNode('n_1', {})
      expect(result.title).toBe('Existing')
    })
  })

  describe('removeNode()', () => {
    it('deletes node and returns removed edge IDs within a transaction', async () => {
      const nodeRow = {
        id: 'n_1',
        product_id: 'p1',
        type: 'persona',
        title: 'To Delete',
        description: null,
        status: null,
        tags: null,
        data: null,
      }
      const edgeRows = [{ id: 'e_1' }, { id: 'e_2' }]

      const responses = new Map<string, { rows: unknown[] }>([
        ['BEGIN', { rows: [] }],
        ['SELECT', { rows: [nodeRow] }],
        ['DELETE FROM upg.edges', { rows: edgeRows }],
        ['DELETE FROM upg.nodes', { rows: [] }],
        ['COMMIT', { rows: [] }],
      ])
      const { pool, mockClient } = createMockPool(responses)
      const store = new UPGPgStore(pool)

      const result = await store.removeNode('n_1')

      expect(result.node.id).toBe('n_1')
      expect(result.removedEdgeIds).toEqual(['e_1', 'e_2'])
      // Verify transaction lifecycle
      const clientCalls = mockClient.query.mock.calls.map(c => c[0] as string)
      expect(clientCalls[0]).toBe('BEGIN')
      expect(clientCalls[clientCalls.length - 1]).toBe('COMMIT')
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('throws and rolls back when node not found', async () => {
      const responses = new Map<string, { rows: unknown[] }>([
        ['BEGIN', { rows: [] }],
        ['ROLLBACK', { rows: [] }],
      ])
      const { pool, mockClient } = createMockPool(responses)
      const store = new UPGPgStore(pool)

      await expect(store.removeNode('n_missing')).rejects.toThrow('Node not found: n_missing')
      const clientCalls = mockClient.query.mock.calls.map(c => c[0] as string)
      expect(clientCalls).toContain('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalled()
    })
  })

  // ── Edges ────────────────────────────────────────────────────────────────

  describe('addEdge()', () => {
    it('inserts edge with correct source, target, type', async () => {
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.edges', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.addEdge('p1', {
        id: 'e_1',
        source: 'n_a',
        target: 'n_b',
        type: 'persona_pursues_job',
      })

      const vals = findQuery(queries, 'INSERT INTO upg.edges').values
      expect(vals[0]).toBe('e_1')               // id
      expect(vals[1]).toBe('p1')                 // product_id
      expect(vals[2]).toBe('n_a')                // source
      expect(vals[3]).toBe('n_b')                // target
      expect(vals[4]).toBe('persona_pursues_job')   // type
      expect(wroteAudit(queries), 'addEdge must write an audit row').toBe(true)
    })

    it('generates an ID when edge has no id', async () => {
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.edges', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.addEdge('p1', {
        id: '',
        source: 'n_a',
        target: 'n_b',
        type: 'related_to' as UPGEdge['type'],
      })

      const insertedId = findQuery(queries, 'INSERT INTO upg.edges').values[0] as string
      expect(insertedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('persists gated edge properties as JSONB (0.8.6)', async () => {
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.edges', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.addEdge('p1', {
        id: 'e_1',
        source: 'n_a',
        target: 'n_b',
        type: 'framework_exercise_includes_node' as UPGEdge['type'],
        properties: { moscow: 'must' },
      })

      const insert = findQuery(queries, 'INSERT INTO upg.edges')
      expect(insert.text).toContain('properties')
      expect(insert.values[5]).toBe(JSON.stringify({ moscow: 'must' })) // payload at $6
    })

    it('writes a NULL payload when an edge carries no properties', async () => {
      const { pool, queries } = createMockPool(
        new Map([['INSERT INTO upg.edges', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)
      await store.addEdge('p1', {
        id: 'e_1',
        source: 'n_a',
        target: 'n_b',
        type: 'persona_pursues_job',
      })
      expect(findQuery(queries, 'INSERT INTO upg.edges').values[5]).toBeNull()
    })
  })

  describe('setEdgeProperties()', () => {
    it('merges via JSONB || by default and returns the updated edge', async () => {
      const updated = { id: 'e_1', product_id: 'p1', source: 'n_a', target: 'n_b', type: 'framework_exercise_includes_node', properties: { reach: 800, impact: 3 } }
      const { pool, queries } = createMockPool(
        new Map([['UPDATE upg.edges', { rows: [updated] }]]),
      )
      const store = new UPGPgStore(pool)

      const edge = await store.setEdgeProperties('e_1', { impact: 3 })

      const update = findQuery(queries, 'UPDATE upg.edges')
      expect(update.text).toContain("COALESCE(properties, '{}'::jsonb) || $1::jsonb")
      expect(update.values[0]).toBe(JSON.stringify({ impact: 3 }))
      expect(update.values[1]).toBe('e_1')
      expect(edge.properties).toEqual({ reach: 800, impact: 3 })
      expect(wroteAudit(queries), 'setEdgeProperties must write an audit row').toBe(true)
    })

    it('replaces the payload wholesale when merge:false', async () => {
      const updated = { id: 'e_1', product_id: 'p1', source: 'n_a', target: 'n_b', type: 'framework_exercise_includes_node', properties: { moscow: 'could' } }
      const { pool, queries } = createMockPool(
        new Map([['UPDATE upg.edges', { rows: [updated] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.setEdgeProperties('e_1', { moscow: 'could' }, { merge: false })

      const update = findQuery(queries, 'UPDATE upg.edges')
      expect(update.text).toContain('SET properties = $1::jsonb')
      expect(update.text).not.toContain('COALESCE')
    })

    it('throws when the edge does not exist', async () => {
      const { pool } = createMockPool(new Map([['UPDATE upg.edges', { rows: [] }]]))
      const store = new UPGPgStore(pool)
      await expect(store.setEdgeProperties('missing', { x: 1 })).rejects.toThrow(/Edge not found/)
    })
  })

  describe('removeEdge()', () => {
    it('deletes edge and returns the removed edge', async () => {
      const edgeRow = { id: 'e_1', source: 'n_a', target: 'n_b', type: 'persona_pursues_job' }
      const { pool } = createMockPool(
        new Map([['DELETE FROM upg.edges WHERE id', { rows: [edgeRow] }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.removeEdge('e_1')

      expect(result).toEqual({
        id: 'e_1',
        source: 'n_a',
        target: 'n_b',
        type: 'persona_pursues_job',
      })
    })

    it('throws when edge not found', async () => {
      const { pool } = createMockPool()
      const store = new UPGPgStore(pool)

      await expect(store.removeEdge('e_missing')).rejects.toThrow('Edge not found: e_missing')
    })
  })

  // ── Search ───────────────────────────────────────────────────────────────

  describe('searchNodes()', () => {
    it('constructs full-text search query with product_id and query', async () => {
      const rows = [
        { id: 'n_1', product_id: 'p1', type: 'persona', title: 'Power User', description: null, status: null, tags: null, data: null },
      ]
      const { pool, queries } = createMockPool(
        new Map([['FROM upg.nodes', { rows }]]),
      )
      const store = new UPGPgStore(pool)

      const result = await store.searchNodes('p1', 'power user')

      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Power User')
      const sql = queries[0].text
      expect(sql).toContain('to_tsvector')
      expect(sql).toContain('plainto_tsquery')
      expect(queries[0].values[0]).toBe('p1')
      expect(queries[0].values[1]).toBe('power user')
    })

    it('adds type filter when type is specified', async () => {
      const { pool, queries } = createMockPool(
        new Map([['FROM upg.nodes', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.searchNodes('p1', 'test', 'feature', 10)

      const sql = queries[0].text
      expect(sql).toContain('type = $3')
      expect(queries[0].values).toEqual(['p1', 'test', 'feature', 10])
    })

    it('uses default limit of 20 when not specified', async () => {
      const { pool, queries } = createMockPool(
        new Map([['FROM upg.nodes', { rows: [] }]]),
      )
      const store = new UPGPgStore(pool)

      await store.searchNodes('p1', 'test')

      // Without type: values = [productId, query, limit]
      expect(queries[0].values).toEqual(['p1', 'test', 20])
    })
  })

  // ── Type safety ──────────────────────────────────────────────────────────

  describe('type safety', () => {
    it('preserves entity type through add and get', async () => {
      const row = {
        id: 'n_1',
        product_id: 'p1',
        type: 'hypothesis',
        title: 'Users want X',
        description: null,
        status: 'testing',
        tags: null,
        data: null,
      }
      const { pool } = createMockPool(
        new Map([
          ['INSERT INTO upg.nodes', { rows: [row] }],
          ['FROM upg.nodes WHERE id', { rows: [row] }],
        ]),
      )
      const store = new UPGPgStore(pool)

      const added = await store.addNode('p1', {
        id: 'n_1',
        type: 'hypothesis' as any,
        title: 'Users want X',
        status: 'testing',
      })
      expect(added.type).toBe('hypothesis')

      const fetched = await store.getNode('n_1')
      expect(fetched!.type).toBe('hypothesis')
    })
  })
})
