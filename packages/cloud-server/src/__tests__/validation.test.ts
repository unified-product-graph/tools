/**
 * Tests for validate_graph cloud tool handler.
 *
 * All Postgres interactions are mocked via a mock pool.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import { UPGPgStore } from '../store/pg-store.js'
import { validateGraph } from '../tools/validation.js'
import { UPG_TYPES_SET, UPG_EDGE_CATALOG } from '@unified-product-graph/core'

// ── Spec sanity ───────────────────────────────────────────────────────────────

it('test fixtures use real spec values', () => {
  expect(UPG_TYPES_SET.has('persona')).toBe(true)
  expect('persona_pursues_job' in UPG_EDGE_CATALOG).toBe(true)
})

function makePool(responses: Record<string, unknown[]> = {}): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      for (const [pattern, rows] of Object.entries(responses)) {
        if (sql.includes(pattern)) return { rows }
      }
      return { rows: [] }
    }),
    connect: vi.fn(),
  } as unknown as Pool
}

function makeContext(pool: Pool) {
  return { store: new UPGPgStore(pool) }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateGraph cloud handler', () => {
  it('returns error when product_id is missing', async () => {
    const ctx = makeContext(makePool())
    const result = await validateGraph({}, ctx)
    expect(result.content[0].text).toContain('Missing required parameter: product_id')
  })

  it('returns error when product is not found', async () => {
    const pool = makePool({
      'SELECT id, title, description, stage FROM upg.products WHERE id': [],
    })
    const ctx = makeContext(pool)
    const result = await validateGraph({ product_id: 'nonexistent' }, ctx)
    expect(result.content[0].text).toContain('Product not found: nonexistent')
  })

  describe('clean graph', () => {
    it('returns valid=true with no drift', async () => {
      const productId = 'prod_clean'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Clean', description: null, stage: 'mvp' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.nodes')) return { rows: [{ count: '5' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.edges')) return { rows: [{ count: '3' }] }
          if (sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.valid).toBe(true)
      expect(parsed.summary.total_nodes).toBe(5)
      expect(parsed.summary.total_edges).toBe(3)
      expect(parsed.summary.unknown_type_nodes).toBe(0)
      expect(parsed.entity_type_drift).toEqual([])
      expect(parsed.edge_type_drift).toEqual([])
      expect(parsed.property_drift).toEqual([])
    })
  })

  describe('entity type drift', () => {
    it('surfaces unknown entity types with count', async () => {
      const productId = 'prod_entity_drift'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Drifted', description: null, stage: 'idea' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.nodes')) return { rows: [{ count: '10' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.edges')) return { rows: [{ count: '2' }] }
          if (sql.includes('FROM upg.nodes') && sql.includes('type NOT IN'))
            return { rows: [{ type: 'old_user_story', count: '3' }] }
          if (sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.valid).toBe(false)
      expect(parsed.summary.unknown_type_nodes).toBe(3)
      expect(parsed.entity_type_drift[0].type).toBe('old_user_story')
      expect(parsed.entity_type_drift[0].count).toBe(3)
    })

    it('suggests migration for deprecated types with known replacement', async () => {
      const productId = 'prod_deprecated'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Deprecated', description: null, stage: 'build' }] }
          // Entity drift query — must be checked before the generic COUNT(*) match
          if (sql.includes('FROM upg.nodes') && sql.includes('type NOT IN'))
            return { rows: [{ type: 'pain_point', count: '2' }] }
          if (sql.includes('FROM upg.edges') && sql.includes('type NOT IN'))
            return { rows: [] }
          if (sql.includes('COUNT(*)::text AS count')) return { rows: [{ count: '2' }] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.entity_type_drift[0].suggested_migration).toBe('need')
    })

    it('returns null migration suggestion for truly unknown types', async () => {
      const productId = 'prod_unknown'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Unknown', description: null, stage: 'concept' }] }
          if (sql.includes('FROM upg.nodes') && sql.includes('type NOT IN'))
            return { rows: [{ type: 'completely_invented_type_xyz', count: '1' }] }
          if (sql.includes('FROM upg.edges') && sql.includes('type NOT IN'))
            return { rows: [] }
          if (sql.includes('COUNT(*)::text AS count')) return { rows: [{ count: '1' }] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.entity_type_drift[0].suggested_migration).toBeNull()
    })
  })

  describe('edge type drift', () => {
    it('surfaces unknown edge types with count', async () => {
      const productId = 'prod_edge_drift'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Edge Drift', description: null, stage: 'launch' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.nodes')) return { rows: [{ count: '5' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.edges')) return { rows: [{ count: '4' }] }
          if (sql.includes('FROM upg.nodes') && sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('FROM upg.edges') && sql.includes('type NOT IN'))
            return { rows: [{ type: 'old_contains', count: '2' }] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.valid).toBe(false)
      expect(parsed.summary.unknown_type_edges).toBe(2)
      expect(parsed.edge_type_drift[0].type).toBe('old_contains')
      expect(parsed.edge_type_drift[0].count).toBe(2)
    })
  })

  describe('property drift', () => {
    it('surfaces types with missing properties in sampled nodes', async () => {
      const productId = 'prod_property_drift'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Property Drift', description: null, stage: 'build' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.nodes')) return { rows: [{ count: '1' }] }
          if (sql.includes('COUNT(*)::text AS count FROM upg.edges')) return { rows: [{ count: '0' }] }
          if (sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('SELECT type, id, data'))
            return { rows: [{ type: 'persona', id: 'node_abc', data: null }] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.summary.property_drift_types).toBeGreaterThan(0)
      expect(parsed.property_drift).toHaveLength(1)
      expect(parsed.property_drift[0].entity_type).toBe('persona')
      expect(parsed.property_drift[0].example_node_id).toBe('node_abc')
      expect(parsed.property_drift[0].missing_fields.length).toBeGreaterThan(0)
    })
  })

  describe('response structure', () => {
    it('always includes the FK constraint note', async () => {
      const productId = 'prod_notes'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Notes', description: null, stage: 'mvp' }] }
          if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] }
          if (sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(Array.isArray(parsed.notes)).toBe(true)
      expect(parsed.notes.some((n: string) => n.includes('Postgres FK constraints'))).toBe(true)
    })

    it('always contains all required top-level keys', async () => {
      const productId = 'prod_shape'
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, title, description, stage FROM upg.products WHERE id'))
            return { rows: [{ id: productId, title: 'Shape', description: null, stage: 'idea' }] }
          if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] }
          if (sql.includes('type NOT IN')) return { rows: [] }
          if (sql.includes('SELECT type, id, data')) return { rows: [] }
          return { rows: [] }
        }),
        connect: vi.fn(),
      } as unknown as Pool
      const ctx = makeContext(pool)
      const result = await validateGraph({ product_id: productId }, ctx)
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed).toHaveProperty('valid')
      expect(parsed).toHaveProperty('product_id')
      expect(parsed).toHaveProperty('summary')
      expect(parsed).toHaveProperty('entity_type_drift')
      expect(parsed).toHaveProperty('edge_type_drift')
      expect(parsed).toHaveProperty('property_drift')
      expect(parsed).toHaveProperty('notes')
      expect(parsed.summary).toHaveProperty('total_nodes')
      expect(parsed.summary).toHaveProperty('total_edges')
      expect(parsed.summary).toHaveProperty('unknown_type_nodes')
      expect(parsed.summary).toHaveProperty('unknown_type_edges')
      expect(parsed.summary).toHaveProperty('property_drift_types')
    })
  })
})
