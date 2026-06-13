/**
 * create_parity_edge typed writer (spec issue #38 fast-follow, UPG 0.10.1).
 *
 * Fixes the edge type to feature_rivals_competitor_feature, validates the parity
 * enums, derives is_gap from parity_status, and routes within-graph
 * (create_edge) vs cross-product (create_cross_product_edge, our side defaulting
 * to the active product).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import { createParityEdge } from '../tools/workspace.js'
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

function doc(): UPGDocument {
  return {
    upg_version: '0.10.1',
    exported_at: '2026-06-13T00:00:00Z',
    source: { tool: 'test' },
    product: { id: 'p_root', title: 'Root', stage: 'concept' },
    nodes: [
      { id: 'n_feat', type: 'feature', title: 'Our Feature' },
      { id: 'n_comp', type: 'competitor', title: 'Rival Inc' },
      { id: 'n_cf', type: 'competitor_feature', title: 'Their Feature' },
    ],
    edges: [],
  } as unknown as UPGDocument
}

describe('#38 create_parity_edge', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-parity-'))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc(), null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'root.upg', products: [{ file: 'root.upg', title: 'Root' }] }, null, 2),
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

  it('writes a within-graph rivalry edge with derived is_gap', async () => {
    const res = await parse(
      createParityEdge({ feature_id: 'n_feat', competitor_feature_id: 'n_cf', parity_status: 'behind' }, makeCtx(store)),
    )
    expect(res.isError).toBeFalsy()
    const edge = store.getAllEdges().find((e) => e.type === 'feature_rivals_competitor_feature')
    expect(edge).toBeTruthy()
    expect(edge!.source).toBe('n_feat')
    expect(edge!.target).toBe('n_cf')
    const props = (edge as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props.parity_status).toBe('behind')
    expect(props.is_gap).toBe(true) // behind => gap
  })

  it('honours an explicit is_gap override and passes through quality / confidence', async () => {
    await parse(
      createParityEdge(
        { feature_id: 'n_feat', competitor_feature_id: 'n_cf', parity_status: 'parity', is_gap: true, quality: 'same', confidence: 'high' },
        makeCtx(store),
      ),
    )
    const edge = store.getAllEdges().find((e) => e.type === 'feature_rivals_competitor_feature')!
    const props = (edge as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props.is_gap).toBe(true)
    expect(props.parity_status).toBe('parity')
    expect(props.quality).toBe('same')
    expect(props.confidence).toBe('high')
  })

  it('rejects an invalid parity_status / quality / confidence', async () => {
    const ctx = makeCtx(store)
    expect((await parse(createParityEdge({ feature_id: 'n_feat', competitor_feature_id: 'n_cf', parity_status: 'bogus' }, ctx))).isError).toBe(true)
    expect((await parse(createParityEdge({ feature_id: 'n_feat', competitor_feature_id: 'n_cf', parity_status: 'behind', quality: 'nope' }, ctx))).isError).toBe(true)
    expect((await parse(createParityEdge({ feature_id: 'n_feat', competitor_feature_id: 'n_cf', parity_status: 'behind', confidence: 'maybe' }, ctx))).isError).toBe(true)
  })

  it('requires feature_id, competitor_feature_id, and parity_status', async () => {
    const ctx = makeCtx(store)
    expect((await parse(createParityEdge({ competitor_feature_id: 'n_cf', parity_status: 'behind' }, ctx))).isError).toBe(true)
    expect((await parse(createParityEdge({ feature_id: 'n_feat', parity_status: 'behind' }, ctx))).isError).toBe(true)
    expect((await parse(createParityEdge({ feature_id: 'n_feat', competitor_feature_id: 'n_cf' }, ctx))).isError).toBe(true)
  })

  it('routes to a cross-product edge for a qualified competitor_feature, defaulting our side to the active product', async () => {
    const res = await parse(
      createParityEdge(
        { feature_id: 'n_feat', competitor_feature_id: 'p_watch/n_cf2', parity_status: 'behind', auto_create_portfolio: true },
        makeCtx(store),
      ),
    )
    expect(res.isError).toBeFalsy()
    // The within-graph store must be untouched.
    expect(store.getAllEdges().find((e) => e.type === 'feature_rivals_competitor_feature')).toBeUndefined()
    // The cross-edge is persisted in portfolio.upg with the active product as source.
    const portfolio = JSON.parse(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
    const crossEdges = (portfolio.cross_edges ?? []) as Array<Record<string, unknown>>
    const parity = crossEdges.find((e) => e.type === 'feature_rivals_competitor_feature')
    expect(parity).toBeTruthy()
    expect(parity!.source).toBe('p_root/n_feat')
    expect(parity!.target).toBe('p_watch/n_cf2')
    expect((parity!.properties as Record<string, unknown>).parity_status).toBe('behind')
    expect((parity!.properties as Record<string, unknown>).is_gap).toBe(true)
  })
})
