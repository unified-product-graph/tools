/**
 * Quantive (Gtmhub) end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { QuantiveAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new QuantiveAdapter() as unknown as AdapterLike

/**
 * Fixture grounded in Quantive's OKR hierarchy:
 *   team -> objective -> key_result -> metric / initiative / task
 * Session is a timeframe container, skipped.
 */
const ITEMS = [
  { source_id: 't1', source_type: 'quantive', title: 'Product Team', metadata: { entity_type: 'team' } },
  {
    source_id: 'obj1',
    source_type: 'quantive',
    title: 'Grow activation',
    metadata: { entity_type: 'objective', status: 'on_track', parent_id: 't1', parent_type: 'team' },
  },
  {
    source_id: 'kr1',
    source_type: 'quantive',
    title: 'Activation rate to 60%',
    metadata: {
      entity_type: 'key_result',
      status: 'at_risk',
      parent_id: 'obj1',
      parent_type: 'objective',
      current_value: 38,
      target_value: 60,
      unit: '%',
    },
  },
  {
    source_id: 'm1',
    source_type: 'quantive',
    title: 'Weekly activation',
    metadata: { entity_type: 'metric', parent_id: 'kr1', parent_type: 'key_result', current_value: 38, unit: '%' },
  },
  {
    source_id: 'init1',
    source_type: 'quantive',
    title: 'Onboarding revamp',
    metadata: { entity_type: 'initiative', status: 'in_progress', parent_id: 'kr1', parent_type: 'key_result' },
  },
  {
    source_id: 'task1',
    source_type: 'quantive',
    title: 'Build setup wizard',
    metadata: { entity_type: 'task', status: 'done', parent_id: 'kr1', parent_type: 'key_result' },
  },
  { source_id: 'sess1', source_type: 'quantive', title: 'Q1 2026', metadata: { entity_type: 'session' } },
]

describe('Quantive e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, no off-schema fields)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps entity types correctly and skips sessions', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(t.t1).toBe('team')
      expect(t.obj1).toBe('objective')
      expect(t.kr1).toBe('key_result')
      expect(t.m1).toBe('metric')
      expect(t.init1).toBe('initiative')
      expect(t.task1).toBe('task')
      expect(t.sess1).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('resolves statuses to valid per-type phase ids (KR keeps its native status)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n]))
      // key_result lifecycle is on_track/at_risk/behind/achieved -> raw value is valid
      expect(byId.kr1.status).toBe('at_risk')
      // initiative/task keep their native in_progress/done phases
      expect(byId.init1.status).toBe('in_progress')
      expect(byId.task1.status).toBe('done')
      // metric and team are lifecycle-free -> no status
      expect(byId.m1.status).toBeUndefined()
      expect(byId.t1.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('nests key_result/metric numeric fields under properties, not top-level', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const kr = out.rawDoc.nodes.find((n) => n.source_id === 'kr1') as Record<string, unknown>
      expect(kr.current_value).toBeUndefined()
      expect(kr.target_value).toBeUndefined()
      expect(kr.unit).toBeUndefined()
      expect(kr.properties).toMatchObject({ current_value: 38, target_value: 60, unit: '%' })
    } finally {
      await out.cleanup()
    }
  })

  it('emits the two canonical OKR edges with correct direction', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const objEdge = out.result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
      expect(objEdge).toBeDefined()
      expect(objEdge?.source).toBe(out.result.nodes.find((n) => n.source_id === 'obj1')?.id)
      expect(objEdge?.target).toBe(out.result.nodes.find((n) => n.source_id === 'kr1')?.id)

      const krEdge = out.result.edges.find((e) => e.type === 'key_result_quantified_by_metric')
      expect(krEdge).toBeDefined()
      expect(krEdge?.source).toBe(out.result.nodes.find((n) => n.source_id === 'kr1')?.id)
      expect(krEdge?.target).toBe(out.result.nodes.find((n) => n.source_id === 'm1')?.id)
    } finally {
      await out.cleanup()
    }
  })

  it('falls back to node_informs_node for the wrong-endpoint pairs (team->objective, key_result->initiative/task)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const types = new Set(out.result.edges.map((e) => e.type))
      expect(types.has('node_informs_node')).toBe(true)
      // The old wrong-endpoint edges must NOT appear
      expect(types.has('team_targets_team_okr')).toBe(false)
      expect(types.has('team_okr_aligns_with_objective')).toBe(false)
      expect(types.has('initiative_drives_outcome')).toBe(false)
    } finally {
      await out.cleanup()
    }
  })
})
