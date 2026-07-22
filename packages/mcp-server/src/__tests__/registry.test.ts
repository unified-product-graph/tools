/**
 * Canonical shared-entity registry (0.9.6, registry initiative Phases 2–3).
 *
 * Runs against a real tmp workspace; the handlers read process.cwd(), so each
 * test chdirs in and restores afterwards. Exercises define_canonical_entity,
 * register_instance (same-type enforcement + idempotency), list_registry,
 * the create_cross_product_edge instance_of rejection, and the portfolio_validate
 * registry-drift surface.
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
import {
  defineCanonicalEntity,
  registerInstance,
  listRegistry,
  updateCanonicalEntity,
  batchDefineCanonicalEntity,
  batchRegisterInstance,
  promoteToCanonical,
  createRegistryEdge,
  deleteCanonicalEntity,
  mergeCanonicalEntities,
} from '../tools/registry.js'
import { createCrossProductEdge, linkAreaToAudience, switchProduct } from '../tools/workspace.js'
import { getNode, getNodes } from '../tools/nodes.js'
import { createEdge } from '../tools/edges.js'
import { portfolioValidate } from '../tools/portfolio-read.js'

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    nodes: [],
    edges: [],
    ...over,
  }
}

const MAIN = doc({
  product: { id: 'p_main', title: 'Main', stage: 'growth' },
  nodes: [
    { id: 'm_dev', type: 'persona', title: 'Developer' },
    { id: 'm_kpi', type: 'metric', title: 'Weekly active developers' },
  ],
})

function bodyOf(result: { content: { text: string }[] } | Promise<unknown>) {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text)
}

/** Raw text of a result — used for textError responses (plain text, not JSON). */
function errOf(result: { content: { text: string }[]; isError?: true }) {
  return result.content[0].text
}

