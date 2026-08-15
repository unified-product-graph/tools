/**
 * Server-handler-level seam enforcement tests ( / /).
 *
 * The existing suites exercise the SDK *lib* functions directly. The four bugs
 * fixed here lived in the MCP *tool handlers*, which bypassed the strict SDK
 * validation — so the drift never reached the wire and the lib-level tests
 * stayed green while the handlers silently accepted bad input.
 *
 * These tests therefore call the ACTUAL MCP tool handlers (the exact functions
 * the server dispatches to) and assert the wire-level behaviour, including
 * single↔batch / create↔update parity:
 *
 *   1. batch_create_edges rejects a non-catalog edge type ("banana"), matching
 *      single create_edge (Seam 1).
 *   2. update_node({ unset_properties }) actually removes the key.
 *   3. update_node rejects an invalid lifecycle status, matching create_node
 *      (Seam 1).
 *   4. update_session_context rejects an invalid/legacy lens ("design") and
 *      accepts all 8 canonical lenses (Seam 4).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type {
  UPGDocument,
  UPGBaseNode,
  UPGEdge,
  UPGEntityType,
} from '@unified-product-graph/core'
import { createEdge, batchCreateEdges } from '../tools/edges.js'
import { createNode, updateNode, batchUpdateNodes } from '../tools/nodes.js'
import { updateSessionContext } from '../tools/context.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  CANONICAL_LENS_IDS,
  type ToolContext,
  type ToolHandler,
  type ToolResult,
} from '../lib/server-context.js'

/**
 * Dispatch a tool handler exactly as the server does, normalising the
 * sync-or-Promise return into an awaited `ToolResult` so assertions read the
 * same regardless of which handler is sync vs async.
 */
function dispatch(
  handler: ToolHandler,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return Promise.resolve(handler(args, ctx))
}

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Seam Handler Fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-seam-handler-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
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

const node = (id: string, type: string, title: string): UPGBaseNode => ({
  id,
  type: type as UPGEntityType,
  title,
})

// ── Fix 1: batch_create_edges rejects non-catalog edge types (Seam 1) ────────
describe(' Seam 1 — batch_create_edges rejects non-catalog edge types', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await loadStore(
      makeDoc(
        [node('persona_1', 'persona', 'A Persona'), node('job_1', 'job', 'A Job')],
        [],
      ),
    )
    ctx = makeCtx(store)
  })

  it('rejects a made-up edge type "banana" in a batch', async () => {
    const result = await dispatch(
      batchCreateEdges,
      { edges: [{ source_id: 'persona_1', target_id: 'job_1', type: 'banana' }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/banana/)
    expect(result.content[0].text).toMatch(/UPG_EDGE_CATALOG/)
    // Nothing landed.
    expect(store.getAllEdges()).toHaveLength(0)
  })

  it('parity: single create_edge rejects the SAME "banana" type', async () => {
    const single = await dispatch(
      createEdge,
      { source_id: 'persona_1', target_id: 'job_1', type: 'banana' },
      ctx,
    )
    expect(single.isError).toBe(true)
    expect(single.content[0].text).toMatch(/UPG_EDGE_CATALOG/)
  })

  it('still accepts a valid catalog edge in a batch', async () => {
    const result = await dispatch(
      batchCreateEdges,
      {
        edges: [
          { source_id: 'persona_1', target_id: 'job_1', type: 'persona_pursues_job' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.created[0].type).toBe('persona_pursues_job')
    expect(store.getAllEdges()).toHaveLength(1)
  })

  it('rejects the entire batch when any one item is non-catalog (atomic)', async () => {
    const result = await dispatch(
      batchCreateEdges,
      {
        edges: [
          { source_id: 'persona_1', target_id: 'job_1', type: 'persona_pursues_job' },
          { source_id: 'persona_1', target_id: 'job_1', type: 'banana' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(store.getAllEdges()).toHaveLength(0)
  })
})

// ── Fix 2: update_node wires unset_properties ──────────────────────
describe(' — update_node({ unset_properties }) removes the key', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await loadStore(
      makeDoc(
        [
          {
            ...node('feature_1', 'feature', 'A Feature'),
            properties: { priority: 'p1', owner: 'someone' },
          },
        ],
        [],
      ),
    )
    ctx = makeCtx(store)
  })

  it('deletes the named key from properties', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'feature_1', unset_properties: ['owner'] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.unset).toEqual(['owner'])
    const after = store.getNode('feature_1')!
    expect(after.properties).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(after.properties!, 'owner')).toBe(false)
    // Untouched key survives.
    expect(after.properties!.priority).toBe('p1')
  })

  it('applies unset AFTER a property merge in the same call', async () => {
    const result = await dispatch(
      updateNode,
      {
        node_id: 'feature_1',
        properties: { priority: 'p0' },
        unset_properties: ['owner'],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const after = store.getNode('feature_1')!
    expect(after.properties!.priority).toBe('p0')
    expect(Object.prototype.hasOwnProperty.call(after.properties!, 'owner')).toBe(false)
  })

  it('ignores unknown keys (no error, not reported as removed)', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'feature_1', unset_properties: ['does_not_exist'] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.unset).toBeUndefined()
  })
})

// ── 0.29.0: batch_update_nodes reaches the same affordance ───────────────────
// The single↔batch asymmetry this file exists to catch, one more instance of
// it. `unset_properties` has worked on update_node since and was
// silently absent from the batch schema, so a caller clearing one key across
// many nodes had to fall back to writing literal nulls. On a numeric property
// that is a third state distinct from both a value and absence, which is how a
// gap in a write path turns into wrong data rather than an error.
describe('0.29.0 — batch_update_nodes({ unset_properties }) matches update_node', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await loadStore(
      makeDoc(
        [
          {
            ...node('surface_1', 'surface', 'Detail panel'),
            properties: { capacity: 1, arbitration_rule: 'Most recent wins' },
          },
          {
            ...node('surface_2', 'surface', 'Banner stack'),
            properties: { capacity: 4, arbitration_rule: 'Priority order' },
          },
        ],
        [],
      ),
    )
    ctx = makeCtx(store)
  })

  it('removes keys per entry and reports what it removed', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      {
        updates: [
          { node_id: 'surface_1', unset_properties: ['capacity'] },
          { node_id: 'surface_2', unset_properties: ['arbitration_rule'] },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.unset).toEqual({
      surface_1: ['capacity'],
      surface_2: ['arbitration_rule'],
    })

    const s1 = store.getNode('surface_1')!
    const s2 = store.getNode('surface_2')!
    // Removed, not nulled: the key is gone, which is what returns `capacity`
    // to its documented ABSENT reading of unbounded.
    expect(Object.prototype.hasOwnProperty.call(s1.properties!, 'capacity')).toBe(false)
    expect(s1.properties!.arbitration_rule).toBe('Most recent wins')
    expect(Object.prototype.hasOwnProperty.call(s2.properties!, 'arbitration_rule')).toBe(false)
    expect(s2.properties!.capacity).toBe(4)
  })

  it('applies unset AFTER the merge within one entry, as the single path does', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      {
        updates: [
          {
            node_id: 'surface_1',
            properties: { composition_mode: 'exclusive' },
            unset_properties: ['arbitration_rule'],
          },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const after = store.getNode('surface_1')!
    expect(after.properties!.composition_mode).toBe('exclusive')
    expect(Object.prototype.hasOwnProperty.call(after.properties!, 'arbitration_rule')).toBe(false)
    expect(after.properties!.capacity).toBe(1)
  })

  it('ignores unknown keys without erroring the batch', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      { updates: [{ node_id: 'surface_1', unset_properties: ['does_not_exist'] }] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.unset).toBeUndefined()
    expect(body.count).toBe(1)
  })
})

