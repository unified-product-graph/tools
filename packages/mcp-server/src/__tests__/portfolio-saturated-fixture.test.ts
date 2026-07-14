/**
 * Guards the `portfolio-saturated` fixture (test-fixtures/portfolio-saturated/)
 * against silent drift. Reads the pre-generated files directly rather than
 * re-running `scripts/build-portfolio-saturated.ts` (that script exercises the
 * live write surface against a real tmp workspace; this test only checks the
 * committed output still has the shape the README promises). Regenerate with
 * `npx tsx scripts/build-portfolio-saturated.ts` after a spec change, then
 * re-run this test to confirm the invariants still hold.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_DIR = join(__dirname, '..', '..', 'test-fixtures', 'portfolio-saturated', '.upg')

function readJson(relPath: string): any {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), 'utf-8'))
}

describe('portfolio-saturated fixture', () => {
  const portfolio = readJson('portfolio.upg')
  const workspace = readJson('workspace.json')

  it('registers all 13 products in workspace.json, spread across subfolders', () => {
    expect(workspace.products).toHaveLength(13)
    const memberKinds = workspace.products.map((p: any) => p.member_kind ?? 'product')
    expect(memberKinds.filter((k: string) => k === 'product')).toHaveLength(7)
    expect(memberKinds.filter((k: string) => k === 'watched')).toHaveLength(3)
    expect(memberKinds.filter((k: string) => k === 'operating_function')).toHaveLength(2)
    expect(memberKinds.filter((k: string) => k === 'org_rollup')).toHaveLength(1)
  })

  it('covers all 5 portfolio kinds, with one nested portfolio', () => {
    expect(portfolio.portfolios).toHaveLength(5)
    const kinds = new Set(portfolio.portfolios.map((p: any) => p.kind))
    expect(kinds).toEqual(new Set(['owned', 'strategic', 'gtm', 'internal', 'watched']))
    expect(portfolio.portfolios.some((p: any) => p.parent_portfolio_id)).toBe(true)
  })

  it('has 4 product areas with one nested under another', () => {
    expect(portfolio.product_areas).toHaveLength(4)
    expect(portfolio.product_areas.some((a: any) => a.parent_area_id)).toBe(true)
  })

  it('has a canonical registry with an instance_of + sanctioned alias', () => {
    expect(portfolio.registry.nodes.length).toBeGreaterThanOrEqual(9)
    const instanceOfEdges = portfolio.cross_edges.filter((e: any) => e.type === 'instance_of')
    expect(instanceOfEdges.length).toBeGreaterThanOrEqual(3)
    expect(instanceOfEdges.some((e: any) => e.alias === true)).toBe(true)
  })

  it('exercises a broad spread of cross-product edge types', () => {
    const types = new Set(portfolio.cross_edges.map((e: any) => e.type))
    expect(types.size).toBeGreaterThanOrEqual(35)
    // spot-check one from each category rather than asserting the full list.
    for (const t of ['shares_persona', 'depends_on_product', 'rolls_up_to', 'instance_of', 'feature_rivals_competitor_feature', 'node_owned_by_team']) {
      expect(types.has(t)).toBe(true)
    }
  })

  it('emitted exactly one reclassification signal (GitLab on the Deployment Model axis)', () => {
    expect(portfolio.signals).toHaveLength(1)
    expect(portfolio.signals[0].properties.signal_type).toBe('reclassification')
    // Product ids are minted by create_product, so resolve GitLab's id from
    // workspace.json by title rather than hard-coding it, then assert the
    // signal's competitor reference is qualified with that product.
    const gitlabEntry = workspace.products.find((p: any) => /gitlab/i.test(p.title))
    expect(gitlabEntry).toBeTruthy()
    const gitlabId = readJson(gitlabEntry.file).product.id
    expect(portfolio.signals[0].properties.competitor).toContain(gitlabId)
  })

  it('kept the org_rollup product outside every portfolio and area', () => {
    const orgId = workspace.products.find((p: any) => p.member_kind === 'org_rollup').file
      ? readJson(workspace.products.find((p: any) => p.member_kind === 'org_rollup').file).product.id
      : null
    for (const pf of portfolio.portfolios) expect(pf.products ?? []).not.toContain(orgId)
    for (const area of portfolio.product_areas) expect(area.products ?? []).not.toContain(orgId)
  })
})
