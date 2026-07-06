/**
 * submit_feedback — consent gate, happy path, and the load-bearing PRIVACY
 * invariant: the outbound payload carries only allowlisted context keys and
 * NEVER graph content (node titles / descriptions).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { submitFeedback, assembleContext, ALLOWED_CONTEXT_KEYS } from '../tools/feedback.js'

// Distinctive strings seeded into the graph. If ANY of these appears in the
// outbound payload, the privacy invariant is broken.
const SECRET_TITLE = 'SECRET_NODE_TITLE_ZZZ_9f3a'
const SECRET_DESC = 'SECRET_NODE_DESCRIPTION_QQQ_7b21'

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes: [
      { id: 'n_1', type: 'persona', title: SECRET_TITLE, description: SECRET_DESC } as never,
      { id: 'n_2', type: 'feature', title: 'Another secret feature name', description: 'more secret body' } as never,
    ],
    edges: [{ id: 'e_1', type: 'persona_pursues_job', source: 'n_1', target: 'n_2' } as never],
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-feedback-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    serverInfo: { name: 'unified-product-graph', version: '9.9.9' },
    getClientInfo: () => ({ name: 'test-client', version: '1.2.3' }),
  }
}

let ctx: ToolContext

beforeEach(async () => {
  ctx = makeCtx(await loadStore(makeDoc()))
  delete process.env.UPG_FEEDBACK_API_URL
  delete process.env.UPG_FEEDBACK_SUBMISSION_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('submit_feedback: consent gate', () => {
  it('refuses to send without confirmed:true and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await submitFeedback(
      { type: 'bug', title: 'Broken thing', description: 'It broke when I did X.' },
      ctx,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    const body = JSON.parse(res.content[0].text) as { status: string; preview: unknown }
    expect(body.status).toBe('confirmation_required')
    expect(body.preview).toBeTruthy()
  })

  it('refuses when confirmed is explicitly false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await submitFeedback(
      { type: 'general', title: 'Note', description: 'A note.', confirmed: false },
      ctx,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(res.content[0].text).status).toBe('confirmation_required')
  })
})

describe('submit_feedback: validation', () => {
  it('rejects an unknown type', async () => {
    const res = await submitFeedback({ type: 'nonsense', title: 't', description: 'd', confirmed: true }, ctx)
    expect(res.isError).toBe(true)
  })

  it('rejects a missing title', async () => {
    const res = await submitFeedback({ type: 'bug', description: 'd', confirmed: true }, ctx)
    expect(res.isError).toBe(true)
  })

  it('rejects a missing description', async () => {
    const res = await submitFeedback({ type: 'bug', title: 't', confirmed: true }, ctx)
    expect(res.isError).toBe(true)
  })
})

describe('submit_feedback: happy path (mocked endpoint)', () => {
  it('returns the id from the endpoint on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'fb_abc123', message: 'Feedback received. Thank you!' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const res = await submitFeedback(
      {
        type: 'bug',
        title: 'Crash on save',
        description: 'The app crashes.',
        details: { steps_to_reproduce: 'save', expected: 'ok', actual: 'crash', severity: 'high' },
        confirmed: true,
      },
      ctx,
    )

    expect(fetchSpy).toHaveBeenCalledOnce()
    const body = JSON.parse(res.content[0].text) as { status: string; id: string }
    expect(body.status).toBe('submitted')
    expect(body.id).toBe('fb_abc123')

    // Endpoint contract: default URL + x-upg-key header + POST.
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://unifiedproductgraph.org/api/feedback')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-upg-key']).toBe('upg-fb-public-v1')
  })

  it('honours UPG_FEEDBACK_API_URL and UPG_FEEDBACK_SUBMISSION_KEY overrides', async () => {
    process.env.UPG_FEEDBACK_API_URL = 'https://staging.example.test/api/feedback'
    process.env.UPG_FEEDBACK_SUBMISSION_KEY = 'staging-key'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', message: 'ok' }), { status: 201 }),
    )
    await submitFeedback({ type: 'general', title: 't', description: 'd', confirmed: true }, ctx)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://staging.example.test/api/feedback')
    expect(((init as RequestInit).headers as Record<string, string>)['x-upg-key']).toBe('staging-key')
  })

  it('surfaces a clear message on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }),
    )
    const res = await submitFeedback({ type: 'bug', title: 't', description: 'd', confirmed: true }, ctx)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('401')
  })

  it('surfaces a clear message on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    )
    const res = await submitFeedback({ type: 'bug', title: 't', description: 'd', confirmed: true }, ctx)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('429')
  })
})

describe('submit_feedback: PRIVACY invariant (load-bearing)', () => {
  it('assembleContext returns only allowlisted keys', () => {
    const context = assembleContext(ctx)
    const allowed = new Set<string>(ALLOWED_CONTEXT_KEYS)
    for (const key of Object.keys(context)) {
      expect(allowed.has(key), `context key "${key}" is not on ALLOWED_CONTEXT_KEYS`).toBe(true)
    }
    // Sanity: it DID collect the non-content signals we expect.
    expect(context.mcp_client).toBe('test-client')
    expect(context.client_version).toBe('1.2.3')
    expect(context.server_version).toBe('9.9.9')
    expect(context.node_count).toBe(2)
    expect(context.edge_count).toBe(1)
  })

  it('the outbound payload contains NO graph content, only allowlisted context', async () => {
    let capturedBody = ''
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = String((init as RequestInit).body ?? '')
      return new Response(JSON.stringify({ id: 'fb_1', message: 'ok' }), { status: 201 })
    })

    await submitFeedback(
      { type: 'observation', title: 'A pattern', description: 'I noticed something.', confirmed: true },
      ctx,
    )
    expect(fetchSpy).toHaveBeenCalledOnce()

    // No seeded node title/description may appear anywhere in the payload.
    expect(capturedBody).not.toContain(SECRET_TITLE)
    expect(capturedBody).not.toContain(SECRET_DESC)
    expect(capturedBody).not.toContain('secret')

    // And the context sub-object is strictly the allowlist.
    const payload = JSON.parse(capturedBody) as { context: Record<string, unknown> }
    const allowed = new Set<string>(ALLOWED_CONTEXT_KEYS)
    for (const key of Object.keys(payload.context)) {
      expect(allowed.has(key), `payload.context leaked non-allowlisted key "${key}"`).toBe(true)
    }
  })

  it('the confirmation preview also carries only allowlisted context', async () => {
    const res = await submitFeedback(
      { type: 'bug', title: 'x', description: 'y' },
      ctx,
    )
    const serialized = res.content[0].text
    expect(serialized).not.toContain(SECRET_TITLE)
    expect(serialized).not.toContain(SECRET_DESC)
    const body = JSON.parse(serialized) as { preview: { context: Record<string, unknown> } }
    const allowed = new Set<string>(ALLOWED_CONTEXT_KEYS)
    for (const key of Object.keys(body.preview.context)) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})
