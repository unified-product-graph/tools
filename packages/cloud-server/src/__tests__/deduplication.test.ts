/**
 * Tests for deduplicate_nodes cloud tool handler.
 *
 * Covers: dry_run preview, edge rebind, self-loop removal, duplicate-edge
 * removal, property merge, ownership validation, and the canonical-in-
 * duplicates guard. All Postgres interactions are mocked via a mock pool
 * that records every query issued.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import { deduplicateNodes } from '../tools/nodes.js'

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeNodeRow(id: string, productId: string, type = 'feature', data: Record<string, unknown> | null = null) {
  return { id, product_id: productId, type, title: `Node ${id}`, description: null, status: null, tags: null, data }
}

function makeEdgeRow(id: string, source: string, target: string, type = 'related_to') {
  return { id, source, target, type }
}

interface MockClient {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

/**
 * Build a mock pool + client pair. The `responses` map is keyed by SQL
 * substrings; the first match wins. `clientOverride` lets individual tests
 * replace the transaction client behaviour entirely.
 */
function makePool(
  responses: Record<string, { rows: unknown[]; rowCount?: number }> = {},
  clientOverride?: Partial<MockClient>,
): { pool: Pool; client: MockClient } {
  const client: MockClient = {
    query: vi.fn(async (sql: string) => {
      for (const [pattern, resp] of Object.entries(responses)) {
        if (sql.includes(pattern)) return resp
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
    ...clientOverride,
  }

  const pool = {
    query: vi.fn(async (sql: string) => {
      for (const [pattern, resp] of Object.entries(responses)) {
        if (sql.includes(pattern)) return resp
      }
      return { rows: [], rowCount: 0 }
    }),
    connect: vi.fn(async () => client),
  } as unknown as Pool

  return { pool, client }
}

function makeContext(pool: Pool) {
  return { store: new UPGPgStore(pool) }
}

// ── Validation guards ─────────────────────────────────────────────────────────

describe('deduplicate_nodes — input validation', () => {
  it('returns error when product_id is missing', async () => {
    const { pool } = makePool()
    const result = await deduplicateNodes({ canonical_id: 'n1', duplicate_ids: ['n2'] }, makeContext(pool))
    expect(result.content[0].text).toContain('Missing required parameter: product_id')
  })

  it('returns error when canonical_id is missing', async () => {
    const { pool } = makePool()
    const result = await deduplicateNodes({ product_id: 'p1', duplicate_ids: ['n2'] }, makeContext(pool))
    expect(result.content[0].text).toContain('Missing required parameter: canonical_id')
  })

  it('returns error when duplicate_ids is missing', async () => {
    const { pool } = makePool()
    const result = await deduplicateNodes({ product_id: 'p1', canonical_id: 'n1' }, makeContext(pool))
    expect(result.content[0].text).toContain('Missing required parameter: duplicate_ids')
  })

  it('returns error when duplicate_ids is empty', async () => {
    const { pool } = makePool()
    const result = await deduplicateNodes({ product_id: 'p1', canonical_id: 'n1', duplicate_ids: [] }, makeContext(pool))
    expect(result.content[0].text).toContain('Missing required parameter: duplicate_ids')
  })

  it('returns error when duplicate_ids exceeds 20', async () => {
    const { pool } = makePool()
    const ids = Array.from({ length: 21 }, (_, i) => `n${i + 2}`)
    const result = await deduplicateNodes({ product_id: 'p1', canonical_id: 'n1', duplicate_ids: ids }, makeContext(pool))
    expect(result.content[0].text).toContain('Maximum 20 duplicate IDs')
  })

  it('returns error when canonical_id appears in duplicate_ids', async () => {
    const { pool } = makePool()
    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n1', 'n2'] },
      makeContext(pool),
    )
    expect(result.content[0].text).toContain('canonical_id must not appear in duplicate_ids')
  })
})

// ── Ownership validation ──────────────────────────────────────────────────────

describe('deduplicate_nodes — ownership validation', () => {
  it('returns error when canonical node does not exist', async () => {
    const { pool } = makePool({
      // getNode for any id returns empty
      'FROM upg.nodes WHERE id': { rows: [] },
    })
    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n_missing', duplicate_ids: ['n2'] },
      makeContext(pool),
    )
    expect(result.content[0].text).toContain('Node not found: n_missing')
  })

  it('returns error when a duplicate node does not exist', async () => {
    // canonical exists, duplicate does not
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM upg.nodes WHERE id')) {
          const id = values?.[0]
          if (id === 'n1') return { rows: [makeNodeRow('n1', 'p1')] }
          return { rows: [] } // n2 not found
        }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2'] },
      makeContext(pool),
    )
    expect(result.content[0].text).toContain('Node not found: n2')
  })

  it('returns error when canonical node belongs to a different product', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM upg.nodes WHERE id'))
          return { rows: [makeNodeRow('n1', 'other_product')] }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2'] },
      makeContext(pool),
    )
    expect(result.content[0].text).toContain('does not belong to product p1')
  })
})

