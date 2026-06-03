/**
 * Framework exercises (UPG 0.8.4): apply a framework, record results on the
 * `includes` edge, and prioritise from those edges instead of node properties.
 *
 * Each test loads a fresh throwaway `.upg` so the file-backed store behaves
 * exactly as it does for an SDK consumer (and so the save/load round-trip
 * exercises the real canonical serializer).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  UPGFileStore,
  createEdge,
  executePrioritise,
  applyFramework,
  applyFrameworkEnvelope,
  scoreEntity,
} from '../index.js'
// Canonical public surface (core) — the frameworks the runtime actually serves.
// 0.8.6 broadened RICE/ICE/WSJF/cost-of-delay declared targets in this surface.
import { UPG_FRAMEWORKS_BY_ID } from '@unified-product-graph/core'

const INCLUDES = 'framework_exercise_includes_node'

function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.4',
      product: { id: 'p_test', title: 'TestProduct' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-02T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'TestProduct' },
    nodes: [
      { id: 'n_sso', type: 'feature', title: 'SSO login', slug: 'sso-login', status: 'proposed' },
      { id: 'n_dark', type: 'feature', title: 'Dark mode', slug: 'dark-mode', status: 'proposed' },
      { id: 'n_feat', type: 'feature', title: 'Export', slug: 'export', status: 'proposed' },
      { id: 'n_sol', type: 'solution', title: 'A solution', slug: 'a-solution', status: 'proposed' },
      { id: 'n_need', type: 'need', title: 'Right portions', slug: 'right-portions', status: 'raw' },
    ],
    edges: [],
  }
}

async function freshStore(): Promise<{ store: UPGFileStore; file: string }> {
  const file = path.join(os.tmpdir(), `upg-fx-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(file, JSON.stringify(fixtureDoc()))
  const store = new UPGFileStore()
  await store.load(file)
  return { store, file }
}

describe('applyFramework', () => {
  it('creates a framework_exercise node + one includes edge per entity', async () => {
    const { store } = await freshStore()
    const res = applyFramework(store, { framework_id: 'moscow', title: 'Q3 Release Scope', entity_ids: ['n_sso', 'n_dark'] })
    expect(res.exercise.type).toBe('framework_exercise')
    expect(res.exercise.title).toBe('Q3 Release Scope')
    expect((res.exercise.properties as { framework_id?: string }).framework_id).toBe('moscow')
    expect(res.exercise.status).toBe('draft')
    expect(res.edges).toHaveLength(2)
    expect(res.edges.every((e) => e.type === INCLUDES && e.source === res.exercise.id)).toBe(true)
    expect(res.warnings).toEqual([])
  })

  it('rejects an unknown framework id', async () => {
    const { store } = await freshStore()
    expect(() => applyFramework(store, { framework_id: 'not-a-framework', entity_ids: [] })).toThrow(/Unknown framework/)
  })

  it('warns when an entity is not a declared target type, but still includes it (M3)', async () => {
    const { store } = await freshStore()
    // n_sol is a `solution`; rice targets feature/opportunity/need, not solution.
    const res = applyFramework(store, { framework_id: 'rice-scoring', entity_ids: ['n_sol'] })
    expect(res.edges).toHaveLength(1)
    expect(res.warnings.join(' ')).toMatch(/not a declared target type/)
  })

  it('rolls back and throws when no requested entity resolves (M4)', async () => {
    const { store } = await freshStore()
    const before = store.getAllNodes().filter((n) => n.type === 'framework_exercise').length
    expect(() =>
      applyFramework(store, { framework_id: 'moscow', entity_ids: ['nope_1', 'nope_2'] }),
    ).toThrow(/No entities could be included/)
    const after = store.getAllNodes().filter((n) => n.type === 'framework_exercise').length
    expect(after).toBe(before) // no dangling empty exercise
  })

  it('applyFrameworkEnvelope is the shared cross-surface shape MCP and CLI both emit (M1)', async () => {
    const { store } = await freshStore()
    const result = applyFramework(store, { framework_id: 'moscow', entity_ids: ['n_sso', 'n_dark'] })
    const env = applyFrameworkEnvelope(result)
    expect(env.exercise_id).toBe(result.exercise.id)
    expect(env.exercise.id).toBe(result.exercise.id)
    expect(env.warnings).toEqual(result.warnings)
    expect(env.included).toEqual(
      result.edges.map((e) => ({ edge_id: e.id, entity_id: e.target, edge_type: e.type })),
    )
    expect(env.included.every((i) => i.edge_type === INCLUDES)).toBe(true)
  })
})

describe('slot roles (Phase 3b-2)', () => {
  it('applyFramework stamps slot_role onto the includes edge + surfaces it in the envelope', async () => {
    const { store } = await freshStore()
    const res = applyFramework(store, {
      framework_id: 'value-proposition-canvas',
      entity_ids: ['n_sso', 'n_dark'],
      slot_roles: { n_sso: 'pain_reliever', n_dark: 'gain_creator' },
    })
    const ssoEdge = res.edges.find((e) => e.target === 'n_sso')
    expect((ssoEdge?.properties as { slot_role?: string }).slot_role).toBe('pain_reliever')
    const env = applyFrameworkEnvelope(res)
    expect(env.included.find((i) => i.entity_id === 'n_sso')?.slot_role).toBe('pain_reliever')
    expect(env.included.find((i) => i.entity_id === 'n_dark')?.slot_role).toBe('gain_creator')
    expect(res.warnings).toEqual([])
  })

  it('warns on an undeclared slot_role but stores it (permissive)', async () => {
    const { store } = await freshStore()
    const res = applyFramework(store, {
      framework_id: 'value-proposition-canvas',
      entity_ids: ['n_sso'],
      slot_roles: { n_sso: 'not_a_role' },
    })
    expect(res.warnings.join(' ')).toMatch(/not a declared slot role/)
    const e = res.edges.find((x) => x.target === 'n_sso')
    expect((e?.properties as { slot_role?: string }).slot_role).toBe('not_a_role') // stored anyway
  })

  it('scoreEntity merges slot_role without flagging it as an unknown input key', async () => {
    const { store } = await freshStore()
    // ice-scoring carries BOTH input keys (impact/confidence/ease) and slot roles.
    const res = applyFramework(store, { framework_id: 'ice-scoring', entity_ids: ['n_sso'] })
    const scored = scoreEntity(store, {
      exercise_id: res.exercise.id,
      entity_id: 'n_sso',
      values: { impact: 5, confidence: 4, ease: 3 },
      slot_role: 'candidate',
    })
    expect('error' in scored).toBe(false)
    if (!('error' in scored)) {
      const props = scored.edge.properties as { slot_role?: string; impact?: number }
      expect(props.slot_role).toBe('candidate')
      expect(props.impact).toBe(5)
      // slot_role is checked against slot roles, not scoring inputs → no false warning.
      expect(scored.warnings.join(' ')).not.toMatch(/not declared/)
    }
  })

  it('scoreEntity warns on an undeclared slot_role but stores it', async () => {
    const { store } = await freshStore()
    const res = applyFramework(store, { framework_id: 'ice-scoring', entity_ids: ['n_sso'] })
    const scored = scoreEntity(store, {
      exercise_id: res.exercise.id,
      entity_id: 'n_sso',
      values: {},
      slot_role: 'bogus_role',
    })
    expect('error' in scored).toBe(false)
    if (!('error' in scored)) {
      expect(scored.warnings.join(' ')).toMatch(/not a declared slot role/)
      expect((scored.edge.properties as { slot_role?: string }).slot_role).toBe('bogus_role')
    }
  })
})

describe('gated edge properties', () => {
  it('rejects properties on a non-carrying (plain semantic) edge', async () => {
    const { store } = await freshStore()
    const r = createEdge(store, { source_id: 'n_sol', target_id: 'n_feat', properties: { x: 1 } })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/does not carry properties/)
  })

  it('allows properties on the includes edge', async () => {
    const { store } = await freshStore()
    const ex = applyFramework(store, { framework_id: 'moscow', entity_ids: [] })
    const r = createEdge(store, { source_id: ex.exercise.id, target_id: 'n_sso', type: INCLUDES, properties: { moscow: 'must' } })
    expect('edge' in r).toBe(true)
    if ('edge' in r) expect((r.edge.properties as { moscow?: string }).moscow).toBe('must')
  })
})

describe('scoreEntity', () => {
  it('records a result on the includes edge, and two exercises over the same entity never conflict', async () => {
    const { store } = await freshStore()
    const q3 = applyFramework(store, { framework_id: 'moscow', title: 'Q3', entity_ids: ['n_dark'] })
    const q4 = applyFramework(store, { framework_id: 'moscow', title: 'Q4', entity_ids: ['n_dark'] })

    const r3 = scoreEntity(store, { exercise_id: q3.exercise.id, entity_id: 'n_dark', values: { moscow: 'could' } })
    const r4 = scoreEntity(store, { exercise_id: q4.exercise.id, entity_id: 'n_dark', values: { moscow: 'must' } })
    expect('edge' in r3 && 'edge' in r4).toBe(true)

    const edges = store.getEdgesForNode('n_dark').filter((e) => e.type === INCLUDES)
    const q3edge = edges.find((e) => e.source === q3.exercise.id)!
    const q4edge = edges.find((e) => e.source === q4.exercise.id)!
    expect((q3edge.properties as { moscow: string }).moscow).toBe('could')
    expect((q4edge.properties as { moscow: string }).moscow).toBe('must')

    // The feature node itself carries NO moscow property — the whole point.
    const dark = store.getNode('n_dark')!
    expect(dark.properties?.moscow).toBeUndefined()
  })

  it('auto-includes an entity that was not in the original scope', async () => {
    const { store } = await freshStore()
    const ex = applyFramework(store, { framework_id: 'moscow', entity_ids: [] })
    const r = scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_sso', values: { moscow: 'should' } })
    expect('edge' in r).toBe(true)
    const edges = store.getEdgesForNode('n_sso').filter((e) => e.type === INCLUDES)
    expect(edges).toHaveLength(1)
    expect((edges[0].properties as { moscow: string }).moscow).toBe('should')
  })

  it('warns on value keys the framework does not declare (but still stores them)', async () => {
    const { store } = await freshStore()
    const ex = applyFramework(store, { framework_id: 'moscow', entity_ids: ['n_sso'] })
    const r = scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_sso', values: { moscow: 'must', bogus: 1 } })
    expect('edge' in r).toBe(true)
    if ('edge' in r) expect(r.warnings.join(' ')).toMatch(/bogus/)
  })

  it('warns on out-of-scale and wrong-type values for declared inputs, but still stores (M2)', async () => {
    const { store } = await freshStore()
    const ex = applyFramework(store, { framework_id: 'rice-scoring', entity_ids: ['n_sso'] })
    // reach is assessment on reach_5 (1..5) → 999 is out of scale; impact expects a number → "high" is wrong type.
    const r = scoreEntity(store, {
      exercise_id: ex.exercise.id,
      entity_id: 'n_sso',
      values: { reach: 999, impact: 'high' },
    })
    expect('edge' in r).toBe(true)
    if ('edge' in r) {
      const w = r.warnings.join(' ')
      expect(w).toMatch(/reach.*(scale|outside)/)
      expect(w).toMatch(/impact.*number/)
      // permissive: the bad values are still stored
      expect((r.edge.properties as { reach?: number }).reach).toBe(999)
    }
  })
})

describe('exercise-aware executePrioritise', () => {
  it('sources inputs from the includes edges, not node.properties', async () => {
    const { store } = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!
    const ex = applyFramework(store, { framework_id: 'rice-scoring', entity_ids: ['n_sso', 'n_dark'] })
    // n_dark scores higher than n_sso, purely from edge data.
    scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_sso', values: { reach: 100, impact: 1, confidence: 0.5, effort: 5 } })
    scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_dark', values: { reach: 1000, impact: 3, confidence: 0.9, effort: 1 } })

    // Empty candidate list → derived from the exercise's includes edges.
    const r = executePrioritise(rice, [], store, { exerciseId: ex.exercise.id })
    expect(r.kind).toBe('execution')
    if (r.kind === 'execution') {
      expect(r.ranked[0].entity_id).toBe('n_dark')
      expect(r.ranked[0].score).toBeGreaterThan(r.ranked[1].score ?? 0)
    }
    // Node properties were never touched.
    expect(store.getNode('n_sso')!.properties?.reach).toBeUndefined()
  })

  it('an exercise over an off-target entity bypasses the type-mismatch guard', async () => {
    const { store } = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!

    // n_sol is a `solution` — still NOT a RICE target after the 0.8.6 broadening
    // (which added opportunity/need, not solution). Direct path → type_mismatch.
    const direct = executePrioritise(rice, ['n_sol'], store)
    expect(direct.kind).toBe('type_mismatch')

    // Via an exercise: deliberately included, so the guard is bypassed and it scores.
    const ex = applyFramework(store, { framework_id: 'rice-scoring', entity_ids: ['n_sol'] })
    scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_sol', values: { reach: 500, impact: 2, confidence: 0.8, effort: 2 } })
    const viaExercise = executePrioritise(rice, [], store, { exerciseId: ex.exercise.id })
    expect(viaExercise.kind).toBe('execution')
  })
})

describe('round-trip', () => {
  it('edge properties survive a save and reload via the canonical serializer', async () => {
    const { store, file } = await freshStore()
    const ex = applyFramework(store, { framework_id: 'moscow', entity_ids: ['n_sso'] })
    scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_sso', values: { moscow: 'must' } })
    await store.flush()

    const reloaded = new UPGFileStore()
    await reloaded.load(file)
    const edge = reloaded.getEdgesForNode('n_sso').find((e) => e.type === INCLUDES)!
    expect(edge).toBeDefined()
    expect((edge.properties as { moscow: string }).moscow).toBe('must')
  })
})
