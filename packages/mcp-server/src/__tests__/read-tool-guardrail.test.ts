/**
 * Integration tests for the pre-flight payload-size guardrail on
 * the four affected read tools: list_nodes, get_nodes, get_area_graph, query.
 *
 * Synthesises a graph large enough to trip the hard limit and asserts each
 * handler refuses with a steering hint that mentions `query`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UPGDocument, UPGEdge, UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { getToolHandler } from '../lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeBigGraph(nodeCount: number, edgesPerNode: number): UPGDocument {
  const nodes: UPGBaseNode[] = []
  const edges: UPGEdge[] = []
  // One area node so get_area_graph has something to traverse from.
  nodes.push({
    id: 'area_main',
    type: 'product_area' as UPGEntityType,
    title: 'Main Area',
  })
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n_${i}`,
      type: 'persona' as UPGEntityType,
      title: `Persona ${i}, verbose title that costs bytes on the wire`,
      description:
        'A reasonably-long description so that per-node bytes match the estimator heuristic in real-world graphs.',
      tags: ['guardrail-fixture', 'large-graph', 'payload-test'],
    })
    if (i > 0) {
      edges.push({
        id: `e_area_${i}`,
        type: 'persona_pursues_job',
        source: 'area_main',
        target: `n_${i}`,
      } as UPGEdge)
    }
    for (let j = 1; j <= edgesPerNode && i + j < nodeCount; j++) {
      edges.push({
        id: `e_${i}_${i + j}`,
        type: 'persona_pursues_job',
        source: `n_${i}`,
        target: `n_${i + j}`,
      } as UPGEdge)
    }
  }
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Big Test Product', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-guardrail-'))
  const filePath = join(dir, 'test.upg')
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

describe('Read-tool payload guardrail', () => {
  let ctx: ToolContext

  beforeEach(async () => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
    const store = await loadStore(makeBigGraph(200, 3))
    ctx = makeCtx(store)
  })

  afterEach(() => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
  })

  it('list_nodes refuses a 200-node-with-edges read with a query hint', async () => {
    const handler = getToolHandler('list_nodes')!
    const result = await handler({ limit: 200, include_edges: true }, ctx)
    expect(result.isError).toBe(true)
    const msg = result.content[0].text
    expect(msg).toMatch(/query/)
    expect(msg).toMatch(/list_nodes/)
  })

  it('get_nodes refuses a 50-id batch when edges push it over the limit', async () => {
    // Squeeze the hard cap so a 50-id batch trips it. Without compact_edges,
    // the natural payload of 50 edge-heavy nodes is borderline; we lower the
    // ceiling to make the assertion deterministic.
    process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = '20000'
    const ids = Array.from({ length: 50 }, (_, i) => `n_${i}`)
    const handler = getToolHandler('get_nodes')!
    const result = await handler({ ids }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/query/)
  })

  it('get_area_graph refuses when traversal pulls in too many nodes', async () => {
    const handler = getToolHandler('get_area_graph')!
    const result = await handler({ area_id: 'area_main', depth: 5 }, ctx)
    expect(result.isError).toBe(true)
    const msg = result.content[0].text
    expect(msg).toMatch(/get_area_graph/)
    expect(msg).toMatch(/query/)
  })

  it('query refuses a wide BFS without projection', async () => {
    const handler = getToolHandler('query')!
    const result = await handler(
      { from: 'persona', depth: 3, limit: 1000, include: ['title', 'description', 'tags', 'properties'] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/query/)
  })

  it('query with a tight projection ships clean', async () => {
    const handler = getToolHandler('query')!
    const result = await handler(
      { from: 'persona', depth: 1, limit: 50, include: ['title'], edge_include: [] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.nodes.length).toBeGreaterThan(0)
    expect(body._warning).toBeUndefined()
  })

  it('surfaces degradation or warning between soft and hard limits', async () => {
    // Lower the soft limit so a small payload triggers the warn path.
    // may auto-degrade (truncate) and attach a `degraded` block; if
    // no stage applies the `_warning` fallback fires instead.
    process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT = '1000'
    process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = '10000000'
    const handler = getToolHandler('list_nodes')!
    const result = await handler({ limit: 50, include_edges: false }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    const surfaced = body.degraded ?? { hint: body._warning }
    expect(typeof surfaced.hint).toBe('string')
    expect(surfaced.hint).toMatch(/query/)
  })
})
