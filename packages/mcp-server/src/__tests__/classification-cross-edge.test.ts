/**
 * Registry-canonical classification cross-edge (brief: registry-canonical-
 * classification, 0.10.2). A competitor classified directly against a
 * `registry/{classification_value}` canonical, with no local taxonomy node.
 * `competitor_classified_as_classification_value` is dual-registered as a
 * cross-edge; the `registry` pseudo-product must never land in `products[]`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createCrossProductEdge, listPortfolioCrossEdges } from '../tools/workspace.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}
async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  const text = r.content[0]?.text ?? ''
  let body: Record<string, unknown> | undefined
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { isError: r.isError, text, body }
}

const TYPE = 'competitor_classified_as_classification_value'
const TARGET = 'registry/classification_value_oss_self_host'

describe('classification cross-edge (registry-canonical, 0.10.2)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-class-'))
    mkdirSync(join(cwd, '.upg'))
    const comp = {
      upg_version: '0.10.2',
      exported_at: '2026-06-13T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_comp', title: 'Contentful', stage: 'concept' },
      nodes: [{ id: 'n_comp', type: 'competitor', title: 'Contentful' }],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'comp.upg'), JSON.stringify(comp, null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'comp.upg', products: [{ file: 'comp.upg', title: 'Contentful' }] }, null, 2),
    )
    process.chdir(cwd)
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'comp.upg'))
    store.stopWatching()
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await store.flush()
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('classifies a competitor against a registry canonical and never registers the registry as a product', async () => {
    const res = await parse(
      createCrossProductEdge(
        { source_id: 'n_comp', source_product_id: 'p_comp', target_id: TARGET, type: TYPE, auto_create_portfolio: true },
        makeCtx(store),
      ),
    )
    expect(res.isError).toBeFalsy()
    const edge = res.body?.edge as Record<string, unknown>
    expect(edge.type).toBe(TYPE)
    expect(edge.source).toBe('p_comp/n_comp')
    expect(edge.target).toBe(TARGET)

    const portfolio = JSON.parse(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
    const cross = (portfolio.cross_edges ?? []) as Array<Record<string, unknown>>
    expect(cross.find((e) => e.type === TYPE)?.target).toBe(TARGET)

    // The registry tier is a pseudo-product and must not be registered; the real
    // source product is.
    const products = (portfolio.products ?? []) as Array<{ id: string }>
    expect(products.find((p) => p.id === 'registry')).toBeUndefined()
    expect(products.find((p) => p.id === 'p_comp')).toBeTruthy()
  })

  it('is enumerated by list_portfolio_cross_edges', async () => {
    const ctx = makeCtx(store)
    await parse(createCrossProductEdge({ source_id: 'n_comp', source_product_id: 'p_comp', target_id: TARGET, type: TYPE, auto_create_portfolio: true }, ctx))
    const list = await parse(listPortfolioCrossEdges({}, ctx))
    const edges = (list.body?.cross_edges ?? list.body?.edges) as Array<Record<string, unknown>> | undefined
    expect(edges?.some((e) => e.type === TYPE)).toBe(true)
  })
})
