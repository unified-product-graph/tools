/**
 * deduplicate_nodes structural-edge preservation (batch-write report, secondary
 * bug). Merging duplicate nodes used to redirect inbound edges best-effort and
 * then cascade-remove the originals, so a kept node could lose its inbound
 * containment edge and vanish from the tree. This pins the fix: the keeper
 * retains every external inbound (parent) edge the group had.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
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
import { deduplicateNodes } from '../tools/nodes.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}
function bodyOf(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text)
}
const e = (id: string, source: string, target: string, type: string) => ({ id, source, target, type })

async function load(d: UPGDocument): Promise<UPGFileStore> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-dedupe-')))
  const fp = join(dir, 'test.upg')
  writeFileSync(fp, JSON.stringify(d, null, 2))
  const s = new UPGFileStore()
  await s.load(fp)
  s.stopWatching()
  return s
}

describe('deduplicate_nodes preserves structural edges', () => {
  let cleanup: string[] = []
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
    cleanup = []
  })

  it('the keeper retains its inbound containment edge after merging a duplicate', async () => {
    // A service serving two DUPLICATE api_endpoints (same title + type), each
    // with its own inbound service_serves_api_endpoint edge — the exact shape
    // the duplicate-delivery bug produced.
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'svc', type: 'service', title: 'Asset Service' },
        { id: 'ep_old', type: 'api_endpoint', title: 'GET /assets', properties: { created_at: '2026-06-01T00:00:00Z' } },
        { id: 'ep_new', type: 'api_endpoint', title: 'GET /assets', properties: { created_at: '2026-06-11T00:00:00Z' } },
      ],
      edges: [
        e('e1', 'svc', 'ep_old', 'service_serves_api_endpoint'),
        e('e2', 'svc', 'ep_new', 'service_serves_api_endpoint'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(deduplicateNodes({ dry_run: false, keep: 'newest' }, makeCtx(store)))

    expect(body.merged).toBe(true)
    expect(body.nodes_removed).toBe(1)
    // The fix's guarantee: no structural parent edge was lost.
    expect(body.structural_warnings).toBeUndefined()
    expect(body.edges_dropped).toBeUndefined()

    // Exactly one api_endpoint survives, keeping 'newest' (ep_new).
    const endpoints = store.getAllNodes().filter((n) => n.type === 'api_endpoint')
    expect(endpoints.map((n) => n.id)).toEqual(['ep_new'])

    // The keeper still has its inbound service_serves_api_endpoint edge — it did
    // NOT get orphaned from its service (the reported failure).
    const keeperInbound = store
      .getEdgesForNode('ep_new')
      .filter((ed) => ed.target === 'ep_new' && ed.type === 'service_serves_api_endpoint')
    expect(keeperInbound.length).toBe(1)
    expect(keeperInbound[0].source).toBe('svc')

    // And there is exactly one such edge (unioned, not multiplied or dropped).
    const allServes = store.getAllEdges().filter((ed) => ed.type === 'service_serves_api_endpoint')
    expect(allServes.length).toBe(1)
  })
})
