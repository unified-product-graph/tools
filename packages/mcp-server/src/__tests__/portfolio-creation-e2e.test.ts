/**
 * MCP E2E test for portfolio creation.
 *
 * Runs the real fixture builder (`buildPortfolioSaturated`, the same function
 * the CLI regenerates the committed fixture from) in-process against a throwaway
 * tmp workspace, then asserts on the live portfolio read/validate handler output.
 * The builder drives the actual tool surface end-to-end — init_workspace →
 * create_product ×N → create_area / create_portfolio → attach / assign →
 * batch_create_nodes / _edges → create_cross_product_edge / register_instance /
 * create_parity_edge / create_classification_edge — so a green run proves the
 * portfolio write path composes correctly, not merely that a committed JSON blob
 * has the right shape (that's portfolio-saturated-fixture.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPortfolioSaturated } from '../testing/build-portfolio-saturated.js'

const workDir = mkdtempSync(join(tmpdir(), 'upg-portfolio-e2e-'))
const originalCwd = process.cwd()

// One build, many assertions. buildPortfolioSaturated chdirs into workDir for
// the duration and restores cwd on completion (asserted below).
const built = await buildPortfolioSaturated(workDir)

function readUpgJson(relPath: string): any {
  return JSON.parse(readFileSync(join(workDir, '.upg', relPath), 'utf-8'))
}

describe('portfolio creation E2E (drives the real MCP write surface)', () => {
  it('restores the original cwd after building', () => {
    expect(process.cwd()).toBe(originalCwd)
  })

  it('materialised a workspace with 13 members spread across the member_kinds', () => {
    const workspace = readUpgJson('workspace.json')
    expect(workspace.products).toHaveLength(13)
    const kinds = workspace.products.map((p: any) => p.member_kind ?? 'product')
    expect(kinds.filter((k: string) => k === 'product')).toHaveLength(7)
    expect(kinds.filter((k: string) => k === 'watched')).toHaveLength(3)
    expect(kinds.filter((k: string) => k === 'operating_function')).toHaveLength(2)
    expect(kinds.filter((k: string) => k === 'org_rollup')).toHaveLength(1)
  })

  it('create_product seeded a real product node in each product graph', () => {
    // The fix that killed the prod() hack: the product node id === product id.
    const jira = readUpgJson('products/jira.upg')
    const productNode = jira.nodes.find((n: any) => n.type === 'product')
    expect(productNode).toBeTruthy()
    expect(productNode.id).toBe(jira.product.id)
  })

  it('portfolio_validate reports a non-uniform state across all 13 members', () => {
    const r = built.validation.rollup
    expect(r.products).toBe(13)
    expect(r.valid + r.invalid).toBe(13)
    expect(r.all_valid).toBe(false)
    expect(r.structurally_valid).toBe(13) // every graph is schema-valid; findings are content-level
  })

  it('fires the deliberate operating-function violations on Support Operations', () => {
    const support = built.validation.products.find((p: any) => p.title === 'Support Operations')
    expect(support).toBeTruthy()
    const ids = (support.top_violations ?? []).map((v: any) => v.anti_pattern_id)
    expect(ids).toContain('operating-function-without-north-star')
    // portfolio-scoped counterpart shows up in the portfolio anti-pattern block
    const portfolioViolations = (built.validation.portfolio_anti_patterns?.violations ?? []).map(
      (v: any) => v.anti_pattern_id,
    )
    expect(portfolioViolations).toContain('operating-function-without-org-link')
  })

  it('keeps the registry clean (instances resolve, no drift)', () => {
    expect(built.validation.registry_drift.clean).toBe(true)
    expect(built.validation.registry_drift.canonical_entities).toBeGreaterThanOrEqual(9)
  })

  it('rolls the structure up correctly (4 areas, 5 portfolios, 13 products)', () => {
    expect(built.tree.stats.areas).toBe(4)
    expect(built.tree.stats.portfolios).toBe(5)
    expect(built.tree.stats.products).toBe(13)
    // org_rollup sits outside every portfolio/area.
    expect(built.tree.stats.unassigned_products).toBe(1)
  })

  it('emitted exactly one reclassification signal from the double-classify write', () => {
    const portfolio = readUpgJson('portfolio.upg')
    expect(portfolio.signals).toHaveLength(1)
    expect(portfolio.signals[0].properties.signal_type).toBe('reclassification')
  })

  it('wrote the fixture files into the conventional subfolders', () => {
    expect(existsSync(join(workDir, '.upg', 'products', 'jira.upg'))).toBe(true)
    expect(existsSync(join(workDir, '.upg', 'competitors', 'competitor-gitlab.upg'))).toBe(true)
    expect(existsSync(join(workDir, '.upg', 'design-system', 'atlassian-design-system.upg'))).toBe(true)
    expect(existsSync(join(workDir, '.upg', 'web-ecosystem', 'atlassian-com.upg'))).toBe(true)
    expect(existsSync(join(workDir, '.upg', 'atlassian-corp.upg'))).toBe(true) // org rollup at root
  })
})

// cleanup
process.on('exit', () => {
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})
