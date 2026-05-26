/**
 * Integration tests for the auto-degrade pass on read tools.
 *
 * covers the hard-refusal path; this file covers the soft-warn path
 * where the server applies one or more degradation stages
 * (compact_edges_auto, drop_optional_fields_auto, truncate_at_count_auto)
 * and surfaces a `degraded` block.
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

function makeGraph(nodeCount: number): UPGDocument {
  const nodes: UPGBaseNode[] = [
    {
      id: 'area_main',
      type: 'product_area' as UPGEntityType,
      title: 'Main Area',
    },
  ]
  const edges: UPGEdge[] = []
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n_${i}`,
      type: 'persona' as UPGEntityType,
      title: `Persona ${i}`,
      description: 'A reasonably long description that costs node bytes on the wire and is droppable in stage 2.',
      properties: { extra: 'payload bytes that should drop in stage 2 of the degrader' } as Record<string, unknown>,
      tags: ['fixture', 'large-graph'],
    })
    edges.push({
      id: `e_area_${i}`,
      type: 'persona_pursues_job',
      source: 'area_main',
      target: `n_${i}`,
    } as UPGEdge)
  }
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Degrade Test', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-degrade-'))
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

describe('Auto-degrade pass', () => {
  let ctx: ToolContext

  beforeEach(async () => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
    const store = await loadStore(makeGraph(100))
    ctx = makeCtx(store)
  })

  afterEach(() => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
  })

  it('list_nodes attaches degraded.applied=[truncate_at_count_auto] when over soft', async () => {
    // 100 nodes × 800 = 80_000 bytes, between default 50K soft and 150K hard.
    const handler = getToolHandler('list_nodes')!
    const result = await handler({ limit: 200, include_edges: false }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.degraded).toBeDefined()
    expect(body.degraded.applied).toEqual(['truncate_at_count_auto'])
    expect(body.degraded.estimated_full_size_bytes).toBeGreaterThan(50_000)
    expect(body.degraded.actual_size_bytes).toBeLessThan(body.degraded.estimated_full_size_bytes)
    expect(body.degraded.hint).toMatch(/query/)
    expect(body.nodes.length).toBeLessThan(100)
    // Once degraded, the _warning fallback should not also fire.
    expect(body._warning).toBeUndefined()
  })

  it('get_nodes degrades through compact_edges → drop_fields → truncate', async () => {
    // Tighten soft so all stages have to fire to fit.
    process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT = '5000'
    const ids = Array.from({ length: 50 }, (_, i) => `n_${i}`)
    const handler = getToolHandler('get_nodes')!
    const result = await handler({ ids }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.degraded).toBeDefined()
    expect(body.degraded.applied).toContain('compact_edges_auto')
    expect(body.degraded.applied).toContain('drop_optional_fields_auto')
    expect(body.degraded.applied[0]).toBe('compact_edges_auto')
    // Nodes should have lost description/properties.
    for (const wrapper of body.nodes) {
      expect(wrapper.node.description).toBeUndefined()
      expect(wrapper.node.properties).toBeUndefined()
    }
  })

  it('query auto-truncates when caller asked for fat fields', async () => {
    const handler = getToolHandler('query')!
    const result = await handler(
      { from: 'persona', depth: 1, limit: 200, include: ['title', 'description', 'properties'] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.degraded).toBeDefined()
    expect(body.degraded.applied.length).toBeGreaterThan(0)
    expect(body.degraded.hint).toMatch(/query/)
  })

  it('get_area_graph degrades a wide BFS', async () => {
    const handler = getToolHandler('get_area_graph')!
    const result = await handler({ area_id: 'area_main', depth: 1 }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    if (body.degraded) {
      expect(body.degraded.applied.length).toBeGreaterThan(0)
      expect(body.degraded.actual_size_bytes).toBeLessThan(body.degraded.estimated_full_size_bytes)
    }
  })

  it('does not attach degraded block when the response already fits under soft', async () => {
    // A single ID stays well under 50K.
    const handler = getToolHandler('get_nodes')!
    const result = await handler({ ids: ['n_0'] }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.degraded).toBeUndefined()
    expect(body._warning).toBeUndefined()
  })
})