// ── Dry-run preview ───────────────────────────────────────────────────────────

describe('deduplicate_nodes — dry_run: true (default)', () => {
  it('returns preview without touching data', async () => {
    let getNodeCallCount = 0
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM upg.nodes WHERE id')) {
          getNodeCallCount++
          const id = values?.[0]
          if (id === 'n1') return { rows: [makeNodeRow('n1', 'p1')] }
          if (id === 'n2') return { rows: [makeNodeRow('n2', 'p1')] }
          if (id === 'n3') return { rows: [makeNodeRow('n3', 'p1')] }
          return { rows: [] }
        }
        // getEdgesForNode returns 3 edges for n2, 2 for n3
        if (sql.includes('source = $1 OR target = $1')) {
          const nodeId = values?.[0]
          if (nodeId === 'n2') return { rows: [makeEdgeRow('e1', 'n2', 'nx'), makeEdgeRow('e2', 'ny', 'n2'), makeEdgeRow('e3', 'n2', 'nz')] }
          if (nodeId === 'n3') return { rows: [makeEdgeRow('e4', 'n3', 'na'), makeEdgeRow('e5', 'nb', 'n3')] }
          return { rows: [] }
        }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2', 'n3'] },
      makeContext(pool),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dry_run).toBe(true)
    expect(parsed.canonical_id).toBe('n1')
    expect(parsed.duplicate_ids).toEqual(['n2', 'n3'])
    expect(parsed.edges_to_rebind).toBe(5) // 3 from n2 + 2 from n3
    expect(parsed.nodes_to_delete).toBe(2)
  })

  it('dry_run is true by default when not specified', async () => {
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM upg.nodes WHERE id')) {
          const id = values?.[0]
          if (id === 'n1') return { rows: [makeNodeRow('n1', 'p1')] }
          if (id === 'n2') return { rows: [makeNodeRow('n2', 'p1')] }
          return { rows: [] }
        }
        if (sql.includes('source = $1 OR target = $1')) return { rows: [] }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(),
    } as unknown as Pool

    // No dry_run param — should default to true
    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2'] },
      makeContext(pool),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dry_run).toBe(true)
  })
})

// ── Full merge (dry_run: false) ───────────────────────────────────────────────

