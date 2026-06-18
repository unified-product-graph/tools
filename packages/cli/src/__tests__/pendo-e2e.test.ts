/**
 * Pendo end-to-end import audit (convert-only adapter).
 *
 * Pendo's list() requires a live API; its convert() is the full import pipeline.
 * Representative records run through convert -> writeToUPGFile -> reload, then
 * conformanceIssues() asserts the result is spec-clean: valid UPG types, valid
 * per-type statuses, no off-schema fields, catalogued edge types with correct
 * endpoint types, and a clean round-trip.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { PendoAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new PendoAdapter() as unknown as AdapterLike

/**
 * Realistic Pendo payload grounded in Pendo's public API:
 *   app  -> page        : product_contains_screen
 *   page -> feature     : screen_surfaces_feature
 */
const ITEMS = [
  { source_id: 'app1', source_type: 'pendo_entity', title: 'Analytics Suite', metadata: { entity_type: 'app' } },
  {
    source_id: 'page1',
    source_type: 'pendo_entity',
    title: '/dashboard',
    metadata: { entity_type: 'page', parent_id: 'app1', parent_type: 'app', avg_time_on_page: 42 },
  },
  {
    source_id: 'feat1',
    source_type: 'pendo_entity',
    title: 'CSV Export Button',
    metadata: {
      entity_type: 'feature',
      parent_id: 'page1',
      parent_type: 'page',
      adoption_rate: 8.3,
      visitor_count: 1240,
      click_count: 430,
    },
  },
  {
    source_id: 'feat2',
    source_type: 'pendo_entity',
    title: 'Bulk Delete Action',
    metadata: { entity_type: 'feature', adoption_rate: 0, visitor_count: 88 },
  },
  { source_id: 'nps1', source_type: 'pendo_entity', title: 'NPS: Score 9 - love the export flow', metadata: { entity_type: 'nps_response' } },
  { source_id: 'fb1', source_type: 'pendo_entity', title: 'Bulk export to PDF', metadata: { entity_type: 'feedback' } },
  { source_id: 'seg1', source_type: 'pendo_entity', title: 'Power Users', metadata: { entity_type: 'segment' } },
]

const SKIP_ITEMS = [
  { source_id: 'g1', source_type: 'pendo_entity', title: 'Onboarding tour', metadata: { entity_type: 'guide' } },
  { source_id: 'ev1', source_type: 'pendo_entity', title: 'Button clicked', metadata: { entity_type: 'event' } },
  { source_id: 'path1', source_type: 'pendo_entity', title: 'Activation path', metadata: { entity_type: 'path' } },
  { source_id: 'rep1', source_type: 'pendo_entity', title: 'Retention report', metadata: { entity_type: 'report' } },
]

describe('Pendo e2e — convert conformance', () => {
  it('produces a spec-conformant graph (the main bar)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps each Pendo entity type to the correct UPG type', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const bySourceId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(bySourceId['app1']).toBe('product')
      expect(bySourceId['page1']).toBe('screen')
      expect(bySourceId['feat1']).toBe('feature')
      expect(bySourceId['feat2']).toBe('feature')
      expect(bySourceId['nps1']).toBe('customer_feedback')
      expect(bySourceId['fb1']).toBe('feature_request')
      expect(bySourceId['seg1']).toBe('market_segment')
    } finally {
      await out.cleanup()
    }
  })

  it('persists adoption_rate under properties (survives the round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const feat = out.rawDoc.nodes.find((n) => n.source_id === 'feat1') as Record<string, unknown>
      expect(feat.properties).toMatchObject({ adoption_rate: 8.3, visitor_count: 1240, click_count: 430 })
      expect(feat.adoption_rate).toBeUndefined()
      expect(feat.visitor_count).toBeUndefined()
      expect(feat.click_count).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('adoption_rate: 0 is persisted correctly under properties', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const feat = out.rawDoc.nodes.find((n) => n.source_id === 'feat2') as Record<string, unknown>
      expect(feat.properties).toMatchObject({ adoption_rate: 0 })
    } finally {
      await out.cleanup()
    }
  })

  it('analytics fields do not bleed onto non-feature nodes', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const screen = out.rawDoc.nodes.find((n) => n.source_id === 'page1') as Record<string, unknown>
      expect(screen.properties).toBeUndefined()
      const seg = out.rawDoc.nodes.find((n) => n.source_id === 'seg1') as Record<string, unknown>
      expect(seg.properties).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('market_segment carries no status (lifecycle-free type)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const seg = out.rawDoc.nodes.find((n) => n.source_id === 'seg1') as Record<string, unknown>
      expect(seg.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits product_contains_screen for app -> page hierarchy (correct endpoints)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const edge = out.rawDoc.edges.find((e) => e.type === 'product_contains_screen')
      expect(edge).toBeDefined()
      const srcNode = out.rawDoc.nodes.find((n) => n.id === edge!.source) as Record<string, unknown>
      const tgtNode = out.rawDoc.nodes.find((n) => n.id === edge!.target) as Record<string, unknown>
      expect(srcNode.type).toBe('product')
      expect(tgtNode.type).toBe('screen')
    } finally {
      await out.cleanup()
    }
  })

  it('emits screen_surfaces_feature for page -> feature hierarchy (correct endpoints)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const edge = out.rawDoc.edges.find((e) => e.type === 'screen_surfaces_feature')
      expect(edge).toBeDefined()
      const srcNode = out.rawDoc.nodes.find((n) => n.id === edge!.source) as Record<string, unknown>
      const tgtNode = out.rawDoc.nodes.find((n) => n.id === edge!.target) as Record<string, unknown>
      expect(srcNode.type).toBe('screen')
      expect(tgtNode.type).toBe('feature')
    } finally {
      await out.cleanup()
    }
  })

  it('feature_request_creates_opportunity has correct endpoints after type-map fix', async () => {
    const ITEMS_WITH_OPP = [
      { source_id: 'fb2', source_type: 'pendo_entity', title: 'Add dark mode', metadata: { entity_type: 'feedback' } },
      {
        source_id: 'opp1',
        source_type: 'pendo_entity',
        title: 'Users want dark mode',
        metadata: { entity_type: 'opportunity', parent_id: 'fb2', parent_type: 'feedback' },
      },
    ]
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS_WITH_OPP })
    try {
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
      const edge = out.rawDoc.edges.find((e) => e.type === 'feature_request_creates_opportunity')
      expect(edge).toBeDefined()
      const srcNode = out.rawDoc.nodes.find((n) => n.id === edge!.source) as Record<string, unknown>
      const tgtNode = out.rawDoc.nodes.find((n) => n.id === edge!.target) as Record<string, unknown>
      expect(srcNode.type).toBe('feature_request')
      expect(tgtNode.type).toBe('opportunity')
    } finally {
      await out.cleanup()
    }
  })

  it('skipped types (guide, event, path, report) produce no nodes', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: SKIP_ITEMS })
    try {
      expect(out.result.nodes).toHaveLength(0)
    } finally {
      await out.cleanup()
    }
  })
})
