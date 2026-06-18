/**
 * Coda end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live Coda API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CodaAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new CodaAdapter() as unknown as AdapterLike

/**
 * Realistic Coda fixture grounded in Coda's public API shape.
 *
 * Each item represents a Coda table row:
 * - source_type: 'table_row' (Coda's row object type)
 * - metadata.table_name: the Coda table the row belongs to
 * - metadata.lookup_fields: Coda Lookup column values (cross-table relations)
 * - metadata.status: a Coda Select column used as status
 * - metadata.current_value / target_value / unit: KR/metric numeric columns
 */
const ITEMS = [
  // ── Strategy layer ────────────────────────────────────────────────────────
  {
    source_id: 'obj1',
    source_type: 'table_row',
    title: 'Grow activation to 60%',
    metadata: { table_name: 'OKRs', status: 'In Progress' },
  },
  {
    source_id: 'kr1',
    source_type: 'table_row',
    title: 'Weekly activation rate',
    metadata: {
      table_name: 'Key Results',
      status: 'In Progress',
      current_value: 38,
      target_value: 60,
      unit: '%',
    },
  },
  {
    source_id: 'init1',
    source_type: 'table_row',
    title: 'Onboarding revamp initiative',
    metadata: { table_name: 'Initiatives', status: 'In Progress' },
  },
  {
    source_id: 'm1',
    source_type: 'table_row',
    title: 'Daily active users',
    metadata: {
      table_name: 'Metrics',
      current_value: 1200,
      target_value: 2000,
      unit: 'users',
      lookup_fields: [
        { column_name: 'Key Result', target_row_id: 'kr1', target_table: 'Key Results' },
      ],
    },
  },
  // ── Discovery layer ───────────────────────────────────────────────────────
  {
    source_id: 'opp1',
    source_type: 'table_row',
    title: 'Users stuck at step 3 of onboarding',
    metadata: { table_name: 'Opportunities', status: 'Validated' },
  },
  {
    source_id: 'sol1',
    source_type: 'table_row',
    title: 'Guided setup wizard',
    metadata: {
      table_name: 'Solutions',
      status: 'In Progress',
      lookup_fields: [
        { column_name: 'Opportunity', target_row_id: 'opp1', target_table: 'Opportunities' },
      ],
    },
  },
  // ── Delivery layer ────────────────────────────────────────────────────────
  {
    source_id: 'rel1',
    source_type: 'table_row',
    title: 'v2.0',
    metadata: { table_name: 'Releases', status: 'Planned' },
  },
  {
    source_id: 'epic1',
    source_type: 'table_row',
    title: 'Onboarding epic',
    metadata: { table_name: 'Epics', status: 'In Progress' },
  },
  {
    source_id: 'feat1',
    source_type: 'table_row',
    title: 'Step-by-step wizard',
    metadata: {
      table_name: 'Features',
      status: 'In Progress',
      external_url: 'https://coda.io/d/feature-123',
      lookup_fields: [
        { column_name: 'Release', target_row_id: 'rel1', target_table: 'Releases' },
      ],
    },
  },
  {
    source_id: 'story1',
    source_type: 'table_row',
    title: 'As a new user I can complete setup in 5 minutes',
    metadata: {
      table_name: 'Stories',
      lookup_fields: [
        { column_name: 'Epic', target_row_id: 'epic1', target_table: 'Epics' },
      ],
    },
  },
  // ── Research / user layer ─────────────────────────────────────────────────
  {
    source_id: 'persona1',
    source_type: 'table_row',
    title: 'Growth-stage PM',
    metadata: { table_name: 'Personas' },
  },
]

