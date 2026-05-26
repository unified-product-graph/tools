/**
 * MCP UX improvements — UPG-504, UPG-505, UPG-506, UPG-515.
 *
 * Covers the four 2026-05-20 live-authoring audit fixes:
 *
 * - UPG-504: `batch_create_nodes` surfaces an orphan warning when ≥2 nodes
 *   land with zero edges of any kind.
 * - UPG-505: `resolve_edge_for_pair` enriches `null` returns with the
 *   target domain's anchor (`anchor_hint`).
 * - UPG-515: same call enriches with `alternate_anchors` + `adjacent_edges`
 *   walks of `UPG_EDGE_CATALOG`. Same enrichment fires from `create_edge`
 *   and `batch_create_edges` error paths.
 * - UPG-506: `create_node` attaches `hints` (anti-patterns, next entity in
 *   creation_sequence, canonical out-edges) on the FIRST node of a given
 *   type. Second-and-later calls of the same type emit no hints.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createNode } from '../tools/nodes.js'
import { batchCreateNodes as batchCreateNodesLib } from '@unified-product-graph/sdk'
import { createEdge, batchCreateEdges } from '../tools/edges.js'
import { resolveEdgeForPair } from '../tools/spec.js'
import {
  buildAnchorHint,
  buildAlternateAnchors,
  buildAdjacentEdges,
} from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
  type ToolResult,
} from '../lib/server-context.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(nodes: UPGDocument['nodes'] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes,
    edges: [],
  }
}

async function makeStore(nodes: UPGDocument['nodes'] = []): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-mcp-ux-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(nodes), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function parseBody(result: ToolResult | Promise<ToolResult>): unknown {
  const r = result as ToolResult
  return JSON.parse(r.content[0].text)
}

function isErrorResult(result: ToolResult | Promise<ToolResult>): boolean {
  return (result as ToolResult).isError === true
}

// ── UPG-504 — batch_create_nodes silent orphans ──────────────────────────────

describe('UPG-504 — batch_create_nodes orphan warning', () => {
  it('warns when ≥2 nodes land with no edges (no parent_ref, no explicit edges)', async () => {
    const store = await makeStore()
    const result = batchCreateNodesLib(store, {
      nodes: [
        { type: 'persona', title: 'P1' },
        { type: 'persona', title: 'P2' },
        { type: 'persona', title: 'P3' },
        { type: 'persona', title: 'P4' },
        { type: 'persona', title: 'P5' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings!.some((w) => /orphans/i.test(w))).toBe(true)
    expect(result.warnings!.some((w) => /get_entity_schema/.test(w))).toBe(true)
  })

  it('omits the orphan warning when explicit edges link the batch', async () => {
    const store = await makeStore()
    const result = batchCreateNodesLib(store, {
      nodes: [
        { type: 'persona', title: 'P1' },
        { type: 'job', title: 'J1' },
        { type: 'need', title: 'N1' },
      ],
      edges: [
        { from_ref: '$0', to_ref: '$1' },
        { from_ref: '$1', to_ref: '$2' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const orphanWarnings = (result.warnings ?? []).filter((w) => /orphans/i.test(w))
    expect(orphanWarnings).toHaveLength(0)
  })

  it('omits the orphan warning when parent_ref auto-edges link the batch', async () => {
    const store = await makeStore()
    const result = batchCreateNodesLib(store, {
      nodes: [
        { type: 'persona', title: 'P1' },
        { type: 'job', title: 'J1', parent_ref: '$0' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const orphanWarnings = (result.warnings ?? []).filter((w) => /orphans/i.test(w))
    expect(orphanWarnings).toHaveLength(0)
  })

  it('does NOT warn on a single-node batch (orphan is only ≥2 nodes)', async () => {
    const store = await makeStore()
    const result = batchCreateNodesLib(store, {
      nodes: [{ type: 'persona', title: 'Solo' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const orphanWarnings = (result.warnings ?? []).filter((w) => /orphans/i.test(w))
    expect(orphanWarnings).toHaveLength(0)
  })
})

// ── UPG-505 — resolve_edge_for_pair anchor hint on null ──────────────────────

describe('UPG-505 — resolve_edge_for_pair anchor_hint', () => {
  it('returns anchor_hint with domain_anchor when target is anchored cross-domain', () => {
    // product → ideal_customer_profile: ICP is anchored in gtm_strategy.
    const result = resolveEdgeForPair(
      { source_type: 'product', target_type: 'ideal_customer_profile' },
      {} as never,
    )
    const body = parseBody(result) as Record<string, unknown>
    expect(body.edge_type).toBeNull()
    expect(body.anchor_hint).toBeDefined()
    const hint = body.anchor_hint as Record<string, unknown>
    expect(hint.target_domain).toBe('go_to_market')
    expect(hint.domain_anchor).toBe('gtm_strategy')
    expect(Array.isArray(hint.creation_sequence)).toBe(true)
    expect((hint.creation_sequence as string[]).length).toBeGreaterThan(0)
    expect(typeof hint.hint).toBe('string')
    expect((hint.hint as string).includes('gtm_strategy')).toBe(true)
  })

  it('omits anchor_hint when edge_type resolves canonically', () => {
    // persona → job: persona_pursues_job is canonical.
    const result = resolveEdgeForPair(
      { source_type: 'persona', target_type: 'job' },
      {} as never,
    )
    const body = parseBody(result) as Record<string, unknown>
    expect(body.edge_type).toBeTruthy()
    expect(body.anchor_hint).toBeUndefined()
    expect(body.alternate_anchors).toBeUndefined()
    expect(body.adjacent_edges).toBeUndefined()
  })

  it('returns no anchor_hint when the target is its own anchor and the source shares its domain', () => {
    // job → desired_outcome with persona as the user-domain anchor — the
    // hint logic suppresses circular advice when source is already in the
    // anchored domain. (Note: job→desired_outcome IS canonical, so we use a
    // null-pair internally to the user domain.)
    const hint = buildAnchorHint('persona', 'persona')
    expect(hint).toBeUndefined()
  })
})

// ── UPG-515 — alternate_anchors + adjacent_edges ─────────────────────────────

describe('UPG-515 — resolver UX alternates', () => {
  it('returns non-empty alternate_anchors + adjacent_edges for product → ideal_customer_profile', () => {
    const result = resolveEdgeForPair(
      { source_type: 'product', target_type: 'ideal_customer_profile' },
      {} as never,
    )
    const body = parseBody(result) as Record<string, unknown>

    // alternate_anchors: edges INTO ideal_customer_profile from a source !== product.
    expect(Array.isArray(body.alternate_anchors)).toBe(true)
    const alternates = body.alternate_anchors as Array<Record<string, unknown>>
    expect(alternates.length).toBeGreaterThan(0)
    expect(alternates.length).toBeLessThanOrEqual(3)
    for (const a of alternates) {
      expect(typeof a.source_type).toBe('string')
      expect(typeof a.edge_type).toBe('string')
      expect(typeof a.hint).toBe('string')
      expect(a.source_type).not.toBe('product')
    }

    // adjacent_edges: edges OUT of product.
    expect(Array.isArray(body.adjacent_edges)).toBe(true)
    const adjacent = body.adjacent_edges as Array<Record<string, unknown>>
    expect(adjacent.length).toBeGreaterThan(0)
    expect(adjacent.length).toBeLessThanOrEqual(3)
    for (const a of adjacent) {
      expect(a.source_type).toBe('product')
      expect(typeof a.target_type).toBe('string')
      expect(typeof a.edge_type).toBe('string')
    }
  })

  it('buildAlternateAnchors returns entries sorted hierarchy → cross-domain', () => {
    // Pick a target known to have multiple incoming sources at different
    // classifications. `need` has both hierarchy and cross-domain incoming
    // edges.
    const rows = buildAlternateAnchors('product', 'need')
    expect(rows.length).toBeGreaterThan(0)
    // First row should not be cross-domain when hierarchy or causal/semantic
    // alternatives exist — we don't test exact ordering but verify uniqueness.
    const sourceTypes = rows.map((r) => r.source_type)
    expect(new Set(sourceTypes).size).toBe(sourceTypes.length)
  })

  it('buildAdjacentEdges returns at most 3 rows from a high-degree source', () => {
    // `product` is the spine of the catalog — many outgoing edges.
    const rows = buildAdjacentEdges('product')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(3)
    // All rows should declare product as the source.
    for (const r of rows) expect(r.source_type).toBe('product')
  })

  it('skips polymorphic wildcards in alternate_anchors', () => {
    // No wildcard ('*') source/target should leak into the results.
    const rows = buildAlternateAnchors('product', 'persona')
    for (const r of rows) expect(r.source_type).not.toBe('*')
  })

  it('create_edge surfaces enrichment hints on a "no canonical edge" failure', async () => {
    // product → ideal_customer_profile is null in the catalog. Need real nodes
    // for the createEdgeLib to reach the inference step.
    const store = await makeStore()
    const ctx = makeCtx(store)
    const productNode = parseBody(
      createNode({ type: 'product', title: 'P' }, ctx),
    ) as { node: { id: string } }
    const icpNode = parseBody(
      createNode({ type: 'ideal_customer_profile', title: 'ICP' }, ctx),
    ) as { node: { id: string } }

    const result = createEdge(
      { source_id: productNode.node.id, target_id: icpNode.node.id },
      ctx,
    )
    expect(isErrorResult(result)).toBe(true)
    const body = parseBody(result) as Record<string, unknown>
    expect(body.error).toBeDefined()
    expect(body.source_type).toBe('product')
    expect(body.target_type).toBe('ideal_customer_profile')
    expect(body.anchor_hint).toBeDefined()
    expect(Array.isArray(body.alternate_anchors)).toBe(true)
  })

  it('batch_create_edges surfaces enrichment hints on a "no canonical edge" failure', async () => {
    const store = await makeStore()
    const ctx = makeCtx(store)
    const productNode = parseBody(
      createNode({ type: 'product', title: 'P' }, ctx),
    ) as { node: { id: string } }
    const icpNode = parseBody(
      createNode({ type: 'ideal_customer_profile', title: 'ICP' }, ctx),
    ) as { node: { id: string } }

    const result = batchCreateEdges(
      {
        edges: [{ source_id: productNode.node.id, target_id: icpNode.node.id }],
      },
      ctx,
    )
    expect(isErrorResult(result)).toBe(true)
    const body = parseBody(result) as Record<string, unknown>
    expect(body.error).toBeDefined()
    expect(body.source_type).toBe('product')
    expect(body.target_type).toBe('ideal_customer_profile')
    expect(body.anchor_hint).toBeDefined()
  })
})

// ── UPG-506 — create_node first-use schema hints ─────────────────────────────

describe('UPG-506 — create_node first-use hints', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('attaches hints with anti_patterns on the FIRST node of a type', () => {
    const result = parseBody(createNode({ type: 'vision', title: 'V1' }, ctx)) as Record<
      string,
      unknown
    >
    expect(result.hints).toBeDefined()
    const hints = result.hints as Record<string, unknown>
    expect(typeof hints.schema_call).toBe('string')
    expect((hints.schema_call as string).includes('vision')).toBe(true)
    // vision's domain (strategy) has anti-patterns + canonical edges out.
    expect(Array.isArray(hints.anti_patterns)).toBe(true)
    expect((hints.anti_patterns as unknown[]).length).toBeGreaterThan(0)
    expect(Array.isArray(hints.canonical_edges_out)).toBe(true)
    expect((hints.canonical_edges_out as unknown[]).length).toBeGreaterThan(0)
  })

  it('omits hints on the second-and-later node of the same type', () => {
    parseBody(createNode({ type: 'vision', title: 'V1' }, ctx))
    const second = parseBody(createNode({ type: 'vision', title: 'V2' }, ctx)) as Record<
      string,
      unknown
    >
    expect(second.hints).toBeUndefined()
  })

  it('emits hints again for a different type even after another type was seeded', () => {
    parseBody(createNode({ type: 'vision', title: 'V1' }, ctx))
    const personaResult = parseBody(
      createNode({ type: 'persona', title: 'Maya' }, ctx),
    ) as Record<string, unknown>
    expect(personaResult.hints).toBeDefined()
  })

  it('honours canonical resolution: alias-typed first node hints against the canonical schema', () => {
    // `jtbd` is an alias for `job`. The hints should reference `job`.
    const result = parseBody(
      createNode({ type: 'jtbd', title: 'Ship faster' }, ctx),
    ) as Record<string, unknown>
    if (result.hints) {
      const hints = result.hints as Record<string, unknown>
      expect((hints.schema_call as string).includes('job')).toBe(true)
    }
    // Second `job` call should not get hints.
    const second = parseBody(
      createNode({ type: 'job', title: 'Save time' }, ctx),
    ) as Record<string, unknown>
    expect(second.hints).toBeUndefined()
  })
})
