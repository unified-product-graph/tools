/**
 * validate_graph parity-divergence advisory (spec issue #38, UPG 0.10.1).
 *
 * The feature_rivals_competitor_feature edge is authoritative for parity; the
 * competitor_feature node's parity_status is a denormalised single-rival cache.
 * When a competitor_feature has exactly one inbound rivalry edge and the cached
 * value disagrees with the edge, validate_graph surfaces it (advisory; never
 * flips valid). With zero or multiple rivals the cache case does not apply.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import { validateGraph } from '../tools/validation.js'
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
  const r = (await Promise.resolve(result)) as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>
}

function docWith(edges: Array<Record<string, unknown>>, cfParity?: string): UPGDocument {
  return {
    upg_version: '0.10.1',
    exported_at: '2026-06-13T00:00:00Z',
    source: { tool: 'test' },
    product: { id: 'p_root', title: 'Root', stage: 'concept' },
    nodes: [
      { id: 'n_feat', type: 'feature', title: 'Our Feature' },
      { id: 'n_feat2', type: 'feature', title: 'Our Feature 2' },
      {
        id: 'n_cf',
        type: 'competitor_feature',
        title: 'Their Feature',
        ...(cfParity ? { properties: { parity_status: cfParity } } : {}),
      },
    ],
    edges,
  } as unknown as UPGDocument
}

async function loadStore(cwd: string, d: UPGDocument): Promise<UPGFileStore> {
  writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(d, null, 2))
  const store = new UPGFileStore()
  await store.load(join(cwd, '.upg', 'root.upg'))
  store.stopWatching()
  return store
}

describe('#38 validate_graph parity divergence', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore | undefined

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-div-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    store?.stopWatching()
    store = undefined
    rmSync(cwd, { recursive: true, force: true })
  })

  it('flags a single-rival cache that disagrees with the edge', async () => {
    store = await loadStore(
      cwd,
      docWith(
        [{ id: 'e_riv', source: 'n_feat', target: 'n_cf', type: 'feature_rivals_competitor_feature', properties: { parity_status: 'parity' } }],
        'behind',
      ),
    )
    const body = await parse(validateGraph({}, makeCtx(store)))
    const div = body.parity_divergence as Array<Record<string, unknown>> | undefined
    expect(div).toBeTruthy()
    expect(div!).toHaveLength(1)
    expect(div![0]).toMatchObject({
      competitor_feature_id: 'n_cf',
      feature_id: 'n_feat',
      edge_id: 'e_riv',
      node_parity_status: 'behind',
      edge_parity_status: 'parity',
    })
    expect((body.summary as Record<string, unknown>).parity_divergence).toBe(1)
  })

  it('is silent when the cache agrees with the edge', async () => {
    store = await loadStore(
      cwd,
      docWith(
        [{ id: 'e_riv', source: 'n_feat', target: 'n_cf', type: 'feature_rivals_competitor_feature', properties: { parity_status: 'behind' } }],
        'behind',
      ),
    )
    const body = await parse(validateGraph({}, makeCtx(store)))
    expect(body.parity_divergence).toBeUndefined()
    expect((body.summary as Record<string, unknown>).parity_divergence).toBeUndefined()
  })

  it('does not flag when more than one rival edge targets the competitor_feature', async () => {
    store = await loadStore(
      cwd,
      docWith(
        [
          { id: 'e_riv1', source: 'n_feat', target: 'n_cf', type: 'feature_rivals_competitor_feature', properties: { parity_status: 'parity' } },
          { id: 'e_riv2', source: 'n_feat2', target: 'n_cf', type: 'feature_rivals_competitor_feature', properties: { parity_status: 'ahead' } },
        ],
        'behind',
      ),
    )
    const body = await parse(validateGraph({}, makeCtx(store)))
    expect(body.parity_divergence).toBeUndefined()
  })
})
