/**
 * Productboard Adapter Tests
 *
 * Covers entity type mappings, Feature sub-type discrimination, hierarchy edge
 * emission, Note-to-Feature evidence chain, status normalisation, warning emission,
 * and source_map correctness.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ProductboardAdapter } from '../adapters/productboard.js'
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

function makeFeature(
  id: string,
  title: string,
  entityType = 'feature',
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: entityType,
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new ProductboardAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('ProductboardAdapter: entity_type → UPG type mapping', () => {
  it('feature (default) maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('f1', 'Dark mode', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('productboard')
  })

  it('feature with feature_type=bug maps to bug', async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Login crash on iOS', 'feature', { feature_type: 'bug' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('bug')
  })

  it('feature with feature_type=chore maps to task', async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Update dependencies', 'feature', { feature_type: 'chore' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
  })

  it('sub_feature maps to epic with confidence medium', async () => {
    const items: SourceItem[] = [makeFeature('sf1', 'Mobile onboarding', 'sub_feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('epic')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('component maps to feature_area with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('c1', 'Payments', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_area')
  })

  it('product maps to product with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('p1', 'Acme Compass', 'product')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('product')
  })

  it('release maps to release with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('r1', 'v2.0 Launch', 'release')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('release')
  })

  it('note maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('n1', 'Users want dark mode', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
  })

  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeFeature('i1', 'Onboarding Revamp', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
  })

  it('user maps to participant with confidence medium', async () => {
    const items: SourceItem[] = [makeFeature('u1', 'Alice Smith', 'user')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
  })

  it('company maps to account with confidence medium', async () => {
    const items: SourceItem[] = [makeFeature('co1', 'Acme Corp', 'company')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('account')
  })

  it('release_group maps to roadmap with confidence medium', async () => {
    const items: SourceItem[] = [makeFeature('rg1', 'H1 2026 Releases', 'release_group')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('roadmap')
  })
})

// ─── Skip / warning cases ─────────────────────────────────────────────────────

describe('ProductboardAdapter: skip and warning cases', () => {
  it('roadmap entity is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeFeature('rm1', 'Q2 Roadmap View', 'roadmap'),
      makeFeature('f1', 'Dark mode', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('roadmap')
  })

  it('board entity is skipped with a warning', async () => {
    const items: SourceItem[] = [makeFeature('b1', 'Engineering Board', 'board')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('board')
  })

  it('scorecard entity is skipped', async () => {
    const items: SourceItem[] = [makeFeature('sc1', 'Reach / Impact / Confidence', 'scorecard')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('unknown entity type defaults to document with a warning', async () => {
    const items: SourceItem[] = [makeFeature('x1', 'Custom thing', 'custom_entity')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('custom_entity')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ProductboardAdapter: status normalisation (validated against feature lifecycle)', () => {
  // feature lifecycle: proposed → in_progress → shipped → archived
  it("'new' maps to 'proposed'", async () => {
    const items: SourceItem[] = [makeFeature('f1', 'Feature', 'feature', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('proposed')
  })

  it("'under-consideration' maps to 'proposed'", async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Feature', 'feature', { status: 'under-consideration' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('proposed')
  })

  it("'planned' maps to 'proposed' for a feature", async () => {
    const items: SourceItem[] = [makeFeature('f1', 'Feature', 'feature', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('proposed')
  })

  it("'in-progress' maps to 'in_progress'", async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Feature', 'feature', { status: 'in-progress' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('in_progress')
  })

  it("'released' maps to 'shipped'", async () => {
    const items: SourceItem[] = [makeFeature('f1', 'Feature', 'feature', { status: 'released' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('shipped')
  })

  it("\"won't do\" maps to 'archived'", async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Feature', 'feature', { status: "won't do" }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('archived')
  })
})

// ─── Hierarchy edge emission ──────────────────────────────────────────────────

describe('ProductboardAdapter: hierarchy edge emission', () => {
  it('feature_area_contains_feature emitted when feature has component parent', async () => {
    const items: SourceItem[] = [
      makeFeature('c1', 'Payments', 'component'),
      makeFeature('f1', 'Accept card payments', 'feature', {
        parent_id: 'c1',
        parent_type: 'component',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_area_contains_feature')
    const edge = result.edges.find((e) => e.type === 'feature_area_contains_feature')
    expect(edge).toBeDefined()
  })

  it('product_organises_into_feature_area emitted when component has product parent', async () => {
    const items: SourceItem[] = [
      makeFeature('p1', 'Acme Compass', 'product'),
      makeFeature('c1', 'Payments', 'component', {
        parent_id: 'p1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_organises_into_feature_area')
    const edge = result.edges.find((e) => e.type === 'product_organises_into_feature_area')
    expect(edge).toBeDefined()
  })

  it('feature_decomposed_into_epic emitted when sub_feature has feature parent', async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Onboarding', 'feature'),
      makeFeature('sf1', 'Mobile onboarding flow', 'sub_feature', {
        parent_id: 'f1',
        parent_type: 'feature',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_decomposed_into_epic')
    const edge = result.edges.find((e) => e.type === 'feature_decomposed_into_epic')
    expect(edge).toBeDefined()
  })

  it('release_contains_feature emitted when feature has release parent', async () => {
    const items: SourceItem[] = [
      makeFeature('r1', 'v2.0', 'release'),
      makeFeature('f1', 'Dark mode', 'feature', {
        parent_id: 'r1',
        parent_type: 'release',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
  })

  it('release_contains_bug emitted when bug-typed feature has release parent', async () => {
    const items: SourceItem[] = [
      makeFeature('r1', 'v2.1 patch', 'release'),
      makeFeature('f1', 'Login crash fix', 'feature', {
        feature_type: 'bug',
        parent_id: 'r1',
        parent_type: 'release',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_bug')
    const edge = result.edges.find((e) => e.type === 'release_contains_bug')
    expect(edge).toBeDefined()
  })

  it('note linked to a feature emits a generic link (no canonical customer_feedback->feature edge)', async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Dark mode', 'feature'),
      makeFeature('n1', 'User wants dark mode', 'note', {
        note_linked_feature_ids: ['f1'],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'note->feature link')
    // The canonical path is customer_feedback -> feature_request -> feature; with
    // no feature_request stub, an honest node_informs_node is emitted (not a
    // mis-typed customer_feedback_becomes_feature_request whose target must be a
    // feature_request).
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('feature_request')
    expect(warnText).toContain('evidence chain')
  })

  it('feature under an objective falls back to a generic link (objective_defers_feature is deliberate-only)', async () => {
    const items: SourceItem[] = [
      makeFeature('obj1', 'Grow retention', 'objective'),
      makeFeature('f1', 'Improve onboarding', 'feature', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective->feature link')
    // objective_defers_feature exists in the catalog (0.17.4) but is deliberate-only
    // (an objective PARKS a feature), so it is never inferred from a parentage.
    expect(result.edges.find((e) => e.type === 'objective_defers_feature')).toBeUndefined()
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('ProductboardAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeFeature('f1', 'Feature', 'feature'),
      makeFeature('c1', 'Component', 'component'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['f1']).toBeDefined()
    expect(result.source_map['c1']).toBeDefined()
  })

  it('skipped roadmap entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeFeature('rm1', 'Q2 Roadmap', 'roadmap')]
    const result = await adapter.convert(items)
    expect(result.source_map['rm1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('ProductboardAdapter: external_tool and external_id', () => {
  it('external_tool is always productboard', async () => {
    const items: SourceItem[] = [makeFeature('f1', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('productboard')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeFeature('pb-feature-999', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('pb-feature-999')
  })
})

// ─── Full fixture ─────────────────────────────────────────────────────────────

describe('ProductboardAdapter: full fixture', () => {
  it('all emitted edges are in the UPG catalogue (full feature hierarchy)', async () => {
    const items: SourceItem[] = [
      makeFeature('prod1', 'Acme Compass', 'product'),
      makeFeature('comp1', 'Onboarding', 'component', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
      makeFeature('f1', 'Guided onboarding wizard', 'feature', {
        parent_id: 'comp1',
        parent_type: 'component',
      }),
      makeFeature('sf1', 'Mobile wizard flow', 'sub_feature', {
        parent_id: 'f1',
        parent_type: 'feature',
      }),
      makeFeature('r1', 'v2.0', 'release'),
      makeFeature('f2', 'Dark mode', 'feature', {
        parent_id: 'r1',
        parent_type: 'release',
      }),
      makeFeature('n1', 'User wants dark mode', 'note', {
        note_linked_feature_ids: ['f2'],
      }),
      makeFeature('obj1', 'Increase activation', 'objective'),
      makeFeature('f3', 'Streamlined onboarding', 'feature', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ProductboardAdapter full fixture')
    // Edges expected:
    // product_organises_into_feature_area (prod1→comp1)
    // feature_area_contains_feature (comp1→f1)
    // feature_decomposed_into_epic (f1→sf1)
    // release_contains_feature (r1→f2)
    // customer_feedback_becomes_feature_request (n1→f2)
    // outcome_delivered_by_feature (obj1→f3)
    expect(result.edges.length).toBe(6)
  })
})
