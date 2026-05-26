/**
 * Real-Postgres webhook delivery (UPG-553). Two halves, both deterministic:
 *  - emission: real mutations push events to the store's sink.
 *  - delivery: the dispatcher reads real webhook rows and POSTs (stubbed fetch),
 *    including the 4xx → active=false auto-disable as a real DB round-trip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { UPGPgStore } from '../../store/pg-store.js'
import { WebhookDispatcher, type FetchLike, type WebhookEvent } from '../../lib/webhook-dispatcher.js'
import { makePool, resetSchema, dbAvailable } from './helpers.js'

const HAS_DB = await dbAvailable()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = (s: string) => s as any

describe.skipIf(!HAS_DB)('integration: webhook delivery (real Postgres)', () => {
  let pool: Pool
  let store: UPGPgStore

  beforeAll(async () => {
    pool = makePool()
    await resetSchema(pool)
    store = new UPGPgStore(pool)
  })
  afterAll(async () => { await pool.end() })

  it('real mutations emit events to the store sink', async () => {
    const events: WebhookEvent[] = []
    store.setEventSink((e) => events.push(e))

    const product = await store.createProduct('Webhook Emit IT')
    const a = await store.addNode(product.id, { id: '', type: T('feature'), title: 'F' })
    const b = await store.addNode(product.id, { id: '', type: T('epic'), title: 'E' })
    await store.addEdge(product.id, { id: '', source: a.id, target: b.id, type: T('feature_decomposed_into_epic') })

    const kinds = events.map((e) => e.event)
    expect(kinds).toContain('product.created')
    expect(kinds).toContain('node.created')
    expect(kinds).toContain('edge.created')
    // events carry the product id and a payload
    const nodeEvent = events.find((e) => e.event === 'node.created')!
    expect(nodeEvent.productId).toBe(product.id)
    expect(nodeEvent.payload.id).toBe(a.id)

    store.setEventSink(() => {}) // detach
  })

  it('dispatcher delivers to a registered webhook with an HMAC signature', async () => {
    const product = await store.createProduct('Webhook Deliver IT')
    await store.registerWebhook(product.id, 'node.created', 'https://receiver.test/hook', 'topsecret')

    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchFn: FetchLike = async (url, init) => { calls.push({ url, headers: init.headers }); return { status: 200 } }
    const dispatcher = new WebhookDispatcher(pool, { fetchFn })

    await dispatcher.dispatch({ productId: product.id, event: 'node.created', payload: { id: 'n1' } })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://receiver.test/hook')
    expect(calls[0].headers['x-upg-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('a webhook that returns 4xx is auto-disabled in the database', async () => {
    const product = await store.createProduct('Webhook Disable IT')
    const hook = await store.registerWebhook(product.id, 'node.created', 'https://gone.test/hook', undefined)

    const fetchFn: FetchLike = async () => ({ status: 410 }) // permanent
    await new WebhookDispatcher(pool, { fetchFn }).dispatch({ productId: product.id, event: 'node.created', payload: {} })

    const { rows } = await pool.query<{ active: boolean }>(
      'SELECT active FROM upg.webhooks WHERE id = $1',
      [hook.id],
    )
    expect(rows[0].active).toBe(false)

    // ...and a now-inactive webhook is no longer delivered to.
    const calls: string[] = []
    const fetchFn2: FetchLike = async (url) => { calls.push(url); return { status: 200 } }
    await new WebhookDispatcher(pool, { fetchFn: fetchFn2 }).dispatch({ productId: product.id, event: 'node.created', payload: {} })
    expect(calls).toHaveLength(0)
  })
})
