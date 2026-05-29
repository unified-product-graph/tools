/**
 * Pendo Adapter Tests
 *
 * Covers all entity type mappings, edge emission from parent/child relationships,
 * status normalisation, feature adoption data preservation, and warning emission
 * including the unique Pendo feature adoption note.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { PendoAdapter } from '../adapters/pendo.js'
import type { SourceItem } from '../types.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

function makeEntity(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'pendo_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new PendoAdapter()

// ─── Type mapping ─────────────────────────────────────────────────────────────

describe('PendoAdapter: entity type → UPG type mapping', () => {
  it('feature maps to feature with confidence high: the unique direct match', async () => {
    const items: SourceItem[] = [makeEntity('f1', 'CSV Export Button', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('pendo')
  })

  it('page maps to screen with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('p1', 'Dashboard', 'page')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('screen')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('nps_response maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('nps1', 'NPS response: Love it', 'nps_response')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feedback maps to feature_request with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('fb1', 'Add dark mode', 'feedback')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_request')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('portfolio maps to product with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('port1', 'My App', 'portfolio')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('product')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('app maps to product with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('app1', 'Analytics App', 'app')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('product')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('segment maps to market_segment with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('seg1', 'Power Users', 'segment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('market_segment')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Feature adoption data: unique to Pendo ──────────────────────────────────

describe('PendoAdapter: feature adoption data', () => {
  it('adoption_rate is preserved on feature nodes', async () => {
    const items: SourceItem[] = [
      makeEntity('f1', 'CSV Export Button', 'feature', { adoption_rate: 23.5 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.adoption_rate).toBe(23.5)
  })

  it('adoption_rate warning is emitted noting Pendo uniqueness', async () => {
    const items: SourceItem[] = [
      makeEntity('f1', 'Export Button', 'feature', { adoption_rate: 12 }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('adoption data')
    expect(warnText).toContain('only analytics tool')
    expect(warnText).toContain('traceability')
  })

  it('feature without adoption_rate does not emit adoption warning', async () => {
    const items: SourceItem[] = [makeEntity('f1', 'Feature without data', 'feature')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).not.toContain('adoption data')
  })

  it('adoption_rate is NOT applied to non-feature entities', async () => {
    const items: SourceItem[] = [
      makeEntity('p1', 'Dashboard', 'page', { adoption_rate: 80 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    // page → screen should not have adoption_rate
    expect(node.adoption_rate).toBeUndefined()
  })

  it('adoption_rate of zero is correctly preserved', async () => {
    const items: SourceItem[] = [
      makeEntity('f1', 'Unused feature', 'feature', { adoption_rate: 0 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.adoption_rate).toBe(0)
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('PendoAdapter: skipped types with warnings', () => {
  it('guide is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeEntity('g1', 'Onboarding tour', 'guide'),
      makeEntity('f1', 'Dashboard button', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('guide')
    expect(warnText).toContain('no UPG equivalent')
  })

  it('event (behavioral) is skipped with a warning explaining why', async () => {
    const items: SourceItem[] = [makeEntity('ev1', 'Button clicked', 'event')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('event')
    expect(warnText).toContain('behavioral events')
  })

  it('path (usage analysis) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('path1', 'Activation path', 'path')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('report is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('rep1', 'Retention report', 'report')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('PendoAdapter: status normalisation', () => {
  it("status 'active' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('f1', 'Feature', 'feature', { status: 'active' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'inactive' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [
      makeEntity('f1', 'Deprecated feature', 'feature', { status: 'inactive' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [
      makeEntity('f1', 'Unreleased feature', 'feature', { status: 'draft' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })
})

// ─── avg_time_on_page tag ─────────────────────────────────────────────────────

describe('PendoAdapter: avg_time_on_page tag on screen nodes', () => {
  it('avg_time_on_page is preserved as a tag on screen nodes', async () => {
    const items: SourceItem[] = [
      makeEntity('p1', 'Dashboard', 'page', { avg_time_on_page: 45 }),
    ]
    const result = await adapter.convert(items)
    const tags = result.nodes[0].tags ?? []
    expect(tags.some((t) => t.includes('avg_time_on_page') && t.includes('45'))).toBe(true)
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('PendoAdapter: edge emission', () => {
  it('product_contains_screen emitted when page has portfolio parent', async () => {
    const items: SourceItem[] = [
      makeEntity('port1', 'My App', 'portfolio'),
      makeEntity('p1', 'Dashboard', 'page', {
        parent_id: 'port1',
        parent_type: 'portfolio',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_contains_screen')
    const edge = result.edges.find((e) => e.type === 'product_contains_screen')
    expect(edge).toBeDefined()
  })

  it('product_contains_screen emitted when page has app parent', async () => {
    const items: SourceItem[] = [
      makeEntity('app1', 'Analytics App', 'app'),
      makeEntity('p1', 'Reports Page', 'page', {
        parent_id: 'app1',
        parent_type: 'app',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_contains_screen (app)')
    const edge = result.edges.find((e) => e.type === 'product_contains_screen')
    expect(edge).toBeDefined()
  })

  it('feature_request_creates_opportunity emitted when opportunity has feedback parent', async () => {
    const items: SourceItem[] = [
      makeEntity('fb1', 'Add dark mode', 'feedback'),
      makeEntity('opp1', 'Users want dark mode', 'opportunity', {
        parent_id: 'fb1',
        parent_type: 'feedback',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_request_creates_opportunity')
    const edge = result.edges.find((e) => e.type === 'feature_request_creates_opportunity')
    expect(edge).toBeDefined()
  })

  it('outcome_delivered_by_feature emitted when feature has outcome parent', async () => {
    const items: SourceItem[] = [
      makeEntity('out1', 'Increase weekly active use to 30%', 'outcome'),
      makeEntity('f1', 'Export Button', 'feature', {
        parent_id: 'out1',
        parent_type: 'outcome',
        adoption_rate: 12,
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_delivered_by_feature')
    const edge = result.edges.find((e) => e.type === 'outcome_delivered_by_feature')
    expect(edge).toBeDefined()
  })

  it('screen_surfaces_feature emitted when feature has page parent', async () => {
    const items: SourceItem[] = [
      makeEntity('p1', 'Dashboard', 'page'),
      makeEntity('f1', 'Export Button', 'feature', {
        parent_id: 'p1',
        parent_type: 'page',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'screen_surfaces_feature')
    const edge = result.edges.find((e) => e.type === 'screen_surfaces_feature')
    expect(edge).toBeDefined()
  })

  it('node_informs_node fallback for unrecognised parent/child pair', async () => {
    const items: SourceItem[] = [
      makeEntity('seg1', 'Power Users', 'segment'),
      makeEntity('nps1', 'NPS response', 'nps_response', {
        parent_id: 'seg1',
        parent_type: 'segment',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_informs_node fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('assertAllEdgesCatalogued: full fixture test', async () => {
    const items: SourceItem[] = [
      makeEntity('app1', 'Analytics App', 'app'),
      makeEntity('p1', 'Dashboard', 'page', { parent_id: 'app1', parent_type: 'app' }),
      makeEntity('f1', 'Export Button', 'feature', {
        parent_id: 'p1',
        parent_type: 'page',
        adoption_rate: 23.5,
      }),
      makeEntity('fb1', 'Add more export formats', 'feedback'),
      makeEntity('nps1', 'NPS: Score 9', 'nps_response'),
      makeEntity('seg1', 'Power Users', 'segment'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'PendoAdapter full fixture')
    // app→page (product_contains_screen), page→feature (screen_surfaces_feature)
    expect(result.edges.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Source map and external fields ───────────────────────────────────────────

describe('PendoAdapter: source_map and external fields', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeEntity('app1', 'My App', 'app'),
      makeEntity('f1', 'Export Button', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['app1']).toBeDefined()
    expect(result.source_map['f1']).toBeDefined()
  })

  it('skipped entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeEntity('g1', 'Tour', 'guide')]
    const result = await adapter.convert(items)
    expect(result.source_map['g1']).toBeUndefined()
  })

  it('external_tool is always pendo', async () => {
    const items: SourceItem[] = [makeEntity('f1', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('pendo')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeEntity('pendo-feat-42', 'Export Button', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('pendo-feat-42')
  })
})
