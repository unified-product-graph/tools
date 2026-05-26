/**
 * Real-Postgres round-trips for the write/trigger paths the mocked unit suite
 * can't see. Each assertion would have failed before its corresponding fix —
 * these are the regression guards for the scaffold-vs-wired class (UPG-554).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { UPGPgStore } from '../../store/pg-store.js'
import { makePool, resetSchema, dbAvailable } from './helpers.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HAS_DB = await dbAvailable()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = (s: string) => s as any

describe.skipIf(!HAS_DB)('integration: write→read round-trips (real Postgres)', () => {
  let pool: Pool
  let store: UPGPgStore

  beforeAll(async () => {
    pool = makePool()
    await resetSchema(pool)
    store = new UPGPgStore(pool)
  })
  afterAll(async () => { await pool.end() })

  it('mints UUID ids for product / node / edge (guards #1697)', async () => {
    const product = await store.createProduct('Round-trip IT')
    expect(product.id).toMatch(UUID)

    const a = await store.addNode(product.id, { id: '', type: T('feature'), title: 'Dark mode' })
    const b = await store.addNode(product.id, { id: '', type: T('epic'), title: 'Theming' })
    expect(a.id).toMatch(UUID)
    expect(b.id).toMatch(UUID)

    await store.addEdge(product.id, { id: '', source: a.id, target: b.id, type: T('feature_decomposed_into_epic') })
    const edges = await store.getAllEdges(product.id)
    expect(edges).toHaveLength(1)
    expect(edges[0].id).toMatch(UUID)
  })

  it('records the audit log on every mutation; get_audit_log returns it (guards UPG-552)', async () => {
    const product = await store.createProduct('Audit IT')
    const n = await store.addNode(product.id, { id: '', type: T('persona'), title: 'PM' })
    await store.updateNode(n.id, { title: 'Busy PM' })
    await store.removeNode(n.id)

    const log = await store.getAuditLog(product.id)
    const seen = log.map((e) => `${e.action}:${e.entity_type}`)
    expect(seen).toContain('create:product')
    expect(seen).toContain('create:node')
    expect(seen).toContain('update:node')
    expect(seen).toContain('delete:node')
    // Every entity_id is a UUID and product-scoped.
    for (const e of log) expect(String(e.entity_id)).toMatch(UUID)
  })
})
