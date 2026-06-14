/**
 * Classification-analysis assemblers (0.11.2, read-path-tooling brief #5/#6).
 * Proves `assembleComparison` joins two competitors axis-by-axis into
 * agree/diverge/single-side rows (the bridge to the parity layer), and
 * `aggregateEdgeProperties` digests a cross-edge property's distribution, both
 * overall and grouped by axis / competitor / value.
 */
import { describe, it, expect } from 'vitest'
import type { UPGPortfolioDocument } from '@unified-product-graph/core'
import { assembleComparison, aggregateEdgeProperties, findSingleSelectOverlaps } from '../lib/portfolio-landscape.js'

/**
 * Two axes (pricing wired by a registry edge, buyer wired by an `axis:` tag) and
 * one orphan value. Two competitors: they AGREE on pricing (both Paid), DIVERGE
 * on buyer (Enterprise vs Developer), and only Alpha is graded on the orphan
 * value (an a_only row, unaxed).
 */
function fixture(): UPGPortfolioDocument {
  return {
    $upg: { version: '0.11.2' },
    organization: { id: 'org', title: 'Org' },
    products: [
      { id: 'p_alpha', title: 'Alpha', nodes: [], edges: [] },
      { id: 'p_beta', title: 'Beta', nodes: [], edges: [] },
    ],
    registry: {
      nodes: [
        { id: 'classification_axis_pricing', type: 'classification_axis', title: 'Pricing Model' },
        { id: 'classification_axis_buyer', type: 'classification_axis', title: 'Primary Buyer' },
        { id: 'classification_value_free', type: 'classification_value', title: 'Free' },
        { id: 'classification_value_paid', type: 'classification_value', title: 'Paid' },
        { id: 'classification_value_dev', type: 'classification_value', title: 'Developer', tags: ['axis:buyer'] },
        { id: 'classification_value_ent', type: 'classification_value', title: 'Enterprise', tags: ['axis:buyer'] },
        { id: 'classification_value_orphan', type: 'classification_value', title: 'Orphan' },
        { id: 'competitor_sitecore', type: 'competitor', title: 'Sitecore' },
        { id: 'competitor_vercel', type: 'competitor', title: 'Vercel' },
      ],
      edges: [
        { id: 're1', source: 'classification_axis_pricing', target: 'classification_value_free', type: 'classification_axis_includes_classification_value' },
        { id: 're2', source: 'classification_axis_pricing', target: 'classification_value_paid', type: 'classification_axis_includes_classification_value' },
      ],
    },
    cross_edges: [
      { id: 'io1', source: 'p_alpha/n_a', target: 'registry/competitor_sitecore', type: 'instance_of', source_product_id: 'p_alpha', target_product_id: 'registry' },
      { id: 'io2', source: 'p_beta/n_b', target: 'registry/competitor_vercel', type: 'instance_of', source_product_id: 'p_beta', target_product_id: 'registry' },
      // Alpha (Sitecore): paid + enterprise + orphan
      { id: 'c1', source: 'p_alpha/n_a', target: 'registry/classification_value_paid', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'Confident' }, assessed_on: '2026-06-15' } },
      { id: 'c2', source: 'p_alpha/n_a', target: 'registry/classification_value_ent', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'Some evidence' } } },
      { id: 'c3', source: 'p_alpha/n_a', target: 'registry/classification_value_orphan', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 2, label: 'Hunch' } } },
      // Beta (Vercel): paid + developer
      { id: 'c4', source: 'p_beta/n_b', target: 'registry/classification_value_paid', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'Confident' } } },
      { id: 'c5', source: 'p_beta/n_b', target: 'registry/classification_value_dev', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'Some evidence' } } },
    ],
  } as unknown as UPGPortfolioDocument
}

describe('assembleComparison', () => {
  it('joins two competitors axis-by-axis: agree, diverge, and a_only', () => {
    const r = assembleComparison(fixture(), { a: 'p_alpha/n_a', b: 'p_beta/n_b' })
    expect(r.a?.title).toBe('Sitecore')
    expect(r.b?.title).toBe('Vercel')
    expect(r.stats).toMatchObject({ shared_axes: 2, agreements: 1, divergences: 1, a_only: 1, b_only: 0 })

    const pricing = r.axes.find((x) => x.axis === 'classification_axis_pricing')!
    expect(pricing.status).toBe('agree')
    expect(pricing.a[0]).toMatchObject({ value: 'classification_value_paid', value_label: 'Paid' })
    expect(pricing.b[0]).toMatchObject({ value: 'classification_value_paid' })

    const buyer = r.axes.find((x) => x.axis === 'classification_axis_buyer')!
    expect(buyer.status).toBe('diverge')
    expect(buyer.a[0].value_label).toBe('Enterprise')
    expect(buyer.b[0].value_label).toBe('Developer')

    const orphan = r.axes.find((x) => x.axis === null)!
    expect(orphan.status).toBe('a_only')
    expect(orphan.b).toHaveLength(0)
  })

  it('orders divergences before agreements (the actionable rows first)', () => {
    const r = assembleComparison(fixture(), { a: 'p_alpha/n_a', b: 'p_beta/n_b' })
    const shared = r.axes.filter((x) => x.status === 'agree' || x.status === 'diverge')
    expect(shared[0].status).toBe('diverge')
  })

  it('axis filter restricts the comparison to one axis', () => {
    const r = assembleComparison(fixture(), { a: 'p_alpha/n_a', b: 'p_beta/n_b', axis: 'classification_axis_pricing' })
    expect(r.axes).toHaveLength(1)
    expect(r.axes[0].axis).toBe('classification_axis_pricing')
    expect(r.stats.agreements).toBe(1)
  })

  it('returns a note when a subject id is missing', () => {
    const r = assembleComparison(fixture(), { a: 'p_alpha/n_a' })
    expect(r.note).toMatch(/requires both/i)
    expect(r.axes).toHaveLength(0)
  })
})

