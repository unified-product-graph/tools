/**
 * Productboard end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ProductboardAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new ProductboardAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'prod1', source_type: 'productboard', title: 'Entopo', metadata: { entity_type: 'product', status: 'in-progress' } },
  { source_id: 'comp1', source_type: 'productboard', title: 'Graph Engine', metadata: { entity_type: 'component', status: 'planned', parent_id: 'prod1', parent_type: 'product' } },
  { source_id: 'feat1', source_type: 'productboard', title: 'Graph diff view', metadata: { entity_type: 'feature', feature_type: 'feature', status: 'under-consideration', parent_id: 'comp1', parent_type: 'component' } },
  { source_id: 'bug1', source_type: 'productboard', title: 'Edge duplication on import', metadata: { entity_type: 'feature', feature_type: 'bug', status: 'in-progress', parent_id: 'comp1', parent_type: 'component' } },
  { source_id: 'sub1', source_type: 'productboard', title: 'Diff: node highlight pass', metadata: { entity_type: 'sub_feature', status: 'new', parent_id: 'feat1', parent_type: 'feature' } },
  { source_id: 'rel1', source_type: 'productboard', title: 'v0.9 Graph Foundations', metadata: { entity_type: 'release', status: 'planned' } },
  { source_id: 'feat2', source_type: 'productboard', title: 'Inline entity editor', metadata: { entity_type: 'feature', status: 'planned', parent_id: 'rel1', parent_type: 'release' } },
  { source_id: 'note1', source_type: 'productboard', title: 'Felix: I need a session diff', metadata: { entity_type: 'note', status: 'new', note_linked_feature_ids: ['feat1'] } },
  { source_id: 'init1', source_type: 'productboard', title: 'Graph Observability', metadata: { entity_type: 'initiative', status: 'planned' } },
  { source_id: 'obj1', source_type: 'productboard', title: 'Trace any decision to evidence', metadata: { entity_type: 'objective', status: 'new', parent_id: 'init1', parent_type: 'initiative' } },
]

describe('Productboard e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps feature sub-types + strategy/feedback types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t.prod1).toBe('product')
      expect(t.comp1).toBe('feature_area')
      expect(t.feat1).toBe('feature')
      expect(t.bug1).toBe('bug')
      expect(t.sub1).toBe('epic')
      expect(t.rel1).toBe('release')
      expect(t.note1).toBe('customer_feedback')
      expect(t.init1).toBe('initiative')
      expect(t.obj1).toBe('objective')
    } finally {
      await out.cleanup()
    }
  })
})