describe('canonical registry (0.9.6)', () => {
  let cwd: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-registry-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'main.upg'), JSON.stringify(MAIN, null, 2))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function activeCtx(): Promise<ToolContext> {
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'main.upg'))
    store.stopWatching()
    return {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
  }

  function readPortfolio(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
  }

  /** Write a minimal portfolio.upg with a registry + cross_edges (no bootstrap needed). */
  function writePortfolioDoc(over: { registry?: unknown; cross_edges?: unknown[] }): void {
    const pf = {
      upg_version: '0.2',
      type: 'portfolio',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      organization: { id: 'org_test', title: 'Test Org' },
      product_areas: [],
      portfolios: [],
      products: [],
      cross_edges: over.cross_edges ?? [],
      ...(over.registry ? { registry: over.registry } : {}),
    }
    writeFileSync(join(cwd, '.upg', 'portfolio.upg'), JSON.stringify(pf, null, 2))
  }

  // ── define_canonical_entity ────────────────────────────────────────────────

  it('define_canonical_entity writes a canonical node and returns its qualified id', async () => {
    const ctx = await activeCtx()
    const body = bodyOf(
      await defineCanonicalEntity(
        { type: 'persona', title: 'Developer', properties: { audience_role: 'user' } },
        ctx,
      ),
    )
    expect(body.canonical.id).toBe('persona_developer')
    expect(body.canonical.type).toBe('persona')
    expect(body.qualified_id).toBe('registry/persona_developer')
    // Persisted into the portfolio document's registry section.
    const pf = readPortfolio() as { registry?: { nodes?: Array<{ id: string }> } }
    expect(pf.registry?.nodes?.map((n) => n.id)).toContain('persona_developer')
  })

  it('define_canonical_entity rejects an unknown type', async () => {
    const ctx = await activeCtx()
    const err = errOf(await defineCanonicalEntity({ type: 'banana', title: 'Nope' }, ctx))
    expect(err).toMatch(/Invalid entity type/i)
  })

  it('define_canonical_entity rejects a duplicate explicit canonical_id', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer', canonical_id: 'dev' }, ctx)
    const err = errOf(
      await defineCanonicalEntity({ type: 'persona', title: 'Dev again', canonical_id: 'dev' }, ctx),
    )
    expect(err).toMatch(/already has a canonical entity/i)
  })

  // ── batch-6 #34: cross-product get_nodes ─────────────────────────────────────

  it('get_nodes resolves a qualified {product_id}/{node_id} from another product', async () => {
    const OTHER = doc({
      product: { id: 'p_other', title: 'Other', stage: 'growth' },
      nodes: [{ id: 'o_persona', type: 'persona', title: 'Designer' }],
    })
    writeFileSync(join(cwd, '.upg', 'other.upg'), JSON.stringify(OTHER, null, 2))
    const ctx = await activeCtx() // active product = main
    const body = bodyOf(await getNodes({ ids: ['m_dev', 'p_other/o_persona'] }, ctx))
    const dev = body.nodes.find((w: { node: { id: string } }) => w.node.id === 'm_dev')
    expect(dev).toBeDefined()
    const designer = body.nodes.find((w: { node: { id: string } }) => w.node.id === 'o_persona')
    expect(designer).toBeDefined()
    expect(designer.product_id).toBe('p_other')
    expect(designer.node.title).toBe('Designer')
  })

  it('get_nodes reports a cross-product miss with its qualified id', async () => {
    const ctx = await activeCtx()
    const body = bodyOf(await getNodes({ ids: ['p_nonexistent/x'] }, ctx))
    expect(body.not_found).toContain('p_nonexistent/x')
  })

  // ── batch-6 #37: p_ product-header acceptance on intra-graph edges ───────────

  it('create_edge accepts the p_ product-header and resolves it to the in-graph product node', async () => {
    // A legacy-shape product: the in-graph product NODE id differs from the
    // p_ header (new products mint them equal; older ones do not).
    const LEGACY = doc({
      product: { id: 'p_legacy', title: 'Legacy', stage: 'growth' },
      nodes: [
        { id: 'n_legacy_prod', type: 'product', title: 'Legacy' },
        { id: 'n_dec', type: 'decision', title: 'Adopt UPG' },
      ],
    })
    writeFileSync(join(cwd, '.upg', 'legacy.upg'), JSON.stringify(LEGACY, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'legacy.upg'))
    store.stopWatching()
    const ctx: ToolContext = {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
    const body = bodyOf(createEdge({ source_id: 'p_legacy', target_id: 'n_dec' }, ctx))
    expect(body.error).toBeUndefined()
    // The p_ header resolved to the in-graph product node, not left as p_legacy.
    expect(body.edge.source).toBe('n_legacy_prod')
  })

  // ── register_instance ───────────────────────────────────────────────────────

  it('register_instance links a product node to a same-type canonical', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const body = bodyOf(await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx))
    expect(body.edge.type).toBe('instance_of')
    expect(body.edge.source).toBe('p_main/m_dev')
    expect(body.edge.target).toBe('registry/persona_developer')
    expect(body.edge.target_product_id).toBe('registry')
    const pf = readPortfolio() as { cross_edges?: Array<{ type: string }> }
    expect(pf.cross_edges?.some((e) => e.type === 'instance_of')).toBe(true)
  })

  it('register_instance rejects a type mismatch', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    // m_kpi is a metric, the canonical is a persona.
    const err = errOf(await registerInstance({ node_id: 'm_kpi', canonical_id: 'persona_developer' }, ctx))
    expect(err).toMatch(/Type mismatch/i)
  })

  it('register_instance rejects a missing canonical', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const err = errOf(await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_ghost' }, ctx))
    expect(err).toMatch(/not found in the registry/i)
  })

  it('register_instance is idempotent', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx)
    const body = bodyOf(await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx))
    expect(body.already_existed).toBe(true)
    const pf = readPortfolio() as { cross_edges?: unknown[] }
    expect(pf.cross_edges).toHaveLength(1)
  })

  // ── cross-product register_instance (register-instance-cross-product fix) ─────
  // register_instance must resolve a node living in ANY workspace product, not
  // just the active/flat-.upg one. p_studio lives in a root-level subdir, so the
  // SDK's flat-scan findProductFileById missed it ("Product not found in the
  // workspace") even though list_local_products + the cross-edge writer resolve
  // it. resolveSourceNode now discovers via findWorkspaceUpgFiles.

  function writeStudioSubdirProduct(): void {
    mkdirSync(join(cwd, 'studio'))
    const studio = doc({
      product: { id: 'p_studio', title: 'Studio', stage: 'growth' },
      nodes: [{ id: 'n_metric', type: 'metric', title: 'Activation rate' }],
    })
    writeFileSync(join(cwd, 'studio', 'studio.upg'), JSON.stringify(studio, null, 2))
  }

  it('register_instance resolves a node in a non-active subdir product (qualified id)', async () => {
    writeStudioSubdirProduct()
    const ctx = await activeCtx() // active = p_main; p_studio is non-active + in a subdir
    await defineCanonicalEntity({ type: 'metric', title: 'Activation' }, ctx)
    const body = bodyOf(
      await registerInstance({ node_id: 'p_studio/n_metric', canonical_id: 'metric_activation' }, ctx),
    )
    expect(body.edge.type).toBe('instance_of')
    expect(body.edge.source).toBe('p_studio/n_metric')
    expect(body.instance.product_id).toBe('p_studio')
    expect(body.instance.type).toBe('metric')
  })

  it('register_instance resolves a non-active subdir product via source_product_id (bare id)', async () => {
    writeStudioSubdirProduct()
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'metric', title: 'Activation' }, ctx)
    const body = bodyOf(
      await registerInstance(
        { node_id: 'n_metric', source_product_id: 'p_studio', canonical_id: 'metric_activation' },
        ctx,
      ),
    )
    expect(body.edge.source).toBe('p_studio/n_metric')
    expect(body.instance.product_id).toBe('p_studio')
  })

  it('batch_register_instance resolves nodes across non-active subdir products', async () => {
    writeStudioSubdirProduct()
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'metric', title: 'Activation' }, ctx)
    const body = bodyOf(
      await batchRegisterInstance(
        { instances: [{ node_id: 'p_studio/n_metric', canonical_id: 'metric_activation' }] },
        ctx,
      ),
    )
    // The cross-product instance registered cleanly (no "product not found").
    const pf = readPortfolio() as { cross_edges?: Array<{ type: string; source: string }> }
    expect(pf.cross_edges?.some((e) => e.type === 'instance_of' && e.source === 'p_studio/n_metric')).toBe(true)
  })

  // ── list_registry ───────────────────────────────────────────────────────────

  it('list_registry reports canonicals, instance_count, and instances', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer', properties: { audience_role: 'user' } }, ctx)
    await defineCanonicalEntity({ type: 'metric', title: 'Weekly active developers' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx)

    const all = bodyOf(await listRegistry({ include_instances: true }, ctx))
    expect(all.total).toBe(2)
    expect(all.by_type).toMatchObject({ persona: 1, metric: 1 })
    const dev = all.registry.find((r: { id: string }) => r.id === 'persona_developer')
    expect(dev.audience_role).toBe('user')
    expect(dev.instance_count).toBe(1)
    expect(dev.instances[0].source).toBe('p_main/m_dev')

    const personasOnly = bodyOf(await listRegistry({ type: 'persona' }, ctx))
    expect(personasOnly.total).toBe(1)
  })

  // ── create_cross_product_edge rejects instance_of ────────────────────────────

  it('create_cross_product_edge refuses instance_of and points at register_instance', async () => {
    const ctx = await activeCtx()
    const err = errOf(
      await createCrossProductEdge(
        { source_id: 'p_main/m_dev', target_id: 'registry/persona_developer', type: 'instance_of' },
        ctx,
      ),
    )
    expect(err).toMatch(/register_instance/i)
  })

  // ── portfolio_validate registry drift (Phase 3) ──────────────────────────────

  it('portfolio_validate reports a clean registry when titles match canon', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx)
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.registry_drift).toBeDefined()
    expect(body.registry_drift.clean).toBe(true)
    expect(body.registry_drift.on_canon).toBe(1)
  })

  it('portfolio_validate flags an instance renamed off-canon (title_divergence)', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx)
    // Rename the product instance off-canon and persist.
    ctx.store.updateNode('m_dev', { title: 'Senior Developer' })
    await ctx.store.flush()
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.registry_drift.clean).toBe(false)
    expect(body.registry_drift.issues_by_kind.title_divergence).toBe(1)
    const issue = body.registry_drift.issues.find((i: { kind: string }) => i.kind === 'title_divergence')
    expect(issue.instance_title).toBe('Senior Developer')
    expect(issue.canonical_title).toBe('Developer')
  })

  // ── update_canonical_entity (#23) ────────────────────────────────────────────

  it('update_canonical_entity edits a canonical without disturbing its instances', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer', description: 'PROOF placeholder' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer' }, ctx)
    const body = bodyOf(
      await updateCanonicalEntity(
        { canonical_id: 'persona_developer', description: 'A software developer.', audience_role: 'user' },
        ctx,
      ),
    )
    expect(body.canonical.description).toBe('A software developer.')
    expect(body.canonical.properties.audience_role).toBe('user')
    expect(body.instance_count).toBe(1)
    const pf = readPortfolio() as { cross_edges?: Array<{ type: string }> }
    expect(pf.cross_edges?.filter((e) => e.type === 'instance_of')).toHaveLength(1)
  })

  it('update_canonical_entity rejects a missing canonical', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const err = errOf(await updateCanonicalEntity({ canonical_id: 'persona_ghost', title: 'X' }, ctx))
    expect(err).toMatch(/not found in the registry/i)
  })

  // ── batch_define_canonical_entity / batch_register_instance (#24) ─────────────

  it('batch_define_canonical_entity writes many atomically', async () => {
    const ctx = await activeCtx()
    const body = bodyOf(
      await batchDefineCanonicalEntity(
        { entities: [{ type: 'persona', title: 'Developer' }, { type: 'metric', title: 'Weekly active developers' }] },
        ctx,
      ),
    )
    expect(body.count).toBe(2)
    expect(bodyOf(await listRegistry({}, ctx)).total).toBe(2)
  })

  it('batch_define_canonical_entity rejects the whole batch on one bad type', async () => {
    const ctx = await activeCtx()
    const err = errOf(
      await batchDefineCanonicalEntity(
        { entities: [{ type: 'persona', title: 'Developer' }, { type: 'banana', title: 'Nope' }] },
        ctx,
      ),
    )
    expect(err).toMatch(/entities\[1\].*invalid entity type/i)
    expect(bodyOf(await listRegistry({}, ctx)).total).toBe(0)
  })

  it('batch_register_instance links many and is idempotent', async () => {
    const ctx = await activeCtx()
    await batchDefineCanonicalEntity(
      { entities: [{ type: 'persona', title: 'Developer' }, { type: 'metric', title: 'Weekly active developers' }] },
      ctx,
    )
    const body = bodyOf(
      await batchRegisterInstance(
        {
          instances: [
            { node_id: 'm_dev', canonical_id: 'persona_developer' },
            { node_id: 'm_kpi', canonical_id: 'metric_weekly_active_developers' },
          ],
        },
        ctx,
      ),
    )
    expect(body.registered).toBe(2)
    const again = bodyOf(
      await batchRegisterInstance({ instances: [{ node_id: 'm_dev', canonical_id: 'persona_developer' }] }, ctx),
    )
    expect(again.already_existed).toBe(1)
    expect(again.registered).toBe(0)
  })

  // ── promote_to_canonical (#26) ───────────────────────────────────────────────

  it('promote_to_canonical lifts an existing node and registers it as first instance', async () => {
    const ctx = await activeCtx()
    const body = bodyOf(await promoteToCanonical({ node_id: 'm_dev' }, ctx))
    expect(body.canonical.type).toBe('persona')
    expect(body.canonical.title).toBe('Developer')
    expect(body.registered_source).toBe(true)
    expect(body.edge.type).toBe('instance_of')
    expect(body.edge.source).toBe('p_main/m_dev')
  })

  // ── alias-sanctioned drift (#25) ─────────────────────────────────────────────

  it('register_instance alias sanctions a title divergence so drift stays clean', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer', alias: true }, ctx)
    ctx.store.updateNode('m_dev', { title: 'Senior Developer' })
    await ctx.store.flush()
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.registry_drift.clean).toBe(true)
    expect(body.registry_drift.sanctioned).toBe(1)
    expect(body.registry_drift.issues_total).toBe(0)
  })

  // ── get_node resolves registry/{id} (#23 bonus) ──────────────────────────────

  it('get_node resolves a registry/{id} canonical with its instances', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    await registerInstance({ node_id: 'm_dev', canonical_id: 'persona_developer', alias: true }, ctx)
    const body = bodyOf(await getNode({ node_id: 'registry/persona_developer' }, ctx))
    expect(body.registry).toBe(true)
    expect(body.node.title).toBe('Developer')
    expect(body.instance_count).toBe(1)
    expect(body.instances[0].alias).toBe(true)
  })

  // ── rolls_up_to via create_cross_product_edge (#30) ──────────────────────────

  it('create_cross_product_edge accepts rolls_up_to (metric to metric)', async () => {
    const ctx = await activeCtx()
    const body = bodyOf(
      await createCrossProductEdge(
        { source_id: 'p_main/m_kpi', target_id: 'p_company/company_nsm', type: 'rolls_up_to', auto_create_portfolio: true },
        ctx,
      ),
    )
    expect(body.edge.type).toBe('rolls_up_to')
    expect(body.edge.source).toBe('p_main/m_kpi')
  })

  // ── link_area_to_audience (#29) ──────────────────────────────────────────────

  it('link_area_to_audience links an area to a registry persona with qualifiers', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const pf = readPortfolio()
    pf.product_areas = [{ id: 'area_platform', title: 'Platform' }]
    writeFileSync(join(cwd, '.upg', 'portfolio.upg'), JSON.stringify(pf, null, 2))
    const body = bodyOf(
      await linkAreaToAudience(
        { area_id: 'area_platform', canonical_id: 'persona_developer', relevance: 'primary', audience_role: 'user' },
        ctx,
      ),
    )
    expect(body.edge.type).toBe('area_serves_persona')
    expect(body.edge.source).toBe('area_platform')
    expect(body.edge.target).toBe('registry/persona_developer')
    expect(body.edge.relevance).toBe('primary')
    expect(body.edge.audience_role).toBe('user')
  })

  it('link_area_to_audience rejects an unknown area', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const err = errOf(await linkAreaToAudience({ area_id: 'area_ghost', canonical_id: 'persona_developer' }, ctx))
    expect(err).toMatch(/not found in the portfolio/i)
  })

  it('create_cross_product_edge refuses area_serves_persona and points at link_area_to_audience', async () => {
    const ctx = await activeCtx()
    const err = errOf(
      await createCrossProductEdge(
        { source_id: 'area_platform', target_id: 'registry/persona_developer', type: 'area_serves_persona' },
        ctx,
      ),
    )
    expect(err).toMatch(/link_area_to_audience/i)
  })

  // ── create_registry_edge (0.9.13 foundations follow-ups) ─────────────────────

  /** Seed a registry specification + organization and return the ctx. */
  async function withSpecAndOrg(): Promise<ToolContext> {
    const ctx = await activeCtx()
    await batchDefineCanonicalEntity(
      {
        entities: [
          { type: 'specification', title: 'UPG', canonical_id: 'specification_upg' },
          { type: 'organization', title: 'Arkheiev', canonical_id: 'organization_arkheiev' },
        ],
      },
      ctx,
    )
    return ctx
  }

  it('create_registry_edge writes a canonical-internal edge into registry.edges', async () => {
    const ctx = await withSpecAndOrg()
    const body = bodyOf(
      await createRegistryEdge(
        { source_id: 'specification_upg', target_id: 'organization_arkheiev', type: 'specification_governed_by_organization' },
        ctx,
      ),
    )
    expect(body.edge.type).toBe('specification_governed_by_organization')
    expect(body.edge.source).toBe('specification_upg')
    expect(body.edge.target).toBe('organization_arkheiev')
    const pf = readPortfolio() as { registry?: { edges?: Array<{ type: string }> } }
    expect(pf.registry?.edges?.map((e) => e.type)).toContain('specification_governed_by_organization')
  })

  it('create_registry_edge accepts registry/{id}-qualified endpoints', async () => {
    const ctx = await withSpecAndOrg()
    const body = bodyOf(
      await createRegistryEdge(
        { source_id: 'registry/specification_upg', target_id: 'registry/organization_arkheiev', type: 'specification_governed_by_organization' },
        ctx,
      ),
    )
    expect(body.edge.source).toBe('specification_upg')
    expect(body.edge.target).toBe('organization_arkheiev')
  })

  it('create_registry_edge is idempotent', async () => {
    const ctx = await withSpecAndOrg()
    await createRegistryEdge(
      { source_id: 'specification_upg', target_id: 'organization_arkheiev', type: 'specification_governed_by_organization' },
      ctx,
    )
    const body = bodyOf(
      await createRegistryEdge(
        { source_id: 'specification_upg', target_id: 'organization_arkheiev', type: 'specification_governed_by_organization' },
        ctx,
      ),
    )
    expect(body.already_existed).toBe(true)
    const pf = readPortfolio() as { registry?: { edges?: unknown[] } }
    expect(pf.registry?.edges).toHaveLength(1)
  })

  it('create_registry_edge rejects an unknown edge type', async () => {
    const ctx = await withSpecAndOrg()
    const err = errOf(
      await createRegistryEdge(
        { source_id: 'specification_upg', target_id: 'organization_arkheiev', type: 'not_a_real_edge' },
        ctx,
      ),
    )
    expect(err).toMatch(/Invalid edge type/i)
  })

  it('create_registry_edge rejects an endpoint type mismatch', async () => {
    const ctx = await withSpecAndOrg()
    // Endpoints reversed: organization -> specification is not the catalog pair.
    const err = errOf(
      await createRegistryEdge(
        { source_id: 'organization_arkheiev', target_id: 'specification_upg', type: 'specification_governed_by_organization' },
        ctx,
      ),
    )
    expect(err).toMatch(/Type mismatch/i)
  })

  it('create_registry_edge rejects a missing endpoint', async () => {
    const ctx = await withSpecAndOrg()
    const err = errOf(
      await createRegistryEdge(
        { source_id: 'specification_upg', target_id: 'organization_ghost', type: 'specification_governed_by_organization' },
        ctx,
      ),
    )
    expect(err).toMatch(/not found in the registry/i)
  })

  // create_registry_edge takes ANY catalog edge whose endpoints resolve to
  // matching registry canonicals (no allowlist) — so a registry-tier
  // classification axis works today without a dedicated cross-edge. This is the
  // hierarchy twin of the 0.10.2/0.10.3 `*_classified_as_classification_value`
  // cross-edges: the axis->value containment lives once in the registry, and
  // graphs classify against its values rather than redefine the taxonomy.
  it('create_registry_edge supports classification_axis_includes_classification_value at the registry tier (0.10.3)', async () => {
    const ctx = await activeCtx()
    await batchDefineCanonicalEntity(
      {
        entities: [
          { type: 'classification_axis', title: 'Delivery Architecture', canonical_id: 'classification_axis_delivery_architecture' },
          { type: 'classification_value', title: 'OSS / Self-host', canonical_id: 'classification_value_oss_self_host' },
        ],
      },
      ctx,
    )
    const body = bodyOf(
      await createRegistryEdge(
        {
          source_id: 'classification_axis_delivery_architecture',
          target_id: 'classification_value_oss_self_host',
          type: 'classification_axis_includes_classification_value',
        },
        ctx,
      ),
    )
    expect(body.edge.type).toBe('classification_axis_includes_classification_value')
    expect(body.edge.source).toBe('classification_axis_delivery_architecture')
    expect(body.edge.target).toBe('classification_value_oss_self_host')
    const pf = readPortfolio() as { registry?: { edges?: Array<{ type: string }> } }
    expect(pf.registry?.edges?.map((e) => e.type)).toContain('classification_axis_includes_classification_value')
  })

  // ── portfolio_validate foundations anti-patterns (0.9.13, scope:'portfolio') ──

  it('portfolio_validate fires the three foundations anti-patterns and stays clean when satisfied', async () => {
    // Two sibling products, each with a product-local "Token" primitive (scatter)
    // and a node that implements a specification.
    for (const pid of ['p_a', 'p_b']) {
      const PROD = doc({
        product: { id: pid, title: pid.toUpperCase(), stage: 'growth' },
        nodes: [
          { id: `${pid}_prod`, type: 'product', title: pid.toUpperCase() },
          { id: `${pid}_token`, type: 'primitive', title: 'Token' },
        ],
      })
      writeFileSync(join(cwd, '.upg', `${pid}.upg`), JSON.stringify(PROD, null, 2))
    }

    // Registry: specification_nql has NO implementer; specification_graphql is
    // implemented by BOTH products (reimplementation). No canonical "Token" primitive.
    writePortfolioDoc({
      registry: {
        nodes: [
          { id: 'specification_nql', type: 'specification', title: 'NQL' },
          { id: 'specification_graphql', type: 'specification', title: 'GraphQL' },
        ],
      },
      cross_edges: [
        {
          id: 'ce_a', source: 'p_a/p_a_prod', target: 'registry/specification_graphql',
          type: 'product_implements_specification', source_product_id: 'p_a', target_product_id: 'registry',
        },
        {
          id: 'ce_b', source: 'p_b/p_b_prod', target: 'registry/specification_graphql',
          type: 'product_implements_specification', source_product_id: 'p_b', target_product_id: 'registry',
        },
      ],
    })

    const ctx = await activeCtx()
    const body = bodyOf(await portfolioValidate({}, ctx))
    const block = body.portfolio_anti_patterns
    expect(block).toBeDefined()
    expect(block.clean).toBe(false)
    const byId = Object.fromEntries(
      block.violations.map((v: { anti_pattern_id: string }) => [v.anti_pattern_id, v]),
    )
    // 1 · NQL has no implementer (GraphQL does, so it is not flagged).
    expect(byId['specification-without-implementer'].count).toBe(1)
    expect(byId['specification-without-implementer'].instances[0].specification).toBe('specification_nql')
    // 2 · "Token" primitive scattered across p_a + p_b with no registry canonical.
    expect(byId['primitive-scattered-without-canonical'].count).toBe(1)
    expect(byId['primitive-scattered-without-canonical'].instances[0].products).toEqual(['p_a', 'p_b'])
    // 3 · GraphQL implemented by two products.
    expect(byId['product-reimplements-specification'].count).toBe(1)
    expect(byId['product-reimplements-specification'].instances[0].products).toEqual(['p_a', 'p_b'])
  })

  it('portfolio_validate omits the foundations block for a non-foundations portfolio', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Developer' }, ctx)
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.portfolio_anti_patterns).toBeUndefined()
  })

  it('portfolio_validate reports a clean foundations block once the specification has an implementer and the primitive is canonical', async () => {
    const PROD = doc({
      product: { id: 'p_a', title: 'A', stage: 'growth' },
      nodes: [{ id: 'p_a_prod', type: 'product', title: 'A' }],
    })
    writeFileSync(join(cwd, '.upg', 'a.upg'), JSON.stringify(PROD, null, 2))
    writePortfolioDoc({
      registry: { nodes: [{ id: 'specification_nql', type: 'specification', title: 'NQL' }] },
      cross_edges: [
        {
          id: 'ce_a', source: 'p_a/p_a_prod', target: 'registry/specification_nql',
          type: 'product_implements_specification', source_product_id: 'p_a', target_product_id: 'registry',
        },
      ],
    })
    const ctx = await activeCtx()
    const body = bodyOf(await portfolioValidate({}, ctx))
    expect(body.portfolio_anti_patterns).toBeDefined()
    expect(body.portfolio_anti_patterns.clean).toBe(true)
    expect(body.portfolio_anti_patterns.violations).toHaveLength(0)
  })

  // ── portfolio_validate org-link anti-pattern (0.17.0, scope:'portfolio') ──

  const fieldFn = {
    upg_version: '0.17.0',
    exported_at: '2026-06-29T00:00:00Z',
    source: { tool: 'test' },
    product: { id: 'p_field', title: 'Field Operations', stage: 'growth' },
    member_kind: 'operating_function',
    nodes: [{ id: 'p_field_prod', type: 'product', title: 'Field Operations' }],
    edges: [],
  }

  it('portfolio_validate fires operating-function-without-org-link for a function with no org link', async () => {
    writeFileSync(join(cwd, '.upg', 'field.upg'), JSON.stringify(fieldFn, null, 2))
    writePortfolioDoc({ cross_edges: [] })
    const ctx = await activeCtx()
    const block = bodyOf(await portfolioValidate({}, ctx)).portfolio_anti_patterns
    expect(block).toBeDefined()
    expect(block.evaluated).toContain('operating-function-without-org-link')
    const byId = Object.fromEntries(block.violations.map((v: { anti_pattern_id: string }) => [v.anti_pattern_id, v]))
    expect(byId['operating-function-without-org-link'].count).toBe(1)
    expect(byId['operating-function-without-org-link'].instances[0].operating_function).toBe('p_field')
  })

  it('portfolio_validate clears the org-link once the function links to a department in the rollup', async () => {
    writeFileSync(join(cwd, '.upg', 'field.upg'), JSON.stringify(fieldFn, null, 2))
    writePortfolioDoc({
      cross_edges: [
        {
          id: 'ce_org', source: 'p_field/p_field_prod', target: 'rollup/dept_field',
          type: 'node_owned_by_department', source_product_id: 'p_field', target_product_id: 'rollup',
        },
      ],
    })
    const ctx = await activeCtx()
    const block = bodyOf(await portfolioValidate({}, ctx)).portfolio_anti_patterns
    expect(block).toBeDefined()
    const byId = Object.fromEntries(block.violations.map((v: { anti_pattern_id: string }) => [v.anti_pattern_id, v]))
    expect(byId['operating-function-without-org-link']).toBeUndefined()
  })

  // ── delete_canonical_entity / merge_canonical_entities (feedback 01b21402) ──
  //
  // The registry twin scenario the feedback reported: two canonicalization
  // passes created `persona_editor` + `persona_editor_2`, every instance was
  // registered instance_of BOTH twins, and the losing twin could never be
  // removed (delete_node only sees the active product).

  /** The twin-canonical portfolio: keeper (audience_role) + richer twin, one
   * instance double-parented under both, one single-parented under the twin. */
  function writeTwinPortfolio(): void {
    writePortfolioDoc({
      registry: {
        nodes: [
          { id: 'persona_editor', type: 'persona', title: 'Editor', properties: { audience_role: 'user' } },
          {
            id: 'persona_editor_2', type: 'persona', title: 'Editor',
            description: 'Edits and curates content daily.',
            tags: ['content'],
            properties: { seniority: 'senior' },
          },
        ],
      },
      cross_edges: [
        // m_dev is double-parented: instance_of BOTH twins.
        { id: 'ce_keep', source: 'p_main/m_dev', target: 'registry/persona_editor', type: 'instance_of', source_product_id: 'p_main', target_product_id: 'registry' },
        { id: 'ce_twin', source: 'p_main/m_dev', target: 'registry/persona_editor_2', type: 'instance_of', source_product_id: 'p_main', target_product_id: 'registry', alias: true },
        // m_kpi… actually a persona-typed second instance lives only under the twin.
        { id: 'ce_only_twin', source: 'p_other/o_writer', target: 'registry/persona_editor_2', type: 'instance_of', source_product_id: 'p_other', target_product_id: 'registry' },
      ],
    })
  }

  it('delete_canonical_entity deletes an unreferenced canonical and persists', async () => {
    const ctx = await activeCtx()
    await defineCanonicalEntity({ type: 'persona', title: 'Orphan' }, ctx)
    const body = bodyOf(await deleteCanonicalEntity({ canonical_id: 'registry/persona_orphan' }, ctx))
    expect(body.deleted.id).toBe('persona_orphan')
    expect(body.cascaded).toEqual({ instance_of: 0, cross_edges: 0, registry_edges: 0 })
    const pf = readPortfolio() as { registry?: { nodes?: Array<{ id: string }> } }
    expect(pf.registry?.nodes?.map((n) => n.id) ?? []).not.toContain('persona_orphan')
  })

  it('delete_canonical_entity refuses a referenced canonical without cascade', async () => {
    writeTwinPortfolio()
    const ctx = await activeCtx()
    const err = errOf(await deleteCanonicalEntity({ canonical_id: 'persona_editor_2' }, ctx))
    expect(err).toMatch(/still referenced/)
    expect(err).toMatch(/2 instance_of edge/)
    expect(err).toMatch(/merge_canonical_entities/)
    // Nothing was deleted.
    const pf = readPortfolio() as { registry: { nodes: Array<{ id: string }> } }
    expect(pf.registry.nodes.map((n) => n.id)).toContain('persona_editor_2')
  })

  it('delete_canonical_entity cascade deletes the canonical and every referencing edge in one flush', async () => {
    writeTwinPortfolio()
    const ctx = await activeCtx()
    const body = bodyOf(await deleteCanonicalEntity({ canonical_id: 'persona_editor_2', cascade: true }, ctx))
    expect(body.deleted.id).toBe('persona_editor_2')
    expect(body.cascaded.instance_of).toBe(2)
    const pf = readPortfolio() as { registry: { nodes: Array<{ id: string }> }; cross_edges: Array<{ id: string }> }
    expect(pf.registry.nodes.map((n) => n.id)).toEqual(['persona_editor'])
    expect(pf.cross_edges.map((e) => e.id)).toEqual(['ce_keep'])
  })

  it('delete_canonical_entity dry_run previews the blast radius without writing', async () => {
    writeTwinPortfolio()
    const before = readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8')
    const ctx = await activeCtx()
    const body = bodyOf(await deleteCanonicalEntity({ canonical_id: 'persona_editor_2', dry_run: true }, ctx))
    expect(body.dry_run).toBe(true)
    expect(body.would_delete.id).toBe('persona_editor_2')
    expect(body.references.instance_of).toHaveLength(2)
    expect(body.deletable_without_cascade).toBe(false)
    expect(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8')).toBe(before)
  })

  it('delete_canonical_entity rejects an unknown canonical', async () => {
    writeTwinPortfolio()
    const ctx = await activeCtx()
    const err = errOf(await deleteCanonicalEntity({ canonical_id: 'persona_ghost' }, ctx))
    expect(err).toMatch(/not found in the registry/)
  })

  it('merge_canonical_entities collapses the twin: repoints, dedups, unions gaps, deletes the loser', async () => {
    writeTwinPortfolio()
    const ctx = await activeCtx()
    const body = bodyOf(
      await mergeCanonicalEntities({ keep: 'persona_editor', merge: ['registry/persona_editor_2'] }, ctx),
    )
    expect(body.merged).toEqual(['persona_editor_2'])
    // ce_twin (double-parent duplicate) drops; ce_only_twin repoints to the keeper.
    expect(body.dropped_duplicate_edges).toBe(1)
    expect(body.repointed_cross_edges).toBe(1)
    // Keeper gained the loser's gap fills: seniority, description, tags.
    expect(body.properties_added.persona_editor_2).toEqual(
      expect.arrayContaining(['seniority', 'description', 'tags']),
    )
    expect(body.kept.instance_count).toBe(2)

    const pf = readPortfolio() as {
      registry: { nodes: Array<{ id: string; description?: string; tags?: string[]; properties?: Record<string, unknown> }> }
      cross_edges: Array<{ id: string; target: string; alias?: boolean }>
    }
    // The loser is gone; the keeper carries the union (its own audience_role intact).
    expect(pf.registry.nodes.map((n) => n.id)).toEqual(['persona_editor'])
    const keeper = pf.registry.nodes[0]
    expect(keeper.properties?.audience_role).toBe('user')
    expect(keeper.properties?.seniority).toBe('senior')
    expect(keeper.description).toBe('Edits and curates content daily.')
    expect(keeper.tags).toEqual(['content'])
    // Every surviving edge points at the keeper; the dropped duplicate's alias
    // sanction survived on the surviving edge.
    expect(pf.cross_edges.every((e) => e.target === 'registry/persona_editor')).toBe(true)
    expect(pf.cross_edges.find((e) => e.id === 'ce_keep')?.alias).toBe(true)
    expect(pf.cross_edges.map((e) => e.id).sort()).toEqual(['ce_keep', 'ce_only_twin'])
  })

  it('merge_canonical_entities dry_run previews the exact plan without writing', async () => {
    writeTwinPortfolio()
    const before = readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8')
    const ctx = await activeCtx()
    const body = bodyOf(
      await mergeCanonicalEntities({ keep: 'persona_editor', merge: ['persona_editor_2'], dry_run: true }, ctx),
    )
    expect(body.dry_run).toBe(true)
    expect(body.dropped_duplicate_edges).toBe(1)
    expect(body.repointed_cross_edges).toBe(1)
    expect(body.plan.cross_edges).toHaveLength(2)
    expect(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8')).toBe(before)
  })

  it('merge_canonical_entities enforces the same-type constraint and keep∉merge', async () => {
    writePortfolioDoc({
      registry: {
        nodes: [
          { id: 'persona_editor', type: 'persona', title: 'Editor' },
          { id: 'metric_mau', type: 'metric', title: 'MAU' },
        ],
      },
      cross_edges: [],
    })
    const ctx = await activeCtx()
    expect(errOf(await mergeCanonicalEntities({ keep: 'persona_editor', merge: ['metric_mau'] }, ctx))).toMatch(
      /Type mismatch/,
    )
    expect(errOf(await mergeCanonicalEntities({ keep: 'persona_editor', merge: ['persona_editor'] }, ctx))).toMatch(
      /cannot appear in both/,
    )
  })

  it('merge_canonical_entities repoints registry-internal edges and drops self-loops', async () => {
    writePortfolioDoc({
      registry: {
        nodes: [
          { id: 'spec_keep', type: 'specification', title: 'NQL' },
          { id: 'spec_lose', type: 'specification', title: 'NQL v0' },
          { id: 'org_std', type: 'organization', title: 'Standards Body' },
        ],
        edges: [
          // loser → keeper becomes a self-loop after repoint → drops.
          { id: 're_loop', source: 'spec_lose', target: 'spec_keep', type: 'specification_extends_specification' },
          // loser → org repoints to keeper → org.
          { id: 're_gov', source: 'spec_lose', target: 'org_std', type: 'specification_governed_by_organization' },
        ],
      },
      cross_edges: [],
    })
    const ctx = await activeCtx()
    const body = bodyOf(await mergeCanonicalEntities({ keep: 'spec_keep', merge: ['spec_lose'] }, ctx))
    expect(body.dropped_registry_edges).toBe(1)
    expect(body.repointed_registry_edges).toBe(1)
    const pf = readPortfolio() as { registry: { nodes: Array<{ id: string }>; edges: Array<{ id: string; source: string }> } }
    expect(pf.registry.nodes.map((n) => n.id).sort()).toEqual(['org_std', 'spec_keep'])
    expect(pf.registry.edges).toHaveLength(1)
    expect(pf.registry.edges[0]).toMatchObject({ id: 're_gov', source: 'spec_keep' })
  })

  // ── switch_product portfolio detection (feedback 01b21402 papercut) ──────────

  it('switch_product on portfolio.upg returns the directed portfolio answer, not the schema error', async () => {
    writePortfolioDoc({ cross_edges: [] })
    const ctx = await activeCtx()
    const err = errOf(
      (await switchProduct({ file: 'portfolio.upg' }, ctx)) as { content: { text: string }[]; isError?: true },
    )
    expect(err).toMatch(/PORTFOLIO document, not a product graph/)
    expect(err).toMatch(/delete_canonical_entity, merge_canonical_entities/)
    expect(err).not.toMatch(/product is required/)
  })
})
