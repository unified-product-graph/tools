/**
 * create_classification_edge fixes (UPG 0.11.1) — the typed-writer bug brief.
 *
 * On a qualified `{product}/{node}` competitor source that already has a classify
 * edge, the 0.10.8 writer (a) mis-typed the edge as the polymorphic
 * `node_classified_as_classification_value`, (b) therefore CREATED a duplicate
 * instead of upserting, and (c) expanded `high` to confidence value 5 (the rest
 * of the graph uses 4). This drives the exact repro: a competitor resolvable only
 * through the portfolio's instance_of index (no local product file), with an
 * existing competitor-typed classify edge, and asserts a clean in-place upsert.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore, UPGPortfolioStore } from '@unified-product-graph/sdk'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { createClassificationEdge } from '../tools/workspace.js'

const CLASSIFY = 'competitor_classified_as_classification_value'

// Active product — deliberately NOT where the competitor lives, and the
// competitor's product (p_rival) has no local file, so the writer can only learn
// the source is a competitor through the portfolio's instance_of index.
const MAIN = {
  upg_version: '0.11',
  exported_at: '2026-06-14T00:00:00.000Z',
  source: { tool: 'test' },
  product: { id: 'p_main', title: 'Our Product', stage: 'build' },
  nodes: [],
  edges: [],
}

const PORTFOLIO = {
  upg_version: '0.11',
  exported_at: '2026-06-14T00:00:00.000Z',
  source: { tool: 'test' },
  type: 'portfolio',
  organization: { id: 'org1', title: 'Co' },
  product_areas: [],
  portfolios: [],
  products: [
    { id: 'p_main', file_path: '.upg/main.upg', title: 'Our Product' },
    { id: 'p_rival', file_path: '.upg/rival.upg', title: 'Rival' }, // stub: no such file
  ],
  registry: {
    nodes: [
      { id: 'cv_integrated', type: 'classification_value', title: 'Integrated' },
      { id: 'cv_agentic', type: 'classification_value', title: 'Agentic' },
      { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
    ],
    edges: [],
  },
  cross_edges: [
    // The competitor is resolvable ONLY via this instance_of edge.
    { id: 'io1', source: 'p_rival/n_acme', target: 'registry/competitor_acme', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
    // The existing, correctly-typed classify edge to upsert onto.
    { id: 'e_existing', source: 'p_rival/n_acme', target: 'registry/cv_integrated', type: CLASSIFY, source_product_id: 'p_rival', target_product_id: 'registry', properties: { confidence: { value: 4, label: 'high' }, assessed_on: '2026-06-15' } },
  ],
}

function makeCtx(store: UPGFileStore): ToolContext {
  return { store, sessionContext: createSessionContext(), queryCache: createQueryCache(), sync: { readSyncState, writeSyncState, hashFile, syncFilePath } }
}
const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

describe('create_classification_edge typed-writer fixes (0.11.1)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext
  let portfolioPath: string

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-typedwriter-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'main.upg'), JSON.stringify(MAIN, null, 2))
    portfolioPath = join(cwd, '.upg', 'portfolio.upg')
    writeFileSync(portfolioPath, JSON.stringify(PORTFOLIO, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'main.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function crossEdgesByType(): Promise<Record<string, number>> {
    const pf = new UPGPortfolioStore()
    await pf.loadOrInit(portfolioPath)
    const counts: Record<string, number> = {}
    for (const e of pf.getAllCrossEdges()) counts[e.type] = (counts[e.type] ?? 0) + 1
    return counts
  }

  it('upserts the existing competitor cell in place (correct type, no duplicate)', async () => {
    const b = bodyOf(await createClassificationEdge({
      node_id: 'p_rival/n_acme',
      classification_value_id: 'registry/cv_integrated',
      confidence: 'high',
      assessed_on: '2026-06-15',
    }, ctx))

    // (a) routed to the specialised type, not the polymorphic fallback.
    expect(b.edge.type).toBe(CLASSIFY)
    // (b) updated in place, not a second edge.
    expect(b.status).toBe('updated')
    expect(b.edge.id).toBe('e_existing')
    // (c) confidence resolves to value 4 with the canonical label, not 5.
    expect(b.edge.properties.confidence).toEqual({ value: 4, label: 'Confident', scale_id: 'confidence_5' })

    // No node_classified_as_… stray; the classify cell stays singular.
    const counts = await crossEdgesByType()
    expect(counts[CLASSIFY]).toBe(1)
    expect(counts.node_classified_as_classification_value ?? 0).toBe(0)
  })

  it('a genuinely new competitor classification also routes to the specialised type', async () => {
    const b = bodyOf(await createClassificationEdge({
      node_id: 'p_rival/n_acme',
      classification_value_id: 'registry/cv_agentic',
      confidence: 'medium',
      assessed_on: '2026-09-01',
    }, ctx))
    expect(b.edge.type).toBe(CLASSIFY)
    expect(b.status).toBe('created')
    expect(b.edge.properties.confidence).toEqual({ value: 3, label: 'Some evidence', scale_id: 'confidence_5' })
    const counts = await crossEdgesByType()
    expect(counts[CLASSIFY]).toBe(2) // existing + the new cell
    expect(counts.node_classified_as_classification_value ?? 0).toBe(0)
  })

  it('rejects an out-of-vocabulary confidence word', async () => {
    const r = await createClassificationEdge({
      node_id: 'p_rival/n_acme',
      classification_value_id: 'registry/cv_integrated',
      confidence: 'very-high',
    }, ctx)
    expect(r.isError).toBe(true)
  })
})
