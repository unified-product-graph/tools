/**
 * Subpath-aware discovery + create_product({ dir }) (spec issue #44, UPG 0.9.27).
 *
 * find_workspace discovery scans the .upg root plus one subdirectory level, so a
 * graph nested deeper (competitors/<slug>/<slug>.upg) was reachable by explicit
 * path but invisible to enumeration. #44 makes discovery registry-driven: any
 * workspace.json-registered subpath is discovered at any depth, and
 * create_product gains a `dir` so a watched portfolio defaults its graphs into
 * competitors/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createProductTool, findWorkspaceUpgFiles } from '../tools/workspace.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  const text = r.content[0]?.text ?? ''
  let body: Record<string, unknown> | undefined
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { isError: r.isError, text, body }
}

describe('#44 subpath discovery + create_product({ dir })', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-44-'))
    mkdirSync(join(cwd, '.upg'))
    const rootDoc = {
      upg_version: '0.9.27',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Root', stage: 'concept' },
      nodes: [],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(rootDoc, null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'root.upg', products: [{ file: 'root.upg', title: 'Root' }] }, null, 2),
    )
    process.chdir(cwd)
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes into the subfolder, registers the subpath, and stays discoverable', async () => {
    const res = await parse(createProductTool({ name: 'Contentful', dir: 'competitors' }, ctx))
    expect(res.isError).toBeFalsy()
    expect(res.body?.file).toBe('competitors/contentful.upg')
    expect(existsSync(join(cwd, '.upg', 'competitors', 'contentful.upg'))).toBe(true)

    const ws = JSON.parse(readFileSync(join(cwd, '.upg', 'workspace.json'), 'utf-8'))
    expect((ws.products as Array<{ file: string }>).some((p) => p.file === 'competitors/contentful.upg')).toBe(true)

    // The filesystem scan reaches only one level into .upg/, so this is found
    // via the registry-driven half of discovery.
    const found = findWorkspaceUpgFiles(cwd)
    expect(found.some((f) => f.endsWith('competitors/contentful.upg'))).toBe(true)
  })

  it('rejects a dir that escapes .upg/', async () => {
    const res = await parse(createProductTool({ name: 'Evil', dir: '../escape' }, ctx))
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/relative path inside/i)
  })

  it('discovers a registered two-level subpath (deeper than the filesystem scan)', () => {
    mkdirSync(join(cwd, '.upg', 'competitors', 'stripe'), { recursive: true })
    writeFileSync(
      join(cwd, '.upg', 'competitors', 'stripe', 'stripe.upg'),
      JSON.stringify({ product: { id: 'p_stripe', title: 'Stripe' }, nodes: [], edges: [] }),
    )
    const ws = JSON.parse(readFileSync(join(cwd, '.upg', 'workspace.json'), 'utf-8'))
    ws.products.push({ file: 'competitors/stripe/stripe.upg', title: 'Stripe' })
    writeFileSync(join(cwd, '.upg', 'workspace.json'), JSON.stringify(ws, null, 2))

    const found = findWorkspaceUpgFiles(cwd)
    expect(found.some((f) => f.endsWith('competitors/stripe/stripe.upg'))).toBe(true)
  })
})
