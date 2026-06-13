/**
 * Classification edge properties + typed writer + read path (0.10.4).
 * Briefs: classification-edge-properties (carry confidence/provenance) +
 * classification-query-path (read it back). Exercises:
 *  - create_classification_edge: confidence coercion, default assessed_on,
 *    competitor vs node edge-type selection, cross-product routing.
 *  - property validation: off-scale / wrong-scale / unknown-key rejection,
 *    empty-bag back-compat.
 *  - read path A: get_node on a registry value lists incoming classify edges.
 *  - read path C: list_portfolio_cross_edges type + group_by.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  createClassificationEdge,
  createCrossProductEdge,
  listPortfolioCrossEdges,
} from '../tools/workspace.js'
import { defineCanonicalEntity } from '../tools/registry.js'
import { getNode } from '../tools/nodes.js'
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

const VALUE = 'registry/classification_value_ai_agentic'

describe('classification edge properties + read path (0.10.4)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-classprops-'))
    mkdirSync(join(cwd, '.upg'))
    const comp = {
      upg_version: '0.10.4',
      exported_at: '2026-06-13T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_comp', title: 'Contentful', stage: 'concept' },
      nodes: [
        { id: 'n_comp', type: 'competitor', title: 'Contentful' },
        { id: 'n_feat', type: 'feature', title: 'A feature' },
      ],
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

  it('create_classification_edge: competitor source picks the specialised edge, coerces confidence, defaults assessed_on', async () => {
    const res = await parse(
      createClassificationEdge(
        { node_id: 'n_comp', classification_value_id: VALUE, confidence: 'high', rationale: 'Ships an agent', auto_create_portfolio: true },
        makeCtx(store),
      ),
    )
    expect(res.isError).toBeFalsy()
    const edge = res.body?.edge as Record<string, unknown>
    expect(edge.type).toBe('competitor_classified_as_classification_value')
    expect(edge.target).toBe(VALUE)
    const props = edge.properties as Record<string, unknown>
    expect(props.confidence).toEqual({ value: 5, label: 'high', scale_id: 'confidence_5' })
    expect(typeof props.assessed_on).toBe('string')
    expect(props.rationale).toBe('Ships an agent')
  })

  it('create_classification_edge: non-competitor source picks the polymorphic edge', async () => {
    const res = await parse(
      createClassificationEdge(
        { node_id: 'n_feat', classification_value_id: VALUE, confidence: 'medium', auto_create_portfolio: true },
        makeCtx(store),
      ),
    )
    expect(res.isError).toBeFalsy()
    const edge = res.body?.edge as Record<string, unknown>
    expect(edge.type).toBe('node_classified_as_classification_value')
    expect((edge.properties as Record<string, unknown>).confidence).toEqual({ value: 3, label: 'medium', scale_id: 'confidence_5' })
  })

  it('rejects off-scale, wrong-scale, and unknown-key properties via the generic writer', async () => {
    const ctx = makeCtx(store)
    const off = await parse(createCrossProductEdge({ source_id: 'n_comp', source_product_id: 'p_comp', target_id: VALUE, type: 'competitor_classified_as_classification_value', properties: { confidence: { value: 7, label: 'x' } }, auto_create_portfolio: true }, ctx))
    expect(off.isError).toBeTruthy()
    expect(off.text).toMatch(/out of range/i)
    const unknown = await parse(createCrossProductEdge({ source_id: 'n_comp', source_product_id: 'p_comp', target_id: VALUE, type: 'competitor_classified_as_classification_value', properties: { bogus: 1 }, auto_create_portfolio: true }, ctx))
    expect(unknown.isError).toBeTruthy()
    expect(unknown.text).toMatch(/unknown property/i)
  })

  it('back-compat: a classification edge with no properties is accepted', async () => {
    const res = await parse(
      createCrossProductEdge({ source_id: 'n_comp', source_product_id: 'p_comp', target_id: VALUE, type: 'competitor_classified_as_classification_value', auto_create_portfolio: true }, makeCtx(store)),
    )
    expect(res.isError).toBeFalsy()
  })

  it('read path A: get_node on the registry value lists incoming classify edges with properties', async () => {
    const ctx = makeCtx(store)
    await parse(defineCanonicalEntity({ type: 'classification_value', title: 'Agentic', canonical_id: 'classification_value_ai_agentic' }, ctx))
    await parse(createClassificationEdge({ node_id: 'n_comp', classification_value_id: VALUE, confidence: 'high', auto_create_portfolio: true }, ctx))
    const res = await parse(getNode({ node_id: VALUE }, ctx))
    expect(res.isError).toBeFalsy()
    const classifiedBy = res.body?.classified_by as Array<Record<string, unknown>> | undefined
    const mine = classifiedBy?.find((c) => c.source === 'p_comp/n_comp')
    expect(mine).toBeTruthy()
    expect(mine?.type).toBe('competitor_classified_as_classification_value')
    expect((mine?.properties as Record<string, unknown>)?.confidence).toEqual({ value: 5, label: 'high', scale_id: 'confidence_5' })
  })

  it('read path C: list_portfolio_cross_edges filters by type and groups by source', async () => {
    const ctx = makeCtx(store)
    await parse(createClassificationEdge({ node_id: 'n_comp', classification_value_id: VALUE, confidence: 'high', auto_create_portfolio: true }, ctx))
    const grouped = await parse(listPortfolioCrossEdges({ type: 'competitor_classified_as_classification_value', group_by: 'source' }, ctx))
    expect(grouped.isError).toBeFalsy()
    expect(grouped.body?.grouped_by).toBe('source')
    const groups = grouped.body?.groups as Record<string, unknown[]>
    expect(Object.keys(groups)).toContain('p_comp/n_comp')
  })
})
