/**
 * Reclassification history auto-emit (UPG 0.11.0).
 *
 * When a classify cross-edge is created to a new value that supersedes a sibling
 * classification of the same competitor on the SAME axis, the portfolio store
 * appends an append-only `reclassification` competitor_signal to `signals[]` —
 * the substrate for `diff_classification`. These tests pin the detection rules:
 * a first classification is not a move; a same-axis value change is; the move is
 * non-destructive (the old edge stays); unaxed values are skipped; and an
 * identical transition is logged at most once.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { UPGCrossEdge } from '@unified-product-graph/core'
import { UPGPortfolioStore } from '../store.js'

const AXIS_INCLUDES = 'classification_axis_includes_classification_value'
const CLASSIFY = 'competitor_classified_as_classification_value'

/** Write a portfolio.upg with an AI-maturity axis carrying two linked values. */
function writePortfolio(dir: string, opts: { axed?: boolean; cardinality?: 'single' | 'multi' } = {}): string {
  const axed = opts.axed !== false
  const doc = {
    upg_version: '0.11',
    type: 'portfolio',
    exported_at: '2026-06-14T00:00:00.000Z',
    source: { tool: 'test' },
    organization: { id: 'org1', title: 'Co' },
    product_areas: [],
    portfolios: [],
    products: [{ id: 'p_rival', file_path: '.upg/rival.upg', title: 'Rival' }],
    cross_edges: [],
    registry: {
      nodes: [
        { id: 'ca_ai', type: 'classification_axis', title: 'AI Maturity', ...(opts.cardinality ? { properties: { cardinality: opts.cardinality } } : {}) },
        { id: 'cv_integrated', type: 'classification_value', title: 'Integrated' },
        { id: 'cv_agentic', type: 'classification_value', title: 'Agentic' },
        { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
      ],
      // Axis -> value linkage. Omitted when `axed: false` to prove unaxed skip.
      edges: axed
        ? [
            { id: 'ax1', source: 'ca_ai', target: 'cv_integrated', type: AXIS_INCLUDES },
            { id: 'ax2', source: 'ca_ai', target: 'cv_agentic', type: AXIS_INCLUDES },
          ]
        : [],
    },
  }
  const p = path.join(dir, 'portfolio.upg')
  fs.writeFileSync(p, JSON.stringify(doc, null, 2))
  return p
}

const classify = (id: string, value: string, assessed = '2026-09-01'): UPGCrossEdge =>
  ({
    id,
    source: 'p_rival/n_acme',
    target: `registry/${value}`,
    type: CLASSIFY,
    source_product_id: 'p_rival',
    target_product_id: 'registry',
    properties: { confidence: { value: 4, label: 'high' }, assessed_on: assessed },
  }) as UPGCrossEdge

async function load(dir: string, opts?: { axed?: boolean; cardinality?: 'single' | 'multi' }): Promise<UPGPortfolioStore> {
  const store = new UPGPortfolioStore()
  await store.loadOrInit(writePortfolio(dir, opts))
  return store
}

describe('reclassification history auto-emit (0.11.0)', () => {
  it('a first classification is not a move (emits nothing)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    expect(store.getReclassificationSignals()).toHaveLength(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a same-axis value change emits one reclassification signal (from -> to)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    store.addCrossEdge(classify('c2', 'cv_agentic'))

    const sigs = store.getReclassificationSignals()
    expect(sigs).toHaveLength(1)
    expect(sigs[0].type).toBe('competitor_signal')
    expect(sigs[0].properties).toMatchObject({
      signal_type: 'reclassification',
      competitor: 'p_rival/n_acme',
      axis: 'ca_ai',
      from_value: 'cv_integrated',
      to_value: 'cv_agentic',
      observed_at: '2026-09-01',
    })
    // Confidence carried from the new classify edge.
    expect((sigs[0].properties as Record<string, unknown>).confidence).toMatchObject({ label: 'high' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('supersede (default) retires the prior same-axis edge and reports it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    const out = store.addCrossEdge(classify('c2', 'cv_agentic'))
    // Only the new value remains on the axis; the move was recorded.
    expect(store.getAllCrossEdges().map((e) => e.target)).toEqual(['registry/cv_agentic'])
    expect(out.superseded?.map((e) => e.id)).toEqual(['c1'])
    expect(store.getReclassificationSignals()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('supersede:false keeps both edges (additive) while still recording the move', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    const out = store.addCrossEdge(classify('c2', 'cv_agentic'), { supersede: false })
    const targets = store.getAllCrossEdges().map((e) => e.target).sort()
    expect(targets).toEqual(['registry/cv_agentic', 'registry/cv_integrated'])
    expect(out.superseded).toBeUndefined()
    expect(store.getReclassificationSignals()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a multi-select axis keeps both values but still records the move', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir, { cardinality: 'multi' })
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    const out = store.addCrossEdge(classify('c2', 'cv_agentic')) // supersede default true
    const targets = store.getAllCrossEdges().map((e) => e.target).sort()
    expect(targets).toEqual(['registry/cv_agentic', 'registry/cv_integrated'])
    expect(out.superseded).toBeUndefined()
    expect(store.getReclassificationSignals()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('skips when the values are not linked to an axis (cannot prove a single-axis move)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir, { axed: false })
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    store.addCrossEdge(classify('c2', 'cv_agentic'))
    expect(store.getReclassificationSignals()).toHaveLength(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not double-emit an identical transition (delete + recreate)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    // supersede:false keeps the `from` edge, so the SAME move is reproducible on retry.
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    store.addCrossEdge(classify('c2', 'cv_agentic'), { supersede: false })
    expect(store.getReclassificationSignals()).toHaveLength(1)
    // The naive retry: drop the new edge, re-create the SAME move at the same date.
    store.removeCrossEdge('c2')
    store.addCrossEdge(classify('c3', 'cv_agentic'), { supersede: false })
    expect(store.getReclassificationSignals()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('persists the history across a flush + reload (canonical signals round-trip)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const pf = writePortfolio(dir)
    const store = new UPGPortfolioStore()
    await store.loadOrInit(pf)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    store.addCrossEdge(classify('c2', 'cv_agentic'))
    await store.flush()

    // A fresh store reading the serialised file must still see the signal — the
    // canonical serializer + normalizeDocument both have to carry `signals[]`.
    const reloaded = new UPGPortfolioStore()
    await reloaded.loadOrInit(pf)
    const sigs = reloaded.getReclassificationSignals()
    expect(sigs).toHaveLength(1)
    expect(sigs[0].properties).toMatchObject({ from_value: 'cv_integrated', to_value: 'cv_agentic' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('filters by since and by product', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-reclass-'))
    const store = await load(dir)
    store.addCrossEdge(classify('c1', 'cv_integrated'))
    store.addCrossEdge(classify('c2', 'cv_agentic')) // observed 2026-09-01
    expect(store.getReclassificationSignals({ since: '2026-10-01' })).toHaveLength(0)
    expect(store.getReclassificationSignals({ since: '2026-06-01' })).toHaveLength(1)
    expect(store.getReclassificationSignals({ product: 'p_rival' })).toHaveLength(1)
    expect(store.getReclassificationSignals({ product: 'p_other' })).toHaveLength(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
