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
import { defineCanonicalEntity, registerInstance, listRegistry } from '../tools/registry.js'
import { createCrossProductEdge } from '../tools/workspace.js'
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

function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
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
})