describe('deduplicate_nodes — dry_run: false', () => {
  /**
   * Build a mock pool where ownership checks pass, then delegate the
   * transaction to a separately-controlled client.
   */
  function makeFullMergePool(
    nodeRows: Record<string, ReturnType<typeof makeNodeRow>>,
    txnResponses: Record<string, { rows: unknown[]; rowCount?: number }>,
  ) {
    const client: MockClient = {
      query: vi.fn(async (sql: string) => {
        for (const [pattern, resp] of Object.entries(txnResponses)) {
          if (sql.includes(pattern)) return resp
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }

    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        // Ownership check queries
        if (sql.includes('FROM upg.nodes WHERE id')) {
          const id = values?.[0] as string
          if (id && nodeRows[id]) return { rows: [nodeRows[id]] }
          return { rows: [] }
        }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(async () => client),
    } as unknown as Pool

    return { pool, client }
  }

  it('executes the correct sequence: BEGIN, rebind edges, self-loop delete, dup-edge delete, property merge, delete nodes, COMMIT', async () => {
    const nodes = {
      n1: makeNodeRow('n1', 'p1'),
      n2: makeNodeRow('n2', 'p1'),
    }

    const { pool, client } = makeFullMergePool(nodes, {
      'UPDATE upg.edges SET source': { rows: [], rowCount: 2 },
      'UPDATE upg.edges SET target': { rows: [], rowCount: 1 },
      'DELETE FROM upg.edges': { rows: [], rowCount: 1 },
      'DELETE FROM upg.edges\n         WHERE id IN': { rows: [], rowCount: 0 },
      'UPDATE upg.nodes': { rows: [] },
      'DELETE FROM upg.nodes': { rows: [] },
    })

    await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2'], dry_run: false },
      makeContext(pool),
    )

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
    // Must contain edge rebind updates
    expect(calls.some((s) => s.includes('UPDATE upg.edges SET source'))).toBe(true)
    expect(calls.some((s) => s.includes('UPDATE upg.edges SET target'))).toBe(true)
    // Self-loop delete
    expect(calls.some((s) => s.includes('DELETE FROM upg.edges') && s.includes('source = $2 AND target = $2'))).toBe(true)
    // Property merge
    expect(calls.some((s) => s.includes('UPDATE upg.nodes') && s.includes('jsonb_object_agg'))).toBe(true)
    // Duplicate node delete
    expect(calls.some((s) => s.includes('DELETE FROM upg.nodes') && s.includes('ANY'))).toBe(true)
    expect(client.release).toHaveBeenCalled()
  })

  it('returns correct response shape on success', async () => {
    const nodes = {
      n1: makeNodeRow('n1', 'p1'),
      n2: makeNodeRow('n2', 'p1'),
      n3: makeNodeRow('n3', 'p1'),
    }

    const { pool } = makeFullMergePool(nodes, {
      'UPDATE upg.edges SET source': { rows: [], rowCount: 3 },
      'UPDATE upg.edges SET target': { rows: [], rowCount: 2 },
      'source = $2 AND target = $2': { rows: [], rowCount: 1 },
      'ROW_NUMBER()': { rows: [], rowCount: 2 },
    })

    const result = await deduplicateNodes(
      { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2', 'n3'], dry_run: false },
      makeContext(pool),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dry_run).toBe(false)
    expect(parsed.canonical_id).toBe('n1')
    expect(parsed.merged_ids).toEqual(['n2', 'n3'])
    expect(typeof parsed.rebound_edges).toBe('number')
    expect(typeof parsed.removed_self_loops).toBe('number')
    expect(typeof parsed.removed_duplicate_edges).toBe('number')
  })

  it('rolls back on transaction error', async () => {
    const nodes = { n1: makeNodeRow('n1', 'p1'), n2: makeNodeRow('n2', 'p1') }
    let clientRef: MockClient | null = null

    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM upg.nodes WHERE id')) {
          const id = values?.[0] as string
          if (id && nodes[id as keyof typeof nodes]) return { rows: [nodes[id as keyof typeof nodes]] }
          return { rows: [] }
        }
        return { rows: [], rowCount: 0 }
      }),
      connect: vi.fn(async () => {
        const client: MockClient = {
          query: vi.fn(async (sql: string) => {
            if (sql === 'BEGIN') return { rows: [] }
            if (sql === 'ROLLBACK') return { rows: [] }
            // Simulate failure on first UPDATE
            if (sql.includes('UPDATE upg.edges SET source')) throw new Error('DB error')
            return { rows: [], rowCount: 0 }
          }),
          release: vi.fn(),
        }
        clientRef = client
        return client
      }),
    } as unknown as Pool

    await expect(
      deduplicateNodes(
        { product_id: 'p1', canonical_id: 'n1', duplicate_ids: ['n2'], dry_run: false },
        makeContext(pool),
      ),
    ).rejects.toThrow('DB error')

    const calls = (clientRef!.query as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calls).toContain('ROLLBACK')
    expect(clientRef!.release).toHaveBeenCalled()
  })
})

// ── pg-store.deduplicateNodes SQL contract ────────────────────────────────────

