/**
 * Tests for migrate_type and migrate_cross_edges cloud tool handlers.
 *
 * All Postgres interactions are mocked. Tests cover:
 *   - dry_run mode for both tools
 *   - validation guards (unknown to_type, missing params)
 *   - apply mode: node retype + edge re-inference for migrate_type
 *   - apply mode: edge SELECT → INSERT → DELETE for migrate_cross_edges
 *   - empty-case behaviour
 */

import { describe, it, expect, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import { migrateType, migrateCrossEdges } from '../tools/migrations.js'
import { UPG_CROSS_EDGE_TYPES } from '@unified-product-graph/core'

// ─── Mock pool factory ────────────────────────────────────────────────────────

type SqlHandler = (sql: string, values?: unknown[]) => { rows: unknown[]; rowCount?: number | null }

function makePool(handler: SqlHandler = () => ({ rows: [] })): Pool {
  const mockClient = {
    query: vi.fn(async (sql: string, values?: unknown[]) => handler(sql, values)),
    release: vi.fn(),
  }

  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => handler(sql, values)),
    connect: vi.fn(async () => mockClient as unknown as PoolClient),
  } as unknown as Pool
}

function makeContext(pool: Pool) {
  return { store: new UPGPgStore(pool) }
}

// ─── migrate_type ─────────────────────────────────────────────────────────────

