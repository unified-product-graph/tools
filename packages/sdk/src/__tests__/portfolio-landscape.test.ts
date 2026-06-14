/**
 * Portfolio classification-landscape assembly (0.10.7). Proves the landscape /
 * competitor_profile shapes assemble from portfolio cross-edges + the shared
 * registry, that titles resolve via the registry and `instance_of` (no opaque
 * ids), that axis resolution honours both the registry edge and the `axis:` tag
 * (and buckets the rest as `unaxed`), and that the whole-portfolio overview is
 * counts-only by default.
 */
import { describe, it, expect } from 'vitest'
import type { UPGPortfolioDocument } from '@unified-product-graph/core'
import {
  assembleLandscape,
  assembleCompetitorProfile,
  buildPortfolioNodeIndex,
  buildValueAxisMap,
} from '../lib/portfolio-landscape.js'

/**
 * A two-axis portfolio: axis A is wired by a registry edge, axis B by an
 * `axis:` tag, and one value is wired by neither (it must land in `unaxed`).
 * Two products each hold one competitor, registered to a registry canonical.
 */
function fixture(): UPGPortfolioDocument {
  return {
    $upg: { version: '0.10.7' },
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
        // axis-by-tag (no registry edge)
        { id: 'classification_value_dev', type: 'classification_value', title: 'Developer', tags: ['axis:buyer'] },
        // orphan value: neither edge nor tag
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
      // product competitor nodes -> registry canonicals
      { id: 'io1', source: 'p_alpha/n_a', target: 'registry/competitor_sitecore', type: 'instance_of', source_product_id: 'p_alpha', target_product_id: 'registry' },
      { id: 'io2', source: 'p_beta/n_b', target: 'registry/competitor_vercel', type: 'instance_of', source_product_id: 'p_beta', target_product_id: 'registry' },
      // classifications
      { id: 'c1', source: 'p_alpha/n_a', target: 'registry/classification_value_free', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'high' }, assessed_on: '2026-06-15' } },
      { id: 'c2', source: 'p_alpha/n_a', target: 'registry/classification_value_dev', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'medium' } } },
      { id: 'c3', source: 'p_alpha/n_a', target: 'registry/classification_value_orphan', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 2, label: 'low' } } },
      { id: 'c4', source: 'p_beta/n_b', target: 'registry/classification_value_paid', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 5, label: 'high' } } },
    ],
  } as unknown as UPGPortfolioDocument
}

describe('buildPortfolioNodeIndex', () => {
  it('resolves registry canonicals and product-local nodes via instance_of', () => {
    const idx = buildPortfolioNodeIndex(fixture())
    expect(idx.get('registry/competitor_sitecore')?.title).toBe('Sitecore')
    // product-local node resolves to its canonical title without a product file
    expect(idx.get('p_alpha/n_a')?.title).toBe('Sitecore')
    expect(idx.get('p_beta/n_b')?.title).toBe('Vercel')
  })

  it('lets an explicit extra ref override the instance_of-resolved title', () => {
    const idx = buildPortfolioNodeIndex(fixture(), [
      { id: 'p_alpha/n_a', bare_id: 'n_a', type: 'competitor', title: 'Sitecore XM Cloud', product_id: 'p_alpha' },
    ])
    expect(idx.get('p_alpha/n_a')?.title).toBe('Sitecore XM Cloud')
  })
})

describe('buildValueAxisMap', () => {
  it('resolves via the registry edge, the axis tag, and leaves orphans unmapped', () => {
    const m = buildValueAxisMap(fixture())
    expect(m.get('classification_value_free')).toMatchObject({ axis: 'classification_axis_pricing', via: 'registry_edge' })
    expect(m.get('classification_value_dev')).toMatchObject({ axis: 'classification_axis_buyer', label: 'Primary Buyer', via: 'axis_tag' })
    expect(m.has('classification_value_orphan')).toBe(false)
  })
})

describe('assembleLandscape', () => {
  it('whole portfolio is counts-only by default (no members inlined)', () => {
    const r = assembleLandscape(fixture())
    expect(r.stats.members_included).toBe(false)
    expect(r.axes.flatMap((a) => a.values).every((v) => v.members.length === 0)).toBe(true)
    // 4 classify edges over 4 distinct values
    expect(r.stats.members).toBe(4)
    expect(r.stats.total_edges).toBe(4)
    expect(r.note).toMatch(/counts only/i)
  })

  it('buckets axis-less values under a null (unaxed) axis', () => {
    const r = assembleLandscape(fixture())
    const unaxed = r.axes.find((a) => a.axis === null)
    expect(unaxed).toBeDefined()
    expect(unaxed!.values.map((v) => v.value)).toContain('classification_value_orphan')
    // real axes come before the unaxed bucket
    expect(r.axes[r.axes.length - 1].axis).toBeNull()
  })

  it('anchored at a value inlines its members with confidence + resolved titles', () => {
    const r = assembleLandscape(fixture(), { from_id: 'registry/classification_value_free' })
    expect(r.anchor?.title).toBe('Free')
    expect(r.stats.members_included).toBe(true)
    const members = r.axes.flatMap((a) => a.values).flatMap((v) => v.members)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ title: 'Sitecore' })
    expect((members[0].confidence as { label: string }).label).toBe('high')
    expect(members[0].assessed_on).toBe('2026-06-15')
  })

  it('anchored at an axis returns only that axis values', () => {
    const r = assembleLandscape(fixture(), { from_id: 'registry/classification_axis_pricing' })
    expect(r.stats.axes).toBe(1)
    const values = r.axes.flatMap((a) => a.values).map((v) => v.value).sort()
    expect(values).toEqual(['classification_value_free', 'classification_value_paid'])
  })

  it('include_members forces members on the whole portfolio', () => {
    const r = assembleLandscape(fixture(), { include_members: true })
    expect(r.stats.members_included).toBe(true)
    expect(r.axes.flatMap((a) => a.values).some((v) => v.members.length > 0)).toBe(true)
  })

  it('reports an empty landscape with a note when no classify edges exist', () => {
    const doc = fixture()
    doc.cross_edges = doc.cross_edges!.filter((e) => e.type === 'instance_of')
    const r = assembleLandscape(doc)
    expect(r.stats.total_edges).toBe(0)
    expect(r.note).toMatch(/no classification edges/i)
  })
})

describe('assembleCompetitorProfile', () => {
  it('profiles a registry canonical by aggregating its product instance positions', () => {
    const r = assembleCompetitorProfile(fixture(), { from_id: 'registry/competitor_sitecore' })
    expect(r.subject?.title).toBe('Sitecore')
    // Sitecore (p_alpha/n_a) is classified at free, dev, orphan
    expect(r.stats.positions).toBe(3)
    const byValue = Object.fromEntries(r.positions.map((p) => [p.value, p.axis_label]))
    expect(byValue['classification_value_free']).toBe('Pricing Model')
    expect(byValue['classification_value_dev']).toBe('Primary Buyer')
    expect(byValue['classification_value_orphan']).toBeNull() // unaxed
  })

  it('returns a note (no positions) when from_id is omitted', () => {
    const r = assembleCompetitorProfile(fixture(), {})
    expect(r.stats.positions).toBe(0)
    expect(r.note).toMatch(/requires from_id/i)
  })
})
