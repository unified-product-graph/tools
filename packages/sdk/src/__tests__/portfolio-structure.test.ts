/**
 * Portfolio structure assembly (0.17.3): the org-chart shape rendered purely from
 * portfolio document fields (organisation, product areas, portfolios, products),
 * with no graph traversal. Nesting, dual membership, dangling/cyclic parents, and
 * unassigned products.
 */
import { describe, it, expect } from 'vitest'
import type { UPGPortfolioDocument } from '@unified-product-graph/core'
import { assembleStructure, type StructureNode } from '../lib/portfolio-structure.js'

const doc = (over: Partial<UPGPortfolioDocument>): UPGPortfolioDocument =>
  ({
    upg_version: '0.2.4',
    exported_at: '2026-07-01T00:00:00Z',
    source: { tool: 'test', tool_version: '0.0.0' },
    organization: { id: 'org_ark', title: 'Arkheiev UG' },
    product_areas: [],
    portfolios: [],
    products: [],
    cross_edges: [],
    ...over,
  }) as unknown as UPGPortfolioDocument

const kidTitles = (n: StructureNode | undefined) => (n?.children ?? []).map((c) => c.title)
const find = (n: StructureNode, id: string): StructureNode | undefined => {
  if (n.id === id) return n
  for (const c of n.children ?? []) {
    const hit = find(c, id)
    if (hit) return hit
  }
  return undefined
}

describe('assembleStructure', () => {
  it('roots at the organisation and nests areas -> sub-areas -> products', () => {
    const s = assembleStructure(
      doc({
        product_areas: [
          { id: 'a_plat', title: 'Platform', products: ['entopo'] },
          { id: 'a_billing', title: 'Billing', parent_area_id: 'a_plat', products: ['billing'] },
        ],
        products: [
          { id: 'entopo', title: 'Entopo', stage: 'beta' },
          { id: 'billing', title: 'Billing Service' },
        ] as never,
      }),
    )
    expect(s.shape).toBe('structure')
    expect(s.root).toMatchObject({ id: 'org_ark', title: 'Arkheiev UG', kind: 'organization' })
    const platform = find(s.root, 'a_plat')!
    expect(platform.kind).toBe('product_area')
    // Platform has a sub-area (Billing) and a member product (Entopo).
    expect(kidTitles(platform).sort()).toEqual(['Billing', 'Entopo'])
    const entopo = find(s.root, 'entopo')!
    expect(entopo).toMatchObject({ kind: 'product', stage: 'beta' })
    const billingArea = find(s.root, 'a_billing')!
    expect(billingArea.children?.some((c) => c.id === 'billing')).toBe(true)
    expect(s.stats).toMatchObject({ areas: 2, portfolios: 0, products: 2, unassigned_products: 0 })
  })

  it('nests portfolios and lets a product appear under both an area and a portfolio', () => {
    const s = assembleStructure(
      doc({
        product_areas: [{ id: 'a_plat', title: 'Platform', products: ['entopo'] }],
        portfolios: [
          { id: 'pf_growth', title: 'Growth Bets', kind: 'strategic', products: ['entopo'] },
          { id: 'pf_new', title: 'New Bets', parent_portfolio_id: 'pf_growth', products: [] },
        ],
        products: [{ id: 'entopo', title: 'Entopo' }] as never,
      }),
    )
    const growth = find(s.root, 'pf_growth')!
    expect(growth).toMatchObject({ kind: 'portfolio', portfolio_kind: 'strategic' })
    // entopo appears under BOTH the area and the portfolio (dual membership).
    const entopoNodes: StructureNode[] = []
    const collect = (n: StructureNode) => {
      if (n.id === 'entopo') entopoNodes.push(n)
      n.children?.forEach(collect)
    }
    collect(s.root)
    expect(entopoNodes.length).toBe(2)
    // sub-portfolio nests under its parent
    expect(growth.children?.some((c) => c.id === 'pf_new')).toBe(true)
    // entopo is assigned (in an area and a portfolio), so not unassigned.
    expect(s.stats.unassigned_products).toBe(0)
  })

  it('surfaces a registered product with no area/portfolio as an unassigned org-level leaf', () => {
    const s = assembleStructure(
      doc({
        product_areas: [{ id: 'a_plat', title: 'Platform', products: ['entopo'] }],
        products: [
          { id: 'entopo', title: 'Entopo' },
          { id: 'orphan', title: 'Orphan Tool' },
        ] as never,
      }),
    )
    // orphan hangs directly off the org root.
    expect(s.root.children?.some((c) => c.id === 'orphan' && c.kind === 'product')).toBe(true)
    expect(s.stats.unassigned_products).toBe(1)
  })

  it('marks a product id referenced but not registered as unregistered, titled by its id', () => {
    const s = assembleStructure(
      doc({
        product_areas: [{ id: 'a_plat', title: 'Platform', products: ['ghost'] }],
        products: [],
      }),
    )
    const ghost = find(s.root, 'ghost')!
    expect(ghost).toMatchObject({ kind: 'product', title: 'ghost', unregistered: true })
  })

  it('treats a dangling parent as top-level and does not loop on a cyclic parent', () => {
    const s = assembleStructure(
      doc({
        product_areas: [
          { id: 'a_orphan', title: 'Orphan Area', parent_area_id: 'a_missing' },
          // a two-node cycle: x -> y -> x
          { id: 'a_x', title: 'X', parent_area_id: 'a_y' },
          { id: 'a_y', title: 'Y', parent_area_id: 'a_x' },
        ],
      }),
    )
    // Dangling parent -> surfaced at the org root, not dropped.
    expect(find(s.root, 'a_orphan')).toBeDefined()
    // Cycle does not hang or duplicate infinitely; both nodes are reachable once.
    expect(find(s.root, 'a_x')).toBeDefined()
    expect(find(s.root, 'a_y')).toBeDefined()
    expect(s.stats.areas).toBe(3)
  })
})
