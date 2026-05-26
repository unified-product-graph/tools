/**
 * — portfolio.upg honours its own structure.
 *
 * Verifies the MCP write path routes portfolio-scoped entities (`portfolio`,
 * `organization`, `product_area`) to `.upg/portfolio.upg` rather than the
 * active product's `nodes[]`, that the read tools find them there, and that
 * `create_cross_product_edge` auto-registers both products on
 * `portfolio.upg.products[]`.
 *
 * Every test runs inside a real tmpdir with process.cwd() chdir'd into it so
 * the cwd-dependent portfolio path resolution exercises end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createNode } from '../tools/nodes.js'
import { createArea, listProductAreas } from '../tools/areas.js'
import {
  listPortfolios,
  getOrganization,
  createCrossProductEdge,
} from '../tools/workspace.js'
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDoc(productId = 'p_test', title = 'Test Product'): UPGDocument {
  return {
    upg_version: '0.5',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: productId, title, stage: 'concept' },
    nodes: [],
    edges: [],
  }
}

async function makeStoreAt(
  filePath: string,
  doc: UPGDocument = makeDoc(),
): Promise<UPGFileStore> {
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
  }
}

interface ParsedResult {
  isError?: boolean
  text: string
  // Loose body shape — every assertion narrows what it cares about.
  body?: Record<string, unknown>
  error?: string
}

async function parseHandlerResult(
  result: ReturnType<typeof createNode>,
): Promise<ParsedResult> {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  const text = r.content[0]?.text ?? ''
  if (r.isError) return { isError: true, text, error: text }
  try {
    return { text, body: JSON.parse(text) }
  } catch {
    return { text }
  }
}

function readPortfolio(cwd: string): Record<string, unknown> | null {
  const p = join(cwd, '.upg', 'portfolio.upg')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

// ── 1. Portfolio-scoped entities route to portfolio.upg ──────────────────────

describe(' · create_node routes portfolio-scoped types to portfolio.upg', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-526-create-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
    const productPath = join(cwd, '.upg', 'product.upg')
    store = await makeStoreAt(productPath)
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('type: "portfolio" writes to portfolio.upg.portfolios[], NOT product nodes[]', async () => {
    const result = await parseHandlerResult(
      createNode(
        {
          type: 'portfolio',
          title: 'Growth Bets',
          description: 'New market expansion investments',
          properties: { hierarchy_model: 'flat' },
        },
        ctx,
      ),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('portfolios')

    const portfolio = readPortfolio(cwd)
    expect(portfolio).not.toBeNull()
    const portfolios = portfolio?.portfolios as Array<{ title: string; hierarchy_model?: string }>
    expect(portfolios).toHaveLength(1)
    expect(portfolios[0].title).toBe('Growth Bets')
    expect(portfolios[0].hierarchy_model).toBe('flat')

    // Active product's nodes[] must be untouched
    expect(store.getAllNodes()).toHaveLength(0)
  })

  it('type: "organization" sets portfolio.upg.organization (singleton)', async () => {
    const result = await parseHandlerResult(
      createNode(
        {
          type: 'organization',
          title: 'Arkheiev UG',
          description: 'Builds The Product Creator brand ecosystem',
          properties: { industry: 'Developer Tools' },
        },
        ctx,
      ),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('organization')

    const portfolio = readPortfolio(cwd)
    const org = portfolio?.organization as { title: string; industry?: string }
    expect(org.title).toBe('Arkheiev UG')
    expect(org.industry).toBe('Developer Tools')
    expect(store.getAllNodes()).toHaveLength(0)
  })

  it('type: "organization" refuses to overwrite without overwrite_organization flag', async () => {
    await parseHandlerResult(
      createNode({ type: 'organization', title: 'First Org' }, ctx),
    )

    const second = await parseHandlerResult(
      createNode({ type: 'organization', title: 'Second Org' }, ctx),
    )
    expect(second.isError).toBe(true)
    expect(second.error).toMatch(/already has an organization/i)
    expect(second.error).toMatch(/overwrite_organization/)

    const portfolio = readPortfolio(cwd)
    const org = portfolio?.organization as { title: string }
    expect(org.title).toBe('First Org')
  })

  it('type: "organization" with overwrite_organization replaces the existing org and warns', async () => {
    await parseHandlerResult(
      createNode({ type: 'organization', title: 'First Org' }, ctx),
    )
    const second = await parseHandlerResult(
      createNode(
        { type: 'organization', title: 'Second Org', overwrite_organization: true },
        ctx,
      ),
    )
    expect(second.isError).toBeUndefined()
    expect(second.body?.warning).toMatch(/Replaced existing organization/)
    const portfolio = readPortfolio(cwd)
    const org = portfolio?.organization as { title: string }
    expect(org.title).toBe('Second Org')
  })

  it('type: "product_area" writes to portfolio.upg.product_areas[], NOT product nodes[]', async () => {
    const result = await parseHandlerResult(
      createNode(
        {
          type: 'product_area',
          title: 'Platform',
          description: 'Core infrastructure',
          properties: { strategic_priority: 'high' },
        },
        ctx,
      ),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('product_areas')

    const portfolio = readPortfolio(cwd)
    const areas = portfolio?.product_areas as Array<{ title: string; strategic_priority?: string }>
    expect(areas).toHaveLength(1)
    expect(areas[0].title).toBe('Platform')
    expect(areas[0].strategic_priority).toBe('high')
    expect(store.getAllNodes()).toHaveLength(0)
  })

  it('non-portfolio types still write to the active product', async () => {
    const result = await parseHandlerResult(
      createNode({ type: 'persona', title: 'Solo Builder' }, ctx),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBeUndefined()
    expect(store.getAllNodes()).toHaveLength(1)
    expect(readPortfolio(cwd)).toBeNull()
  })

  it('create_area routes to portfolio.upg.product_areas[]', async () => {
    const result = await parseHandlerResult(
      createArea(
        { title: 'Search', strategic_priority: 'medium' },
        ctx,
      ),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('product_areas')

    const portfolio = readPortfolio(cwd)
    const areas = portfolio?.product_areas as Array<{ title: string; strategic_priority?: string }>
    expect(areas).toHaveLength(1)
    expect(areas[0].title).toBe('Search')
    expect(areas[0].strategic_priority).toBe('medium')
    expect(store.getAllNodes()).toHaveLength(0)
  })
})

// ── 2. Read tools find portfolio-scoped entities ─────────────────────────────

describe(' · list_portfolios / list_product_areas / get_organization read from portfolio.upg', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-526-read-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
    const productPath = join(cwd, '.upg', 'product.upg')
    store = await makeStoreAt(productPath)
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('list_portfolios returns the portfolio entity created via create_node', async () => {
    await parseHandlerResult(
      createNode(
        { type: 'portfolio', title: 'Q4 Bets', properties: { hierarchy_model: 'nested' } },
        ctx,
      ),
    )

    const listResult = await parseHandlerResult(listPortfolios({}, ctx))
    expect(listResult.isError).toBeUndefined()
    const body = listResult.body as {
      portfolios: Array<{ title: string; hierarchy_model?: string }>
      total: number
    }
    expect(body.total).toBe(1)
    expect(body.portfolios[0].title).toBe('Q4 Bets')
    expect(body.portfolios[0].hierarchy_model).toBe('nested')
  })

  it('list_product_areas returns the product_area entity created via create_node', async () => {
    await parseHandlerResult(
      createNode(
        { type: 'product_area', title: 'Billing', properties: { strategic_priority: 'critical' } },
        ctx,
      ),
    )

    const listResult = await parseHandlerResult(listProductAreas({}, ctx))
    expect(listResult.isError).toBeUndefined()
    const body = listResult.body as {
      areas: Array<{ title: string; strategic_priority?: string }>
      total: number
    }
    expect(body.total).toBe(1)
    expect(body.areas[0].title).toBe('Billing')
    expect(body.areas[0].strategic_priority).toBe('critical')
  })

  it('get_organization returns the organisation set via create_node', async () => {
    await parseHandlerResult(
      createNode(
        { type: 'organization', title: 'Acme Corp', properties: { industry: 'Retail' } },
        ctx,
      ),
    )

    const orgResult = await parseHandlerResult(getOrganization({}, ctx))
    expect(orgResult.isError).toBeUndefined()
    const body = orgResult.body as {
      organization: { title: string; industry?: string } | null
      portfolio_file?: string
    }
    expect(body.organization?.title).toBe('Acme Corp')
    expect(body.organization?.industry).toBe('Retail')
    expect(body.portfolio_file).toMatch(/portfolio\.upg/)
  })
})

// ── 3. Empty / missing portfolio.upg handling ────────────────────────────────

describe(' · read tools return empty when no portfolio.upg exists', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-526-empty-'))
    process.chdir(cwd)
    // Bare cwd — NO .upg/ directory at all. The product file lives outside
    // the workspace, so portfolio.upg cannot exist.
    const productPath = join(cwd, 'lone.upg')
    store = await makeStoreAt(productPath)
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('list_portfolios returns empty array (not error) when no portfolio.upg exists', async () => {
    const result = await parseHandlerResult(listPortfolios({}, ctx))
    expect(result.isError).toBeUndefined()
    const body = result.body as { portfolios: unknown[]; total: number }
    expect(body.portfolios).toEqual([])
    expect(body.total).toBe(0)
  })

  it('list_product_areas returns empty array (not error) when no portfolio.upg exists', async () => {
    const result = await parseHandlerResult(listProductAreas({}, ctx))
    expect(result.isError).toBeUndefined()
    const body = result.body as { areas: unknown[]; total: number }
    expect(body.areas).toEqual([])
    expect(body.total).toBe(0)
  })

  it('get_organization returns { organization: null } when no portfolio.upg exists', async () => {
    const result = await parseHandlerResult(getOrganization({}, ctx))
    expect(result.isError).toBeUndefined()
    const body = result.body as { organization: unknown }
    expect(body.organization).toBeNull()
  })
})

// ── 4. create_cross_product_edge auto-registers products ─────────────────────

describe(' · create_cross_product_edge auto-registers products on portfolio.upg.products[]', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-526-cross-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)

    // Seed two product files in the workspace so findProductFileById can
    // resolve the file_path + title for each registered product.
    const productA = makeDoc('p_alpha', 'Alpha')
    productA.nodes = [{ id: 'n_a1', type: 'persona', title: 'Alpha User' }]
    const productB = makeDoc('p_beta', 'Beta')
    productB.nodes = [{ id: 'n_b1', type: 'persona', title: 'Beta User' }]
    writeFileSync(join(cwd, '.upg', 'alpha.upg'), JSON.stringify(productA, null, 2))
    writeFileSync(join(cwd, '.upg', 'beta.upg'), JSON.stringify(productB, null, 2))

    store = await makeStoreAt(join(cwd, '.upg', 'alpha.upg'), productA)
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('registers both products on portfolio.upg.products[]', async () => {
    const result = await parseHandlerResult(
      createCrossProductEdge(
        {
          source_id: 'p_alpha/n_a1',
          target_id: 'p_beta/n_b1',
          type: 'shares_persona',
        },
        ctx,
      ),
    )
    expect(result.isError).toBeUndefined()

    const portfolio = readPortfolio(cwd)
    const products = portfolio?.products as Array<{ id: string; file_path?: string; title?: string }>
    expect(products).toHaveLength(2)
    const productIds = products.map((p) => p.id).sort()
    expect(productIds).toEqual(['p_alpha', 'p_beta'])

    // Each registered product carries its resolved file_path + title
    const alpha = products.find((p) => p.id === 'p_alpha')
    expect(alpha?.file_path).toMatch(/alpha\.upg/)
    expect(alpha?.title).toBe('Alpha')
    const beta = products.find((p) => p.id === 'p_beta')
    expect(beta?.file_path).toMatch(/beta\.upg/)
    expect(beta?.title).toBe('Beta')

    // Cross-edge itself written too
    const crossEdges = portfolio?.cross_edges as Array<{ source: string; target: string }>
    expect(crossEdges).toHaveLength(1)
    expect(crossEdges[0].source).toBe('p_alpha/n_a1')
    expect(crossEdges[0].target).toBe('p_beta/n_b1')

    // Response surfaces what was registered
    const body = result.body as {
      registered_products?: Array<{ id: string }>
    }
    expect(body.registered_products).toHaveLength(2)
  })

  it('does not double-register an already-listed product on a second cross-edge', async () => {
    await parseHandlerResult(
      createCrossProductEdge(
        {
          source_id: 'p_alpha/n_a1',
          target_id: 'p_beta/n_b1',
          type: 'shares_persona',
        },
        ctx,
      ),
    )
    const second = await parseHandlerResult(
      createCrossProductEdge(
        {
          source_id: 'p_alpha/n_a1',
          target_id: 'p_beta/n_b1',
          type: 'shares_competitor',
        },
        ctx,
      ),
    )
    expect(second.isError).toBeUndefined()

    const portfolio = readPortfolio(cwd)
    const products = portfolio?.products as Array<{ id: string }>
    expect(products).toHaveLength(2)

    // Second call registers nothing new
    const body = second.body as { registered_products?: unknown[] }
    expect(body.registered_products).toBeUndefined()
  })
})
