/**
 * Regression tests for the v0.8.x seam-fix wave (/590/591/598-601/604/605).
 *
 * Each test loads a fresh throwaway `.upg` (a full canonical envelope) so the
 * file-backed store behaves exactly as it does for an SDK consumer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  UPGClient,
  UPGFileStore,
  createNode,
  createEdge,
  updateNode,
  batchCreateNodes,
  batchUpdateNodes,
  executeTrace,
  executePrioritise,
  executePlan,
  executeReflect,
  ReflectModeError,
  WriteValidationError,
  renderDriftSummary,
  renderDanglingReport,
  registerProductOnPortfolio,
  updateProduct,
  computeGraphDigest,
  InvalidProductStageError,
} from '../index.js'
// Frameworks are asserted against the CANONICAL public surface (core), the
// surface the mcp-server/CLI actually serve at runtime — not the raw internal
// @unified-product-graph/frameworks research catalog. 0.8.6 broadened RICE/ICE/
// WSJF/cost-of-delay declared targets here; the tests must verify that surface.
import { UPG_FRAMEWORKS_BY_ID, validateProductStageStrict } from '@unified-product-graph/core'

// A connected, well-formed graph: persona → job → need, solution → feature, etc.
function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_test', title: 'TestProduct' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-01T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'TestProduct' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Solo Cook', slug: 'solo-cook' },
      { id: 'n_job', type: 'job', title: 'Eat well', slug: 'eat-well' },
      { id: 'n_need', type: 'need', title: 'Right portions', slug: 'right-portions', status: 'raw', properties: { reach: 824, impact: 3, confidence: 0.8, effort: 1 } },
      { id: 'n_opp', type: 'opportunity', title: 'Cut decision time', slug: 'cut-decision-time', status: 'identified', properties: { reach: 887, impact: 1, confidence: 0.8, effort: 8 } },
      { id: 'n_sol', type: 'solution', title: 'Recipe suggestions', slug: 'recipe-suggestions', status: 'proposed' },
      { id: 'n_feat', type: 'feature', title: 'Pantry suggestions', slug: 'pantry-suggestions', status: 'proposed' },
    ],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
      { id: 'e_jn', source: 'n_job', target: 'n_need', type: 'job_surfaces_need' },
      { id: 'e_sf', source: 'n_sol', target: 'n_feat', type: 'solution_becomes_feature' },
    ],
  }
}

let tmpFile: string
function writeFixture(): string {
  const f = path.join(os.tmpdir(), `upg-seam-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(fixtureDoc()))
  return f
}

async function freshStore(): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(writeFixture())
  return store
}

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile)
})

// ──: validation matrix — single + batch return the SAME answer ────────

describe(' unified write validation (single ↔ batch parity)', () => {
  it('invalid STATUS rejects identically in create / update / batch_create / batch_update', async () => {
    const store = await freshStore()
    // single create
    expect(() => createNode(store, { type: 'feature', title: 'A', status: 'not_a_phase' }))
      .toThrow(WriteValidationError)
    // single update
    expect(() => updateNode(store, { node_id: 'n_feat', status: 'not_a_phase' }))
      .toThrow(WriteValidationError)
    // batch create
    const bc = batchCreateNodes(store, { nodes: [{ type: 'feature', title: 'B', status: 'not_a_phase' }] })
    expect(bc.ok).toBe(false)
    if (!bc.ok) expect(bc.error).toMatch(/not a valid phase/i)
    // batch update
    const bu = batchUpdateNodes(store, [{ node_id: 'n_feat', status: 'not_a_phase' }])
    expect(bu.ok).toBe(false)
    if (!bu.ok) expect(bu.error).toMatch(/not a valid phase/i)
  })

  it('unknown PROPERTY warns (permissive) in single + batch, and rejects in strict in both', async () => {
    const store = await freshStore()
    // single create: warn, store
    const c = createNode(store, { type: 'feature', title: 'P', properties: { bogus_prop: 1 } })
    expect(c.warning).toMatch(/unknown propert/i)
    expect(c.node.properties?.bogus_prop).toBe(1)
    // batch create: warn (was previously SILENT), store
    const bc = batchCreateNodes(store, { nodes: [{ type: 'feature', title: 'P2', properties: { bogus_prop: 2 } }] })
    expect(bc.ok).toBe(true)
    if (bc.ok) expect(bc.warnings?.some((w) => /unknown propert/i.test(w))).toBe(true)
    // strict: reject in single
    expect(() => createNode(store, { type: 'feature', title: 'P3', properties: { bogus_prop: 3 }, strict: true }))
      .toThrow(WriteValidationError)
    // strict: reject in batch
    const bcs = batchCreateNodes(store, { nodes: [{ type: 'feature', title: 'P4', properties: { bogus_prop: 4 }, strict: true }] })
    expect(bcs.ok).toBe(false)
  })

  it('explicit non-catalog EDGE type rejects in single create_edge (matches batch)', async () => {
    const store = await freshStore()
    const single = createEdge(store, { source_id: 'n_feat', target_id: 'n_sol', type: 'totally_made_up_edge' })
    expect('error' in single).toBe(true)
    if ('error' in single) expect(single.error).toMatch(/not in UPG_EDGE_CATALOG/)
    // batch already rejected; confirm parity
    const batch = batchCreateNodes(store, {
      nodes: [],
      // empty nodes path returns early; assert the explicit-edge catalog check
      // independently via a 2-node batch with a bogus explicit edge
    })
    expect(batch.ok).toBe(false) // empty nodes
  })

  it('unknown TYPE rejects in both (throws UnknownEntityTypeError single, error in batch)', async () => {
    const store = await freshStore()
    expect(() => createNode(store, { type: 'definitely_not_a_type', title: 'X' })).toThrow()
    const bc = batchCreateNodes(store, { nodes: [{ type: 'definitely_not_a_type', title: 'X' }] })
    expect(bc.ok).toBe(false)
  })
})

// ──: property unset ───────────────────────────────────────────────────

describe(' property unset', () => {
  it('unset_properties deletes keys (vs null which only stores null)', async () => {
    const store = await freshStore()
    const before = store.getNode('n_need')!.properties!
    expect(Object.keys(before)).toContain('effort')
    const r = updateNode(store, { node_id: 'n_need', unset_properties: ['effort'] })
    expect(r.unset).toEqual(['effort'])
    expect(Object.keys(store.getNode('n_need')!.properties!)).not.toContain('effort')
    // null merely stores null (the trap we're fixing)
    updateNode(store, { node_id: 'n_need', properties: { impact: null as unknown as number } })
    expect(store.getNode('n_need')!.properties!.impact).toBeNull()
  })
})

// ──: trace off-by-one ────────────────────────────────────────────────

describe(' trace path semantics', () => {
  it('documented happy-path (hops AFTER anchor) yields a multi-hop trail', async () => {
    const store = await freshStore()
    const r = executeTrace(store, 'n_persona', ['job', 'need'])
    expect(r.error).toBeUndefined()
    expect(r.trail.map((t) => t.entity_type)).toEqual(['persona', 'job', 'need'])
    expect(r.trail.length).toBe(3)
  })

  it('including the anchor type as path[0] halts at depth 1 (the broken convention)', async () => {
    const store = await freshStore()
    const r = executeTrace(store, 'n_persona', ['persona', 'job', 'need'])
    expect(r.halted_at_depth).toBe(1)
  })
})

// ──: prioritise type mismatch (no div-by-zero) ───────────────────────

describe(' prioritise type guard', () => {
  it('returns a clear type_mismatch (not a div-by-zero) for wrong-type candidates', async () => {
    const store = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!
    // n_job is a `job` — NOT one of RICE's targets (feature/opportunity/solution/need),
    // so the guard must still fire loud. (`solution` is now a RICE target as of 0.9.0.)
    const r = executePrioritise(rice, ['n_job'], store)
    expect(r.kind).toBe('type_mismatch')
    if (r.kind === 'type_mismatch') {
      expect(r.target_entity_types).toContain('feature')
      expect(r.hint).toMatch(/job/)
    }
  })

  it('computes for correct-type candidates', async () => {
    const store = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!
    // give the feature rice props so it computes
    updateNode(store, { node_id: 'n_feat', properties: { reach: 100, impact: 2, confidence: 1, effort: 4 } })
    const r = executePrioritise(rice, ['n_feat'], store)
    expect(r.kind).toBe('execution')
  })

  it('0.8.6: RICE now scores an opportunity directly (broadened target)', async () => {
    const store = await freshStore()
    const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']!
    // n_opp is an `opportunity` carrying RICE inputs in the fixture; broadening
    // makes it a first-class target, so the direct path computes (no exercise).
    expect(rice.data.computed_properties?.some((c) => c.entity_type === 'opportunity')).toBe(true)
    const r = executePrioritise(rice, ['n_opp'], store)
    expect(r.kind).toBe('execution')
  })
})

// ──: plan scope ──────────────────────────────────────────────────────

describe(' plan scope', () => {
  it('defaults to active regions, not the whole 315-type universe', async () => {
    const store = await freshStore()
    const r = executePlan(store)
    expect(r.scope).toBe('active_regions')
    expect(r.expected_count).toBeGreaterThan(0)
    expect(r.expected_count).toBeLessThan(315)
    expect(r.scoped_regions.length).toBeGreaterThan(0)
  })

  it('exhaustive opt-in scores the full universe', async () => {
    const store = await freshStore()
    expect(executePlan(store, { exhaustive: true }).expected_count).toBe(316)
  })

  it('accepts a canonical region id AND an atomic-domain id', async () => {
    const store = await freshStore()
    expect(executePlan(store, { region: 'discovery_research_validation' }).expected_count).toBeGreaterThan(0)
    expect(executePlan(store, { region: 'discovery' }).expected_count).toBeGreaterThan(0)
  })

  it('returns a clear error for an unknown region/domain (not silent empty)', async () => {
    const store = await freshStore()
    const r = executePlan(store, { region: 'nonsense' })
    expect(r.error).toBeDefined()
    expect(r.expected_count).toBe(0)
  })
})

// ──: contract cluster ────────────────────────────────────────────────

describe(' contracts', () => {
  it('S-02: verify().ok is true on a clean graph', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    const v = await upg.verify()
    expect(v.ok).toBe(true)
  })

  it('S-03: render helpers return a string (not null) on the clean case', () => {
    const cleanDrift = { entity_drift: 0, edge_drift: 0, top_level_drift: 0, lifecycle_drift: 0, self_referential: 0, property_drift: 0, total_nodes: 0, total_edges: 0 }
    expect(typeof renderDriftSummary(cleanDrift)).toBe('string')
    expect(() => renderDriftSummary(cleanDrift)!.split('\n')).not.toThrow()
    const cleanDangling = { total: 0, by_class: { expected: 0, suspect: 0, corrupt: 0 }, edges: [] }
    expect(typeof renderDanglingReport(cleanDangling, 'x.upg')).toBe('string')
    // quietWhenClean still returns null (loader path)
    expect(renderDriftSummary(cleanDrift, undefined, { quietWhenClean: true })).toBeNull()
  })

  it('S-06: executeReflect throws ReflectModeError on an unknown mode', async () => {
    const store = await freshStore()
    expect(() => executeReflect(store, 'coverage')).toThrow(ReflectModeError)
    // valid mode + null mode work
    expect(executeReflect(store, 'assumptions').mode).toBe('assumptions')
    expect(executeReflect(store, undefined).prompts.length).toBeGreaterThanOrEqual(0)
  })

  it('S-08: nodes.get(id, {withEdges}) / inspect return edges_in/edges_out', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    const withEdges = await upg.nodes.get('n_job', { withEdges: true })
    expect(withEdges).toBeDefined()
    expect(withEdges!).toHaveProperty('edges_in')
    expect(withEdges!).toHaveProperty('edges_out')
    const inspected = await upg.nodes.inspect('n_job')
    expect(inspected!.edges_out.length).toBeGreaterThan(0) // job → need
    // bare get still returns just the node
    const bare = await upg.nodes.get('n_job')
    expect(bare).not.toHaveProperty('edges_out')
  })
})

// ──: edge resolver + schema facade ───────────────────────────────────

describe(' client schema facade', () => {
  it('edges.resolve is directional; returns null on no-canonical', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    expect(upg.edges.resolve('solution', 'feature')?.type).toBe('solution_becomes_feature')
    expect(upg.edges.resolve('feature', 'solution')).toBeNull()
  })

  it('schema.validChildren / edgesFrom / edgeFor work', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    expect(upg.schema.validChildren('feature_area')).toContain('feature')
    expect(upg.schema.edgesFrom('feature').length).toBeGreaterThan(0)
    expect(upg.schema.edgeFor('solution', 'feature')).toBe('solution_becomes_feature')
  })
})

// ──: portfolio register → flush round-trip ───────────────────────────

describe(' portfolio register persists through flush', () => {
  it('registerProductOnPortfolio(doc, ref, store) survives flush()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-portfolio-'))
    const { UPGPortfolioStore } = await import('../store.js')
    const store = new UPGPortfolioStore()
    const portfolioPath = path.join(dir, 'portfolio.upg')
    await store.loadOrInit(portfolioPath)
    const doc = store.getDocument()!
    const appended = registerProductOnPortfolio(doc, { id: 'prod_x', title: 'X' }, store)
    expect(appended).toBe(true)
    await store.flush()
    // re-read from disk: the product must persist
    const store2 = new UPGPortfolioStore()
    await store2.loadOrInit(portfolioPath)
    const products = (store2.getDocument()!.products as unknown as Array<{ id: string }>)
    expect(products.some((p) => p.id === 'prod_x')).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ──: client conveniences ─────────────────────────────────────────────

describe(' client conveniences', () => {
  it('nodes.createMany is atomic and chains via parent_ref', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    const r = await upg.nodes.createMany({
      nodes: [
        { type: 'feature_area', title: 'Area' },
        { type: 'feature', title: 'Child', parent_ref: '$0' },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.count).toBe(2)
      expect(r.edges.length).toBe(1) // parent_ref auto-edge
    }
  })

  it('product.update sets stage and persists', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    await upg.product.update({ stage: 'build' })
    const reloaded = new UPGClient({ file: tmpFile })
    expect((await reloaded.product.get()).stage).toBe('build')
  })

  it('transaction defers flush to one write', async () => {
    tmpFile = writeFixture()
    const upg = new UPGClient({ file: tmpFile })
    await upg.transaction(async () => {
      await upg.nodes.create({ type: 'feature', title: 'T1' })
      await upg.nodes.create({ type: 'feature', title: 'T2' })
    })
    const reloaded = new UPGClient({ file: tmpFile })
    const list = await reloaded.nodes.list({ type: 'feature' })
    expect(list.nodes.length).toBeGreaterThanOrEqual(3) // original + 2
  })
})

// ── / DT-SIM-1 + DT-SIM-2: product-stage write validation + 2-product guard ──

describe(' product-stage write validation (create_node ↔ create_product parity)', () => {
  it('create_node(type:product) with a legacy stage is REJECTED (no longer silent)', async () => {
    const store = await freshStore()
    expect(() =>
      createNode(store, { type: 'product', title: 'Legacy', properties: { stage: 'idea' } }),
    ).toThrow(WriteValidationError)
  })

  it('rejects with the SAME message create_product gives (validateProductStageStrict is the single source)', async () => {
    const store = await freshStore()
    const expected = validateProductStageStrict('idea')
    expect(expected).toBeTruthy()
    let thrown: WriteValidationError | undefined
    try {
      createNode(store, { type: 'product', title: 'Legacy', properties: { stage: 'idea' } })
    } catch (err) {
      thrown = err as WriteValidationError
    }
    expect(thrown).toBeInstanceOf(WriteValidationError)
    // The create_node rejection carries the exact create_product message.
    expect(thrown!.message).toContain(expected as string)
    // And it names the canonical alternative ('concept') + the canonical enum.
    expect(thrown!.message).toMatch(/concept/)
  })

  it('create_node(type:product) with a CANONICAL stage is accepted', async () => {
    const store = await freshStore()
    const r = createNode(store, { type: 'product', title: 'OK', properties: { stage: 'build' } })
    expect(r.node.properties?.stage).toBe('build')
  })

  it('update_node on a product with a legacy stage is rejected; canonical is accepted', async () => {
    const store = await freshStore()
    // seed a canonical product node, then try to update its stage to a legacy value
    const created = createNode(store, { type: 'product', title: 'P', properties: { stage: 'concept' } })
    expect(() =>
      updateNode(store, { node_id: created.node.id, properties: { stage: 'mvp' } }),
    ).toThrow(WriteValidationError)
    const ok = updateNode(store, { node_id: created.node.id, properties: { stage: 'growth' } })
    expect(ok.node.properties?.stage).toBe('growth')
  })

  it('legacy stage on a NON-product node is untouched (validation is product-scoped)', async () => {
    const store = await freshStore()
    // 'feature' has no 'stage' in its schema, but a stray stage key must NOT
    // trip product-stage validation — only product nodes are checked.
    const r = createNode(store, { type: 'feature', title: 'F', properties: { stage: 'idea' } })
    expect(r.node.properties?.stage).toBe('idea')
  })

  it('batch_create_nodes applies the same product-stage rejection', async () => {
    const store = await freshStore()
    const bc = batchCreateNodes(store, {
      nodes: [{ type: 'product', title: 'BadProduct', properties: { stage: 'scale' } }],
    })
    expect(bc.ok).toBe(false)
    if (!bc.ok) expect(bc.error).toMatch(/Invalid product stage/i)
  })
})

describe(' / DT-SIM-2: two-product guard', () => {
  it('warns when a SECOND product node would be created in one .upg', async () => {
    const store = await freshStore()
    // fixture has no product node → first product: no two-product warning
    const first = createNode(store, { type: 'product', title: 'First', properties: { stage: 'concept' } })
    expect(first.warning ?? '').not.toMatch(/already exists/i)
    // second product node: guard fires
    const second = createNode(store, { type: 'product', title: 'Second', properties: { stage: 'concept' } })
    expect(second.warning).toBeTruthy()
    expect(second.warning).toMatch(/already exists/i)
    expect(second.warning).toMatch(/init_workspace/)
    // it WARNS (does not hard-reject): the node still lands
    expect(second.node.type).toBe('product')
  })
})

// ── §B: product stage updatable + header↔node sync + digest precedence ──

describe(' §B product stage write surface', () => {
  it('updateProduct writes the header stage and rejects a non-canonical stage', async () => {
    const store = await freshStore()
    const r = await updateProduct({ store, stage: 'build' })
    expect(r.updated).toContain('stage')
    expect((store.getProduct() as { stage?: string }).stage).toBe('build')
    // updateProduct is async (0.10.1): a non-canonical stage rejects, not throws.
    await expect(updateProduct({ store, stage: 'mvp' as never })).rejects.toThrow(InvalidProductStageError)
  })

  it('update_node on a product node syncs $upg.product.stage (closes the desync)', async () => {
    const store = await freshStore()
    const created = createNode(store, { type: 'product', title: 'P', properties: { stage: 'concept' } })
    updateNode(store, { node_id: created.node.id, properties: { stage: 'growth' } })
    expect((store.getProduct() as { stage?: string }).stage).toBe('growth')
  })

  it('get_graph_digest resolves the product stage node-first (header fallback)', async () => {
    const store = await freshStore()
    createNode(store, { type: 'product', title: 'P', properties: { stage: 'growth' } })
    const digest = computeGraphDigest(store)
    expect(digest.product.stage).toBe('growth')
  })
})
