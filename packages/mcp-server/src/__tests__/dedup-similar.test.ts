/**
 * deduplicate_nodes match:"similar" — read-only near-duplicate suggestion (0.17.2).
 *
 * Exact title matching misses metric variants that mean the same thing under
 * different wording (the Media Library "cross-project reuse rate" case). The
 * "similar" pass surfaces them by fuzzy title overlap and by metrics sharing a
 * statistical_function and an area. It never merges.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGEdgeType } from '@unified-product-graph/core'
import { deduplicateNodes } from '../tools/nodes.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

const metric = (id: string, title: string, fn: string): UPGBaseNode => ({
  id, type: 'metric' as UPGEntityType, title, properties: { statistical_function: fn },
})
const node = (id: string, type: string, title: string): UPGBaseNode => ({ id, type: type as UPGEntityType, title })
const edge = (id: string, source: string, target: string, type: string): UPGEdge => ({
  id, source, target, type: type as UPGEdgeType,
})

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Metric Fixture', stage: 'growth' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-dedup-similar-'))
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

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text)

// oc1 contains the reuse + adoption metrics (shared scope); m4 unrelated; m9/m10 exact dup.
const nodes = [
  node('oc1', 'outcome', 'Editorial efficiency'),
  metric('m1', 'Cross-project reuse rate', 'rate'),
  metric('m2', 'Cross project reuse rate %', 'rate'),
  metric('m3', 'Cross-project reuse rate (monthly)', 'rate'),
  metric('m4', 'Monthly active users', 'count'),
  metric('m6', 'Feature adoption rate', 'rate'),
  metric('m7', 'Adoption rate by segment', 'rate'),
  metric('m9', 'Net revenue retention', 'rate'),
  metric('m10', 'Net revenue retention', 'rate'),
]
const edges = ['m1', 'm2', 'm3', 'm4', 'm6', 'm7', 'm9', 'm10'].map((m, i) =>
  edge(`e${i}`, 'oc1', m, 'outcome_measured_by_metric'),
)

describe('deduplicate_nodes match:"similar"', () => {
  it('groups the three fuzzy-titled reuse-rate metric variants', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = parse(deduplicateNodes({ type: 'metric', match: 'similar' }, makeCtx(store)))
    expect(res.match).toBe('similar')
    const reuseGroup = res.similar_candidates.find((g: { members: { id: string }[] }) =>
      g.members.some((m) => m.id === 'm1'))
    expect(reuseGroup).toBeDefined()
    const ids = reuseGroup.members.map((m: { id: string }) => m.id).sort()
    expect(ids).toEqual(['m1', 'm2', 'm3'])
  })

  it('flags same-statistical_function + same-area metrics with partial title overlap', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = parse(deduplicateNodes({ type: 'metric', match: 'similar' }, makeCtx(store)))
    const adoptionGroup = res.similar_candidates.find((g: { members: { id: string }[] }) =>
      g.members.some((m) => m.id === 'm6'))
    expect(adoptionGroup).toBeDefined()
    expect(adoptionGroup.members.map((m: { id: string }) => m.id).sort()).toEqual(['m6', 'm7'])
    expect(adoptionGroup.reason).toBe('same_statistical_function_and_area')
    expect(adoptionGroup.statistical_function).toBe('rate')
  })

  it('does not flag an exact-title pair as a similar candidate', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = parse(deduplicateNodes({ type: 'metric', match: 'similar' }, makeCtx(store)))
    const hasExactPair = res.similar_candidates.some((g: { members: { id: string }[] }) =>
      g.members.some((m) => m.id === 'm9') || g.members.some((m) => m.id === 'm10'))
    expect(hasExactPair).toBe(false)
  })

  it('does not flag unrelated metrics', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = parse(deduplicateNodes({ type: 'metric', match: 'similar' }, makeCtx(store)))
    const hasM4 = res.similar_candidates.some((g: { members: { id: string }[] }) =>
      g.members.some((m) => m.id === 'm4'))
    expect(hasM4).toBe(false)
  })

  it('never mutates the graph', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const beforeNodes = store.getAllNodes().length
    const beforeEdges = store.getAllEdges().length
    parse(deduplicateNodes({ type: 'metric', match: 'similar' }, makeCtx(store)))
    expect(store.getAllNodes().length).toBe(beforeNodes)
    expect(store.getAllEdges().length).toBe(beforeEdges)
  })

  it('rejects an invalid match value', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = deduplicateNodes({ match: 'fuzzy' }, makeCtx(store)) as { content: { text: string }[] }
    expect(res.content[0].text).toMatch(/Invalid match/i)
  })

  it('still does exact dedup by default (match omitted)', async () => {
    const store = await loadStore(makeDoc(nodes, edges))
    const res = parse(deduplicateNodes({ type: 'metric', dry_run: true }, makeCtx(store)))
    // m9 / m10 are exact-title dups → one exact group.
    expect(res.duplicates.some((d: { ids: string[] }) => d.ids.includes('m9') && d.ids.includes('m10'))).toBe(true)
  })
})