describe('UPGPgStore.deduplicateNodes — SQL shape', () => {
  it('issues rebind UPDATEs with correct parameters for each duplicate', async () => {
    const capturedQueries: Array<{ sql: string; values: unknown[] }> = []

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    } as unknown as Pool

    const store = new UPGPgStore(pool)
    await store.deduplicateNodes('p1', 'n1', ['n2', 'n3'])

    // For each duplicate, we expect two UPDATE statements (source + target)
    const sourceUpdates = capturedQueries.filter((q) => q.sql.includes('UPDATE upg.edges SET source'))
    const targetUpdates = capturedQueries.filter((q) => q.sql.includes('UPDATE upg.edges SET target'))
    expect(sourceUpdates).toHaveLength(2) // one per duplicate
    expect(targetUpdates).toHaveLength(2)

    // Verify parameter binding — canonical is $1, duplicate is $2, product is $3
    for (const q of sourceUpdates) {
      expect(q.values[0]).toBe('n1')   // canonical_id
      expect(q.values[2]).toBe('p1')   // product_id
    }
    // Duplicate IDs should be n2 and n3 across the two source updates
    const dupIds = sourceUpdates.map((q) => q.values[1])
    expect(dupIds).toContain('n2')
    expect(dupIds).toContain('n3')
  })

  it('issues self-loop DELETE scoped to canonical and product', async () => {
    const capturedQueries: Array<{ sql: string; values: unknown[] }> = []

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool
    const store = new UPGPgStore(pool)
    await store.deduplicateNodes('p1', 'n1', ['n2'])

    const selfLoopDelete = capturedQueries.find(
      (q) => q.sql.includes('DELETE FROM upg.edges') && q.sql.includes('source = $2 AND target = $2'),
    )
    expect(selfLoopDelete).toBeDefined()
    expect(selfLoopDelete!.values[0]).toBe('p1')   // product_id
    expect(selfLoopDelete!.values[1]).toBe('n1')   // canonical_id
  })

  it('issues duplicate-edge DELETE using ROW_NUMBER window function', async () => {
    const capturedQueries: Array<{ sql: string; values: unknown[] }> = []

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool
    const store = new UPGPgStore(pool)
    await store.deduplicateNodes('p1', 'n1', ['n2'])

    const dedupEdgeDelete = capturedQueries.find(
      (q) => q.sql.includes('ROW_NUMBER()') && q.sql.includes('PARTITION BY source, target, type'),
    )
    expect(dedupEdgeDelete).toBeDefined()
    expect(dedupEdgeDelete!.values[0]).toBe('p1')
  })

  it('issues property merge UPDATE with jsonb_object_agg — canonical wins', async () => {
    const capturedQueries: Array<{ sql: string; values: unknown[] }> = []

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool
    const store = new UPGPgStore(pool)
    await store.deduplicateNodes('p1', 'n1', ['n2'])

    const mergeUpdate = capturedQueries.find(
      (q) => q.sql.includes('UPDATE upg.nodes') && q.sql.includes('jsonb_object_agg'),
    )
    expect(mergeUpdate).toBeDefined()
    // The UNION puts canonical last so its keys overwrite duplicates' keys
    expect(mergeUpdate!.sql).toContain('UNION ALL')
    // canonical_id passed as $3
    expect(mergeUpdate!.values[2]).toBe('n1')
  })

  it('issues DELETE for duplicate nodes scoped to product', async () => {
    const capturedQueries: Array<{ sql: string; values: unknown[] }> = []

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values: values ?? [] })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool
    const store = new UPGPgStore(pool)
    await store.deduplicateNodes('p1', 'n1', ['n2', 'n3'])

    const nodeDelete = capturedQueries.find(
      (q) => q.sql.includes('DELETE FROM upg.nodes') && q.sql.includes('ANY'),
    )
    expect(nodeDelete).toBeDefined()
    // duplicate_ids array is $1, product_id is $2
    expect(nodeDelete!.values[0]).toEqual(['n2', 'n3'])
    expect(nodeDelete!.values[1]).toBe('p1')
  })
})
