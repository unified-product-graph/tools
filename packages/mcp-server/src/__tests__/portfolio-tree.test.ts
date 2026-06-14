/**
 * get_portfolio_tree + list_portfolio_cross_edges enhancements (0.10.7).
 *
 * The portfolio-grain classification read surface (read-path brief):
 *  - get_portfolio_tree assembles the landscape (axis -> value -> members) and a
 *    competitor_profile, resolving titles via the registry + instance_of so
 *    output names entities, not opaque ids.
 *  - list_portfolio_cross_edges resolves titles, projects properties, and
 *    paginates, so the 218-edge matrix reads back agent-usably.
 *
 * Runs against a real tmp workspace; handlers read process.cwd().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { getPortfolioTree } from '../tools/portfolio-read.js'
import { listPortfolioCrossEdges } from '../tools/workspace.js'

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return {
    upg_version: '0.10',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    nodes: [],
    edges: [],
    ...over,
  }
}

// Active product: a watched competitor graph holding two competitor nodes.
const RIVAL = doc({
  product: { id: 'p_rival', title: 'Rival Watch', stage: 'concept' },
  nodes: [
    { id: 'n_acme', type: 'competitor', title: 'Acme Local Name' },
    { id: 'n_globex', type: 'competitor', title: 'Globex Local Name' },
  ],
  edges: [],
})

// Portfolio: 1 axis wired by registry edge, 1 value wired by `axis:` tag, 1 orphan.
const PORTFOLIO = {
  upg_version: '0.10',
  exported_at: new Date().toISOString(),
  source: { tool: 'test' },
  type: 'portfolio',
  organization: { id: 'org1', title: 'Co' },
  product_areas: [],
  portfolios: [],
  products: [{ id: 'p_rival', file_path: '.upg/rival.upg', title: 'Rival Watch' }],
  registry: {
    nodes: [
      { id: 'ca_ai', type: 'classification_axis', title: 'AI Maturity' },
      { id: 'cv_agentic', type: 'classification_value', title: 'Agentic' },
      { id: 'cv_integrated', type: 'classification_value', title: 'Integrated' },
      { id: 'cv_dev', type: 'classification_value', title: 'Developer', tags: ['axis:buyer'] },
      { id: 'ca_buyer', type: 'classification_axis', title: 'Primary Buyer' },
      { id: 'cv_orphan', type: 'classification_value', title: 'Orphan' },
      { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
      { id: 'competitor_globex', type: 'competitor', title: 'Globex' },
    ],
    edges: [
      { id: 're1', source: 'ca_ai', target: 'cv_agentic', type: 'classification_axis_includes_classification_value' },
      { id: 're2', source: 'ca_ai', target: 'cv_integrated', type: 'classification_axis_includes_classification_value' },
    ],
  },
  cross_edges: [
    { id: 'io1', source: 'p_rival/n_acme', target: 'registry/competitor_acme', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'io2', source: 'p_rival/n_globex', target: 'registry/competitor_globex', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'c1', source: 'p_rival/n_acme', target: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'high' }, assessed_on: '2026-06-15' } },
    { id: 'c2', source: 'p_rival/n_acme', target: 'registry/cv_dev', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'medium' } } },
    { id: 'c3', source: 'p_rival/n_globex', target: 'registry/cv_integrated', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 5, label: 'high' } } },
    { id: 'c4', source: 'p_rival/n_globex', target: 'registry/cv_orphan', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 2, label: 'low' } } },
  ],
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

describe('get_portfolio_tree + list_portfolio_cross_edges (0.10.7)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-ptree-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'rival.upg'), JSON.stringify(RIVAL, null, 2))
    writeFileSync(join(cwd, '.upg', 'portfolio.upg'), JSON.stringify(PORTFOLIO, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'rival.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  // ── get_portfolio_tree: landscape ──
  it('landscape whole-portfolio is counts-only and points at how to render members', async () => {
    const b = bodyOf(await getPortfolioTree({ shape: 'landscape' }, ctx))
    expect(b.shape).toBe('landscape')
    expect(b.stats.members_included).toBe(false)
    expect(b.note).toMatch(/counts only/i)
    // axis wired by registry edge is present and labelled
    const ai = b.axes.find((a: { axis: string }) => a.axis === 'ca_ai')
    expect(ai.label).toBe('AI Maturity')
    // orphan value lands in the null/unaxed bucket
    const unaxed = b.axes.find((a: { axis: string | null }) => a.axis === null)
    expect(unaxed.values.map((v: { value: string }) => v.value)).toContain('cv_orphan')
  })

  it('landscape anchored at a value inlines members with resolved titles + confidence', async () => {
    const b = bodyOf(await getPortfolioTree({ shape: 'landscape', from_id: 'registry/cv_agentic' }, ctx))
    expect(b.anchor.title).toBe('Agentic')
    expect(b.stats.members_included).toBe(true)
    const members = b.axes.flatMap((a: { values: { members: unknown[] }[] }) => a.values).flatMap((v: { members: unknown[] }) => v.members)
    expect(members).toHaveLength(1)
    // title resolves to the registry canonical, not the opaque product node id
    expect(members[0].title).toBe('Acme')
    expect(members[0].confidence.label).toBe('high')
    expect(members[0].assessed_on).toBe('2026-06-15')
  })

  it('competitor_profile by registry canonical aggregates the instance positions', async () => {
    const b = bodyOf(await getPortfolioTree({ shape: 'competitor_profile', from_id: 'registry/competitor_acme' }, ctx))
    expect(b.subject.title).toBe('Acme')
    expect(b.stats.positions).toBe(2) // agentic + dev
    const labels = b.positions.map((p: { value_label: string }) => p.value_label).sort()
    expect(labels).toEqual(['Agentic', 'Developer'])
  })

  it('rejects an invalid shape', async () => {
    const r = await getPortfolioTree({ shape: 'bogus' }, ctx)
    expect(r.isError).toBe(true)
  })

  // ── list_portfolio_cross_edges: titles + projection + pagination ──
  it('resolves source/target titles and projects properties', async () => {
    const b = bodyOf(await listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', property_include: ['confidence'] }, ctx))
    expect(b.total).toBe(4)
    const e = b.cross_edges.find((x: { id: string }) => x.id === 'c1')
    expect(e.source_title).toBe('Acme') // instance_of-resolved, not p_rival/n_acme
    expect(e.target_title).toBe('Agentic')
    expect(e.properties).toEqual({ confidence: { value: 4, label: 'high' } }) // assessed_on trimmed away
  })

  it('paginates the flat list with offset/limit and has_more', async () => {
    const page1 = bodyOf(await listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', limit: 2, offset: 0 }, ctx))
    expect(page1.returned).toBe(2)
    expect(page1.has_more).toBe(true)
    const page2 = bodyOf(await listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', limit: 2, offset: 2 }, ctx))
    expect(page2.returned).toBe(2)
    expect(page2.has_more).toBe(false)
  })

  it('resolve_titles:false omits title decoration', async () => {
    const b = bodyOf(await listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', resolve_titles: false }, ctx))
    expect(b.cross_edges[0].source_title).toBeUndefined()
  })
})
