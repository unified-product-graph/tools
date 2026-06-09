/**
 * Tests for `init_workspace`: general workspace bootstrap.
 *
 * Each test runs against a real tmp directory so the fs choreography
 * (readdir filtering, rename, copyFile, mkdir) is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { readFileSync } from 'node:fs'
import {
  createProduct,
  initWorkspace,
  InvalidProductNameError,
  InvalidProductStageError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotInitialisedError,
} from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'

function makeDoc(title = 'Test Product'): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title, stage: 'concept' },
    nodes: [],
    edges: [],
  }
}

async function makeStoreAt(filePath: string, doc: UPGDocument = makeDoc()): Promise<UPGFileStore> {
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

describe('initWorkspace', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'upg-init-workspace-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('moves a single root-level .upg file into .upg/', async () => {
    const filePath = join(cwd, 'product.upg')
    const store = await makeStoreAt(filePath, makeDoc('My Product'))

    const result = await initWorkspace({ cwd, store })

    expect(result.products).toHaveLength(1)
    expect(result.products[0]).toEqual({ file: 'product.upg', title: 'My Product' })
    expect(existsSync(join(cwd, '.upg', 'product.upg'))).toBe(true)
    expect(existsSync(join(cwd, 'product.upg'))).toBe(false)
    expect(existsSync(join(cwd, '.upg', 'workspace.json'))).toBe(true)
  })

  // ── regression: directory-as-file bug ──────────────────────────────

  it('does not try to rename the .upg directory into itself when no root files exist', async () => {
    // Set up: user has already organised their .upg file inside .upg/ (e.g.,
    // ran a different command earlier) but NEVER ran init_workspace, so
    // workspace.json doesn't exist yet.
    mkdirSync(join(cwd, '.upg'))
    const filePath = join(cwd, '.upg', 'product.upg')
    const store = await makeStoreAt(filePath, makeDoc('Already Inside'))

    // This should NOT throw EINVAL; the old code's readdir filter matched
    // the literal `.upg` directory entry and tried `rename('.upg', '.upg/.upg')`.
    const result = await initWorkspace({ cwd, store })

    expect(result.products).toHaveLength(1)
    expect(result.products[0]).toEqual({ file: 'product.upg', title: 'Already Inside' })
    expect(existsSync(join(cwd, '.upg', 'product.upg'))).toBe(true)
    expect(existsSync(join(cwd, '.upg', 'workspace.json'))).toBe(true)
  })

  it('discovers and registers .upg files already inside .upg/ alongside root files', async () => {
    // Mixed scenario: some files at root (need moving), some already in .upg/
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(
      join(cwd, '.upg', 'pre-existing.upg'),
      JSON.stringify(makeDoc('Pre-existing'), null, 2),
    )

    const rootFile = join(cwd, 'fresh.upg')
    const store = await makeStoreAt(rootFile, makeDoc('Fresh'))

    const result = await initWorkspace({ cwd, store })

    expect(result.products).toHaveLength(2)
    const titles = result.products.map((p) => p.title).sort()
    expect(titles).toEqual(['Fresh', 'Pre-existing'])
    expect(existsSync(join(cwd, '.upg', 'fresh.upg'))).toBe(true)
    expect(existsSync(join(cwd, '.upg', 'pre-existing.upg'))).toBe(true)
    expect(existsSync(join(cwd, 'fresh.upg'))).toBe(false)
  })

  it('does not clobber an existing .upg/<name> when the same name exists at root', async () => {
    // Edge case: user has both <cwd>/foo.upg and <cwd>/.upg/foo.upg (different
    // contents). Don't blow away the workspace copy.
    mkdirSync(join(cwd, '.upg'))
    const insidePath = join(cwd, '.upg', 'product.upg')
    writeFileSync(insidePath, JSON.stringify(makeDoc('Inside'), null, 2))

    const rootPath = join(cwd, 'product.upg')
    const store = await makeStoreAt(rootPath, makeDoc('Outside'))

    const result = await initWorkspace({ cwd, store })

    // Workspace registers the file once; the inside copy is preserved.
    expect(result.products).toHaveLength(1)
    expect(existsSync(insidePath)).toBe(true)
    // Root file is left in place (non-destructive default) since dest existed.
    expect(existsSync(rootPath)).toBe(true)
  })

  it('rejects with WorkspaceAlreadyExistsError when workspace.json already present', async () => {
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'workspace.json'), '{}')
    const filePath = join(cwd, 'product.upg')
    const store = await makeStoreAt(filePath)

    await expect(initWorkspace({ cwd, store })).rejects.toBeInstanceOf(
      WorkspaceAlreadyExistsError,
    )
  })

  it('seeds with the loaded store file when neither root nor .upg/ has any .upg files', async () => {
    // Store file is somewhere else entirely (e.g., user invoked the server
    // with --file pointing outside cwd). init_workspace should still seed.
    const externalDir = mkdtempSync(join(tmpdir(), 'upg-external-'))
    try {
      const externalFile = join(externalDir, 'remote.upg')
      const store = await makeStoreAt(externalFile, makeDoc('Remote'))

      const result = await initWorkspace({ cwd, store })

      expect(result.products).toHaveLength(1)
      expect(result.products[0].file).toBe('remote.upg')
      expect(existsSync(join(cwd, '.upg', 'remote.upg'))).toBe(true)
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  it('honours moveExisting: false (registers root files without moving them)', async () => {
    const filePath = join(cwd, 'product.upg')
    const store = await makeStoreAt(filePath, makeDoc('Stay Put'))

    const result = await initWorkspace({ cwd, store, moveExisting: false })

    // moveExisting:false means we do NOT scan root for files. Falls back to
    // seeding with the loaded store file.
    expect(result.products).toHaveLength(1)
    expect(existsSync(join(cwd, 'product.upg'))).toBe(true)
  })
})

// ── createProduct ──────────────────────────────────────────────────

describe('createProduct', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'upg-create-product-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  async function bootstrapWorkspace(title = 'First Product') {
    const filePath = join(cwd, 'first.upg')
    const store = await makeStoreAt(filePath, makeDoc(title))
    await initWorkspace({ cwd, store })
    return store
  }

  it('mints a canonical product id and writes a fresh .upg into the workspace', async () => {
    const store = await bootstrapWorkspace()

    const result = await createProduct({ cwd, store, name: 'Second Product' })

    expect(result.id).toMatch(/^p_[A-Za-z0-9_-]{16}$/)
    expect(result.slug).toBe('second-product')
    expect(result.file).toBe('second-product.upg')
    expect(existsSync(join(cwd, '.upg', 'second-product.upg'))).toBe(true)
  })

  it('stamps integrity on first write so the new file is tamper-detectable immediately', async () => {
    const store = await bootstrapWorkspace()
    const result = await createProduct({ cwd, store, name: 'Stamped Product' })

    // Canonical form: integrity lives in the `$upg` header as a
    // checksum of the canonical body, and provenance carries the writer tool.
    const raw = readFileSync(join(cwd, '.upg', result.file), 'utf-8')
    const doc = JSON.parse(raw) as { $upg?: { integrity?: { algorithm?: string; body?: string }; provenance?: { tool?: string }; format_version?: string } }
    expect(doc.$upg?.format_version).toBeDefined()
    expect(doc.$upg?.integrity?.algorithm).toBe('sha256-128')
    expect(doc.$upg?.integrity?.body).toMatch(/^[a-f0-9]{32}$/)
    expect(doc.$upg?.provenance?.tool).toBe('upg-mcp-local')
  })

  it('appends to workspace.json so the new product is immediately listable', async () => {
    const store = await bootstrapWorkspace()
    await createProduct({ cwd, store, name: 'Appended' })

    const ws = JSON.parse(
      readFileSync(join(cwd, '.upg', 'workspace.json'), 'utf-8'),
    ) as { products: Array<{ file: string; title: string }> }
    expect(ws.products).toHaveLength(2)
    expect(ws.products.map((p) => p.title)).toContain('Appended')
  })

  it('resolves slug collisions by appending -2, -3, ...', async () => {
    const store = await bootstrapWorkspace()
    const a = await createProduct({ cwd, store, name: 'Same Name' })
    const b = await createProduct({ cwd, store, name: 'Same Name' })

    expect(a.slug).toBe('same-name')
    expect(b.slug).toBe('same-name-2')
    expect(existsSync(join(cwd, '.upg', 'same-name.upg'))).toBe(true)
    expect(existsSync(join(cwd, '.upg', 'same-name-2.upg'))).toBe(true)
  })

  it('honours an explicit slug override', async () => {
    const store = await bootstrapWorkspace()
    const result = await createProduct({
      cwd,
      store,
      name: 'Display Title with Spaces',
      slug: 'short-handle',
    })
    expect(result.slug).toBe('short-handle')
    expect(result.file).toBe('short-handle.upg')
  })

  it('rejects an empty or whitespace-only name', async () => {
    const store = await bootstrapWorkspace()
    await expect(
      createProduct({ cwd, store, name: '' }),
    ).rejects.toBeInstanceOf(InvalidProductNameError)
    await expect(
      createProduct({ cwd, store, name: '   ' }),
    ).rejects.toBeInstanceOf(InvalidProductNameError)
  })

  // ──: strict stage validation on the write path ──────────────────

  it('Rejects a non-canonical legacy stage value with a coercion hint', async () => {
    const store = await bootstrapWorkspace()
    await expect(
      // `discovery` is a known legacy alias; write path must reject and
      // point the caller at the canonical `validation` value.
      createProduct({ cwd, store, name: 'Stage Test', stage: 'discovery' as never }),
    ).rejects.toBeInstanceOf(InvalidProductStageError)

    try {
      await createProduct({ cwd, store, name: 'Stage Test 2', stage: 'idea' as never })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductStageError)
      // Error message must surface the canonical target so the caller can fix it.
      expect((err as Error).message).toContain('"concept"')
    }
  })

  it('Rejects a truly unknown stage value listing the canonical set', async () => {
    const store = await bootstrapWorkspace()
    try {
      await createProduct({ cwd, store, name: 'Unknown Stage', stage: 'xyz' as never })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductStageError)
      expect((err as Error).message).toContain('concept')
      expect((err as Error).message).toContain('sunset')
    }
  })

  it('Accepts every canonical UPGProductStage value', async () => {
    const store = await bootstrapWorkspace()
    const stages = ['concept', 'validation', 'build', 'beta', 'launch', 'growth', 'mature', 'maintenance', 'sunset'] as const
    for (let i = 0; i < stages.length; i++) {
      const r = await createProduct({ cwd, store, name: `Stage ${i}`, stage: stages[i] })
      expect(r.id).toMatch(/^p_/)
    }
  })

  it('rejects when the workspace is not initialised', async () => {
    // No bootstrapWorkspace: workspace.json absent
    const filePath = join(cwd, 'lone.upg')
    const store = await makeStoreAt(filePath, makeDoc())

    await expect(
      createProduct({ cwd, store, name: 'Anything' }),
    ).rejects.toBeInstanceOf(WorkspaceNotInitialisedError)
  })

  it('attaches the new product to a portfolio in the current store', async () => {
    const store = await bootstrapWorkspace()
    // Add a portfolio node to the current store
    const portfolioId = 'n_portfolio_1'
    store.addNode({
      id: portfolioId,
      type: 'portfolio',
      title: 'Q4 Portfolio',
    })

    const result = await createProduct({
      cwd,
      store,
      name: 'Portfolio Member',
      portfolio_id: portfolioId,
    })

    expect(result.portfolio_attached).toBe(true)
    // The new product should appear as a node in the current store
    expect(store.getNode(result.id)).toBeDefined()
    // And there should be a portfolio_contains_product edge
    const edges = store.getAllEdges().filter(
      (e) => e.source === portfolioId && e.target === result.id,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].type).toBe('portfolio_contains_product')
  })

  it('does not attach to a non-portfolio node (silently skips with portfolio_attached: false)', async () => {
    const store = await bootstrapWorkspace()
    const personaId = 'n_persona_1'
    store.addNode({ id: personaId, type: 'persona', title: 'Dev' })

    const result = await createProduct({
      cwd,
      store,
      name: 'Wrong Parent',
      portfolio_id: personaId,
    })

    expect(result.portfolio_attached).toBe(false)
    expect(
      store.getAllEdges().filter((e) => e.target === result.id),
    ).toHaveLength(0)
  })

  it('registers the new product on portfolio.upg.products[] when a portfolio exists', async () => {
    const store = await bootstrapWorkspace()
    // Stand up a portfolio document alongside the workspace.
    const { UPGPortfolioStore } = await import('@unified-product-graph/sdk')
    const portfolioPath = join(cwd, '.upg', 'portfolio.upg')
    const pstore = new UPGPortfolioStore()
    await pstore.loadOrInit(portfolioPath)
    await pstore.flush()

    const result = await createProduct({ cwd, store, name: 'Sanity Studio' })

    // The portfolio registry — and its serialiser-derived $upg.counts.products —
    // must now track the product, not just workspace.json.
    const pdoc = JSON.parse(readFileSync(portfolioPath, 'utf-8')) as {
      $upg?: { counts?: { products?: number } }
      products?: Array<{ id: string; title?: string; file_path?: string }>
    }
    expect(pdoc.products?.some((p) => p.id === result.id && p.title === 'Sanity Studio')).toBe(true)
    expect(pdoc.$upg?.counts?.products).toBe(1)
  })

  it('createProduct leaves no portfolio registry behind when no portfolio.upg exists', async () => {
    const store = await bootstrapWorkspace()
    const result = await createProduct({ cwd, store, name: 'No Portfolio' })
    // No portfolio document in the workspace → nothing to register, and we must
    // not fabricate one.
    expect(existsSync(join(cwd, '.upg', 'portfolio.upg'))).toBe(false)
    expect(result.id).toMatch(/^p_/)
  })
})
