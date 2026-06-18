/**
 * Aha! end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { AhaAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new AhaAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'prod1', source_type: 'aha', title: 'Acme Compass', metadata: { entity_type: 'product', status: 'planned' } },
  { source_id: 'init1', source_type: 'aha', title: 'Platform Modernisation', metadata: { entity_type: 'initiative', status: 'planned', parent_id: 'prod1', parent_type: 'product' } },
  { source_id: 'g1', source_type: 'aha', title: 'Reduce Technical Debt', metadata: { entity_type: 'goal', status: 'new', parent_id: 'init1', parent_type: 'initiative' } },
  { source_id: 'kr1', source_type: 'aha', title: 'Reduce p95 latency to 200ms', metadata: { entity_type: 'key_result', status: 'in-progress', parent_id: 'g1', parent_type: 'goal', key_result_current: 450, key_result_target: 200, key_result_unit: 'ms' } },
  { source_id: 'r1', source_type: 'aha', title: 'v2.0', metadata: { entity_type: 'release', status: 'planned' } },
  { source_id: 'f1', source_type: 'aha', title: 'Async job queue', metadata: { entity_type: 'feature', status: 'in-progress', parent_id: 'r1', parent_type: 'release' } },
  { source_id: 'e1', source_type: 'aha', title: 'Queue implementation', metadata: { entity_type: 'epic', status: 'in-progress', parent_id: 'f1', parent_type: 'feature' } },
  { source_id: 'req1', source_type: 'aha', title: 'Jobs must retry on failure', metadata: { entity_type: 'requirement', parent_id: 'e1', parent_type: 'epic' } },
  { source_id: 'p1', source_type: 'aha', title: 'The Enterprise PM', metadata: { entity_type: 'persona', parent_id: 'prod1', parent_type: 'product' } },
  { source_id: 'idea1', source_type: 'aha', title: 'Background processing idea', metadata: { entity_type: 'idea', status: 'new', idea_promoted_to_feature_id: 'f1' } },
]

describe('Aha! e2e — convert conformance', () => {
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
      expect(t.prod1).toBe('product')
      expect(t.init1).toBe('initiative')
      expect(t.g1).toBe('objective')
      expect(t.kr1).toBe('key_result')
      expect(t.r1).toBe('release')
      expect(t.f1).toBe('feature')
      expect(t.e1).toBe('epic')
      expect(t.req1).toBe('acceptance_criterion')
      expect(t.p1).toBe('persona')
      expect(t.idea1).toBe('feature_request')
    } finally {
      await out.cleanup()
    }
  })

  it('nests key_result fields under properties, not top-level', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const kr = out.rawDoc.nodes.find((n) => n.source_id === 'kr1') as Record<string, unknown>
      expect(kr.current_value).toBeUndefined()
      expect(kr.target_value).toBeUndefined()
      expect(kr.unit).toBeUndefined()
      expect(kr.properties).toMatchObject({ current_value: 450, target_value: 200, unit: 'ms' })
    } finally {
      await out.cleanup()
    }
  })

  it('emits catalogue-valid edges (and falls back to node_informs_node where no canonical edge exists)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const types = new Set(out.result.edges.map((e) => e.type))
      expect(types.has('product_invests_in_initiative')).toBe(true)
      expect(types.has('product_targets_persona')).toBe(true)
      expect(types.has('objective_achieved_through_key_result')).toBe(true)
      expect(types.has('release_contains_feature')).toBe(true)
      expect(types.has('feature_decomposed_into_epic')).toBe(true)
      expect(types.has('feature_request_creates_opportunity')).toBe(true)
      // initiative->objective and epic->acceptance_criterion have no canonical edge
      expect(types.has('node_informs_node')).toBe(true)
      // the wrong-endpoint edges must NOT appear
      expect(types.has('initiative_drives_outcome')).toBe(false)
      expect(types.has('outcome_delivered_by_feature')).toBe(false)
    } finally {
      await out.cleanup()
    }
  })
})
