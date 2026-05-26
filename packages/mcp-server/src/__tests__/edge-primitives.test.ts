/**
 * Tests for the Wave 2 edge primitives:
 *   - export_edges: flat enumeration with type filter and pagination
 *   - rename_edge_type: exact-match rename with optional flip and dry_run
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGEdgeType } from '@unified-product-graph/core'
import { exportEdges, renameEdgeType } from '../tools/edges.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Edge Primitives Fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-edge-primitives-'))
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

const persona = (id: string): UPGBaseNode => ({
  id,
  type: 'persona' as UPGEntityType,
  title: `Persona ${id}`,
})
const job = (id: string): UPGBaseNode => ({
  id,
  type: 'job' as UPGEntityType,
  title: `Job ${id}`,
})

const edge = (id: string, source: string, target: string, type: string): UPGEdge => ({
  id,
  source,
  target,
  type: type as UPGEdgeType,
})

async function buildStore(): Promise<UPGFileStore> {
  const nodes = [persona('p1'), persona('p2'), job('j1'), job('j2'), job('j3')]
  const edges = [
    edge('e1', 'p1', 'j1', 'persona_pursues_job'),
    edge('e2', 'p1', 'j2', 'persona_pursues_job'),
    edge('e3', 'p2', 'j3', 'persona_pursues_job'),
    edge('e4', 'p1', 'p2', 'persona_relates_to_persona'),
  ]
  return loadStore(makeDoc(nodes, edges))
}

describe('export_edges', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await buildStore()
    ctx = makeCtx(store)
  })

  it('returns every edge when types is omitted', async () => {
    const result = await exportEdges({}, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.total).toBe(4)
    expect(body.edges).toHaveLength(4)
    expect(body.edges[0]).toEqual({
      id: 'e1',
      source: 'p1',
      target: 'j1',
      type: 'persona_pursues_job',
    })
  })

  it('filters by exact type match', async () => {
    const result = await exportEdges({ types: ['persona_pursues_job'] }, ctx)
    const body = JSON.parse(result.content[0].text)
    expect(body.total).toBe(3)
    expect(body.edges.map((e: UPGEdge) => e.id).sort()).toEqual(['e1', 'e2', 'e3'])
    expect(body.types).toEqual(['persona_pursues_job'])
  })

  it('paginates via offset/limit', async () => {
    const r1 = JSON.parse((await exportEdges({ limit: 2 }, ctx)).content[0].text)
    expect(r1.edges).toHaveLength(2)
    expect(r1.total).toBe(4)
    const r2 = JSON.parse(
      (await exportEdges({ offset: 2, limit: 2 }, ctx)).content[0].text,
    )
    expect(r2.edges).toHaveLength(2)
    expect(r2.edges[0].id).toBe('e3')
  })

  it('rejects non-array `types`', async () => {
    const result = await exportEdges({ types: 'persona_pursues_job' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/array of strings/)
  })

  it('honours if_changed_since when graph is unchanged', async () => {
    const first = JSON.parse((await exportEdges({}, ctx)).content[0].text)
    const second = JSON.parse(
      (await exportEdges({ if_changed_since: first._hash }, ctx)).content[0].text,
    )
    expect(second.changed).toBe(false)
  })
})

describe('rename_edge_type', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await buildStore()
    ctx = makeCtx(store)
  })

  it('defaults to dry_run and reports the count without mutating', async () => {
    const result = await renameEdgeType(
      { from: 'persona_pursues_job', to: 'persona_has_job', allow_non_canonical: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.dry_run).toBe(true)
    expect(body.would_rename).toBe(3)
    expect(body.sample).toHaveLength(3)
    // Graph untouched
    const types = store.getAllEdges().map((e) => e.type)
    expect(types.filter((t) => t === 'persona_pursues_job')).toHaveLength(3)
  })

  it('renames every matching edge when dry_run is false', async () => {
    const result = await renameEdgeType(
      {
        from: 'persona_pursues_job',
        to: 'persona_has_job',
        dry_run: false,
        allow_non_canonical: true,
      },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.dry_run).toBe(false)
    expect(body.renamed).toBe(3)
    expect(body.ids.sort()).toEqual(['e1', 'e2', 'e3'])
    const types = store.getAllEdges().map((e) => e.type as string)
    expect(types.filter((t) => t === 'persona_has_job')).toHaveLength(3)
    expect(types.filter((t) => t === 'persona_pursues_job')).toHaveLength(0)
  })

  it('uses exact match — never substring (regression vs migrate_type)', async () => {
    // Adding a persona_relates_to_persona edge that includes 'persona' as a
    // substring. A substring matcher would mangle it; an exact matcher leaves
    // it alone.
    const result = await renameEdgeType(
      {
        from: 'persona',
        to: 'individual',
        dry_run: false,
        allow_non_canonical: true,
      },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.renamed).toBe(0)
    // No edge type is exactly 'persona', so nothing should change.
    expect(store.getAllEdges().map((e) => e.type)).toEqual([
      'persona_pursues_job',
      'persona_pursues_job',
      'persona_pursues_job',
      'persona_relates_to_persona',
    ])
  })

  it('flips source/target when flip is true', async () => {
    const result = await renameEdgeType(
      {
        from: 'persona_pursues_job',
        to: 'job_pursued_by_persona',
        flip: true,
        dry_run: false,
        allow_non_canonical: true,
      },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.renamed).toBe(3)
    const e1 = store.getEdge('e1')!
    expect(e1.type).toBe('job_pursued_by_persona')
    expect(e1.source).toBe('j1') // was p1
    expect(e1.target).toBe('p1') // was j1
  })

  it('rejects when from === to and flip is false', async () => {
    const result = await renameEdgeType(
      { from: 'persona_pursues_job', to: 'persona_pursues_job' },
      ctx,
    )
    expect(result.isError).toBe(true)
  })

  it('requires `from` and `to`', async () => {
    expect((await renameEdgeType({ to: 'x' }, ctx)).isError).toBe(true)
    expect((await renameEdgeType({ from: 'x' }, ctx)).isError).toBe(true)
  })
})