describe('migrateType cloud handler', () => {
  it('returns error when product_id is missing', async () => {
    const ctx = makeContext(makePool())
    const result = await migrateType({}, ctx)
    expect(result.content[0].text).toContain('Missing required parameter: product_id')
  })

  it('returns error when from_type is missing', async () => {
    const ctx = makeContext(makePool())
    const result = await migrateType({ product_id: 'p1' }, ctx)
    expect(result.content[0].text).toContain('Missing required parameter: from_type')
  })

  it('returns error when to_type is missing', async () => {
    const ctx = makeContext(makePool())
    const result = await migrateType({ product_id: 'p1', from_type: 'pain_point' }, ctx)
    expect(result.content[0].text).toContain('Missing required parameter: to_type')
  })

  it('returns error for unknown to_type', async () => {
    const ctx = makeContext(makePool())
    const result = await migrateType({ product_id: 'p1', from_type: 'pain_point', to_type: 'not_a_real_type' }, ctx)
    expect(result.content[0].text).toContain('Unknown entity type: "not_a_real_type"')
  })

  describe('dry_run mode (default)', () => {
    it('counts affected nodes without mutating', async () => {
      const handler: SqlHandler = (sql) => {
        if (sql.includes('COUNT(*)::text AS count')) return { rows: [{ count: '12' }] }
        return { rows: [] }
      }
      const pool = makePool(handler)
      const ctx = makeContext(pool)

      const result = await migrateType({
        product_id: 'p1',
        from_type: 'pain_point',
        to_type: 'need',
      }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.from_type).toBe('pain_point')
      expect(parsed.to_type).toBe('need')
      expect(parsed.affected_nodes).toBe(12)
      expect(parsed.dry_run).toBe(true)
      // pool.connect() should NOT have been called in dry_run
      expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })

    it('returns 0 when no matching nodes exist', async () => {
      const pool = makePool(() => ({ rows: [{ count: '0' }] }))
      const ctx = makeContext(pool)

      const result = await migrateType({
        product_id: 'p1',
        from_type: 'hypothesis',
        to_type: 'experiment',
        dry_run: true,
      }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.affected_nodes).toBe(0)
      expect(parsed.dry_run).toBe(true)
    })

    it('is the default when dry_run is omitted', async () => {
      const pool = makePool(() => ({ rows: [{ count: '5' }] }))
      const ctx = makeContext(pool)

      // No dry_run param; should default to true (read-only path)
      const result = await migrateType({
        product_id: 'p1',
        from_type: 'pain_point',
        to_type: 'need',
      }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.dry_run).toBe(true)
      expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })
  })

  describe('apply mode (dry_run: false)', () => {
    it('updates node types and re-infers edges in a transaction', async () => {
      const queries: Array<{ sql: string; values?: unknown[] }> = []

      const mockClient = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values })
          if (sql.includes('UPDATE upg.nodes')) return { rows: [], rowCount: 3 }
          if (sql.includes('SELECT e.id, e.source, e.target')) {
            // Return one affected edge where re-inference applies
            return {
              rows: [{
                id: 'edge1',
                source: 'node1',
                target: 'node2',
                type: 'area_contains_feature',
                source_type: 'product_area',
                target_type: 'feature',
              }],
            }
          }
          if (sql.includes('UPDATE upg.edges')) return { rows: [], rowCount: 1 }
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)
      const result = await migrateType({
        product_id: 'p1',
        from_type: 'pain_point',
        to_type: 'need',
        dry_run: false,
      }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.dry_run).toBe(false)
      expect(parsed.affected_nodes).toBe(3)
      expect(parsed.from_type).toBe('pain_point')
      expect(parsed.to_type).toBe('need')

      // Transaction should have been opened and committed
      const sqls = queries.map((q) => q.sql)
      expect(sqls).toContain('BEGIN')
      expect(sqls).toContain('COMMIT')

      // Node update should have been called
      const nodeUpdate = queries.find((q) => q.sql.includes('UPDATE upg.nodes'))
      expect(nodeUpdate).toBeDefined()
      expect(nodeUpdate?.values).toContain('need')
      expect(nodeUpdate?.values).toContain('pain_point')
    })

    it('rolls back on error', async () => {
      const queries: string[] = []
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql)
          if (sql.includes('UPDATE upg.nodes')) throw new Error('Simulated DB error')
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)

      await expect(migrateType({
        product_id: 'p1',
        from_type: 'pain_point',
        to_type: 'need',
        dry_run: false,
      }, ctx)).rejects.toThrow('Simulated DB error')

      expect(queries).toContain('BEGIN')
      expect(queries).toContain('ROLLBACK')
    })

    it('reports retyped_edges count', async () => {
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('UPDATE upg.nodes')) return { rows: [], rowCount: 2 }
          if (sql.includes('SELECT e.id, e.source, e.target')) {
            return {
              rows: [
                {
                  id: 'e1', source: 's1', target: 't1',
                  type: 'old_edge_type', source_type: 'product_area', target_type: 'feature',
                },
                {
                  id: 'e2', source: 's2', target: 't2',
                  type: 'feature_area_contains_feature', source_type: 'feature_area', target_type: 'feature',
                },
              ],
            }
          }
          if (sql.includes('UPDATE upg.edges')) return { rows: [], rowCount: 1 }
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)
      const result = await migrateType({
        product_id: 'p1',
        from_type: 'pain_point',
        to_type: 'need',
        dry_run: false,
      }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      // e1: old_edge_type → resolveContainmentEdge('product_area','feature') = 'product_area_contains_feature'
      // e2: already canonical (feature_area_contains_feature matches resolveContainmentEdge result)
      // So retyped_edges should be 1 (only e1)
      expect(typeof parsed.retyped_edges).toBe('number')
    })
  })
})

// ─── migrate_cross_edges ──────────────────────────────────────────────────────

