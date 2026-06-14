/**
 * CLI classification read parity (0.10.6, query-path briefs B + D).
 *   B: `upg portfolio query --traverse <cross-edge>` follows the cross edge out
 *      to its registry target instead of stopping at the product boundary.
 *   D: `upg portfolio health --json` carries a `classification` distribution
 *      block (per axis, count of members per value).
 * Drives the built binary against a workspace with a registry + a classify edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from './helpers/exec.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

const RIVAL = {
  upg_version: '0.10.0',
  exported_at: new Date().toISOString(),
  source: { tool: 'test', tool_version: '0' },
  product: { id: 'p_rival', title: 'Rival Watch' },
  nodes: [{ id: 'n_comp', type: 'competitor', title: 'Acme' }],
  edges: [],
}

const PORTFOLIO = {
  upg_version: '0.10.0',
  exported_at: new Date().toISOString(),
  source: { tool: 'test', tool_version: '0' },
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
      properties: { confidence: { value: 5, label: 'high', scale_id: 'confidence_5' } },
    },
  ],
}

describe('CLI portfolio classification reads (0.10.6)', () => {
  let tmp: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-classif-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(path.join(upgDir, 'rival.upg'), JSON.stringify(RIVAL, null, 2))
    await fsp.writeFile(path.join(upgDir, 'portfolio.upg'), JSON.stringify(PORTFOLIO, null, 2))
  })
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) })

  it('B: portfolio query follows the classify cross edge to its registry target', () => {
    const r = run([
      'portfolio', 'query', '--from', 'competitor',
      '--traverse', 'competitor_classified_as_classification_value', '--json',
    ], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const rival = out.products.find((p: { product_id: string }) => p.product_id === 'p_rival')
    expect(rival.total_edges).toBe(1)
    const edge = rival.edges.find((e: { type: string }) => e.type === 'competitor_classified_as_classification_value')
    expect(edge.target).toBe('registry/cv_agentic')
    expect(edge.properties.confidence.value).toBe(5)
    const target = rival.nodes.find((n: { id: string }) => n.id === 'registry/cv_agentic')
    expect(target.title).toBe('Agentic')
  })

  it('B: without a cross type in --traverse the query stays within product (no cross edges)', () => {
    const r = run(['portfolio', 'query', '--from', 'competitor', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const rival = out.products.find((p: { product_id: string }) => p.product_id === 'p_rival')
    expect(rival.total_edges).toBe(0)
  })

  it('0.11.3: classify supersedes the prior same-axis edge by default', () => {
    // n_comp is on cv_agentic; reclassify to cv_integrated on the same (single-select) axis.
    const r = run(['portfolio', 'classify', 'p_rival/n_comp', 'registry/cv_integrated', '--file', '.upg/rival.upg', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.superseded).toEqual([{ edge_id: 'ce_existing', target: 'registry/cv_agentic' }])
    // On disk, only the new value remains on the axis.
    const pf = JSON.parse(fs.readFileSync(path.join(tmp, '.upg', 'portfolio.upg'), 'utf-8'))
    const classify = pf.cross_edges.filter((e: { type: string }) => e.type === 'competitor_classified_as_classification_value')
    expect(classify.map((e: { target: string }) => e.target)).toEqual(['registry/cv_integrated'])
  })

  it('0.11.3: --no-supersede keeps both same-axis values', () => {
    const r = run(['portfolio', 'classify', 'p_rival/n_comp', 'registry/cv_integrated', '--no-supersede', '--file', '.upg/rival.upg', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.superseded).toBeUndefined()
    const pf = JSON.parse(fs.readFileSync(path.join(tmp, '.upg', 'portfolio.upg'), 'utf-8'))
    const classify = pf.cross_edges.filter((e: { type: string }) => e.type === 'competitor_classified_as_classification_value')
    expect(classify.map((e: { target: string }) => e.target).sort()).toEqual(['registry/cv_agentic', 'registry/cv_integrated'])
  })

  it('D: portfolio health --json carries a classification block', () => {
    const r = run(['portfolio', 'health', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.classification.total_classified_edges).toBe(1)
    const axis = out.classification.axes.find((a: { axis: string }) => a.axis === 'ca_ai')
    expect(axis.label).toBe('AI Maturity')
    expect(axis.values[0]).toMatchObject({ value: 'cv_agentic', label: 'Agentic', count: 1 })
  })
})