describe('aggregateEdgeProperties', () => {
  it('overall confidence distribution buckets by label', () => {
    const r = aggregateEdgeProperties(fixture(), { edge_type: 'competitor_classified_as_classification_value' })
    expect(r.total).toBe(5)
    expect(r.with_property).toBe(5)
    expect(r.without_property).toBe(0)
    // 3x Confident? no: Confident x2 (c1,c4), Some evidence x2 (c2,c5), Hunch x1 (c3)
    const byKey = Object.fromEntries(r.overall.map((b) => [b.key, b.count]))
    expect(byKey).toMatchObject({ Confident: 2, 'Some evidence': 2, Hunch: 1 })
    // descending count first
    expect(r.overall[0].count).toBeGreaterThanOrEqual(r.overall[r.overall.length - 1].count)
    expect(r.groups).toBeUndefined()
  })

  it('group_by axis splits the distribution per axis (unaxed last)', () => {
    const r = aggregateEdgeProperties(fixture(), { edge_type: 'competitor_classified_as_classification_value', group_by: 'axis' })
    expect(r.groups).toBeDefined()
    const pricing = r.groups!.find((g) => g.group === 'classification_axis_pricing')!
    expect(pricing.group_label).toBe('Pricing Model')
    expect(pricing.total).toBe(2)
    expect(pricing.distribution).toEqual([{ key: 'Confident', count: 2 }])
    // the orphan value has no axis -> unaxed bucket, sorted last
    expect(r.groups![r.groups!.length - 1].group).toBe('unaxed')
  })

  it('group_by competitor groups by the source node with resolved titles', () => {
    const r = aggregateEdgeProperties(fixture(), { edge_type: 'competitor_classified_as_classification_value', group_by: 'competitor' })
    const alpha = r.groups!.find((g) => g.group === 'p_alpha/n_a')!
    expect(alpha.group_label).toBe('Sitecore')
    expect(alpha.total).toBe(3)
  })

  it('counts edges missing the property under without_property', () => {
    const doc = fixture()
    doc.cross_edges!.push({
      id: 'c6', source: 'p_beta/n_b', target: 'registry/classification_value_free',
      type: 'competitor_classified_as_classification_value',
    } as never)
    const r = aggregateEdgeProperties(doc, { edge_type: 'competitor_classified_as_classification_value' })
    expect(r.total).toBe(6)
    expect(r.with_property).toBe(5)
    expect(r.without_property).toBe(1)
  })

  it('returns a note for an edge type with no edges', () => {
    const r = aggregateEdgeProperties(fixture(), { edge_type: 'feature_rivals_competitor_feature' })
    expect(r.total).toBe(0)
    expect(r.note).toMatch(/no cross-edges/i)
  })
})

describe('findSingleSelectOverlaps (0.11.3)', () => {
  it('returns [] when every source holds one value per single-select axis', () => {
    expect(findSingleSelectOverlaps(fixture())).toEqual([])
  })

  it('flags a source carrying two values on a single-select axis', () => {
    const doc = fixture()
    // Alpha now sits at BOTH Free and Paid on the (single-select) pricing axis.
    doc.cross_edges!.push({ id: 'c6', source: 'p_alpha/n_a', target: 'registry/classification_value_free', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'Some evidence' }, assessed_on: '2026-06-10' } } as never)
    const overlaps = findSingleSelectOverlaps(doc)
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]).toMatchObject({ source: 'p_alpha/n_a', source_title: 'Sitecore', axis: 'classification_axis_pricing' })
    expect(overlaps[0].values.map((v) => v.value).sort()).toEqual(['classification_value_free', 'classification_value_paid'])
  })

  it('exempts a multi-select axis', () => {
    const doc = fixture()
    // Mark the pricing axis multi-select, then double-classify Alpha on it.
    const axis = doc.registry!.nodes.find((n) => n.id === 'classification_axis_pricing')!
    ;(axis as { properties?: Record<string, unknown> }).properties = { cardinality: 'multi' }
    doc.cross_edges!.push({ id: 'c6', source: 'p_alpha/n_a', target: 'registry/classification_value_free', type: 'competitor_classified_as_classification_value' } as never)
    expect(findSingleSelectOverlaps(doc)).toEqual([])
  })
})
