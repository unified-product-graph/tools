/**
 * update_product member_kind setter (spec brief member-kind-setter, UPG 0.10.1).
 *
 * 0.10.0 could only set member_kind at create_product time. This completes the
 * write surface: update_product re-kinds an existing graph, the full three-place
 * write — the graph's $upg.member_kind (integrity resealed), the workspace.json
 * cache (so list_local_products reflects it), and the portfolio.upg registry (so
 * counts.products and the watched anti-pattern scoping reflect it). Acceptance
 * criteria 1, 3, 4, 5 from the brief.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { updateProductTool, listLocalProducts } from '../tools/workspace.js'
import { getProductContext } from '../tools/context.js'
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

function readJson(p: string) {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

describe('update_product member_kind (0.10.1)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-rekind-'))
    mkdirSync(join(cwd, '.upg'))
    const rootDoc = {
      upg_version: '0.10.1',
      exported_at: '2026-06-13T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Root', stage: 'concept' },
      nodes: [{ id: 'p_root', type: 'product', title: 'Root' }],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(rootDoc, null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'root.upg', products: [{ file: 'root.upg', title: 'Root' }] }, null, 2),
    )
    writeFileSync(
      join(cwd, '.upg', 'portfolio.upg'),
      JSON.stringify({ type: 'portfolio', organization: { id: 'org_x', title: 'Org' }, portfolios: [], products: [{ id: 'p_root', title: 'Root' }], cross_edges: [] }, null, 2),
    )
    process.chdir(cwd)
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('re-kinds across all three places: $upg, workspace.json, portfolio.upg', async () => {
    const ctx = makeCtx(store)
    const res = await parse(updateProductTool({ member_kind: 'watched' }, ctx))
    expect(res.isError).toBeFalsy()
    expect(res.body?.member_kind).toBe('watched')
    expect((res.body?.updated as string[]) ?? []).toContain('member_kind')

    // 1. the graph file (source of truth, integrity resealed by the flush)
    const graph = readJson(join(cwd, '.upg', 'root.upg'))
    expect(graph.$upg.member_kind).toBe('watched')
    expect(graph.$upg.integrity).toBeTruthy()

    // 2. workspace.json cache → list_local_products reflects it
    const ws = readJson(join(cwd, '.upg', 'workspace.json'))
    expect(ws.products.find((p: { file: string }) => p.file === 'root.upg').member_kind).toBe('watched')
    const list = await parse(listLocalProducts({}, ctx))
    const products = list.body?.products as Array<{ title: string; member_kind?: string }>
    expect(products.find((p) => p.title === 'Root')?.member_kind).toBe('watched')

    // 3. portfolio.upg registry → drives counts.products + watched scoping
    const portfolio = readJson(join(cwd, '.upg', 'portfolio.upg'))
    expect(portfolio.products.find((p: { id: string }) => p.id === 'p_root').member_kind).toBe('watched')
  })

  it('get_product_context surfaces member_kind', async () => {
    const ctx = makeCtx(store)
    await parse(updateProductTool({ member_kind: 'org_rollup' }, ctx))
    const out = await parse(getProductContext({}, ctx))
    expect(out.text).toContain('Member kind: org_rollup')
  })

  it('rejects an invalid member_kind, echoing the valid set', async () => {
    const res = await parse(updateProductTool({ member_kind: 'bogus' }, makeCtx(store)))
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/product/)
    expect(res.text).toMatch(/org_rollup/)
    expect(res.text).toMatch(/watched/)
  })

  it('re-kinding back to product clears the field everywhere', async () => {
    const ctx = makeCtx(store)
    await parse(updateProductTool({ member_kind: 'watched' }, ctx))
    const res = await parse(updateProductTool({ member_kind: 'product' }, ctx))
    expect(res.isError).toBeFalsy()

    expect(readJson(join(cwd, '.upg', 'root.upg')).$upg.member_kind).toBeUndefined()
    const ws = readJson(join(cwd, '.upg', 'workspace.json'))
    expect(ws.products.find((p: { file: string }) => p.file === 'root.upg').member_kind).toBeUndefined()
    const portfolio = readJson(join(cwd, '.upg', 'portfolio.upg'))
    expect(portfolio.products.find((p: { id: string }) => p.id === 'p_root').member_kind).toBeUndefined()
  })
})
