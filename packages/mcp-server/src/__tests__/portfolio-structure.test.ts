/**
 *: portfolio.upg honours its own structure.
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
import {
  createArea,
  createPortfolio,
  listProductAreas,
  assignProductToAreaTool,
  updateAreaTool,
  removeProductFromAreaTool,
  deleteAreaTool,
  moveProductToAreaTool,
} from '../tools/areas.js'
import {
  listPortfolios,
  getOrganization,
  createCrossProductEdge,
  attachProductToPortfolioTool,
  detachProductFromPortfolioTool,
  deleteCrossProductEdgeTool,
  batchCreateCrossProductEdges,
  createProductTool,
  listLocalProducts,
  listPortfolioCrossEdges,
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
  // Loose body shape; every assertion narrows what it cares about.
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

  it('create_portfolio routes to portfolio.upg.portfolios[] with the kind (0.17.x, gap G2)', async () => {
    const result = await parseHandlerResult(
      createPortfolio({ title: 'Go-to-Market', kind: 'gtm' }, ctx),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('portfolios')

    const portfolio = readPortfolio(cwd)
    const portfolios = portfolio?.portfolios as Array<{ title: string; kind?: string }>
    expect(portfolios).toHaveLength(1)
    expect(portfolios[0].title).toBe('Go-to-Market')
    expect(portfolios[0].kind).toBe('gtm')
    expect(store.getAllNodes()).toHaveLength(0)
  })

  it('create_portfolio rejects an invalid kind', async () => {
    const result = await parseHandlerResult(
      createPortfolio({ title: 'Bad', kind: 'bogus' }, ctx),
    )
    expect(result.isError).toBe(true)
  })

  it('create_portfolio warns (not silent) on a non-existent parent_portfolio_id', async () => {
    const result = await parseHandlerResult(
      createPortfolio({ title: 'Orphan', parent_portfolio_id: 'pf_does_not_exist' }, ctx),
    )
    expect(result.isError).toBeUndefined()
    expect(result.body?.written_to).toBe('portfolios')
    expect(result.body?.warning).toMatch(/forward reference|does not match/)
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
    // Legacy non-canonical 'critical' coerces to the canonical 'urgent'.
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
    expect(body.areas[0].strategic_priority).toBe('urgent')
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
    // Bare cwd: NO .upg/ directory at all. The product file lives outside
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
          auto_create_portfolio: true,
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
          auto_create_portfolio: true,
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
          auto_create_portfolio: true,
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

// ── 0.8.15 · product_area owner + product→container attachment ────────────────

describe('0.8.15 · owner property + assign/attach product ( §C / §A)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-0815-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
    store = await makeStoreAt(join(cwd, '.upg', 'product.upg'))
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('§C: create_area persists owner and list_product_areas surfaces it', async () => {
    await parseHandlerResult(createArea({ title: 'Payments', owner: 'Team Cash' }, ctx))
    const list = await parseHandlerResult(listProductAreas({}, ctx))
    const body = list.body as { areas: Array<{ title: string; owner?: string }> }
    expect(body.areas[0].owner).toBe('Team Cash')
    const areas = readPortfolio(cwd)?.product_areas as Array<{ owner?: string }>
    expect(areas[0].owner).toBe('Team Cash')
  })

  it('§A: assign_product_to_area adds the product to area.products[] in portfolio.upg', async () => {
    const created = await parseHandlerResult(createArea({ title: 'Platform' }, ctx))
    const areaId = (created.body?.node as { id: string }).id
    const r = await parseHandlerResult(
      assignProductToAreaTool({ product_id: 'p_test', area_id: areaId }, ctx),
    )
    expect(r.isError).toBeUndefined()
    expect((r.body as { container_kind?: string }).container_kind).toBe('product_area')
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; products?: string[] }>
    expect(areas.find((a) => a.id === areaId)?.products).toContain('p_test')
  })

  it('§A: assign_product_to_area errors on an unknown area id', async () => {
    await parseHandlerResult(createArea({ title: 'Anything' }, ctx)) // ensure portfolio.upg exists
    const r = await parseHandlerResult(
      assignProductToAreaTool({ product_id: 'p_test', area_id: 'n_nope' }, ctx),
    )
    expect(r.isError).toBe(true)
    expect(r.error).toMatch(/not found in portfolio\.upg/i)
  })

  it('§A: attach_product_to_portfolio adds the product to portfolio.products[]', async () => {
    await parseHandlerResult(createNode({ type: 'portfolio', title: 'Bets' }, ctx))
    const portfolioId = (readPortfolio(cwd)?.portfolios as Array<{ id: string }>)[0].id
    const r = await parseHandlerResult(
      attachProductToPortfolioTool({ product_id: 'p_test', portfolio_id: portfolioId }, ctx),
    )
    expect(r.isError).toBeUndefined()
    const after = readPortfolio(cwd)?.portfolios as Array<{ id: string; products?: string[] }>
    expect(after[0].products).toContain('p_test')
  })

  it('§A: attach_product_to_portfolio resolves a product in a workspace.json subfolder', async () => {
    // A product created with `dir:` lives in a subfolder and is registered in
    // workspace.json (e.g. `web-ecosystem/<slug>.upg`) — the old root-only
    // findProductFileById missed it ("Product not found in this workspace"),
    // so attach/detach/assign/move all failed for subfolder products.
    await parseHandlerResult(createNode({ type: 'portfolio', title: 'Web Ecosystem' }, ctx))
    const portfolioId = (readPortfolio(cwd)?.portfolios as Array<{ id: string }>)[0].id
    mkdirSync(join(cwd, '.upg', 'web-ecosystem'))
    writeFileSync(
      join(cwd, '.upg', 'web-ecosystem', 'studio.upg'),
      JSON.stringify(makeDoc('p_studio', 'Studio'), null, 2),
    )
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ products: [{ file: 'web-ecosystem/studio.upg', title: 'Studio' }] }, null, 2),
    )
    const r = await parseHandlerResult(
      attachProductToPortfolioTool({ product_id: 'p_studio', portfolio_id: portfolioId }, ctx),
    )
    expect(r.isError).toBeUndefined()
    const after = readPortfolio(cwd)?.portfolios as Array<{ id: string; products?: string[] }>
    expect(after.find((p) => p.id === portfolioId)?.products).toContain('p_studio')
  })
})

// ── 0.8.16 · portfolio edit / cleanup tier ─────────────────────────

describe('0.8.16 · portfolio edit/cleanup tier', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-0816-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
    store = await makeStoreAt(join(cwd, '.upg', 'product.upg'))
    ctx = makeCtx(store)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  async function makeArea(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await parseHandlerResult(createArea({ title, ...extra }, ctx))
    return (r.body?.node as { id: string }).id
  }

  // #7 update_area
  it('#7 update_area edits title / strategic_priority / owner', async () => {
    const id = await makeArea('Platform', { strategic_priority: 'low' })
    const r = await parseHandlerResult(
      updateAreaTool({ area_id: id, title: 'Platform and APIs', strategic_priority: 'high', owner: 'Team P' }, ctx),
    )
    expect(r.isError).toBeUndefined()
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; title: string; strategic_priority?: string; owner?: string }>
    const a = areas.find((x) => x.id === id)!
    expect(a.title).toBe('Platform and APIs')
    expect(a.strategic_priority).toBe('high')
    expect(a.owner).toBe('Team P')
  })

  it('#7 update_area coerces legacy critical to urgent', async () => {
    const id = await makeArea('Risk')
    await parseHandlerResult(updateAreaTool({ area_id: id, strategic_priority: 'critical' }, ctx))
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; strategic_priority?: string }>
    expect(areas.find((x) => x.id === id)?.strategic_priority).toBe('urgent')
  })

  it('#7 update_area re-parents then un-nests via parent_area_id', async () => {
    const parent = await makeArea('Platform')
    const child = await makeArea('Billing')
    await parseHandlerResult(updateAreaTool({ area_id: child, parent_area_id: parent }, ctx))
    let areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; parent_area_id?: string | null }>
    expect(areas.find((x) => x.id === child)?.parent_area_id).toBe(parent)
    await parseHandlerResult(updateAreaTool({ area_id: child, parent_area_id: null }, ctx))
    areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; parent_area_id?: string | null }>
    // Un-nested: the canonical serializer drops a null parent_area_id, so absent === top-level.
    expect(areas.find((x) => x.id === child)?.parent_area_id ?? null).toBeNull()
  })

  it('#7 update_area rejects a re-parent cycle', async () => {
    const a = await makeArea('A')
    const b = await makeArea('B')
    await parseHandlerResult(updateAreaTool({ area_id: b, parent_area_id: a }, ctx))
    const r = await parseHandlerResult(updateAreaTool({ area_id: a, parent_area_id: b }, ctx))
    expect(r.isError).toBe(true)
    expect(r.error).toMatch(/cycle/i)
  })

  it('#7 update_area errors on unknown area and unknown parent', async () => {
    const id = await makeArea('Solo')
    const r1 = await parseHandlerResult(updateAreaTool({ area_id: 'n_nope', title: 'x' }, ctx))
    expect(r1.isError).toBe(true)
    const r2 = await parseHandlerResult(updateAreaTool({ area_id: id, parent_area_id: 'n_missing' }, ctx))
    expect(r2.isError).toBe(true)
    expect(r2.error).toMatch(/parent area not found/i)
  })

  // #8 remove / detach / delete / move
  it('#8 remove_product_from_area removes membership and is idempotent', async () => {
    const id = await makeArea('Platform')
    await parseHandlerResult(assignProductToAreaTool({ product_id: 'p_test', area_id: id }, ctx))
    const r1 = await parseHandlerResult(removeProductFromAreaTool({ product_id: 'p_test', area_id: id }, ctx))
    expect((r1.body as { removed?: boolean }).removed).toBe(true)
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; products?: string[] }>
    expect(areas.find((a) => a.id === id)?.products ?? []).not.toContain('p_test')
    const r2 = await parseHandlerResult(removeProductFromAreaTool({ product_id: 'p_test', area_id: id }, ctx))
    expect((r2.body as { removed?: boolean }).removed).toBe(false)
  })

  it('#8 detach_product_from_portfolio removes from portfolio.products[]', async () => {
    await parseHandlerResult(createNode({ type: 'portfolio', title: 'Bets' }, ctx))
    const pid = (readPortfolio(cwd)?.portfolios as Array<{ id: string }>)[0].id
    await parseHandlerResult(attachProductToPortfolioTool({ product_id: 'p_test', portfolio_id: pid }, ctx))
    const r = await parseHandlerResult(detachProductFromPortfolioTool({ product_id: 'p_test', portfolio_id: pid }, ctx))
    expect((r.body as { removed?: boolean }).removed).toBe(true)
    const pf = readPortfolio(cwd)?.portfolios as Array<{ id: string; products?: string[] }>
    expect(pf[0].products ?? []).not.toContain('p_test')
  })

  it('#8 delete_area is guarded, but force deletes and un-nests children', async () => {
    const parent = await makeArea('Platform')
    const child = await makeArea('Billing')
    await parseHandlerResult(updateAreaTool({ area_id: child, parent_area_id: parent }, ctx))
    await parseHandlerResult(assignProductToAreaTool({ product_id: 'p_test', area_id: parent }, ctx))
    const guarded = await parseHandlerResult(deleteAreaTool({ area_id: parent }, ctx))
    expect(guarded.isError).toBe(true)
    expect(guarded.error).toMatch(/still has/i)
    const forced = await parseHandlerResult(deleteAreaTool({ area_id: parent, force: true }, ctx))
    expect(forced.isError).toBeUndefined()
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; parent_area_id?: string | null }>
    expect(areas.find((a) => a.id === parent)).toBeUndefined()
    // Child un-nested; null parent_area_id is dropped on serialize, so absent === top-level.
    expect(areas.find((a) => a.id === child)?.parent_area_id ?? null).toBeNull()
  })

  it('#8 move_product_to_area moves between areas', async () => {
    const a = await makeArea('A')
    const b = await makeArea('B')
    await parseHandlerResult(assignProductToAreaTool({ product_id: 'p_test', area_id: a }, ctx))
    const r = await parseHandlerResult(moveProductToAreaTool({ product_id: 'p_test', to_area_id: b }, ctx))
    expect(r.isError).toBeUndefined()
    const areas = readPortfolio(cwd)?.product_areas as Array<{ id: string; products?: string[] }>
    expect(areas.find((x) => x.id === a)?.products ?? []).not.toContain('p_test')
    expect(areas.find((x) => x.id === b)?.products).toContain('p_test')
  })

  // #10 batch + #8 delete_cross_product_edge
  it('#10 batch_create_cross_product_edges writes many atomically (incl. hosts); #8 delete removes one', async () => {
    const res = await parseHandlerResult(
      batchCreateCrossProductEdges(
        {
          auto_create_portfolio: true,
          edges: [
            { source_id: 'p_a/n1', target_id: 'p_b/n2', type: 'hosts' },
            { source_id: 'p_a/n3', target_id: 'p_c/n4', type: 'depends_on_product' },
          ],
        },
        ctx,
      ),
    )
    expect(res.isError).toBeUndefined()
    expect((res.body as { count?: number }).count).toBe(2)
    const list = await parseHandlerResult(listPortfolioCrossEdges({}, ctx))
    const edges = (list.body as { cross_edges: Array<{ id: string; type: string }> }).cross_edges
    expect(edges).toHaveLength(2)
    expect(edges.some((e) => e.type === 'hosts')).toBe(true)
    const del = await parseHandlerResult(deleteCrossProductEdgeTool({ edge_id: edges[0].id }, ctx))
    expect((del.body as { deleted?: boolean }).deleted).toBe(true)
    const after = await parseHandlerResult(listPortfolioCrossEdges({}, ctx))
    expect((after.body as { cross_edges: unknown[] }).cross_edges).toHaveLength(1)
  })

  it('#10 batch_create_cross_product_edges rejects the whole batch on one invalid edge (atomic)', async () => {
    const res = await parseHandlerResult(
      batchCreateCrossProductEdges(
        {
          auto_create_portfolio: true,
          edges: [
            { source_id: 'p_a/n1', target_id: 'p_b/n2', type: 'hosts' },
            { source_id: 'p_a/n3', target_id: 'p_c/n4', type: 'not_a_type' },
          ],
        },
        ctx,
      ),
    )
    expect(res.isError).toBe(true)
    expect(res.error).toMatch(/invalid cross-product edge type/i)
    const list = await parseHandlerResult(listPortfolioCrossEdges({}, ctx))
    expect((list.body as { cross_edges: unknown[] }).cross_edges).toHaveLength(0)
  })

  // #11a / #11b
  it('#11b create_product seeds a product node; #11a list_local_products returns id + membership and skips portfolio.upg', async () => {
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify(
        { version: '1', default_product: 'product.upg', products: [{ file: 'product.upg', title: 'Test Product' }] },
        null,
        2,
      ),
    )
    const created = await parseHandlerResult(createProductTool({ name: 'Studio', stage: 'build' }, ctx))
    expect(created.isError).toBeUndefined()
    const newId = (created.body as { id: string }).id
    const newFile = (created.body as { file: string }).file
    // #11b: the new product graph carries a seeded product node anchored to $upg.product.id
    const doc = JSON.parse(readFileSync(join(cwd, '.upg', newFile), 'utf-8')) as {
      nodes: Array<{ id: string; type: string; properties?: { stage?: string } }>
    }
    const pn = doc.nodes.find((n) => n.type === 'product')
    expect(pn).toBeDefined()
    expect(pn?.id).toBe(newId)
    expect(pn?.properties?.stage).toBe('build')

    // #11a: id + area membership surfaced; portfolio.upg excluded from the product list
    const areaId = await makeArea('Apps')
    await parseHandlerResult(assignProductToAreaTool({ product_id: newId, area_id: areaId }, ctx))
    const list = await parseHandlerResult(listLocalProducts({}, ctx))
    const products = (list.body as {
      products: Array<{ id: string | null; file: string; title: string; areas?: string[] }>
    }).products
    expect(products.every((p) => !p.file.endsWith('portfolio.upg'))).toBe(true)
    const studio = products.find((p) => p.id === newId)
    expect(studio).toBeDefined()
    expect(studio?.areas).toContain('Apps')
  })
})
