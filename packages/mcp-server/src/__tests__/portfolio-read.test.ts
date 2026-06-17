/**
 * Cross-product read layer (batch-3 #13) + switch_product resolution fix
 * (batch-3 #12). Runs against a real tmp workspace with multiple `.upg` files;
 * the handlers read `process.cwd()`, so each test chdirs into the workspace and
 * restores cwd afterwards. The active product is read from the live store; the
 * rest are read read-only — exercising both reader paths.
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
  type ToolContext,
} from '../lib/server-context.js'
import { portfolioQuery, portfolioDigest, portfolioCensus } from '../tools/portfolio-read.js'
import { switchProduct } from '../tools/workspace.js'

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

const ALPHA = doc({
  product: { id: 'p_alpha', title: 'Alpha', stage: 'concept' },
  nodes: [
    { id: 'a_p', type: 'persona', title: 'Alpha Persona' },
    { id: 'a_j', type: 'job', title: 'Alpha Job' },
  ],
  edges: [{ id: 'a_e', source: 'a_p', target: 'a_j', type: 'persona_pursues_job' }],
})
const BETA = doc({
  product: { id: 'p_beta', title: 'Beta', stage: 'build' },
  nodes: [
    { id: 'b_p', type: 'persona', title: 'Beta Persona' },
    {
      id: 'b_m',
      type: 'metric',
      title: 'Beta Metric',
      description: 'A north-star metric',
      tags: ['north-star', 'kpi'],
      properties: { designation: 'north_star', target: 100 },
    },
  ],
  edges: [],
})

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

describe('portfolio read layer', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-portfolio-read-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'alpha.upg'), JSON.stringify(ALPHA, null, 2))
    writeFileSync(join(cwd, '.upg', 'beta.upg'), JSON.stringify(BETA, null, 2))
    // A portfolio document carries no `product` header and must be ignored.
    writeFileSync(
      join(cwd, '.upg', 'portfolio.upg'),
      JSON.stringify({ organization: { id: 'org1', title: 'Co' }, product_areas: [], portfolios: [] }, null, 2),
    )
    // Active product = alpha (read live); beta is read read-only.
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

  it('portfolio_digest rolls up every product, skipping the portfolio doc', async () => {
    const body = bodyOf(await portfolioDigest({}, ctx))
    expect(body.rollup.products).toBe(2)
    const ids = body.products.map((p: { product_id: string }) => p.product_id).sort()
    expect(ids).toEqual(['p_alpha', 'p_beta'])
    expect(body.rollup.by_stage).toMatchObject({ concept: 1, build: 1 })
    const alpha = body.products.find((p: { product_id: string }) => p.product_id === 'p_alpha')
    expect(alpha.total_nodes).toBe(2)
    expect(alpha.health).toBeDefined()
  })

  it('portfolio_query spans products and tags each subgraph with its product_id', async () => {
    const body = bodyOf(await portfolioQuery({ from: 'persona' }, ctx))
    expect(body.products_searched).toBe(2)
    expect(body.products_with_matches).toBe(2)
    const matched = body.products.map((p: { product_id: string }) => p.product_id).sort()
    expect(matched).toEqual(['p_alpha', 'p_beta'])
  })

  it('portfolio_query honours scope', async () => {
    const body = bodyOf(await portfolioQuery({ from: 'persona', scope: ['p_beta'] }, ctx))
    expect(body.products_searched).toBe(1)
    expect(body.products.map((p: { product_id: string }) => p.product_id)).toEqual(['p_beta'])
  })

  it('portfolio_query reports empties and unmatched scope', async () => {
    const body = bodyOf(await portfolioQuery({ from: 'competitor' }, ctx))
    expect(body.products_with_matches).toBe(0)
    expect(body.empty_products.sort()).toEqual(['p_alpha', 'p_beta'])

    const scoped = bodyOf(await portfolioQuery({ from: 'persona', scope: ['p_ghost'] }, ctx))
    expect(scoped.products_searched).toBe(0)
    expect(scoped.unmatched_scope).toEqual(['p_ghost'])
  })

  it('portfolio_query validates from / from_id', async () => {
    const result = await portfolioQuery({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Provide either/)
  })

  it('portfolio_census lists nodes of a type across products (flat, default projection)', async () => {
    const body = bodyOf(await portfolioCensus({ type: 'persona' }, ctx))
    expect(body.total).toBe(2)
    expect(body.returned).toBe(2)
    expect(body.has_more).toBe(false)
    expect(body.products_searched).toBe(2)
    expect(body.products_with_matches).toBe(2)
    const rows = body.rows.sort((a: { node_id: string }, b: { node_id: string }) => a.node_id.localeCompare(b.node_id))
    expect(rows).toEqual([
      { product_id: 'p_alpha', node_id: 'a_p', title: 'Alpha Persona' },
      { product_id: 'p_beta', node_id: 'b_p', title: 'Beta Persona' },
    ])
  })

  it('portfolio_census projects include + property_include and never returns edges', async () => {
    const body = bodyOf(
      await portfolioCensus(
        { type: 'metric', include: ['title', 'description', 'tags', 'properties'], property_include: ['designation'] },
        ctx,
      ),
    )
    expect(body.total).toBe(1)
    expect(body.rows[0]).toEqual({
      product_id: 'p_beta',
      node_id: 'b_m',
      title: 'Beta Metric',
      description: 'A north-star metric',
      tags: ['north-star', 'kpi'],
      properties: { designation: 'north_star' },
    })
    expect(body.rows[0].edges).toBeUndefined()
  })

  it('portfolio_census group_by product nests rows under each product', async () => {
    const body = bodyOf(await portfolioCensus({ type: 'persona', group_by: 'product' }, ctx))
    expect(body.rows).toBeUndefined()
    const byId = Object.fromEntries(
      body.products.map((p: { product_id: string }) => [p.product_id, p]),
    )
    expect(byId.p_alpha.count).toBe(1)
    expect(byId.p_alpha.rows).toEqual([{ node_id: 'a_p', title: 'Alpha Persona' }])
    expect(byId.p_beta.count).toBe(1)
  })

  it('portfolio_census honours scope, tags filter, and paging', async () => {
    const scoped = bodyOf(await portfolioCensus({ type: 'persona', scope: ['p_beta'] }, ctx))
    expect(scoped.products_searched).toBe(1)
    expect(scoped.rows.map((r: { product_id: string }) => r.product_id)).toEqual(['p_beta'])

    const tagged = bodyOf(await portfolioCensus({ type: 'metric', tags: ['north-star'] }, ctx))
    expect(tagged.total).toBe(1)
    const noTag = bodyOf(await portfolioCensus({ type: 'metric', tags: ['nonexistent'] }, ctx))
    expect(noTag.total).toBe(0)

    const page = bodyOf(await portfolioCensus({ type: 'persona', limit: 1 }, ctx))
    expect(page.total).toBe(2)
    expect(page.returned).toBe(1)
    expect(page.has_more).toBe(true)
    const page2 = bodyOf(await portfolioCensus({ type: 'persona', limit: 1, offset: 1 }, ctx))
    expect(page2.returned).toBe(1)
    expect(page2.has_more).toBe(false)
  })

  it('portfolio_census requires a type and reports unmatched scope', async () => {
    const err = await portfolioCensus({}, ctx)
    expect(err.isError).toBe(true)
    expect(err.content[0].text).toMatch(/Provide "type"/)

    const ghost = bodyOf(await portfolioCensus({ type: 'persona', scope: ['p_ghost'] }, ctx))
    expect(ghost.products_searched).toBe(0)
    expect(ghost.unmatched_scope).toEqual(['p_ghost'])
  })
})

describe('switch_product resolution (batch-3 #12)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-switch-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(
      join(cwd, '.upg', 'sanity.upg'),
      JSON.stringify(doc({ product: { id: 'p_sanity', title: 'Sanity', stage: 'concept' } }), null, 2),
    )
    // A sibling SOURCE directory whose name collides with the bare product name.
    // The old resolution `path.resolve('sanity')` matched this directory and
    // store.load threw EISDIR. The fix anchors to .upg/ and requires a file.
    mkdirSync(join(cwd, 'sanity'))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'sanity.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('resolves a bare name to .upg/<name>.upg even when a sibling dir collides', async () => {
    const result = await switchProduct({ file: 'sanity' }, ctx)
    expect(result.isError).toBeUndefined()
    const body = bodyOf(result)
    expect(body.product.title).toBe('Sanity')
    expect(body.file.endsWith('.upg/sanity.upg')).toBe(true)
  })

  it('still resolves an explicit .upg path', async () => {
    const result = await switchProduct({ file: '.upg/sanity.upg' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(bodyOf(result).product.title).toBe('Sanity')
  })

  it('returns a not-found error for an unknown bare name', async () => {
    const result = await switchProduct({ file: 'nope' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/File not found/)
  })
})
