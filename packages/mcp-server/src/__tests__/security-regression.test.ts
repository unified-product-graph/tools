/**
 * Security regression tests: replays the 7 exploits surfaced by the
 * 2026-05-20 adversarial spec audit. Every attack here was confirmed against
 * `.upg/chaos.upg` before the hardening landed; this file ensures
 * they stay refused / detected forever.
 *
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type {
  UPGDocument,
  UPGBaseNode,
  UPGEdge,
  UPGEntityType,
  UPGEdgeType,
} from '@unified-product-graph/core'
import { createEdge, renameEdgeType } from '../tools/edges.js'
import { updateNode, migrateType } from '../tools/nodes.js'
import { validateGraph } from '../tools/validation.js'
import { createCrossProductEdge } from '../tools/workspace.js'
import { computeGraphDigest } from '@unified-product-graph/sdk'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'security regression fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument, dirPrefix = 'upg-security-'): Promise<{
  store: UPGFileStore
  dir: string
}> {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return { store, dir }
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

// ─── F1: explicit edge type pair mismatch ───────────────────────────

describe('F1: explicit edge type pair mismatch must be refused', () => {
  it('refuses persona_pursues_job between vision → vulnerability', async () => {
    const { store } = await loadStore(
      makeDoc([
        { id: 'v1', type: 'vision' as UPGEntityType, title: 'Bold vision' },
        { id: 'vu1', type: 'vulnerability' as UPGEntityType, title: 'Auth bypass' },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await createEdge(
      { source_id: 'v1', target_id: 'vu1', type: 'persona_pursues_job' },
      ctx,
    )
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain('persona_pursues_job')
    expect(text).toContain('source_type=persona')
    expect(text).toContain('target_type=job')
    // Graph stays empty of that edge.
    const edges = store.getAllEdges()
    expect(edges).toHaveLength(0)
  })

  it('refuses vision_realised_through_mission between persona → command', async () => {
    const { store } = await loadStore(
      makeDoc([
        { id: 'p1', type: 'persona' as UPGEntityType, title: 'Bold persona' },
        // No `command` entity type in current catalog, so use a placeholder
        // canonical pair that catalog says doesn't match the edge.
        { id: 'j1', type: 'job' as UPGEntityType, title: 'A job' },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await createEdge(
      { source_id: 'p1', target_id: 'j1', type: 'vision_realised_through_mission' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('source_type=vision')
    expect(result.content[0].text).toContain('target_type=mission')
    expect(store.getAllEdges()).toHaveLength(0)
  })
})

// ─── F2: graph topology self-loops ──────────────────────────────────

describe('F2: graph-topology self-loops must be refused', () => {
  it('refuses a vision_guides_objective self-loop on vision → vision', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'v1', type: 'vision' as UPGEntityType, title: 'Vision' }]),
    )
    const ctx = makeCtx(store)
    const result = await createEdge(
      { source_id: 'v1', target_id: 'v1', type: 'vision_guides_objective' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text.toLowerCase()).toContain('self-loop')
    expect(store.getAllEdges()).toHaveLength(0)
  })

  it('refuses a self-loop on any node regardless of edge type', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'product' as UPGEntityType, title: 'Product' }]),
    )
    const ctx = makeCtx(store)
    const result = await createEdge(
      { source_id: 'p1', target_id: 'p1', type: 'product_builds_feature' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text.toLowerCase()).toContain('self-loop')
  })
})

// ─── F4: property type violations must be refused ───────────────────

describe('F4: declared property type violations must be refused', () => {
  it('refuses metric.target_value = "not_a_number_lol" (string instead of number)', async () => {
    const { store } = await loadStore(
      makeDoc([
        {
          id: 'm1',
          type: 'metric' as UPGEntityType,
          title: 'Activation rate',
        },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await updateNode(
      {
        node_id: 'm1',
        properties: { target_value: 'not_a_number_lol' },
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain('target_value')
    expect(text).toContain('number')
    // Graph value unchanged.
    const node = store.getNode('m1')
    expect((node?.properties as { target_value?: unknown } | undefined)?.target_value).toBeUndefined()
  })

  it('accepts a valid number value for the same field', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'm1', type: 'metric' as UPGEntityType, title: 'rate' }]),
    )
    const ctx = makeCtx(store)
    const result = await updateNode(
      { node_id: 'm1', properties: { target_value: 42 } },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const node = store.getNode('m1')
    expect((node?.properties as { target_value?: number } | undefined)?.target_value).toBe(42)
  })
})

// ─── F5: rename_edge_type must refuse non-canonical without opt-in ──

describe('F5: rename_edge_type non-canonical target', () => {
  it('refuses to rename to a fictional edge type by default', async () => {
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' },
          { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
        ],
        [
          {
            id: 'e1',
            source: 'p1',
            target: 'j1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await renameEdgeType(
      {
        from: 'persona_pursues_job',
        to: 'fictional_edge',
        dry_run: false,
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('UPG_EDGE_CATALOG')
    expect(result.content[0].text).toContain('allow_non_canonical')
    // Graph stays as it was; original edge type intact.
    expect(store.getAllEdges()[0].type).toBe('persona_pursues_job')
  })

  it('accepts the rename when allow_non_canonical: true is passed', async () => {
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' },
          { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
        ],
        [
          {
            id: 'e1',
            source: 'p1',
            target: 'j1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await renameEdgeType(
      {
        from: 'persona_pursues_job',
        to: 'fictional_edge',
        dry_run: false,
        allow_non_canonical: true,
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(store.getAllEdges()[0].type).toBe('fictional_edge')
  })
})

// ─── F6: migrate_type semantic-nonsense pairs ───────────────────────

describe('F6: migrate_type without registered rule', () => {
  it('refuses to migrate persona → bug without force', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'persona' as UPGEntityType, title: 'P' }]),
    )
    const ctx = makeCtx(store)
    const result = await migrateType(
      { from_type: 'persona', to_type: 'bug' },
      ctx,
    )
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain('persona')
    expect(text).toContain('bug')
    expect(text).toContain('force')
    // Graph stays as it was; persona still persona.
    const node = store.getNode('p1')
    expect(node?.type).toBe('persona')
  })

  it('accepts the migration when force: true is passed', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'persona' as UPGEntityType, title: 'P' }]),
    )
    const ctx = makeCtx(store)
    const result = await migrateType(
      { from_type: 'persona', to_type: 'bug', force: true },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    // Should report migrated nodes > 0.
    const body = JSON.parse(result.content[0].text)
    expect(body.migrated_nodes).toBe(1)
  })

  it('accepts a registered migration (pain_point → need) without force', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'pain_point' as UPGEntityType, title: 'P' }]),
    )
    const ctx = makeCtx(store)
    const result = await migrateType(
      { from_type: 'pain_point', to_type: 'need' },
      ctx,
    )
    expect(result.isError).toBeUndefined()
  })
})

// ─── F7: create_cross_product_edge requires portfolio ───────────────

describe('F7: create_cross_product_edge without a portfolio document', () => {
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    workDir = mkdtempSync(join(tmpdir(), 'upg-cross-edge-'))
    // Set up a workspace dir (.upg/) but NO portfolio.upg inside.
    const upgDir = join(workDir, '.upg')
    mkdirSync(upgDir, { recursive: true })
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  it('refuses when no portfolio.upg exists', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'persona' as UPGEntityType, title: 'P' }]),
    )
    const ctx = makeCtx(store)
    const result = await createCrossProductEdge(
      {
        source_id: 'product_chaos/p1',
        target_id: 'product_inkling/i1',
        type: 'shares_persona',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain('portfolio')
    expect(text).toContain('auto_create_portfolio')
    // No portfolio file was created.
    expect(existsSync(join(workDir, '.upg', 'portfolio.upg'))).toBe(false)
  })

  it('accepts when auto_create_portfolio: true is passed', async () => {
    const { store } = await loadStore(
      makeDoc([{ id: 'p1', type: 'persona' as UPGEntityType, title: 'P' }]),
    )
    const ctx = makeCtx(store)
    const result = await createCrossProductEdge(
      {
        source_id: 'product_chaos/p1',
        target_id: 'product_inkling/i1',
        type: 'shares_persona',
        auto_create_portfolio: true,
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(existsSync(join(workDir, '.upg', 'portfolio.upg'))).toBe(true)
  })
})

// ───: chain analyzer 2-hop persona-bridge ───────────────────

describe(': chain analyzer 2-hop persona-bridged jobs+needs', () => {
  it('counts a job as needing-covered via the persona bridge', async () => {
    // Construct: persona pursues job; persona experiences need.
    // No direct job_surfaces_need edge; the chain is only satisfied via the
    // persona bridge. Pre-fix, job_with_need would be 0.
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' },
          { id: 'j1', type: 'job' as UPGEntityType, title: 'Ship a product' },
          { id: 'n1', type: 'need' as UPGEntityType, title: 'Capture ideas' },
        ],
        [
          {
            id: 'e1',
            source: 'p1',
            target: 'j1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
          {
            id: 'e2',
            source: 'p1',
            target: 'n1',
            type: 'persona_experiences_need' as UPGEdgeType,
          },
        ],
      ),
    )
    const digest = computeGraphDigest(store)
    // Without the bridge, job_with_need would be 0. With it's 1.
    expect(digest.chains.job_with_need).toBeGreaterThan(0)
    expect(digest.chains.job_with_need).toBe(1)
    expect(digest.chains.job_total).toBe(1)
  })

  it('still counts the direct job → need edge (no double-counting)', async () => {
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
          { id: 'n1', type: 'need' as UPGEntityType, title: 'N' },
        ],
        [
          {
            id: 'e1',
            source: 'j1',
            target: 'n1',
            type: 'job_surfaces_need' as UPGEdgeType,
          },
        ],
      ),
    )
    const digest = computeGraphDigest(store)
    expect(digest.chains.job_with_need).toBe(1)
    expect(digest.chains.job_total).toBe(1)
  })

  it('reports zero when the bridge is broken (persona pursues job but no need)', async () => {
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' },
          { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
        ],
        [
          {
            id: 'e1',
            source: 'p1',
            target: 'j1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
        ],
      ),
    )
    const digest = computeGraphDigest(store)
    expect(digest.chains.job_with_need).toBe(0)
    expect(digest.chains.job_total).toBe(1)
  })
})

// ─── validate_graph picks up the chaos exploits after they're already in
// the file ─────────────────────────────────────────────────────────

describe('validate_graph picks up cleanup-relevant drift after the fact', () => {
  it('reports edge_type_pair_drift for a wrong-pair canonical edge', async () => {
    // Construct by writing the raw doc directly; the on-disk doc may have
    // been built before the hardening landed.
    const { store } = await loadStore(
      makeDoc(
        [
          { id: 'v1', type: 'vision' as UPGEntityType, title: 'V' },
          { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
        ],
        [
          {
            id: 'e1',
            source: 'v1',
            target: 'j1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { scope: 'edge_type_pair_drift', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.edge_type_pair_drift).toBe(1)
    expect(body.edge_type_pair_drift).toHaveLength(1)
    expect(body.edge_type_pair_drift[0].type).toBe('persona_pursues_job')
    expect(body.edge_type_pair_drift[0].expected.source).toBe('persona')
    expect(body.edge_type_pair_drift[0].actual.source).toBe('vision')
  })
})