describe('Coda e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, no off-schema fields)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps all entity types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(t.obj1).toBe('objective')
      expect(t.kr1).toBe('key_result')
      expect(t.init1).toBe('initiative')
      expect(t.m1).toBe('metric')
      expect(t.opp1).toBe('opportunity')
      expect(t.sol1).toBe('solution')
      expect(t.rel1).toBe('release')
      expect(t.epic1).toBe('epic')
      expect(t.feat1).toBe('feature')
      expect(t.story1).toBe('user_story')
      expect(t.persona1).toBe('persona')
    } finally {
      await out.cleanup()
    }
  })

  it('nests metric/key_result numeric fields under properties, not top-level', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const kr = out.rawDoc.nodes.find((n) => n.source_id === 'kr1') as Record<string, unknown>
      expect(kr.current_value).toBeUndefined()
      expect(kr.target_value).toBeUndefined()
      expect(kr.unit).toBeUndefined()
      expect(kr.properties).toMatchObject({ current_value: 38, target_value: 60, unit: '%' })

      const m = out.rawDoc.nodes.find((n) => n.source_id === 'm1') as Record<string, unknown>
      expect(m.current_value).toBeUndefined()
      expect(m.properties).toMatchObject({ current_value: 1200, target_value: 2000, unit: 'users' })
    } finally {
      await out.cleanup()
    }
  })

  it('converts external_url to external_ref (canonical field)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const feat = out.rawDoc.nodes.find((n) => n.source_id === 'feat1') as Record<string, unknown>
      expect(feat.external_url).toBeUndefined()
      expect(feat.external_ref).toBe('https://coda.io/d/feature-123')
    } finally {
      await out.cleanup()
    }
  })

  it('emits catalogue-valid edges with correct source/target direction', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const edgeTypes = new Set(out.result.edges.map((e) => e.type))
      // key_result → metric: source=key_result node, target=metric node
      expect(edgeTypes.has('key_result_quantified_by_metric')).toBe(true)
      const krEdge = out.result.edges.find((e) => e.type === 'key_result_quantified_by_metric')
      expect(krEdge).toBeDefined()
      const krNode = out.result.nodes.find((n) => n.source_id === 'kr1')
      const mNode = out.result.nodes.find((n) => n.source_id === 'm1')
      expect(krEdge?.source).toBe(krNode?.id)
      expect(krEdge?.target).toBe(mNode?.id)

      // opportunity → solution: source=opportunity, target=solution
      expect(edgeTypes.has('opportunity_drives_solution')).toBe(true)
      const oppEdge = out.result.edges.find((e) => e.type === 'opportunity_drives_solution')
      const oppNode = out.result.nodes.find((n) => n.source_id === 'opp1')
      const solNode = out.result.nodes.find((n) => n.source_id === 'sol1')
      expect(oppEdge?.source).toBe(oppNode?.id)
      expect(oppEdge?.target).toBe(solNode?.id)

      // release → feature: source=release, target=feature
      expect(edgeTypes.has('release_contains_feature')).toBe(true)
      const relEdge = out.result.edges.find((e) => e.type === 'release_contains_feature')
      const relNode = out.result.nodes.find((n) => n.source_id === 'rel1')
      const featNode = out.result.nodes.find((n) => n.source_id === 'feat1')
      expect(relEdge?.source).toBe(relNode?.id)
      expect(relEdge?.target).toBe(featNode?.id)

      // epic → user_story: source=epic, target=user_story
      expect(edgeTypes.has('epic_specified_by_user_story')).toBe(true)
      const epicEdge = out.result.edges.find((e) => e.type === 'epic_specified_by_user_story')
      const epicNode = out.result.nodes.find((n) => n.source_id === 'epic1')
      const storyNode = out.result.nodes.find((n) => n.source_id === 'story1')
      expect(epicEdge?.source).toBe(epicNode?.id)
      expect(epicEdge?.target).toBe(storyNode?.id)
    } finally {
      await out.cleanup()
    }
  })

  it('emits per-type valid statuses only (omits invalid statuses for lifecycle-free types)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      // persona is lifecycle-free: must have no status
      const persona = out.rawDoc.nodes.find((n) => n.source_id === 'persona1')
      expect(persona?.status).toBeUndefined()

      // user_story is lifecycle-free: must have no status
      const story = out.rawDoc.nodes.find((n) => n.source_id === 'story1')
      expect(story?.status).toBeUndefined()

      // metric is lifecycle-free: must have no status
      const metric = out.rawDoc.nodes.find((n) => n.source_id === 'm1')
      expect(metric?.status).toBeUndefined()

      // feature 'In Progress' → valid feature phase 'in_progress'
      const feat = out.rawDoc.nodes.find((n) => n.source_id === 'feat1')
      expect(feat?.status).toBe('in_progress')

      // release 'Planned' → valid release phase 'planned'
      const rel = out.rawDoc.nodes.find((n) => n.source_id === 'rel1')
      expect(rel?.status).toBe('planned')

      // epic 'In Progress' → valid epic phase 'in_progress'
      const epic = out.rawDoc.nodes.find((n) => n.source_id === 'epic1')
      expect(epic?.status).toBe('in_progress')
    } finally {
      await out.cleanup()
    }
  })
})
