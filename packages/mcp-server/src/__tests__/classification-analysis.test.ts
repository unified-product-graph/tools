/**
 * Classification-analysis read tools (0.11.2, read-path-tooling brief #5/#6):
 *   #5 compare_classifications — two competitors axis-by-axis (agree/diverge).
 *   #6 aggregate_edge_properties — a cross-edge property's distribution digest.
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
import { compareClassifications, aggregateEdgePropertiesTool } from '../tools/portfolio-read.js'

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return { upg_version: '0.11', exported_at: new Date().toISOString(), source: { tool: 'test' }, nodes: [], edges: [], ...over }
}

const RIVAL = doc({
  product: { id: 'p_rival', title: 'Rival Watch', stage: 'concept' },
  nodes: [{ id: 'n_acme', type: 'competitor', title: 'Acme' }, { id: 'n_globex', type: 'competitor', title: 'Globex' }],
  edges: [],
})

// Acme & Globex AGREE on AI Maturity (both Agentic), DIVERGE on Pricing
// (Free vs Paid); only Acme is graded on the orphan (unaxed) value.
const PORTFOLIO = {
  upg_version: '0.11',
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
      { id: 'ca_pricing', type: 'classification_axis', title: 'Pricing' },
      { id: 'cv_agentic', type: 'classification_value', title: 'Agentic' },
      { id: 'cv_free', type: 'classification_value', title: 'Free' },
      { id: 'cv_paid', type: 'classification_value', title: 'Paid' },
      { id: 'cv_orphan', type: 'classification_value', title: 'Orphan' },
      { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
      { id: 'competitor_globex', type: 'competitor', title: 'Globex' },
    ],
    edges: [
      { id: 're1', source: 'ca_ai', target: 'cv_agentic', type: 'classification_axis_includes_classification_value' },
      { id: 're2', source: 'ca_pricing', target: 'cv_free', type: 'classification_axis_includes_classification_value' },
      { id: 're3', source: 'ca_pricing', target: 'cv_paid', type: 'classification_axis_includes_classification_value' },
    ],
  },
  cross_edges: [
    { id: 'io1', source: 'p_rival/n_acme', target: 'registry/competitor_acme', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'io2', source: 'p_rival/n_globex', target: 'registry/competitor_globex', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'c1', source: 'p_rival/n_acme', target: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'Confident' }, assessed_on: '2026-06-15' } },
    { id: 'c2', source: 'p_rival/n_acme', target: 'registry/cv_free', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'Some evidence' } } },
    { id: 'c3', source: 'p_rival/n_acme', target: 'registry/cv_orphan', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 2, label: 'Hunch' } } },
    { id: 'c4', source: 'p_rival/n_globex', target: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'Confident' } } },
    { id: 'c5', source: 'p_rival/n_globex', target: 'registry/cv_paid', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'Some evidence' } } },
  ],
}

function makeCtx(store: UPGFileStore): ToolContext {
  return { store, sessionContext: createSessionContext(), queryCache: createQueryCache(), sync: { readSyncState, writeSyncState, hashFile, syncFilePath } }
}
const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

describe('classification-analysis read tools (0.11.2)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-classanalysis-')))
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

  // ── #5 compare_classifications ──
  it('compares two competitors axis-by-axis with resolved titles', async () => {
    const b = bodyOf(await compareClassifications({ a: 'p_rival/n_acme', b: 'p_rival/n_globex' }, ctx))
    expect(b.a.title).toBe('Acme')
    expect(b.b.title).toBe('Globex')
    expect(b.stats).toMatchObject({ shared_axes: 2, agreements: 1, divergences: 1, a_only: 1, b_only: 0 })
    const ai = b.axes.find((x: { axis: string }) => x.axis === 'ca_ai')
    expect(ai.status).toBe('agree')
    const pricing = b.axes.find((x: { axis: string }) => x.axis === 'ca_pricing')
    expect(pricing.status).toBe('diverge')
    expect(pricing.a[0].value_label).toBe('Free')
    expect(pricing.b[0].value_label).toBe('Paid')
  })

  it('errors when a or b is missing', async () => {
    expect((await compareClassifications({ a: 'p_rival/n_acme' }, ctx)).isError).toBe(true)
    expect((await compareClassifications({ b: 'p_rival/n_globex' }, ctx)).isError).toBe(true)
  })

  // ── #6 aggregate_edge_properties ──
  it('aggregates the overall confidence distribution', async () => {
    const b = bodyOf(await aggregateEdgePropertiesTool({ edge_type: 'competitor_classified_as_classification_value' }, ctx))
    expect(b.total).toBe(5)
    expect(b.with_property).toBe(5)
    const byKey = Object.fromEntries(b.overall.map((d: { key: string; count: number }) => [d.key, d.count]))
    expect(byKey).toMatchObject({ Confident: 2, 'Some evidence': 2, Hunch: 1 })
    expect(b.groups).toBeUndefined()
  })

  it('group_by axis splits per axis and sinks unaxed last', async () => {
    const b = bodyOf(await aggregateEdgePropertiesTool({ edge_type: 'competitor_classified_as_classification_value', group_by: 'axis' }, ctx))
    const ai = b.groups.find((g: { group: string }) => g.group === 'ca_ai')
    expect(ai.group_label).toBe('AI Maturity')
    expect(ai.total).toBe(2)
    expect(b.groups[b.groups.length - 1].group).toBe('unaxed')
  })

  it('rejects an unknown edge type and an invalid group_by', async () => {
    expect((await aggregateEdgePropertiesTool({ edge_type: 'not_a_type' }, ctx)).isError).toBe(true)
    expect((await aggregateEdgePropertiesTool({ edge_type: 'competitor_classified_as_classification_value', group_by: 'bogus' }, ctx)).isError).toBe(true)
  })
})
