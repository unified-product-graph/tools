/**
 * update_product file rename (0.17.2, A-bonus).
 *
 * Renaming a product can now move the .upg file to match the title slug. The
 * careful part is the OPEN FILE HANDLE: after the move, the store must write to
 * the new path, not the old. This exercises the full reconcile — file on disk,
 * open handle, workspace.json file path, portfolio.upg file_path — including a
 * rename while the product is the active/open one, plus collision handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { updateProductTool } from '../tools/workspace.js'
import { createNode } from '../tools/nodes.js'
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

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))

describe('update_product file rename (0.17.2)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-rename-'))
    mkdirSync(join(cwd, '.upg'))
    const rootDoc = {
      upg_version: '0.17.1',
      exported_at: '2026-06-30T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Old Name', stage: 'concept' },
      nodes: [{ id: 'p_root', type: 'product', title: 'Old Name' }],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'old-name.upg'), JSON.stringify(rootDoc, null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'old-name.upg', products: [{ file: 'old-name.upg', title: 'Old Name' }] }, null, 2),
    )
    writeFileSync(
      join(cwd, '.upg', 'portfolio.upg'),
      JSON.stringify({ type: 'portfolio', organization: { id: 'org_x', title: 'Org' }, portfolios: [], products: [{ id: 'p_root', title: 'Old Name', file_path: '.upg/old-name.upg' }], cross_edges: [] }, null, 2),
    )
    process.chdir(cwd)
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'old-name.upg'))
    store.stopWatching()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('renames the file to the new title slug and reconciles every reference', async () => {
    const ctx = makeCtx(store)
    const res = await parse(updateProductTool({ title: 'Brand New Name', rename_file: true }, ctx))
    expect(res.isError).toBeFalsy()
    expect((res.body?.updated as string[]) ?? []).toContain('file')
    expect((res.body?.renamed as { to: string }).to).toBe('brand-new-name.upg')

    // File moved on disk: new exists, old gone.
    expect(existsSync(join(cwd, '.upg', 'brand-new-name.upg'))).toBe(true)
    expect(existsSync(join(cwd, '.upg', 'old-name.upg'))).toBe(false)

    // New file carries the new title.
    expect(readJson(join(cwd, '.upg', 'brand-new-name.upg')).$upg.product.title).toBe('Brand New Name')

    // workspace.json points at the new file with the new title.
    const ws = readJson(join(cwd, '.upg', 'workspace.json'))
    expect(ws.products.find((p: { file: string }) => p.file === 'brand-new-name.upg')).toBeTruthy()
    expect(ws.products.some((p: { file: string }) => p.file === 'old-name.upg')).toBe(false)

    // portfolio.upg file_path repointed.
    const pf = readJson(join(cwd, '.upg', 'portfolio.upg'))
    expect(pf.products.find((p: { id: string }) => p.id === 'p_root').file_path).toBe('.upg/brand-new-name.upg')
  })

  it('keeps the open handle valid: a write after the rename lands in the new file', async () => {
    const ctx = makeCtx(store)
    await parse(updateProductTool({ title: 'Renamed Live', rename_file: true }, ctx))
    // The store was rebound mid-session; a subsequent mutation must flush to the
    // new path, not resurrect the old file.
    await parse(createNode({ type: 'persona', title: 'Added After Rename' }, ctx))
    await store.flush()
    expect(existsSync(join(cwd, '.upg', 'old-name.upg'))).toBe(false)
    const graph = readJson(join(cwd, '.upg', 'renamed-live.upg'))
    expect(graph.nodes.some((n: { title: string }) => n.title === 'Added After Rename')).toBe(true)
  })

  it('accepts an explicit slug (implies rename) independent of the title', async () => {
    const ctx = makeCtx(store)
    const res = await parse(updateProductTool({ slug: 'custom-slug' }, ctx))
    expect((res.body?.renamed as { slug: string }).slug).toBe('custom-slug')
    expect(existsSync(join(cwd, '.upg', 'custom-slug.upg'))).toBe(true)
  })

  it('is a no-op when the slug is unchanged (no renamed field)', async () => {
    const ctx = makeCtx(store)
    const res = await parse(updateProductTool({ title: 'Old Name', rename_file: true }, ctx))
    // title unchanged value but a field still counts as updated; the slug resolves
    // back to old-name, so no file move happens.
    expect(res.body?.renamed).toBeUndefined()
    expect(existsSync(join(cwd, '.upg', 'old-name.upg'))).toBe(true)
  })

  it('never clobbers a sibling on a slug collision', async () => {
    // A sibling product already owns "taken.upg".
    const siblingDoc = { upg_version: '0.17.1', exported_at: '2026-06-30T00:00:00Z', source: { tool: 'test' }, product: { id: 'p_sib', title: 'Taken', stage: 'concept' }, nodes: [], edges: [] }
    writeFileSync(join(cwd, '.upg', 'taken.upg'), JSON.stringify(siblingDoc, null, 2))
    const before = readJson(join(cwd, '.upg', 'taken.upg'))

    const res = await parse(updateProductTool({ slug: 'taken' }, makeCtx(store)))
    const to = (res.body?.renamed as { to: string }).to
    // Our file gets a collision-suffixed slug; the sibling is untouched.
    expect(to).not.toBe('taken.upg')
    expect(readJson(join(cwd, '.upg', 'taken.upg'))).toEqual(before)
    expect(existsSync(join(cwd, '.upg', to))).toBe(true)
    expect(existsSync(join(cwd, '.upg', 'old-name.upg'))).toBe(false)
  })
})
