/**
 * Classification read + write closure (0.10.6) — bundles three briefs:
 *   B (query-path): portfolio_query follows a cross-edge type named in traverse[]
 *     out to its registry target, instead of returning total_edges: 0.
 *   D (query-path bonus): portfolio_digest carries a `classification` block
 *     (per axis, count of members per value).
 *   upsert: create_cross_product_edge / batch_create_cross_product_edges UPSERT
 *     properties on an idempotent hit (was a silent no-op), and report status;
 *     create_classification_edge resolves a qualified cross-product competitor
 *     source to the specialised edge type (was mis-typed as polymorphic).
 *
 * Runs against a real tmp workspace; handlers read process.cwd().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
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
import { createCrossProductEdge, batchCreateCrossProductEdges, createClassificationEdge } from '../tools/workspace.js'
import { portfolioQuery as pq, portfolioDigest as pd } from '../tools/portfolio-read.js'

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

// Active product: a watched competitor graph holding the competitor node.
const RIVAL = doc({
  product: { id: 'p_rival', title: 'Rival Watch', stage: 'concept' },
  nodes: [{ id: 'n_comp', type: 'competitor', title: 'Acme' }],
  edges: [],
})

// A portfolio with a classification registry (2 axes/values) + one existing
// classify cross edge with NO properties (the backfill target).
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
    ],
    edges: [
      { id: 're1', source: 'ca_ai', target: 'cv_agentic', type: 'classification_axis_includes_classification_value' },
      { id: 're2', source: 'ca_ai', target: 'cv_integrated', type: 'classification_axis_includes_classification_value' },
    ],
  },
  cross_edges: [
    {
      id: 'ce_existing',
      source: 'p_rival/n_comp',
      target: 'registry/cv_agentic',
      type: 'competitor_classified_as_classification_value',
      source_product_id: 'p_rival',
      target_product_id: 'registry',
    },
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

function bodyOf(result: { content: { text: string }[]; isError?: boolean }) {
  return JSON.parse(result.content[0].text)
}

describe('classification read + write closure (0.10.6)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-classif-')))
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

  // ── B: portfolio_query follows the classify cross edge ──
  it('B: portfolio_query follows a cross-edge type in traverse[] to its registry target', async () => {
    const body = bodyOf(await pq({ from: 'competitor', traverse: ['competitor_classified_as_classification_value'] }, ctx))
    const rival = body.products.find((p: { product_id: string }) => p.product_id === 'p_rival')
    expect(rival).toBeDefined()
    // Was total_edges: 0 before the fix.
    expect(rival.total_edges).toBe(1)
    const edge = rival.edges.find((e: { type: string }) => e.type === 'competitor_classified_as_classification_value')
    expect(edge.target).toBe('registry/cv_agentic')
    // The registry target is resolved as a terminal node.
    const target = rival.nodes.find((n: { id: string }) => n.id === 'registry/cv_agentic')
    expect(target).toBeDefined()
    expect(target.title).toBe('Agentic')
  })

  it('B: without a cross type in traverse[], the within-graph query is unchanged (no cross edges)', async () => {
    const body = bodyOf(await pq({ from: 'competitor' }, ctx))
    const rival = body.products.find((p: { product_id: string }) => p.product_id === 'p_rival')
    expect(rival.total_edges).toBe(0)
  })

  // ── D: classification distribution block in portfolio_digest ──
  it('D: portfolio_digest carries a classification block grouped by axis', async () => {
    const body = bodyOf(await pd({}, ctx))
    expect(body.classification).toBeDefined()
    expect(body.classification.total_classified_edges).toBe(1)
    const axis = body.classification.axes.find((a: { axis: string }) => a.axis === 'ca_ai')
    expect(axis.label).toBe('AI Maturity')
    const agentic = axis.values.find((v: { value: string }) => v.value === 'cv_agentic')
    expect(agentic).toMatchObject({ label: 'Agentic', count: 1 })
  })

  // ── upsert: properties land on an existing edge ──
  it('upsert: create_cross_product_edge updates properties on an idempotent hit', async () => {
    const res = await createCrossProductEdge(
      {
        source_id: 'p_rival/n_comp',
        target_id: 'registry/cv_agentic',
        type: 'competitor_classified_as_classification_value',
        properties: { confidence: { value: 3, label: 'medium', scale_id: 'confidence_5' } },
      },
      ctx,
    )
    const body = bodyOf(res)
    expect(body.status).toBe('updated')
    expect(body.applied).toBe(true)
    expect(body.edge.id).toBe('ce_existing') // existing id preserved, no duplicate
    expect(body.edge.properties.confidence.value).toBe(3)
    // persisted to disk
    const onDisk = JSON.parse(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
    expect(onDisk.cross_edges).toHaveLength(1)
    expect(onDisk.cross_edges[0].properties.confidence.value).toBe(3)

    // re-running with identical props is a no-op (unchanged)
    const again = bodyOf(await createCrossProductEdge(
      {
        source_id: 'p_rival/n_comp',
        target_id: 'registry/cv_agentic',
        type: 'competitor_classified_as_classification_value',
        properties: { confidence: { value: 3, label: 'medium', scale_id: 'confidence_5' } },
      },
      ctx,
    ))
    expect(again.status).toBe('unchanged')
    expect(again.applied).toBe(false)
  })

  it('upsert: batch_create_cross_product_edges reports per-status counts', async () => {
    const body = bodyOf(await batchCreateCrossProductEdges(
      {
        edges: [
          {
            source_id: 'p_rival/n_comp',
            target_id: 'registry/cv_agentic',
            type: 'competitor_classified_as_classification_value',
            properties: { confidence: { value: 5, label: 'high', scale_id: 'confidence_5' } },
          },
        ],
      },
      ctx,
    ))
    expect(body.counts.updated).toBe(1)
    expect(body.counts.created).toBe(0)
    expect(body.edges[0].status).toBe('updated')
    expect(body.edges[0].edge.properties.confidence.value).toBe(5)
  })

  // ── type-fix: qualified cross-product competitor source ──
  it('create_classification_edge types a qualified cross-product competitor source as competitor_classified', async () => {
    // Active product is p_rival here, but qualify explicitly to exercise the
    // cross-product owning-product resolution path.
    const body = bodyOf(await createClassificationEdge(
      {
        node_id: 'p_rival/n_comp',
        classification_value_id: 'registry/cv_integrated',
        confidence: 'high',
      },
      ctx,
    ))
    expect(body.edge.type).toBe('competitor_classified_as_classification_value')
    expect(body.edge.target).toBe('registry/cv_integrated')
    expect(body.status).toBe('created')
    // 0.11.1: friendly "high" pins to value 4 (Confident), not 5.
    expect(body.edge.properties.confidence.value).toBe(4)
  })
})
