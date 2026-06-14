/**
 * Property-layer tooling from the backfill brief (0.10.8):
 *   #1 audit_property_coverage — which cross-edges lack required properties.
 *   #2 dry_run on create_cross_product_edge / batch_create_cross_product_edges —
 *      forecast create/update/unchanged WITHOUT writing.
 *   #3 freshness filter on list_portfolio_cross_edges — the stale set by
 *      assessed_on age.
 *
 * Runs against a real tmp workspace; handlers read process.cwd().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, realpathSync } from 'node:fs'
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
import { auditPropertyCoverage } from '../tools/portfolio-read.js'
import { listPortfolioCrossEdges, createCrossProductEdge, batchCreateCrossProductEdges } from '../tools/workspace.js'

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return { upg_version: '0.10', exported_at: new Date().toISOString(), source: { tool: 'test' }, nodes: [], edges: [], ...over }
}

const RIVAL = doc({
  product: { id: 'p_rival', title: 'Rival Watch', stage: 'concept' },
  nodes: [{ id: 'n_acme', type: 'competitor', title: 'Acme' }, { id: 'n_globex', type: 'competitor', title: 'Globex' }],
  edges: [],
})

// 3 classify edges: c1 fully assessed (fresh), c2 missing confidence, c3 stale-dated.
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
      { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
      { id: 'competitor_globex', type: 'competitor', title: 'Globex' },
    ],
    edges: [],
  },
  cross_edges: [
    { id: 'io1', source: 'p_rival/n_acme', target: 'registry/competitor_acme', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'io2', source: 'p_rival/n_globex', target: 'registry/competitor_globex', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    { id: 'c1', source: 'p_rival/n_acme', target: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 4, label: 'high' }, assessed_on: '2026-06-15' } },
    { id: 'c2', source: 'p_rival/n_globex', target: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { assessed_on: '2026-06-15' } },
    { id: 'c3', source: 'p_rival/n_globex', target: 'registry/cv_integrated', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 3, label: 'medium' }, assessed_on: '2024-01-01' } },
  ],
}

function makeCtx(store: UPGFileStore): ToolContext {
  return { store, sessionContext: createSessionContext(), queryCache: createQueryCache(), sync: { readSyncState, writeSyncState, hashFile, syncFilePath } }
}
const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

describe('property-layer tooling (0.10.8)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext
  let portfolioPath: string

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-proptool-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'rival.upg'), JSON.stringify(RIVAL, null, 2))
    portfolioPath = join(cwd, '.upg', 'portfolio.upg')
    writeFileSync(portfolioPath, JSON.stringify(PORTFOLIO, null, 2))
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

  // ── #1 audit_property_coverage ──
  it('finds the edge missing a required key, with resolved titles', async () => {
    const b = bodyOf(await auditPropertyCoverage({ edge_type: 'competitor_classified_as_classification_value', required_keys: ['confidence', 'assessed_on'] }, ctx))
    expect(b.total).toBe(3)
    expect(b.complete).toBe(2) // c1 + c3 have both; c2 lacks confidence
    expect(b.missing).toHaveLength(1)
    expect(b.missing[0]).toMatchObject({ edge_id: 'c2', missing_keys: ['confidence'], source_title: 'Globex', target_title: 'Agentic' })
  })

  it('reports missing: [] when every edge carries the keys', async () => {
    const b = bodyOf(await auditPropertyCoverage({ edge_type: 'competitor_classified_as_classification_value', required_keys: ['assessed_on'] }, ctx))
    expect(b.missing).toEqual([])
    expect(b.complete).toBe(3)
  })

  it('rejects an unknown edge type and missing required_keys', async () => {
    expect((await auditPropertyCoverage({ edge_type: 'not_a_type', required_keys: ['x'] }, ctx)).isError).toBe(true)
    expect((await auditPropertyCoverage({ edge_type: 'competitor_classified_as_classification_value', required_keys: [] }, ctx)).isError).toBe(true)
  })

  // ── #2 dry_run ──
  it('single dry_run forecasts unchanged for an existing edge and writes nothing', async () => {
    const before = statSync(portfolioPath).mtimeMs
    const b = bodyOf(await createCrossProductEdge({ source_id: 'p_rival/n_acme', target_id: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', dry_run: true }, ctx))
    expect(b.dry_run).toBe(true)
    expect(b.would).toBe('unchanged')
    expect(statSync(portfolioPath).mtimeMs).toBe(before)
  })

  it('batch dry_run forecasts create/update/unchanged and writes nothing', async () => {
    const before = statSync(portfolioPath).mtimeMs
    const b = bodyOf(await batchCreateCrossProductEdges({ dry_run: true, edges: [
      // existing, no new props -> unchanged
      { source_id: 'p_rival/n_acme', target_id: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value' },
      // existing c2, adds confidence -> update
      { source_id: 'p_rival/n_globex', target_id: 'registry/cv_agentic', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 2, label: 'low' } } },
      // brand new -> create
      { source_id: 'p_rival/n_acme', target_id: 'registry/cv_integrated', type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 5, label: 'high' } } },
    ] }, ctx))
    expect(b.dry_run).toBe(true)
    expect(b.would_counts).toEqual({ create: 1, update: 1, unchanged: 1 })
    expect(b.edges.map((e: { would: string }) => e.would)).toEqual(['unchanged', 'update', 'create'])
    expect(statSync(portfolioPath).mtimeMs).toBe(before)
  })

  // ── #3 freshness ──
  it('assessed_before returns only the stale (older-dated) edges', async () => {
    const b = bodyOf(await listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', assessed_before: '2025-01-01' }, ctx))
    // only c3 (2024-01-01) is before the cutoff
    expect(b.total).toBe(1)
    expect(b.cross_edges[0].id).toBe('c3')
  })

  it('an edge with no assessed_on counts as stale (kept by the freshness filter)', async () => {
    // No type filter: the instance_of edges (no assessed_on) are the stalest and
    // are kept; c1/c2 (2026-06-15) and c3 (2024) are not before 2020.
    const b = bodyOf(await listPortfolioCrossEdges({ assessed_before: '2020-01-01' }, ctx))
    expect(b.cross_edges.map((e: { id: string }) => e.id).sort()).toEqual(['io1', 'io2'])
  })

  it('rejects a malformed assessed_before date', async () => {
    expect((await listPortfolioCrossEdges({ assessed_before: 'not-a-date' }, ctx)).isError).toBe(true)
  })
})
