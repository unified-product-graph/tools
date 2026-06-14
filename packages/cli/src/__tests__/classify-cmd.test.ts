/**
 * Classification + edge-property CLI parity tests (0.10.5).
 *
 * Closes the CLI side of the classification-edge-properties capability: the
 * `upg`-side equivalents of `create_classification_edge` /
 * `create_cross_product_edge` carrying confidence + provenance, and the
 * `list_portfolio_cross_edges` filters. Drives the built binary against
 * throwaway workspaces.
 *
 * Covers:
 *   - `connect --properties` writes + validates a within-graph property bag
 *   - `connect --properties` rejects unknown keys / off-scale confidence (exit != 0)
 *   - `portfolio classify` (within-graph) writes a polymorphic classification edge
 *   - `portfolio classify` picks the competitor-specialised edge for a competitor source
 *   - `portfolio classify` (cross-product) writes a cross edge to portfolio.upg
 *   - `portfolio connect --properties` validation
 *   - `portfolio edges --group-by` / `--source-product`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow, readJsonMaybe } from './helpers/exec.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

/** A product document with a competitor, a feature, and a local classification value. */
function productDoc(id: string, title: string) {
  return {
    upg_version: '0.10.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [
      { id: `${id}_comp`, type: 'competitor', title: 'A Rival' },
      { id: `${id}_feature`, type: 'feature', title: 'A Feature' },
      { id: `${id}_cv`, type: 'classification_value', title: 'Leader' },
    ],
    edges: [],
  }
}

/** A minimal portfolio document. */
function portfolioDoc(portfolioId: string, portfolioTitle: string) {
  return {
    upg_version: '0.10.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    type: 'portfolio',
    organization: { id: 'org_abc12345', title: 'Test Org' },
    portfolios: [{ id: portfolioId, title: portfolioTitle }],
    product_areas: [],
    products: [],
    cross_edges: [],
  }
}

async function makeWorkspace(prefix: string) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  const upgDir = path.join(tmp, '.upg')
  await fsp.mkdir(upgDir, { recursive: true })
  await fsp.writeFile(path.join(upgDir, 'alpha.upg'), JSON.stringify(productDoc('p_alpha', 'Alpha'), null, 2))
  await fsp.writeFile(path.join(upgDir, 'portfolio.upg'), JSON.stringify(portfolioDoc('pf_main', 'Main'), null, 2))
  return { tmp, productFile: path.join(upgDir, 'alpha.upg'), portfolioFile: path.join(upgDir, 'portfolio.upg') }
}

describe('connect --properties (within-graph)', () => {
  let tmp: string, productFile: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    ;({ tmp, productFile } = await makeWorkspace('upg-classify-conn-'))
  })
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) })

  it('writes a confidence_5 assessment onto the edge', () => {
    const props = JSON.stringify({ confidence: { value: 3, label: 'medium', scale_id: 'confidence_5' } })
    const r = run([
      'connect', 'p_alpha_feature', 'p_alpha_cv',
      '--type', 'node_classified_as_classification_value',
      '--properties', props, '--file', productFile, '--json',
    ], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge.properties.confidence.value).toBe(3)
    const doc = readJsonMaybe<{ edges: Array<{ properties?: { confidence?: { value: number } } }> }>(productFile)
    expect(doc?.edges?.[0]?.properties?.confidence?.value).toBe(3)
  })

  it('rejects an unknown property key', () => {
    const r = run([
      'connect', 'p_alpha_feature', 'p_alpha_cv',
      '--type', 'node_classified_as_classification_value',
      '--properties', JSON.stringify({ bogus: 1 }), '--file', productFile,
    ], tmp)
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/bogus|unknown|propert/i)
  })

  it('rejects an off-scale confidence value', () => {
    const r = run([
      'connect', 'p_alpha_feature', 'p_alpha_cv',
      '--type', 'node_classified_as_classification_value',
      '--properties', JSON.stringify({ confidence: { value: 7, label: 'x' } }), '--file', productFile,
    ], tmp)
    expect(r.status).not.toBe(0)
  })

  it('rejects malformed JSON', () => {
    const r = run([
      'connect', 'p_alpha_feature', 'p_alpha_cv',
      '--type', 'node_classified_as_classification_value',
      '--properties', '{not json', '--file', productFile,
    ], tmp)
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/JSON/i)
  })
})

describe('portfolio classify (within-graph)', () => {
  let tmp: string, productFile: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    ;({ tmp, productFile } = await makeWorkspace('upg-classify-wg-'))
  })
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) })

  it('writes a polymorphic edge for a non-competitor source, with confidence + assessed_on', () => {
    const r = run([
      'portfolio', 'classify', 'p_alpha_feature', 'p_alpha_cv',
      '--confidence', 'high', '--rationale', 'strong fit',
      '--file', productFile, '--json',
    ], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.scope).toBe('within_graph')
    expect(out.edge.type).toBe('node_classified_as_classification_value')
    expect(out.edge.properties.confidence.value).toBe(4) // 0.11.1: high pins to 4 (Confident)
    expect(out.edge.properties.assessed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.edge.properties.rationale).toBe('strong fit')
  })

  it('picks the competitor-specialised edge for a competitor source', () => {
    const r = run([
      'portfolio', 'classify', 'p_alpha_comp', 'p_alpha_cv',
      '--confidence', 'low', '--file', productFile, '--json',
    ], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge.type).toBe('competitor_classified_as_classification_value')
    expect(out.edge.properties.confidence.value).toBe(2)
  })

  it('rejects an invalid confidence level', () => {
    const r = run([
      'portfolio', 'classify', 'p_alpha_feature', 'p_alpha_cv',
      '--confidence', 'certain', '--file', productFile,
    ], tmp)
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/confidence/i)
  })
})

describe('portfolio classify (cross-product) + edges filters', () => {
  let tmp: string, productFile: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    ;({ tmp, productFile } = await makeWorkspace('upg-classify-cross-'))
  })
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) })

  it('writes a cross edge to portfolio.upg when the value is registry-qualified', () => {
    const r = run([
      'portfolio', 'classify', 'p_alpha_comp', 'registry/cv_leader',
      '--confidence', 'high', '--evidence', 'sig_q2',
      '--file', productFile, '--json',
    ], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.scope).toBe('cross_product')
    expect(out.edge.type).toBe('competitor_classified_as_classification_value')
    expect(out.edge.source).toBe('p_alpha/p_alpha_comp')
    expect(out.edge.target).toBe('registry/cv_leader')
    expect(out.edge.properties.confidence.value).toBe(4) // 0.11.1: high pins to 4 (Confident)
    expect(out.edge.properties.evidence).toBe('sig_q2')

    // round-trips through `portfolio edges`
    const edges = run(['portfolio', 'edges', '--json'], tmp)
    const ej = JSON.parse(edges.stdout)
    expect(ej.total).toBe(1)
    expect(ej.cross_edges[0].properties.confidence.value).toBe(4) // 0.11.1: high pins to 4
  })

  it('groups cross edges by source', () => {
    run([
      'portfolio', 'classify', 'p_alpha_comp', 'registry/cv_leader',
      '--confidence', 'medium', '--file', productFile, '--json',
    ], tmp)
    const r = run(['portfolio', 'edges', '--group-by', 'source', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.grouped_by).toBe('source')
    expect(out.group_count).toBe(1)
    expect(out.groups['p_alpha/p_alpha_comp']).toHaveLength(1)
  })

  it('rejects an invalid --group-by value', () => {
    const r = run(['portfolio', 'edges', '--group-by', 'sideways', '--json'], tmp)
    expect(r.status).not.toBe(0)
  })
})