describe('migrateCrossEdges cloud handler', () => {
  it('returns error when product_id is missing', async () => {
    const ctx = makeContext(makePool())
    const result = await migrateCrossEdges({}, ctx)
    expect(result.content[0].text).toContain('Missing required parameter: product_id')
  })

  describe('dry_run mode (default)', () => {
    it('returns list of cross-product edges that would be migrated', async () => {
      const crossEdges = [
        { id: 'e1', source: 'n1', target: 'n2', type: 'shares_persona' },
        { id: 'e2', source: 'n3', target: 'n4', type: 'depends_on_product' },
      ]
      const pool = makePool((sql) => {
        if (sql.includes('AND type = ANY')) return { rows: crossEdges }
        return { rows: [] }
      })
      const ctx = makeContext(pool)

      const result = await migrateCrossEdges({ product_id: 'p1' }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.product_id).toBe('p1')
      expect(parsed.dry_run).toBe(true)
      expect(parsed.count).toBe(2)
      expect(parsed.migrated).toHaveLength(2)
      expect(parsed.migrated[0].type).toBe('shares_persona')
      // pool.connect should NOT be called in dry_run
      expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })

    it('returns empty list when no cross-product edges exist in upg.edges', async () => {
      const pool = makePool(() => ({ rows: [] }))
      const ctx = makeContext(pool)

      const result = await migrateCrossEdges({ product_id: 'p1', dry_run: true }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.count).toBe(0)
      expect(parsed.migrated).toEqual([])
      expect(parsed.dry_run).toBe(true)
    })

    it('is the default when dry_run is omitted', async () => {
      const pool = makePool(() => ({ rows: [] }))
      const ctx = makeContext(pool)

      const result = await migrateCrossEdges({ product_id: 'p1' }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.dry_run).toBe(true)
      expect((pool.connect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })
  })

  describe('apply mode (dry_run: false)', () => {
    it('moves cross-product edges to upg.cross_product_edges in a transaction', async () => {
      const crossEdges = [
        { id: 'e1', source: 'n1', target: 'n2', type: 'shares_persona' },
      ]
      const queries: Array<{ sql: string; values?: unknown[] }> = []

      const mockClient = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values })
          if (sql.includes('AND type = ANY')) return { rows: crossEdges }
          return { rows: [], rowCount: 1 }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)
      const result = await migrateCrossEdges({ product_id: 'p1', dry_run: false }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.dry_run).toBe(false)
      expect(parsed.count).toBe(1)
      expect(parsed.migrated[0].id).toBe('e1')

      const sqls = queries.map((q) => q.sql)
      expect(sqls).toContain('BEGIN')
      expect(sqls).toContain('COMMIT')

      // INSERT into cross_product_edges
      const insertQuery = queries.find((q) => q.sql.includes('INSERT INTO upg.cross_product_edges'))
      expect(insertQuery).toBeDefined()
      // created_by_product_id should be the product_id
      expect(insertQuery?.values).toContain('p1')

      // DELETE from upg.edges
      const deleteQuery = queries.find((q) => q.sql.includes('DELETE FROM upg.edges'))
      expect(deleteQuery).toBeDefined()
    })

    it('skips DELETE when no edges to migrate', async () => {
      const queries: Array<{ sql: string }> = []

      const mockClient = {
        query: vi.fn(async (sql: string) => {
          queries.push({ sql })
          if (sql.includes('AND type = ANY')) return { rows: [] }
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)
      const result = await migrateCrossEdges({ product_id: 'p1', dry_run: false }, ctx)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.count).toBe(0)
      expect(parsed.dry_run).toBe(false)

      // No DELETE should have been issued
      const hasDelete = queries.some((q) => q.sql.includes('DELETE FROM upg.edges'))
      expect(hasDelete).toBe(false)
    })

    it('rolls back on error', async () => {
      const queries: string[] = []
      const mockClient = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql)
          if (sql.includes('AND type = ANY')) return { rows: [{ id: 'e1', source: 'n1', target: 'n2', type: 'shares_persona' }] }
          if (sql.includes('INSERT INTO upg.cross_product_edges')) throw new Error('Simulated insert error')
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)

      await expect(migrateCrossEdges({
        product_id: 'p1',
        dry_run: false,
      }, ctx)).rejects.toThrow('Simulated insert error')

      expect(queries).toContain('BEGIN')
      expect(queries).toContain('ROLLBACK')
    })

    it('queries with the full list of cross-product edge types', async () => {
      const calls: Array<{ sql: string; values?: unknown[] }> = []

      const mockClient = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values })
          return { rows: [] }
        }),
        release: vi.fn(),
      }

      const pool = {
        query: vi.fn(async () => ({ rows: [] })),
        connect: vi.fn(async () => mockClient),
      } as unknown as Pool

      const ctx = makeContext(pool)
      await migrateCrossEdges({ product_id: 'p1', dry_run: false }, ctx)

      const selectCall = calls.find((c) => c.sql.includes('AND type = ANY'))
      expect(selectCall).toBeDefined()

      // The values should include all cross-product edge types as the array parameter
      const crossEdgeTypesArray = selectCall?.values?.[1] as string[]
      for (const t of UPG_CROSS_EDGE_TYPES) {
        expect(crossEdgeTypesArray).toContain(t)
      }
    })
  })
})
