import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import { WebhookDispatcher, type FetchLike } from '../lib/webhook-dispatcher.js'

interface Hook { id: string; event: string; url: string; secret: string | null }

/** Mock pool: returns the given webhooks for the SELECT, records all queries. */
function mockPool(hooks: Hook[]) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values ?? [] })
      if (text.includes('FROM upg.webhooks')) return { rows: hooks }
      return { rows: [], rowCount: 0 }
    }),
  } as unknown as Pool
  return { pool, queries }
}

/** fetch stub that returns a fixed status and records calls. */
function fetchStub(status: number) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const fn: FetchLike = async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return { status } }
  return { fn, calls }
}

const EVENT = { productId: 'p1', event: 'node.created', payload: { id: 'n1', title: 'X' } }

describe('WebhookDispatcher', () => {
  it('delivers to a matching active webhook', async () => {
    const { pool } = mockPool([{ id: 'w1', event: 'node.created', url: 'https://hook.test/a', secret: null }])
    const { fn, calls } = fetchStub(200)
    await new WebhookDispatcher(pool, { fetchFn: fn }).dispatch(EVENT)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hook.test/a')
    expect(calls[0].headers['x-upg-event']).toBe('node.created')
    const body = JSON.parse(calls[0].body)
    expect(body).toMatchObject({ event: 'node.created', product_id: 'p1', data: { id: 'n1', title: 'X' }, webhook_id: 'w1' })
  })

  it('scopes the lookup to product + event + active', async () => {
    const { pool, queries } = mockPool([])
    await new WebhookDispatcher(pool, { fetchFn: fetchStub(200).fn }).dispatch(EVENT)
    const sel = queries.find((q) => q.text.includes('FROM upg.webhooks'))!
    expect(sel.text).toContain('active = true')
    expect(sel.values).toEqual(['p1', 'node.created'])
  })

  it('adds an HMAC signature header only when a secret is set', async () => {
    const withSecret = mockPool([{ id: 'w1', event: 'node.created', url: 'https://h/a', secret: 's3cr3t' }])
    const f1 = fetchStub(200)
    await new WebhookDispatcher(withSecret.pool, { fetchFn: f1.fn }).dispatch(EVENT)
    expect(f1.calls[0].headers['x-upg-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)

    const noSecret = mockPool([{ id: 'w2', event: 'node.created', url: 'https://h/b', secret: null }])
    const f2 = fetchStub(200)
    await new WebhookDispatcher(noSecret.pool, { fetchFn: f2.fn }).dispatch(EVENT)
    expect(f2.calls[0].headers['x-upg-signature']).toBeUndefined()
  })

  it('disables a webhook on a permanent 4xx', async () => {
    const { pool, queries } = mockPool([{ id: 'w1', event: 'node.created', url: 'https://h/a', secret: null }])
    const { fn, calls } = fetchStub(404)
    await new WebhookDispatcher(pool, { fetchFn: fn }).dispatch(EVENT)

    expect(calls).toHaveLength(1) // no retry on permanent error
    const disable = queries.find((q) => q.text.includes('UPDATE upg.webhooks SET active = false'))
    expect(disable, '404 must disable the registration').toBeDefined()
    expect(disable!.values).toEqual(['w1'])
  })

  it('retries on a transient 5xx and does NOT disable', async () => {
    const { pool, queries } = mockPool([{ id: 'w1', event: 'node.created', url: 'https://h/a', secret: null }])
    const { fn, calls } = fetchStub(503)
    await new WebhookDispatcher(pool, { fetchFn: fn, maxAttempts: 3, backoffMs: 1 }).dispatch(EVENT)

    expect(calls).toHaveLength(3) // exhausted retries
    expect(queries.some((q) => q.text.includes('UPDATE upg.webhooks SET active = false'))).toBe(false)
  })

  it('matches a wildcard registration', async () => {
    const { pool, queries } = mockPool([])
    await new WebhookDispatcher(pool, { fetchFn: fetchStub(200).fn }).dispatch(EVENT)
    const sel = queries.find((q) => q.text.includes('FROM upg.webhooks'))!
    expect(sel.text).toContain("event = '*'")
  })
})
