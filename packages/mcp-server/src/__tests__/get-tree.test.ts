/**
 * get_tree (0.9.15): server-side tree assembly. Exercises nested output, the
 * gaps field, and anchor fallback (the brief's "wrong root, empty tree" case).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import { getTree } from '../tools/tree.js'

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

async function load(d: UPGDocument): Promise<UPGFileStore> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-gettree-')))
  const fp = join(dir, 'test.upg')
  writeFileSync(fp, JSON.stringify(d, null, 2))
  const s = new UPGFileStore()
  await s.load(fp)
  s.stopWatching()
  return s
}

const e = (id: string, source: string, target: string, type: string) => ({ id, source, target, type })

describe('get_tree (0.9.15)', () => {
  let cleanup: string[] = []
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
    cleanup = []
  })

  it('assembles the user pattern as nested data and reports a gap', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'p1', type: 'persona', title: 'Developer' },
        { id: 'j1', type: 'job', title: 'Ship faster' },
        { id: 'n1', type: 'need', title: 'Less boilerplate' },
        { id: 'do1', type: 'desired_outcome', title: 'Confidence' },
        { id: 'p2', type: 'persona', title: 'Designer' }, // no children -> gap
      ],
      edges: [
        e('e1', 'p1', 'j1', 'persona_pursues_job'),
        e('e2', 'j1', 'n1', 'job_surfaces_need'),
        e('e3', 'p1', 'do1', 'persona_aspires_to_desired_outcome'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'user' }, makeCtx(store)))
    expect(body.pattern).toBe('user')
    expect(body.anchor_used).toBe('persona')
    const dev = body.roots.find((r: { id: string }) => r.id === 'p1')
    expect(dev).toBeDefined()
    // p1 -> j1 (-> n1) + do1
    const childIds = dev.children.map((c: { id: string }) => c.id).sort()
    expect(childIds).toEqual(['do1', 'j1'])
    const job = dev.children.find((c: { id: string }) => c.id === 'j1')
    expect(job.children.map((c: { id: string }) => c.id)).toEqual(['n1'])
    // p2 has no children -> a gap on the REQUIRED child only (job); need /
    // desired_outcome are optional and do not produce gap noise.
    const gap = body.gaps.find((g: { node_id: string }) => g.node_id === 'p2')
    expect(gap).toBeDefined()
    expect(gap.missing).toEqual(['job'])
  })

  it('renders a shared (multi-parent) node under every parent as a reference, never dropped', async () => {
    // DAG: two personas pursue the SAME job; the job carries a need. The job must
    // appear under BOTH personas (the second as a shared reference, not dropped),
    // and its subtree (the need) expands exactly once.
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'p1', type: 'persona', title: 'Developer' },
        { id: 'p2', type: 'persona', title: 'Designer' },
        { id: 'j1', type: 'job', title: 'Model content as code' },
        { id: 'n1', type: 'need', title: 'Reuse without forking' },
      ],
      edges: [
        e('e1', 'p1', 'j1', 'persona_pursues_job'),
        e('e2', 'p2', 'j1', 'persona_pursues_job'),
        e('e3', 'j1', 'n1', 'job_surfaces_need'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'user' }, makeCtx(store)))
    const p1 = body.roots.find((r: { id: string }) => r.id === 'p1')
    const p2 = body.roots.find((r: { id: string }) => r.id === 'p2')
    const j1UnderP1 = p1.children.find((c: { id: string }) => c.id === 'j1')
    const j1UnderP2 = p2.children.find((c: { id: string }) => c.id === 'j1')
    // Appears under both parents (never silently dropped).
    expect(j1UnderP1).toBeDefined()
    expect(j1UnderP2).toBeDefined()
    // Expanded once (the need is under the first occurrence), referenced second.
    expect(j1UnderP1.children.map((c: { id: string }) => c.id)).toEqual(['n1'])
    expect(j1UnderP1.shared).toBeUndefined()
    expect(j1UnderP2.shared).toBe(true)
    expect(j1UnderP2.children).toEqual([])
    expect(body.stats.shared_refs).toBe(1)
    // Neither persona is gap-flagged for job (both have one).
    expect(body.gaps.find((g: { node_id: string }) => g.node_id === 'p2')).toBeUndefined()
  })

  it('falls back to the product anchor for strategy when there is no vision, and reports it', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'prod', type: 'product', title: 'Studio' },
        { id: 't1', type: 'strategic_theme', title: 'Bet: AI-native' },
        { id: 'i1', type: 'initiative', title: 'AI surface' },
      ],
      edges: [
        e('e1', 'prod', 't1', 'product_organises_around_strategic_theme'),
        e('e2', 't1', 'i1', 'strategic_theme_pursues_initiative'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'strategy' }, makeCtx(store)))
    expect(body.anchor_type).toBe('vision')
    expect(body.anchor_used).toBe('product')
    expect(body.anchor_resolved_from).toBe('vision')
    const root = body.roots.find((r: { id: string }) => r.id === 'prod')
    expect(root.children[0].id).toBe('t1')
    expect(root.children[0].children[0].id).toBe('i1')
  })

  it('roots the delivery pattern at the roadmap even when a product is wired above it', async () => {
    // Regression: the shipped delivery child_map listed product -> roadmap, which
    // made the product a SUPERSET of the roadmap, so the most-nodes anchor rule
    // rooted delivery at the product even when a roadmap existed. The product ->
    // roadmap slot is dropped; the roadmap must win when present. A product ->
    // roadmap EDGE is present here to prove the pattern no longer follows it.
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'prod', type: 'product', title: 'Studio' },
        { id: 'rm', type: 'roadmap', title: 'Studio Roadmap' },
        { id: 'th', type: 'roadmap_theme', title: 'AI theme' },
        { id: 'rel', type: 'release', title: 'v6.0.0' },
        { id: 'feat', type: 'feature', title: 'Vite 8' },
        { id: 'cl', type: 'changelog', title: 'v6.0.0 notes' },
      ],
      edges: [
        e('e0', 'prod', 'rm', 'product_plans_via_roadmap'),
        e('e1', 'rm', 'th', 'roadmap_categorised_by_roadmap_theme'),
        e('e2', 'rm', 'rel', 'roadmap_schedules_release'),
        e('e3', 'rel', 'feat', 'release_contains_feature'),
        e('e4', 'rel', 'cl', 'release_documented_in_changelog'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'delivery' }, makeCtx(store)))
    expect(body.anchor_used).toBe('roadmap')
    expect(body.anchor_resolved_from).toBeUndefined()
    const root = body.roots.find((r: { id: string }) => r.id === 'rm')
    expect(root, 'roots at the roadmap, not the product').toBeDefined()
    const childIds = root.children.map((c: { id: string }) => c.id).sort()
    expect(childIds).toEqual(['rel', 'th'])
    const rel = root.children.find((c: { id: string }) => c.id === 'rel')
    // release reaches both its feature and its changelog (new optional slots).
    expect(rel.children.map((c: { id: string }) => c.id).sort()).toEqual(['cl', 'feat'])
    // All-optional pattern: no gap noise.
    expect(body.gaps).toEqual([])
  })

  it('falls back to the product for delivery when there is no roadmap', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'prod', type: 'product', title: 'Studio' },
        { id: 'rel', type: 'release', title: 'v6.0.0' },
        { id: 'feat', type: 'feature', title: 'Vite 8' },
      ],
      edges: [
        e('e1', 'prod', 'rel', 'product_ships_release'),
        e('e2', 'rel', 'feat', 'release_contains_feature'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'delivery' }, makeCtx(store)))
    expect(body.anchor_used).toBe('product')
    expect(body.anchor_resolved_from).toBe('roadmap')
    const root = body.roots.find((r: { id: string }) => r.id === 'prod')
    expect(root.children[0].id).toBe('rel')
  })

  it('falls back from service to bounded_context for the architecture pattern', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'bc', type: 'bounded_context', title: 'AI layer' },
        { id: 'repo', type: 'code_repository', title: 'studio-ai' },
        { id: 'api', type: 'external_api', title: 'Anthropic API' },
      ],
      edges: [
        e('e1', 'bc', 'repo', 'bounded_context_includes_code_repository'),
        e('e2', 'bc', 'api', 'bounded_context_integrates_external_api'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'architecture' }, makeCtx(store)))
    expect(body.anchor_type).toBe('service')
    expect(body.anchor_used).toBe('bounded_context')
    expect(body.anchor_resolved_from).toBe('service')
    const root = body.roots.find((r: { id: string }) => r.id === 'bc')
    expect(root.children.map((c: { id: string }) => c.id).sort()).toEqual(['api', 'repo'])
  })

  it('honours from_id and include_properties', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'o1', type: 'objective', title: 'O', properties: { progress: 42 } },
        { id: 'k1', type: 'key_result', title: 'KR' },
      ],
      edges: [e('e1', 'o1', 'k1', 'objective_achieved_through_key_result')],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'okr', from_id: 'o1', include_properties: ['progress'] }, makeCtx(store)))
    expect(body.roots[0].id).toBe('o1')
    expect(body.roots[0].properties.progress).toBe(42)
    expect(body.roots[0].children[0].id).toBe('k1')
  })

  it('rejects an unknown pattern', () => {
    const ctx = makeCtx(new UPGFileStore())
    const r = getTree({ pattern: 'not-a-pattern' }, ctx) as { content: { text: string }[]; isError?: true }
    expect(r.content[0].text).toMatch(/Unknown tree pattern/i)
  })

  it('requires the pattern argument', () => {
    const ctx = makeCtx(new UPGFileStore())
    const r = getTree({}, ctx) as { content: { text: string }[]; isError?: true }
    expect(r.content[0].text).toMatch(/Missing required parameter: pattern/i)
  })
})
