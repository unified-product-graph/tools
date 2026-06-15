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
    // The anchor type (service) is genuinely ABSENT here.
    expect(body.anchor_present).toBe(false)
    const root = body.roots.find((r: { id: string }) => r.id === 'bc')
    expect(root.children.map((c: { id: string }) => c.id).sort()).toEqual(['api', 'repo'])
  })

  it('reports anchor_present=true when the anchor exists but nests under the fallback root', async () => {
    // The Content Lake case: services EXIST but every one nests under a
    // bounded_context, so the most-nodes rule roots on bounded_context. The
    // fallback fired, but "No service found" would contradict the services
    // rendered below; anchor_present distinguishes present-but-nested from absent.
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'bc', type: 'bounded_context', title: 'Content layer' },
        { id: 'svc1', type: 'service', title: 'Asset Service' },
        { id: 'svc2', type: 'service', title: 'Query Service' },
        { id: 'sch', type: 'database_schema', title: 'assets' },
      ],
      edges: [
        e('e1', 'bc', 'svc1', 'bounded_context_deploys_service'),
        e('e2', 'bc', 'svc2', 'bounded_context_deploys_service'),
        e('e3', 'svc1', 'sch', 'service_persisted_in_database_schema'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'architecture' }, makeCtx(store)))
    expect(body.anchor_used).toBe('bounded_context')
    expect(body.anchor_resolved_from).toBe('service')
    // The fix: services ARE present (2 of them), just nested.
    expect(body.anchor_present).toBe(true)
    const root = body.roots.find((r: { id: string }) => r.id === 'bc')
    expect(root.children.map((c: { id: string }) => c.id).sort()).toEqual(['svc1', 'svc2'])
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

  it('J1: collapses the redundant journey->step path through the phase spine (no double-count)', async () => {
    // A step reachable BOTH directly (user_journey_contains_journey_step) and via
    // its phase (passes_through -> spans) must render ONCE, under the phase. A step
    // in NO phase still renders directly (the direct path is the fallback, never a
    // silent drop). Mirror of the G5 silent-drop fix.
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'uj', type: 'user_journey', title: 'Onboarding' },
        { id: 'ph', type: 'journey_phase', title: 'Set up', properties: { phase_order: 0 } },
        { id: 'st1', type: 'journey_step', title: 'Sign up', properties: { step_order: 1 } },
        { id: 'st2', type: 'journey_step', title: 'Pick template', properties: { step_order: 0 } },
        { id: 'st3', type: 'journey_step', title: 'Orphan step (no phase)', properties: { step_order: 0 } },
        { id: 'a1', type: 'journey_action', title: 'Click sign up', properties: { action_order: 0 } },
      ],
      edges: [
        e('e1', 'uj', 'ph', 'user_journey_passes_through_journey_phase'),
        // Redundant DIRECT edges to steps that also hang off the phase:
        e('e2', 'uj', 'st1', 'user_journey_contains_journey_step'),
        e('e3', 'uj', 'st2', 'user_journey_contains_journey_step'),
        // st3 is direct-only (in no phase):
        e('e4', 'uj', 'st3', 'user_journey_contains_journey_step'),
        e('e5', 'ph', 'st1', 'journey_phase_spans_journey_step'),
        e('e6', 'ph', 'st2', 'journey_phase_spans_journey_step'),
        e('e7', 'st1', 'a1', 'journey_step_has_action'),
      ],
    }
    const store = await load(doc)
    // depth 5 so the action leaf renders (journey natural_depth is 3).
    const body = bodyOf(getTree({ pattern: 'journey', depth: 5 }, makeCtx(store)))
    const uj = body.roots.find((r: { id: string }) => r.id === 'uj')
    // Journey's direct children: the phase (slot 0) then the orphan step (slot 1).
    // st1/st2 are NOT here -- they collapsed onto the phase spine.
    expect(uj.children.map((c: { id: string }) => c.id)).toEqual(['ph', 'st3'])
    // The phase holds the two steps, sorted by step_order (st2=0 before st1=1).
    const ph = uj.children.find((c: { id: string }) => c.id === 'ph')
    expect(ph.children.map((c: { id: string }) => c.id)).toEqual(['st2', 'st1'])
    // The collapsed step keeps its subtree (rendered under the phase, not hollow).
    const st1 = ph.children.find((c: { id: string }) => c.id === 'st1')
    expect(st1.children.map((c: { id: string }) => c.id)).toEqual(['a1'])
    expect(st1.shared).toBeUndefined()
    // The orphan step renders directly and is not a shared reference.
    const st3 = uj.children.find((c: { id: string }) => c.id === 'st3')
    expect(st3.shared).toBeUndefined()
    // No hollow duplicate anywhere: the redundant path produced zero shared refs.
    expect(body.stats.shared_refs).toBe(0)
  })

  it('J1: falls back to the direct journey->step path when the journey has no phases', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'uj', type: 'user_journey', title: 'Quick flow' },
        { id: 'st1', type: 'journey_step', title: 'Second', properties: { step_order: 1 } },
        { id: 'st2', type: 'journey_step', title: 'First', properties: { step_order: 0 } },
      ],
      edges: [
        e('e1', 'uj', 'st1', 'user_journey_contains_journey_step'),
        e('e2', 'uj', 'st2', 'user_journey_contains_journey_step'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'journey' }, makeCtx(store)))
    const uj = body.roots.find((r: { id: string }) => r.id === 'uj')
    // No phase grouping -> steps render directly, in step_order.
    expect(uj.children.map((c: { id: string }) => c.id)).toEqual(['st2', 'st1'])
  })

  it('J2: returns children in canonical *_order, nulls last', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'uj', type: 'user_journey', title: 'J' },
        { id: 'phA', type: 'journey_phase', title: 'A', properties: { phase_order: 2 } },
        { id: 'phB', type: 'journey_phase', title: 'B', properties: { phase_order: 0 } },
        { id: 'phC', type: 'journey_phase', title: 'C (no order)' }, // null -> last
        { id: 'sA1', type: 'journey_step', title: 'A.second', properties: { step_order: 1 } },
        { id: 'sA2', type: 'journey_step', title: 'A.first', properties: { step_order: 0 } },
      ],
      edges: [
        e('e1', 'uj', 'phA', 'user_journey_passes_through_journey_phase'),
        e('e2', 'uj', 'phB', 'user_journey_passes_through_journey_phase'),
        e('e3', 'uj', 'phC', 'user_journey_passes_through_journey_phase'),
        e('e4', 'phA', 'sA1', 'journey_phase_spans_journey_step'),
        e('e5', 'phA', 'sA2', 'journey_phase_spans_journey_step'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'journey' }, makeCtx(store)))
    const uj = body.roots.find((r: { id: string }) => r.id === 'uj')
    // Phases ascending by phase_order, the unset one last.
    expect(uj.children.map((c: { id: string }) => c.id)).toEqual(['phB', 'phA', 'phC'])
    // Steps within a phase ascending by step_order.
    const phA = uj.children.find((c: { id: string }) => c.id === 'phA')
    expect(phA.children.map((c: { id: string }) => c.id)).toEqual(['sA2', 'sA1'])
  })

  it('commercial: roots at business_model, shares a dual-parent pricing_tier, decomposes a metric', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'bm', type: 'business_model', title: 'Open-core SaaS' },
        { id: 'rs', type: 'revenue_stream', title: 'Self-serve subs' },
        { id: 'cs', type: 'cost_structure', title: 'Cloud COGS' },
        { id: 'ue', type: 'unit_economics', title: 'Unit economics' },
        { id: 'ps', type: 'pricing_strategy', title: 'Tiered pricing' },
        { id: 'pt', type: 'pricing_tier', title: 'Team' }, // reached from BOTH rs and ps
        { id: 'mrr', type: 'metric', title: 'Net New MRR' },
        { id: 'new', type: 'metric', title: 'New MRR' }, // component of mrr
        { id: 'gm', type: 'metric', title: 'Gross margin' },
      ],
      edges: [
        e('e1', 'bm', 'rs', 'business_model_earns_via_revenue_stream'),
        e('e2', 'bm', 'cs', 'business_model_costs_via_cost_structure'),
        e('e3', 'bm', 'ue', 'business_model_measured_by_unit_economics'),
        e('e4', 'rs', 'pt', 'revenue_stream_tiered_as_pricing_tier'),
        e('e5', 'rs', 'mrr', 'revenue_stream_measured_by_metric'),
        e('e6', 'rs', 'ps', 'revenue_stream_priced_by_pricing_strategy'),
        e('e7', 'ps', 'pt', 'pricing_strategy_offers_pricing_tier'), // dual parent -> shared
        e('e8', 'cs', 'gm', 'cost_structure_measured_by_metric'),
        e('e9', 'mrr', 'new', 'metric_decomposes_into_metric'),
      ],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'commercial', depth: 5 }, makeCtx(store)))
    expect(body.pattern).toBe('commercial')
    expect(body.anchor_used).toBe('business_model')
    expect(body.gaps).toEqual([]) // all-optional
    const bm = body.roots.find((r: { id: string }) => r.id === 'bm')
    expect(bm.children.map((c: { id: string }) => c.id).sort()).toEqual(['cs', 'rs', 'ue'])
    // pricing_tier hangs off both the stream (directly) and the strategy -> shared ref.
    expect(body.stats.shared_refs).toBeGreaterThan(0)
    // metric waterfall: Net New MRR decomposes into New MRR.
    const rs = bm.children.find((c: { id: string }) => c.id === 'rs')
    const mrr = rs.children.find((c: { id: string }) => c.id === 'mrr')
    expect(mrr.children.map((c: { id: string }) => c.id)).toEqual(['new'])
  })

  it('commercial: falls back to product when no business_model exists', async () => {
    const doc: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'prod', type: 'product', title: 'Studio' },
        { id: 'rs', type: 'revenue_stream', title: 'Orphan stream' },
      ],
      edges: [],
    }
    const store = await load(doc)
    const body = bodyOf(getTree({ pattern: 'commercial' }, makeCtx(store)))
    expect(body.anchor_used).toBe('product')
    expect(body.anchor_resolved_from).toBe('business_model')
    expect(body.anchor_present).toBe(false)
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
