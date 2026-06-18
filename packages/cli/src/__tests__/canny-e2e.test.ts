/**
 * Canny end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CannyAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new CannyAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'opp1', source_type: 'canny_entity', title: 'Users need faster export', metadata: { entity_type: 'opportunity' } },
  { source_id: 'opp2', source_type: 'canny_entity', title: 'Better customisation needed', metadata: { entity_type: 'opportunity' } },
  { source_id: 'p1', source_type: 'canny_entity', title: 'Add CSV export', metadata: { entity_type: 'post', status: 'planned', vote_count: 312, board_name: 'Feature Requests', parent_id: 'opp1' } },
  { source_id: 'p2', source_type: 'canny_entity', title: 'Add white-label branding', metadata: { entity_type: 'post', status: 'open', vote_count: 187, parent_id: 'opp2' } },
  { source_id: 'p3', source_type: 'canny_entity', title: 'Add dark mode', metadata: { entity_type: 'post', status: 'complete', vote_count: 421, tags: ['ui', 'accessibility'] } },
  { source_id: 'co1', source_type: 'canny_entity', title: 'Acme Corp', metadata: { entity_type: 'company' } },
]

describe('Canny e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, no off-schema fields)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps post -> feature_request and company -> account correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(t.p1).toBe('feature_request')
      expect(t.p2).toBe('feature_request')
      expect(t.p3).toBe('feature_request')
      expect(t.co1).toBe('account')
      expect(t.opp1).toBe('opportunity')
    } finally {
      await out.cleanup()
    }
  })

  it('preserves vote_count under properties (survives round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const p1 = out.rawDoc.nodes.find((n) => n.source_id === 'p1') as Record<string, unknown>
      expect(p1.properties).toMatchObject({ vote_count: 312 })
      expect(p1.vote_count).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits feature_request_creates_opportunity with correct endpoints (feature_request -> opportunity)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const oppEdges = out.result.edges.filter((e) => e.type === 'feature_request_creates_opportunity')
      expect(oppEdges.length).toBe(2)
      const nodeById = Object.fromEntries(out.result.nodes.map((n) => [n.id as string, n]))
      for (const e of oppEdges) {
        expect(nodeById[e.source as string]?.type).toBe('feature_request')
        expect(nodeById[e.target as string]?.type).toBe('opportunity')
      }
    } finally {
      await out.cleanup()
    }
  })
})
