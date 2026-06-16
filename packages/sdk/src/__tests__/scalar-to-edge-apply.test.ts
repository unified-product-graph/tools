/**
 * Scalar → edge promotion apply engine (P14 conformance, 0.12.0).
 *
 * Round-trips the lossless `promote_scalar_to_edge` apply against a file-backed
 * store: a scalar naming a first-class entity becomes a real node + canonical
 * edge, nothing discarded, re-running is a no-op. Covers find-or-create dedup,
 * scalar drop, reverse orientation, string[] multi, and the keep-display-cache
 * (drop_scalar:false) actor case.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  UPGFileStore,
  applyScalarToEdgeMigrations,
  applyScalarToEdgeRules,
} from '../index.js'

const cleanups: string[] = []
function writeTmp(doc: unknown): string {
  const f = path.join(os.tmpdir(), `upg-s2e-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(doc))
  cleanups.push(f)
  return f
}
afterEach(() => {
  while (cleanups.length) {
    const f = cleanups.pop()!
    try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
  }
})

function envelope(nodes: unknown[], edges: unknown[] = []) {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.11.6',
      product: { id: 'p_test', title: 'TestProduct' },
      counts: { nodes: nodes.length, edges: edges.length },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-16T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'TestProduct' },
    nodes,
    edges,
  }
}

async function load(doc: unknown): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(writeTmp(doc))
  return store
}

describe('applyScalarToEdgeMigrations — flagship north_star_metric (0.11.6 → 0.12.0)', () => {
  it('mints metric{designation:north_star}, links, drops the scalar, dedups, and is idempotent', async () => {
    const store = await load(envelope([
      { id: 'n_p', type: 'product', title: 'TestProduct' },
      { id: 'n_bm1', type: 'business_model', title: 'Core BM', properties: { north_star_metric: 'Weekly active editors' } },
      { id: 'n_bm2', type: 'business_model', title: 'Side BM', properties: { north_star_metric: 'weekly active  editors' } }, // same metric, messy case/ws
    ]))

    const res = applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0')

    // Exactly one metric minted (dedup across the two business models).
    const metrics = store.getAllNodes().filter((n) => n.type === 'metric')
    expect(metrics).toHaveLength(1)
    expect(metrics[0].title).toBe('Weekly active editors')
    expect(metrics[0].properties?.designation).toBe('north_star')

    // Both business models link to the single metric via the canonical edge.
    const links = store.getAllEdges().filter((e) => e.type === 'business_model_guided_by_metric')
    expect(links).toHaveLength(2)
    expect(new Set(links.map((e) => e.source))).toEqual(new Set(['n_bm1', 'n_bm2']))
    expect(new Set(links.map((e) => e.target))).toEqual(new Set([metrics[0].id]))

    // The scalar is gone from both (lossless: value lives on the metric node now).
    for (const id of ['n_bm1', 'n_bm2']) {
      expect(store.getNode(id)!.properties?.north_star_metric).toBeUndefined()
    }

    // Summary reports the work.
    const flagship = res.per_rule.find((r) => r.scalar_property === 'north_star_metric')!
    expect(flagship.minted).toHaveLength(1)
    expect(flagship.linked).toHaveLength(2)
    expect(flagship.dropped_from.sort()).toEqual(['n_bm1', 'n_bm2'])

    // Idempotent: a second pass mints nothing, links nothing new.
    const res2 = applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0')
    expect(res2.total_minted).toBe(0)
    expect(store.getAllNodes().filter((n) => n.type === 'metric')).toHaveLength(1)
    expect(store.getAllEdges().filter((e) => e.type === 'business_model_guided_by_metric')).toHaveLength(2)
  })

  it('dryRun previews the plan without mutating the store', async () => {
    const store = await load(envelope([
      { id: 'n_p', type: 'product', title: 'TestProduct' },
      { id: 'n_bm1', type: 'business_model', title: 'Core BM', properties: { north_star_metric: 'Weekly active editors' } },
      { id: 'n_bm2', type: 'business_model', title: 'Side BM', properties: { north_star_metric: 'weekly active editors' } },
    ]))

    const plan = applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0', { dryRun: true })
    expect(plan.total_minted).toBe(1) // dedup respected in preview
    expect(plan.total_linked).toBe(2)
    expect(plan.total_dropped).toBe(2)

    // Nothing actually changed.
    expect(store.getAllNodes().filter((n) => n.type === 'metric')).toHaveLength(0)
    expect(store.getAllEdges().filter((e) => e.type === 'business_model_guided_by_metric')).toHaveLength(0)
    expect(store.getNode('n_bm1')!.properties?.north_star_metric).toBe('Weekly active editors')

    // The real pass produces the same totals the preview promised.
    const real = applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0')
    expect(real.total_minted).toBe(plan.total_minted)
    expect(real.total_linked).toBe(plan.total_linked)
    expect(real.total_dropped).toBe(plan.total_dropped)
  })

  it('links to an EXISTING target instead of minting a duplicate', async () => {
    const store = await load(envelope([
      { id: 'n_p', type: 'product', title: 'TestProduct' },
      { id: 'n_metric', type: 'metric', title: 'Weekly Active Editors', slug: 'wae' },
      { id: 'n_bm', type: 'business_model', title: 'Core BM', properties: { north_star_metric: 'weekly active editors' } },
    ]))

    applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0')

    // No new metric — the title-normalized match reused n_metric.
    expect(store.getAllNodes().filter((n) => n.type === 'metric')).toHaveLength(1)
    const link = store.getAllEdges().find((e) => e.type === 'business_model_guided_by_metric')!
    expect(link.source).toBe('n_bm')
    expect(link.target).toBe('n_metric')
  })
})

describe('applyScalarToEdgeRules — engine branches (synthetic rules)', () => {
  it('reverse orientation + string[] multi: one edge per element, target is the edge source', async () => {
    const store = await load(envelope([
      { id: 'n_p', type: 'product', title: 'TestProduct' },
      { id: 'n_gc', type: 'growth_campaign', title: 'Q3 Push', properties: { channels_targeted: ['Email', 'Paid Search'] } },
    ]))

    const res = applyScalarToEdgeRules(store, [{
      from_type: 'growth_campaign', scalar_property: 'channels_targeted',
      target_type: 'acquisition_channel', edge_type: 'acquisition_channel_runs_growth_campaign',
      reverse: true, multi: true, drop_scalar: true,
      reason: 'test',
    }])

    expect(res.total_minted).toBe(2)
    const edges = store.getAllEdges().filter((e) => e.type === 'acquisition_channel_runs_growth_campaign')
    expect(edges).toHaveLength(2)
    // Reverse: the resolved acquisition_channel is the SOURCE; the campaign is the target.
    for (const e of edges) {
      expect(e.target).toBe('n_gc')
      expect(store.getNode(e.source)!.type).toBe('acquisition_channel')
    }
    expect(store.getNode('n_gc')!.properties?.channels_targeted).toBeUndefined()
  })

  it('drop_scalar:false keeps the display-cache scalar (actor case)', async () => {
    const store = await load(envelope([
      { id: 'n_p', type: 'product', title: 'TestProduct' },
      { id: 'n_feat', type: 'feature', title: 'Canvas', properties: { owner: 'Ada Lovelace' } },
    ]))

    applyScalarToEdgeRules(store, [{
      from_type: 'feature', scalar_property: 'owner',
      target_type: 'person', edge_type: 'node_owned_by_person',
      drop_scalar: false,
      reason: 'test',
    }])

    // A person was minted + linked, but the string stays as a display-cache.
    expect(store.getAllNodes().filter((n) => n.type === 'person')).toHaveLength(1)
    expect(store.getAllEdges().filter((e) => e.type === 'node_owned_by_person')).toHaveLength(1)
    expect(store.getNode('n_feat')!.properties?.owner).toBe('Ada Lovelace')
  })
})
