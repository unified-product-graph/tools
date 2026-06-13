/**
 * Workspace member_kind end-to-end (spec issue #45, UPG 0.10.0).
 *
 * create_product({ member_kind }) stamps the new graph's $upg.member_kind
 * (source of truth) and caches it in workspace.json; list_local_products labels
 * it; classifyProductKind treats a registry member tagged 'watched' as watched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createProductTool, listLocalProducts } from '../tools/workspace.js'
import { classifyProductKind } from '../lib/portfolio-kind.js'
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

describe('#45 create_product member_kind', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-45-'))
    mkdirSync(join(cwd, '.upg'))
    const rootDoc = {
      upg_version: '0.10.0',
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
  })

  afterEach(() => {
    process.chdir(originalCwd)
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('stamps $upg.member_kind, caches it in workspace.json, and labels the listing', async () => {
    const ctx = makeCtx(store)
    const res = await parse(createProductTool({ name: 'Contentful', member_kind: 'watched', dir: 'competitors' }, ctx))
    expect(res.isError).toBeFalsy()

    const graph = JSON.parse(readFileSync(join(cwd, '.upg', 'competitors', 'contentful.upg'), 'utf-8'))
    expect(graph.$upg.member_kind).toBe('watched')

    const ws = JSON.parse(readFileSync(join(cwd, '.upg', 'workspace.json'), 'utf-8'))
    const entry = (ws.products as Array<{ file: string; member_kind?: string }>).find(
      (p) => p.file === 'competitors/contentful.upg',
    )
    expect(entry?.member_kind).toBe('watched')

    const list = await parse(listLocalProducts({}, ctx))
    const products = list.body?.products as Array<{ title: string; member_kind?: string }>
    expect(products.find((p) => p.title === 'Contentful')?.member_kind).toBe('watched')
    expect(products.find((p) => p.title === 'Root')?.member_kind).toBe('product')
  })

  it('classifyProductKind treats a registry member_kind:watched as watched', () => {
    writeFileSync(
      join(cwd, '.upg', 'portfolio.upg'),
      JSON.stringify({
        type: 'portfolio',
        portfolios: [],
        products: [
          { id: 'p_owned', title: 'Owned' },
          { id: 'p_watch', title: 'Contentful', member_kind: 'watched' },
        ],
      }),
    )
    expect(classifyProductKind(cwd, 'p_watch')).toBe('watched')
    expect(classifyProductKind(cwd, 'p_owned')).toBe('owned')
  })
})
