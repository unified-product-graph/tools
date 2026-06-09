/**
 * Batch-4 0.9.3 — multi-product authoring safety pack.
 *
 * Covers:
 *   #15  batch_create_nodes / batch_create_edges `validate_only` dry-run
 *        (full error accumulation, never writes)
 *   #16  batch_create_nodes `ref` aliases (parent_ref + edges by name) and
 *        stray-`$` / duplicate-alias rejection
 *   #19  portfolio_validate (audit across the workspace)
 *   #20  active-product write guard + echo helpers (server dispatch)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
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
  text,
  type ToolContext,
} from '../lib/server-context.js'
import { batchCreateNodes } from '../tools/nodes.js'
import { batchCreateEdges } from '../tools/edges.js'
import { portfolioValidate } from '../tools/portfolio-read.js'
import {
  ACTIVE_PRODUCT_WRITE_TOOLS,
  activeProductIdentity,
  matchesActiveProduct,
  withActiveProductEcho,
} from '../server.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    nodes: [],
    edges: [],
    ...over,
  }
}

async function loadStore(d: UPGDocument, fileName = 'test.upg'): Promise<{ store: UPGFileStore; dir: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-batch4-')))
  const filePath = join(dir, fileName)
  writeFileSync(filePath, JSON.stringify(d, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return { store, dir }
}

// ─── #15 + #16: batch_create_nodes ──────────────────────────────────────────

describe('batch_create_nodes: validate_only dry-run (#15)', () => {
  let store: UPGFileStore
  let dir: string
  let ctx: ToolContext

  beforeEach(async () => {
    ;({ store, dir } = await loadStore(doc({ product: { id: 'p1', title: 'Fixture', stage: 'concept' } })))
    ctx = makeCtx(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports valid + would-be counts without writing', () => {
    const before = store.getAllNodes().length
    const body = bodyOf(
      batchCreateNodes(
        {
          validate_only: true,
          nodes: [
            { ref: 'p', type: 'persona', title: 'Persona' },
            { ref: 'j', type: 'job', title: 'Job', parent_ref: 'p' },
          ],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.validate_only).toBe(true)
    expect(body.valid).toBe(true)
    expect(body.errors).toEqual([])
    expect(body.would_create_nodes).toBe(2)
    expect(body.would_create_edges).toBe(1) // persona -> job parent edge
    // Nothing was written.
    expect(store.getAllNodes().length).toBe(before)
  })

  it('accumulates EVERY error and writes nothing', () => {
    const before = store.getAllNodes().length
    const body = bodyOf(
      batchCreateNodes(
        {
          validate_only: true,
          nodes: [
            { type: 'banana', title: 'Bad type 1' },
            { type: 'persona', title: 'Good' },
            { type: 'kumquat', title: 'Bad type 2' },
          ],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.valid).toBe(false)
    // Both bad-type nodes are reported in ONE pass, not just the first.
    expect(body.errors.length).toBeGreaterThanOrEqual(2)
    expect(body.errors.join(' ')).toMatch(/banana/)
    expect(body.errors.join(' ')).toMatch(/kumquat/)
    expect(store.getAllNodes().length).toBe(before)
  })
})

describe('batch_create_nodes: ref aliases (#16)', () => {
  let store: UPGFileStore
  let dir: string
  let ctx: ToolContext

  beforeEach(async () => {
    ;({ store, dir } = await loadStore(doc({ product: { id: 'p1', title: 'Fixture', stage: 'concept' } })))
    ctx = makeCtx(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('wires edges by alias instead of positional $N', () => {
    const body = bodyOf(
      batchCreateNodes(
        {
          nodes: [
            { ref: 'persona_dev', type: 'persona', title: 'Dev' },
            { ref: 'job_ship', type: 'job', title: 'Ship' },
          ],
          edges: [{ from_ref: 'persona_dev', to_ref: 'job_ship' }],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.count).toBe(2)
    expect(body.explicit_edges).toHaveLength(1)
    expect(body.explicit_edges[0].type).toBe('persona_pursues_job')
  })

  it('resolves parent_ref by alias', () => {
    const body = bodyOf(
      batchCreateNodes(
        {
          nodes: [
            { ref: 'p', type: 'persona', title: 'P' },
            { type: 'job', title: 'J', parent_ref: 'p' },
          ],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.edges).toHaveLength(1)
    expect(body.edges[0].type).toBe('persona_pursues_job')
  })

  it('rejects an out-of-range $N and a stray $token, echoing the ref_map', () => {
    const result = batchCreateNodes(
      {
        validate_only: true,
        nodes: [{ ref: 'only', type: 'persona', title: 'Only' }],
        edges: [
          { from_ref: '$99', to_ref: '$0' },
          { from_ref: '$nope', to_ref: 'only' },
        ],
      },
      ctx,
    ) as { content: { text: string }[] }
    const body = bodyOf(result)
    expect(body.valid).toBe(false)
    expect(body.errors.join(' ')).toMatch(/out of range/)
    expect(body.errors.join(' ')).toMatch(/looks like a positional ref/)
    expect(body.ref_map).toEqual([{ token: 'only', index: 0, type: 'persona', title: 'Only' }])
  })

  it('rejects a duplicate alias', () => {
    const body = bodyOf(
      batchCreateNodes(
        {
          validate_only: true,
          nodes: [
            { ref: 'dup', type: 'persona', title: 'A' },
            { ref: 'dup', type: 'job', title: 'B' },
          ],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.valid).toBe(false)
    expect(body.errors.join(' ')).toMatch(/duplicate ref alias "dup"/)
  })

  it('surfaces the full error list + ref_map on a failed COMMIT', () => {
    const result = batchCreateNodes(
      {
        nodes: [
          { ref: 'p', type: 'persona', title: 'P' },
          { type: 'banana', title: 'Bad' },
        ],
      },
      ctx,
    ) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    const body = bodyOf(result)
    expect(body.error).toMatch(/banana/)
    expect(body.ref_map).toEqual([{ token: 'p', index: 0, type: 'persona', title: 'P' }])
    // Atomic: nothing landed.
    expect(store.getAllNodes().length).toBe(0)
  })
})

// ─── #15: batch_create_edges ────────────────────────────────────────────────

describe('batch_create_edges: validate_only dry-run (#15)', () => {
  let store: UPGFileStore
  let dir: string
  let ctx: ToolContext

  beforeEach(async () => {
    ;({ store, dir } = await loadStore(
      doc({
        product: { id: 'p1', title: 'Fixture', stage: 'concept' },
        nodes: [
          { id: 'per', type: 'persona', title: 'P' },
          { id: 'job', type: 'job', title: 'J' },
        ],
      }),
    ))
    ctx = makeCtx(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('validates a good edge without writing', () => {
    const before = store.getAllEdges().length
    const body = bodyOf(batchCreateEdges({ validate_only: true, edges: [{ source_id: 'per', target_id: 'job' }] }, ctx))
    expect(body.validate_only).toBe(true)
    expect(body.valid).toBe(true)
    expect(body.would_create_edges).toBe(1)
    expect(store.getAllEdges().length).toBe(before)
  })

  it('accumulates errors for bad edges without writing', () => {
    const before = store.getAllEdges().length
    const body = bodyOf(
      batchCreateEdges(
        {
          validate_only: true,
          edges: [
            { source_id: 'ghost', target_id: 'job' },
            { source_id: 'per', target_id: 'per' }, // self-loop
          ],
        },
        ctx,
      ),
    )
    expect(body.valid).toBe(false)
    expect(body.errors.length).toBe(2)
    expect(body.errors.join(' ')).toMatch(/not found/)
    expect(body.errors.join(' ')).toMatch(/self-loop/)
    expect(store.getAllEdges().length).toBe(before)
  })
})

// ─── #19: portfolio_validate ────────────────────────────────────────────────

describe('portfolio_validate (#19)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-portfolio-validate-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(
      join(cwd, '.upg', 'alpha.upg'),
      JSON.stringify(
        doc({
          product: { id: 'p_alpha', title: 'Alpha', stage: 'concept' },
          nodes: [
            { id: 'a_p', type: 'persona', title: 'Alpha Persona' },
            { id: 'a_j', type: 'job', title: 'Alpha Job' },
          ],
          edges: [{ id: 'a_e', source: 'a_p', target: 'a_j', type: 'persona_pursues_job' }],
        }),
        null,
        2,
      ),
    )
    writeFileSync(
      join(cwd, '.upg', 'beta.upg'),
      JSON.stringify(
        doc({
          product: { id: 'p_beta', title: 'Beta', stage: 'build' },
          // A deprecated-alias type guarantees entity drift → structurally invalid.
          nodes: [{ id: 'b_x', type: 'pain_point', title: 'Drifted node' }],
        }),
        null,
        2,
      ),
    )
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'alpha.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('audits every product and rolls up a consistent verdict', async () => {
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.rollup.products).toBe(2)
    expect(body.rollup.valid + body.rollup.invalid).toBe(2)
    expect(typeof body.rollup.all_valid).toBe('boolean')
    for (const p of body.products) {
      expect(typeof p.valid).toBe('boolean')
      expect(p.drift).toBeDefined()
      expect(p.anti_patterns).toBeDefined()
    }
    // Beta carries a deprecated-alias node → entity drift → structurally invalid.
    const beta = body.products.find((p: { product_id: string }) => p.product_id === 'p_beta')
    expect(beta.structurally_valid).toBe(false)
    expect(beta.drift.entity).toBeGreaterThanOrEqual(1)
  })

  it('honours scope', async () => {
    const body = bodyOf(await portfolioValidate({ scope: ['p_alpha'] }, ctx))
    expect(body.rollup.products).toBe(1)
    expect(body.products[0].product_id).toBe('p_alpha')
  })
})

// ─── #20: active-product write guard + echo helpers ─────────────────────────

describe('active-product write guard + echo (#20)', () => {
  let store: UPGFileStore
  let dir: string

  beforeEach(async () => {
    ;({ store, dir } = await loadStore(
      doc({ product: { id: 'p_x', title: 'Product X', stage: 'concept' } }),
      'productx.upg',
    ))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('curates exactly the active-product mutators', () => {
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('batch_create_nodes')).toBe(true)
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('create_edge')).toBe(true)
    // Portfolio + lifecycle tools are excluded.
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('create_product')).toBe(false)
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('switch_product')).toBe(false)
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('portfolio_validate')).toBe(false)
    expect(ACTIVE_PRODUCT_WRITE_TOOLS.has('query')).toBe(false)
  })

  it('matches the active product by id, title, file, and stem', () => {
    const ident = activeProductIdentity(store)
    expect(ident.id).toBe('p_x')
    expect(ident.title).toBe('Product X')
    expect(matchesActiveProduct('p_x', ident)).toBe(true)
    expect(matchesActiveProduct('Product X', ident)).toBe(true)
    expect(matchesActiveProduct('productx.upg', ident)).toBe(true)
    expect(matchesActiveProduct('productx', ident)).toBe(true)
    expect(matchesActiveProduct('p_other', ident)).toBe(false)
  })

  it('echoes active_product into a JSON write result', () => {
    const echoed = withActiveProductEcho(text(JSON.stringify({ created: [], count: 0 })), store)
    const body = JSON.parse(echoed.content[0].text)
    expect(body.active_product).toEqual({ id: 'p_x', title: 'Product X' })
  })

  it('leaves a non-JSON result untouched', () => {
    const r = withActiveProductEcho(text('plain text'), store)
    expect(r.content[0].text).toBe('plain text')
  })
})