// ── Fix 3: update_node rejects invalid status, parity with create_node ───────
describe(' Seam 1 — update_node rejects an invalid lifecycle status', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await loadStore(
      makeDoc([{ ...node('feature_1', 'feature', 'A Feature'), status: 'proposed' }], []),
    )
    ctx = makeCtx(store)
  })

  it('rejects a bogus status', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'feature_1', status: 'totally_bogus' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/totally_bogus/)
    expect(result.content[0].text).toMatch(/valid phase/i)
    // Status unchanged.
    expect(store.getNode('feature_1')!.status).toBe('proposed')
  })

  it('accepts a valid status', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'feature_1', status: 'shipped' },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(store.getNode('feature_1')!.status).toBe('shipped')
  })

  it('parity: create_node rejects the SAME bogus status', async () => {
    const created = await dispatch(
      createNode,
      { type: 'feature', title: 'Another Feature', status: 'totally_bogus' },
      ctx,
    )
    expect(created.isError).toBe(true)
    expect(created.content[0].text).toMatch(/totally_bogus/)
  })
})

// ── Fix 4: update_session_context rejects invalid/legacy lens (Seam 4) ───────
describe(' Seam 4 — update_session_context lens validation', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  beforeEach(async () => {
    store = await loadStore(makeDoc([], []))
    ctx = makeCtx(store)
  })

  it('rejects the legacy lens "design"', async () => {
    const result = await dispatch(updateSessionContext, { lens: 'design' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Invalid lens "design"/)
    expect(result.content[0].text).toMatch(/product, ux_design, engineering, growth, business, research, marketing, competitive, full/)
  })

  it('rejects an arbitrary invalid lens', async () => {
    const result = await dispatch(updateSessionContext, { lens: 'banana' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Invalid lens "banana"/)
  })

  it('accepts all 9 canonical lenses', async () => {
    expect(CANONICAL_LENS_IDS).toHaveLength(9)
    for (const lens of CANONICAL_LENS_IDS) {
      const result = await dispatch(updateSessionContext, { lens }, ctx)
      expect(result.isError, `lens "${lens}" should be accepted`).toBeUndefined()
      const body = JSON.parse(result.content[0].text)
      expect(body.updated).toBe(true)
      expect(body.session.lens).toBe(lens)
    }
  })

  it('does not mutate lens or claim updated for a bad lens', async () => {
    const before = ctx.sessionContext.lens
    const result = await dispatch(updateSessionContext, { lens: 'design' }, ctx)
    expect(result.isError).toBe(true)
    expect(ctx.sessionContext.lens).toBe(before)
  })
})
