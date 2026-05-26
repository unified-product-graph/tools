/**
 * Tests for approach verb execution.
 *
 * Each test loads a small purpose-built graph and exercises one approach
 * verb end-to-end through its handler. The handlers return JSON envelopes;
 * tests parse those and assert on the structured projection.
 *
 * Coverage:
 *   - prioritise — RICE expression evaluates over candidate properties;
 *     frameworks without an expression fall back to definition_lookup.
 *   - inspect — wraps validate_graph, returns unified violations.
 *   - plan — gap analysis vs canonical creation sequences.
 *   - trace — BFS over a typed path; partial trail + error when canonical
 *     edge can't resolve.
 *   - reflect — surfaces blind-spot domains when coverage < 30%.
 *   - All five tools return execution_mode: "execution_v0_4_0" (or the
 *     fallback "definition_lookup_v0_4_0" for prioritise-without-expression).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type {
  UPGDocument,
  UPGBaseNode,
  UPGEdge,
  UPGEntityType,
  UPGEdgeType,
} from '@unified-product-graph/core'
import {
  plan,
  inspect,
  prioritise,
  trace,
  reflect,
} from '../tools/spec.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
  type ToolResult,
} from '../lib/server-context.js'

// ─── Fixture helpers ────────────────────────────────────────────────

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'approach-execution fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-approach-exec-'))
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

async function callAsync(
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; body: Record<string, unknown>; raw: ToolResult }> {
  const r = await handler(args, ctx)
  if (r.isError) {
    return { ok: false, body: { error: r.content[0].text }, raw: r }
  }
  return { ok: true, body: JSON.parse(r.content[0].text), raw: r }
}

// ─── prioritise ─────────────────────────────────────────────────────

describe('prioritise — executes framework expressions', () => {
  it('ranks RICE candidates by computed score', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'feat_a',
            type: 'feature' as UPGEntityType,
            title: 'Feature A',
            properties: { reach: 8, impact: 3, confidence: 0.8, effort: 4 },
          } as UPGBaseNode,
          {
            id: 'feat_b',
            type: 'feature' as UPGEntityType,
            title: 'Feature B',
            properties: { reach: 10, impact: 1, confidence: 0.5, effort: 2 },
          } as UPGBaseNode,
          {
            id: 'feat_c',
            type: 'feature' as UPGEntityType,
            title: 'Feature C',
            properties: { reach: 4, impact: 2, confidence: 1, effort: 1 },
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(
      prioritise,
      {
        candidates: ['feat_a', 'feat_b', 'feat_c'],
        framework_id: 'rice-scoring',
      },
      ctx,
    )
    expect(ok).toBe(true)
    const ranked = body.ranked as Array<{ entity_id: string; score: number | null }>
    expect(ranked).toHaveLength(3)
    // RICE = (reach * impact * confidence) / effort
    // A: 8*3*0.8 / 4 = 4.8
    // B: 10*1*0.5 / 2 = 2.5
    // C: 4*2*1 / 1 = 8
    expect(ranked.map((r) => r.entity_id)).toEqual(['feat_c', 'feat_a', 'feat_b'])
    expect(ranked[0].score).toBe(8)
    expect(ranked[1].score).toBeCloseTo(4.8, 5)
    expect(ranked[2].score).toBe(2.5)
    expect(body.execution_mode).toBe('execution_v0_4_0')
    expect((body.framework_resolved as { expression: string }).expression).toBe(
      '(reach * impact * confidence) / effort',
    )
  })

  it('returns score=null with missing_properties when candidate lacks fields', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'feat_x',
            type: 'feature' as UPGEntityType,
            title: 'Feature X',
            properties: { reach: 8, impact: 3 }, // missing confidence + effort
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(
      prioritise,
      { candidates: ['feat_x'], framework_id: 'rice-scoring' },
      ctx,
    )
    const ranked = body.ranked as Array<{
      entity_id: string
      score: number | null
      missing_properties?: string[]
    }>
    expect(ranked[0].score).toBeNull()
    expect(ranked[0].missing_properties).toEqual(
      expect.arrayContaining(['confidence', 'effort']),
    )
  })

  it('falls back to definition_lookup for frameworks without an expression', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(
      prioritise,
      {
        candidates: ['feat_a'],
        framework_id: 'story-points-poker', // no computed_properties
      },
      ctx,
    )
    expect(ok).toBe(true)
    expect(body.execution_mode).toBe('definition_lookup_v0_4_0')
    expect(typeof body.hint).toBe('string')
    expect(body.ranked).toBeUndefined()
  })

  it('errors when framework_id is unknown', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { ok, raw } = await callAsync(
      prioritise,
      { candidates: ['n1'], framework_id: 'not-a-framework' },
      ctx,
    )
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown framework_id/)
  })

  it('returns helpful rationale on division by zero', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'feat_z',
            type: 'feature' as UPGEntityType,
            title: 'Feature Z',
            properties: { reach: 5, impact: 3, confidence: 1, effort: 0 },
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(
      prioritise,
      { candidates: ['feat_z'], framework_id: 'rice-scoring' },
      ctx,
    )
    const ranked = body.ranked as Array<{ score: number | null; rationale: string }>
    expect(ranked[0].score).toBeNull()
    expect(ranked[0].rationale).toMatch(/Division by zero/)
  })
})

// ─── inspect ────────────────────────────────────────────────────────

describe('inspect — wraps validate_graph + projects unified violations', () => {
  it('surfaces anti-pattern violations matching validate_graph', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'p1',
            type: 'persona' as UPGEntityType,
            title: 'Solo Builder',
          } as UPGBaseNode,
          // Feature without hypothesis — triggers `features-without-hypotheses`
          {
            id: 'f1',
            type: 'feature' as UPGEntityType,
            title: 'Onboarding wizard',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(inspect, {}, ctx)
    expect(ok).toBe(true)
    expect(body.execution_mode).toBe('execution_v0_4_0')
    const violations = body.violations as Array<{ kind: string; severity: string }>
    // At least one anti-pattern fires.
    expect(violations.length).toBeGreaterThan(0)
    // High severity first
    expect(violations[0].severity).toBe('high')
  })

  it('includes entity_drift kinds in the unified violations list', async () => {
    const store = await loadStore(
      makeDoc(
        [
          // Use a known deprecated alias.
          {
            id: 'h1',
            type: 'hypothesis_evidence' as UPGEntityType,
            title: 'Old evidence',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(inspect, {}, ctx)
    const violations = body.violations as Array<{ kind: string; entity_id?: string }>
    const drift = violations.find((v) => v.kind === 'entity_drift')
    expect(drift).toBeDefined()
    expect(drift?.entity_id).toBe('h1')
  })

  it('narrows by region scope', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'p1',
            type: 'persona' as UPGEntityType,
            title: 'Solo Builder',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(
      inspect,
      { region: 'users_needs' },
      ctx,
    )
    expect(body.execution_mode).toBe('execution_v0_4_0')
    // Envelope scope echoes the input scalar (region wins over entities).
    expect(body.scope).toBe('users_needs')
    // The params block carries the broken-out scope.
    expect((body.params as { region: string }).region).toBe('users_needs')
  })
})

// ─── plan ───────────────────────────────────────────────────────────

describe('plan — gap analysis vs canonical creation sequences', () => {
  it('returns missing entities ordered by creation_sequence position (region scoped)', async () => {
    // user domain creation_sequence: persona, job, need, desired_outcome, job_step, switching_cost
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'p1',
            type: 'persona' as UPGEntityType,
            title: 'Solo Builder',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(plan, { region: 'users_needs' }, ctx)
    expect(ok).toBe(true)
    expect(body.execution_mode).toBe('execution_v0_4_0')
    const missing = body.missing_entities as Array<{
      entity_type: string
      position_in_sequence: number
    }>
    expect(missing.length).toBeGreaterThan(0)
    // First missing should be the lowest position not covered.
    // persona (0) is covered → job (1) should be first.
    expect(missing[0].entity_type).toBe('job')
    // Sorted by position
    for (let i = 1; i < missing.length; i++) {
      expect(missing[i].position_in_sequence).toBeGreaterThanOrEqual(
        missing[i - 1].position_in_sequence,
      )
    }
    expect(body.coverage_score).toBeGreaterThan(0)
    expect(body.coverage_score).toBeLessThan(1)
  })

  it('returns 0 coverage for empty graph', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { body } = await callAsync(plan, { region: 'users_needs' }, ctx)
    expect(body.coverage_score).toBe(0)
    expect(body.covered_count).toBe(0)
  })

  it('handles whole-graph plan (no region) — surfaces missing types across domains', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { body } = await callAsync(plan, {}, ctx)
    expect(body.region).toBeNull()
    const missing = body.missing_entities as unknown[]
    // Whole-graph expected set should be larger than any one region.
    expect(missing.length).toBeGreaterThan(20)
  })
})

// ─── trace ──────────────────────────────────────────────────────────

describe('trace — BFS over a typed path', () => {
  it('walks a 2-hop persona → job → need path', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
          { id: 'j1', type: 'job' as UPGEntityType, title: 'Ship a product' } as UPGBaseNode,
          { id: 'j2', type: 'job' as UPGEntityType, title: 'Find a co-founder' } as UPGBaseNode,
          { id: 'n1', type: 'need' as UPGEntityType, title: 'Onboarding clarity' } as UPGBaseNode,
        ],
        [
          { id: 'e1', source: 'p1', target: 'j1', type: 'persona_pursues_job' as UPGEdgeType },
          { id: 'e2', source: 'p1', target: 'j2', type: 'persona_pursues_job' as UPGEdgeType },
          { id: 'e3', source: 'j1', target: 'n1', type: 'job_surfaces_need' as UPGEdgeType },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(
      trace,
      { anchor: 'p1', path: ['job', 'need'] },
      ctx,
    )
    expect(ok).toBe(true)
    expect(body.execution_mode).toBe('execution_v0_4_0')
    const trail = body.trail as Array<{
      depth: number
      entity_id: string
      edge_type_in: string | null
    }>
    // depth 0: p1
    expect(trail[0]).toEqual({
      depth: 0,
      entity_id: 'p1',
      entity_type: 'persona',
      edge_type_in: null,
    })
    // depth 1: j1, j2
    const depth1Ids = trail.filter((t) => t.depth === 1).map((t) => t.entity_id).sort()
    expect(depth1Ids).toEqual(['j1', 'j2'])
    // depth 2: n1 (only j1 leads to a need)
    const depth2 = trail.filter((t) => t.depth === 2)
    expect(depth2).toHaveLength(1)
    expect(depth2[0].entity_id).toBe('n1')
    expect(depth2[0].edge_type_in).toBe('job_surfaces_need')

    const reached = body.reached as string[]
    expect(reached).toContain('n1')
  })

  it('returns partial trail + error when no canonical edge resolves', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    // persona → vision has no canonical edge — verified via resolver probe.
    const { body } = await callAsync(
      trace,
      { anchor: 'p1', path: ['vision'] },
      ctx,
    )
    expect(body.error).toMatch(/no canonical edge/)
    expect(body.halted_at_depth).toBe(1)
    // Trail still includes the anchor
    expect((body.trail as unknown[]).length).toBe(1)
  })

  it('errors when anchor is missing from the graph', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { body } = await callAsync(
      trace,
      { anchor: 'does-not-exist', path: ['job'] },
      ctx,
    )
    expect(body.error).toMatch(/Anchor entity not found/)
    expect(body.halted_at_depth).toBe(0)
  })
})

// ─── reflect ────────────────────────────────────────────────────────

describe('reflect — emits structured prompts based on graph topology', () => {
  it('blind-spots mode surfaces empty canonical domains', async () => {
    // Only one persona — most canonical domains are empty.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { ok, body } = await callAsync(
      reflect,
      { mode: 'blind-spots' },
      ctx,
    )
    expect(ok).toBe(true)
    expect(body.execution_mode).toBe('execution_v0_4_0')
    const prompts = body.prompts as Array<{ kind: string; question: string }>
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.every((p) => p.kind === 'blind_spot')).toBe(true)
  })

  it('assumptions mode surfaces assumption + drafted hypothesis nodes', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'a1',
            type: 'assumption' as UPGEntityType,
            title: 'Users want speed over polish',
          } as UPGBaseNode,
          {
            id: 'h1',
            type: 'hypothesis' as UPGEntityType,
            title: 'Daily reminders boost retention',
            status: 'drafted',
          } as UPGBaseNode,
          {
            id: 'h2',
            type: 'hypothesis' as UPGEntityType,
            title: 'Tested',
            status: 'validated',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(reflect, { mode: 'assumptions' }, ctx)
    const prompts = body.prompts as Array<{ kind: string; target_entities?: string[] }>
    const targeted = new Set(prompts.flatMap((p) => p.target_entities ?? []))
    expect(targeted.has('a1')).toBe(true)
    expect(targeted.has('h1')).toBe(true)
    // h2 is validated → not surfaced
    expect(targeted.has('h2')).toBe(false)
  })

  it('load-bearing mode surfaces top entities by incoming-edge count', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
          { id: 'j1', type: 'job' as UPGEntityType, title: 'Ship' } as UPGBaseNode,
          { id: 'j2', type: 'job' as UPGEntityType, title: 'Sell' } as UPGBaseNode,
          { id: 'j3', type: 'job' as UPGEntityType, title: 'Learn' } as UPGBaseNode,
        ],
        [
          { id: 'e1', source: 'p1', target: 'j1', type: 'persona_pursues_job' as UPGEdgeType },
          { id: 'e2', source: 'p1', target: 'j2', type: 'persona_pursues_job' as UPGEdgeType },
          { id: 'e3', source: 'p1', target: 'j3', type: 'persona_pursues_job' as UPGEdgeType },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(reflect, { mode: 'load-bearing' }, ctx)
    const prompts = body.prompts as Array<{ kind: string }>
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.every((p) => p.kind === 'load_bearing')).toBe(true)
  })

  it('open reflection (no mode) returns at most 3 prompts mixed across categories', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
          {
            id: 'a1',
            type: 'assumption' as UPGEntityType,
            title: 'Users prefer dark mode',
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)
    const { body } = await callAsync(reflect, {}, ctx)
    const prompts = body.prompts as unknown[]
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.length).toBeLessThanOrEqual(3)
  })

  it('empty graph returns a single onboarding-style prompt', async () => {
    const store = await loadStore(makeDoc([], []))
    const ctx = makeCtx(store)
    const { body } = await callAsync(reflect, {}, ctx)
    const prompts = body.prompts as Array<{ kind: string; question: string }>
    expect(prompts).toHaveLength(1)
    expect(prompts[0].question).toMatch(/empty/i)
  })
})

// ─── Cross-cutting: execution_mode contract ─────────────────────────

describe('all 5 approach tools — execution_mode contract', () => {
  it('plan + inspect + trace + reflect all return execution_mode v0_4_0', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)

    const planR = await callAsync(plan, {}, ctx)
    expect(planR.body.execution_mode).toBe('execution_v0_4_0')

    const inspectR = await callAsync(inspect, {}, ctx)
    expect(inspectR.body.execution_mode).toBe('execution_v0_4_0')

    const traceR = await callAsync(trace, { anchor: 'p1', path: ['job'] }, ctx)
    expect(traceR.body.execution_mode).toBe('execution_v0_4_0')

    const reflectR = await callAsync(reflect, {}, ctx)
    expect(reflectR.body.execution_mode).toBe('execution_v0_4_0')
  })

  it('prioritise returns execution_v0_4_0 for RICE; definition_lookup_v0_4_0 for kano', async () => {
    const store = await loadStore(
      makeDoc(
        [
          {
            id: 'feat_a',
            type: 'feature' as UPGEntityType,
            title: 'Feature A',
            properties: { reach: 8, impact: 3, confidence: 0.8, effort: 4 },
          } as UPGBaseNode,
        ],
        [],
      ),
    )
    const ctx = makeCtx(store)

    const rice = await callAsync(
      prioritise,
      { candidates: ['feat_a'], framework_id: 'rice-scoring' },
      ctx,
    )
    expect(rice.body.execution_mode).toBe('execution_v0_4_0')

    // kano-model HAS computed_properties (satisfaction_coefficient), so it runs;
    // story-points-poker doesn't.
    const sp = await callAsync(
      prioritise,
      { candidates: ['feat_a'], framework_id: 'story-points-poker' },
      ctx,
    )
    expect(sp.body.execution_mode).toBe('definition_lookup_v0_4_0')
  })
})
