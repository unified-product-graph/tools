/**
 * 0.39.0 (B5) — a stale registry `file_path` is reported, and repairable.
 *
 * The field case: portfolio.upg registered `.upg/sanity-studio.upg` while the
 * graph lived at `products/sanity-studio.upg`. Discovery kept working because
 * workspace.json is authoritative, so nothing surfaced the mismatch; no tool
 * rewrote a registry file_path; and the document is integrity-hashed, so
 * hand-editing is forbidden. A wrong-but-harmless entry with no sanctioned
 * repair.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createDispatcher } from '../server.js'
import {
  createSessionContext, createQueryCache, readSyncState, writeSyncState,
  hashFile, syncFilePath, type ToolContext,
} from '../lib/server-context.js'

let dir: string
let prevCwd: string
let store: UPGFileStore
let dispatch: (n: string, a: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>

const productDoc = (id: string, title: string) => JSON.stringify({
  upg_version: '0.8.0', exported_at: new Date().toISOString(),
  source: { tool: 'test', tool_version: '0' },
  product: { id, title }, nodes: [], edges: [],
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'upg-b5-'))
  prevCwd = process.cwd()
  mkdirSync(join(dir, '.upg', 'products'), { recursive: true })
  // The graph lives in products/, exactly as the field case did.
  writeFileSync(join(dir, '.upg', 'products', 'studio.upg'), productDoc('p_studio', 'Studio'), 'utf-8')
  writeFileSync(join(dir, '.upg', 'workspace.json'), JSON.stringify({
    version: '1.0', default_product: 'products/studio.upg',
    products: [{ file: 'products/studio.upg', title: 'Studio' }],
  }, null, 2), 'utf-8')
  // The registry claims the OLD flat path.
  writeFileSync(join(dir, '.upg', 'portfolio.upg'), JSON.stringify({
    $upg: { format_version: '1.0.0', spec_version: '0.8.0', kind: 'portfolio',
      organization: { id: 'o_1', title: 'Org' } },
    organization: { id: 'o_1', title: 'Org' },
    product_areas: [], portfolios: [],
    products: [{ id: 'p_studio', title: 'Studio', file_path: '.upg/studio.upg', nodes: [], edges: [] }],
    cross_edges: [],
  }, null, 2), 'utf-8')
  process.chdir(dir)
  store = new UPGFileStore()
  await store.load(join(dir, '.upg', 'products', 'studio.upg'))
  const ctx: ToolContext = {
    store, sessionContext: createSessionContext(), queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    serverInfo: { name: 'test', version: '0' }, getClientInfo: () => undefined,
  }
  dispatch = createDispatcher(ctx).dispatch as typeof dispatch
})

afterEach(() => {
  process.chdir(prevCwd)
  store.stopWatching()
  rmSync(dir, { recursive: true, force: true })
})

const registry = () => JSON.parse(readFileSync(join(dir, '.upg', 'portfolio.upg'), 'utf-8')) as {
  products: Array<{ id: string; file_path: string }>
}

describe('B5 — registry_file_path_drift', () => {
  it('portfolio_validate reports the mismatch and names where the graph actually is', async () => {
    const r = await dispatch('portfolio_validate', {})
    const body = JSON.parse(r.content[0].text)
    expect(body.registry_file_path_drift, 'drift block missing').toBeDefined()
    const entry = body.registry_file_path_drift[0]
    expect(entry.registered_path).toBe('.upg/studio.upg')
    expect(entry.found_at).toContain('studio.upg')
    // The report carries the repair call, not just the complaint.
    expect(entry.reason).toContain('update_product')
  })

  it('update_product({file_path}) repairs the registry without moving the file', async () => {
    const r = await dispatch('update_product', { file_path: '.upg/products/studio.upg' })
    expect(r.isError).toBeFalsy()
    expect(registry().products[0].file_path).toBe('.upg/products/studio.upg')
    // The graph did not move.
    expect(() => readFileSync(join(dir, '.upg', 'products', 'studio.upg'))).not.toThrow()
  })

  it('after the repair, portfolio_validate is quiet', async () => {
    await dispatch('update_product', { file_path: '.upg/products/studio.upg' })
    const r = await dispatch('portfolio_validate', {})
    expect(JSON.parse(r.content[0].text).registry_file_path_drift).toBeUndefined()
  })

  it('refuses a file_path that resolves to nothing (never trade stale for broken)', async () => {
    const r = await dispatch('update_product', { file_path: '.upg/does-not-exist.upg' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('does not resolve to an existing file')
    // The stale entry is left exactly as it was, not half-written.
    expect(registry().products[0].file_path).toBe('.upg/studio.upg')
  })

  it('a correct registry produces no drift block at all', async () => {
    await dispatch('update_product', { file_path: '.upg/products/studio.upg' })
    const r = await dispatch('portfolio_validate', {})
    const body = JSON.parse(r.content[0].text)
    expect(body.registry_file_path_drift).toBeUndefined()
    // And the advisory nature holds: it never moved the verdict.
    expect(body.rollup).toBeDefined()
  })
})
