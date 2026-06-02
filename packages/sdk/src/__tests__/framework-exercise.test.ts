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
  scoreEntity,
} from '../index.js'
import { UPG_FRAMEWORKS_BY_ID } from '@unified-product-graph/frameworks'

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

  it('an exercise over a non-feature entity bypasses the type-mismatch guard', async () => {
    const { store } = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!

    // Without an exercise: a need is the wrong type → type_mismatch.
    const direct = executePrioritise(rice, ['n_need'], store)
    expect(direct.kind).toBe('type_mismatch')

    // Via an exercise: deliberately included, so it scores.
    const ex = applyFramework(store, { framework_id: 'rice-scoring', entity_ids: ['n_need'] })
    scoreEntity(store, { exercise_id: ex.exercise.id, entity_id: 'n_need', values: { reach: 500, impact: 2, confidence: 0.8, effort: 2 } })
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
