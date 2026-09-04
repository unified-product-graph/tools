/**
 * Tests for the new validate_graph drift classes added by the 2026-05-20
 * audit hardening:
 *
 *   - edge_type_pair_drift: canonical edge type wired to wrong node-type pair
 *   - graph_topology_self_loops: edges where source === target
 *   - property_type_drift: declared property value doesn't match schema type
 *
 * Each class is exercised in isolation against a hand-crafted fixture so
 * the assertion surface stays narrow.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
import { validateGraph } from '../tools/validation.js'
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
    product: { id: 'p1', title: 'drift class fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-drift-classes-'))
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

// ─── edge_type_pair_drift ────────────────────────────────────────────

describe('validate_graph: edge_type_pair_drift', () => {
  it('reports a canonical edge wired to a wrong source/target pair', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'v1', type: 'vision' as UPGEntityType, title: 'V' },
          { id: 'vu1', type: 'vulnerability' as UPGEntityType, title: 'Vu' },
        ],
        [
          {
            id: 'e1',
            source: 'v1',
            target: 'vu1',
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
    const entry = body.edge_type_pair_drift[0]
    expect(entry.id).toBe('e1')
    expect(entry.type).toBe('persona_pursues_job')
    expect(entry.expected).toEqual({ source: 'persona', target: 'job' })
    expect(entry.actual).toEqual({ source: 'vision', target: 'vulnerability' })
    expect(entry.reason).toContain('persona_pursues_job')
  })

  it('reports zero when every canonical edge is wired correctly', async () => {
    const store = await loadStore(
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
    const result = await validateGraph(
      { scope: 'edge_type_pair_drift', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.edge_type_pair_drift).toBe(0)
    expect(body.edge_type_pair_drift).toEqual([])
  })

  it('does not flag non-canonical edge types (they are edge_drift not pair_drift)', async () => {
    const store = await loadStore(
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
            type: 'totally_made_up_edge' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph({ skip_anti_patterns: true }, ctx)
    const body = JSON.parse(result.content[0].text)
    // Non-canonical type → edge_drift fires, but edge_type_pair_drift does
    // not (that's the existing class's job).
    expect(body.summary.edge_type_pair_drift).toBe(0)
    expect(body.summary.edge_drift).toBeGreaterThan(0)
  })
})

// ─── graph_topology_self_loops ───────────────────────────────────────

describe('validate_graph: graph_topology_self_loops', () => {
  it('reports an edge whose source === target', async () => {
    // Inject a self-loop into the file directly; the file writer is the
    // only way to get a self-loop into the graph now that create_edge
    // refuses them at write-time.
    const store = await loadStore(
      makeDoc(
        [{ id: 'v1', type: 'vision' as UPGEntityType, title: 'V' }],
        [
          {
            id: 'e1',
            source: 'v1',
            target: 'v1',
            type: 'vision_guides_objective' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { scope: 'graph_topology_self_loops', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.graph_topology_self_loops).toBe(1)
    expect(body.graph_topology_self_loops).toHaveLength(1)
    expect(body.graph_topology_self_loops[0]).toEqual({
      id: 'e1',
      type: 'vision_guides_objective',
      node: 'v1',
    })
  })

  it('reports zero on a graph with no self-loops', async () => {
    const store = await loadStore(
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
    const result = await validateGraph(
      { scope: 'graph_topology_self_loops', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.graph_topology_self_loops).toBe(0)
    expect(body.graph_topology_self_loops).toEqual([])
  })

  it('is distinct from the existing self_referential class (props vs topology)', async () => {
    // self_referential fires when source_id/source_type properties on a node
    // mirror the node's own id/type; that's an import-provenance redundancy,
    // not a graph-topology loop. The two classes report DIFFERENT things.
    const store = await loadStore(
      makeDoc([
        {
          id: 'v1',
          type: 'vision' as UPGEntityType,
          title: 'V',
          source_id: 'v1',
          source_type: 'vision',
        } as UPGBaseNode,
      ]),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.self_referential).toBe(1)
    expect(body.summary.graph_topology_self_loops).toBe(0)
  })
})

// ─── property_type_drift ─────────────────────────────────────────────

describe('validate_graph: property_type_drift', () => {
  it('reports a string written into a declared number field', async () => {
    // metric.target_value is declared `number` in UPG_PROPERTY_SCHEMA.
    const store = await loadStore(
      makeDoc([
        {
          id: 'm1',
          type: 'metric' as UPGEntityType,
          title: 'rate',
          properties: { target_value: 'not_a_number_lol' },
        },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { scope: 'property_type_drift', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.property_type_drift).toBe(1)
    expect(body.property_type_drift).toHaveLength(1)
    const entry = body.property_type_drift[0]
    expect(entry.id).toBe('m1')
    expect(entry.property).toBe('target_value')
    expect(entry.expected_type).toBe('number')
    expect(entry.actual_type).toBe('string')
  })

  it('reports zero when declared properties carry the right type', async () => {
    const store = await loadStore(
      makeDoc([
        {
          id: 'm1',
          type: 'metric' as UPGEntityType,
          title: 'rate',
          properties: { target_value: 42, current_value: 30 },
        },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { scope: 'property_type_drift', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.property_type_drift).toBe(0)
    expect(body.property_type_drift).toEqual([])
  })

  it('does not flag undeclared properties (those are a different concern)', async () => {
    const store = await loadStore(
      makeDoc([
        {
          id: 'm1',
          type: 'metric' as UPGEntityType,
          title: 'rate',
          properties: { completely_undeclared_field: 'whatever' },
        },
      ]),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { scope: 'property_type_drift', skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.property_type_drift).toBe(0)
  })
})

// ─── valid flag reflects new drift classes ──────────────────────────

describe('validate_graph: valid flag respects the new drift classes', () => {
  it('flips valid to false when only edge_type_pair_drift is present', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'v1', type: 'vision' as UPGEntityType, title: 'V' },
          { id: 'vu1', type: 'vulnerability' as UPGEntityType, title: 'Vu' },
        ],
        [
          {
            id: 'e1',
            source: 'v1',
            target: 'vu1',
            type: 'persona_pursues_job' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph({ skip_anti_patterns: true }, ctx)
    const body = JSON.parse(result.content[0].text)
    expect(body.valid).toBe(false)
    expect(body.summary.edge_type_pair_drift).toBe(1)
  })
})

// ─── F2: scope narrows the arrays, never the counts ──────────────────
//
// 0.41.0. `scope` gated the DETECTION, not just the response, so every class
// the caller did not name reported 0. The field case that surfaced it: an
// operator scoped to the new `property_enum_drift` class to inspect it, and a
// 156-entry `undeclared_property_drift` backlog read as 0 in the same payload.
// Reproduced on this repo's own tracker before the fix: 219 at scope `all`,
// 0 at scope `lifecycle_drift`, identical graph hash.
//
// A validator may return less detail than asked. It may never report a clean
// number over a dirty graph, which is the same failure class as a write
// reporting success over a file it did not save.

describe('validate_graph: scope narrows entry arrays, never summary counts (F2)', () => {
  /** One graph carrying drift in three classes at once. */
  async function dirtyGraph(): Promise<ToolContext> {
    return makeCtx(
      await loadStore(
        makeDoc(
          [
            { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' },
            { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
            {
              id: 'f1',
              type: 'feature' as UPGEntityType,
              title: 'F',
              // Undeclared property: not in the feature schema.
              properties: { not_a_spec_property: 'x' },
            } as UPGBaseNode,
          ],
          [
            // Wrong pair: persona_pursues_job wired persona -> feature.
            { id: 'e1', source: 'p1', target: 'f1', type: 'persona_pursues_job' as UPGEdgeType },
            // Self loop.
            { id: 'e2', source: 'j1', target: 'j1', type: 'node_informs_node' as UPGEdgeType },
          ],
        ),
      ),
    )
  }

  it('reports every class in summary no matter which one the scope names', async () => {
    const ctx = await dirtyGraph()
    const all = JSON.parse(
      (await validateGraph({ scope: 'all', skip_anti_patterns: true }, ctx)).content[0].text,
    )
    // The graph is genuinely dirty in three classes.
    expect(all.summary.edge_type_pair_drift).toBeGreaterThan(0)
    expect(all.summary.graph_topology_self_loops).toBeGreaterThan(0)
    expect(all.summary.undeclared_property_drift).toBeGreaterThan(0)

    // Scoping to ONE class must not zero the other two.
    for (const scope of ['edge_type_pair_drift', 'graph_topology_self_loops', 'undeclared_property_drift']) {
      const scoped = JSON.parse(
        (await validateGraph({ scope, skip_anti_patterns: true }, ctx)).content[0].text,
      )
      expect(scoped.summary.edge_type_pair_drift).toBe(all.summary.edge_type_pair_drift)
      expect(scoped.summary.graph_topology_self_loops).toBe(all.summary.graph_topology_self_loops)
      expect(scoped.summary.undeclared_property_drift).toBe(all.summary.undeclared_property_drift)
    }
  })

  it('still withholds the entry arrays the scope excludes', async () => {
    const ctx = await dirtyGraph()
    const scoped = JSON.parse(
      (await validateGraph({ scope: 'edge_type_pair_drift', skip_anti_patterns: true }, ctx))
        .content[0].text,
    )
    expect(scoped.edge_type_pair_drift.length).toBeGreaterThan(0)
    expect(scoped.graph_topology_self_loops).toBeUndefined()
    expect(scoped.undeclared_property_drift).toBeUndefined()
  })

  it('structurally_valid does not go green because the scope looked elsewhere', async () => {
    const ctx = await dirtyGraph()
    const scoped = JSON.parse(
      (await validateGraph({ scope: 'lifecycle_drift', skip_anti_patterns: true }, ctx))
        .content[0].text,
    )
    // Nothing wrong in lifecycle_drift; plenty wrong in the graph.
    expect(scoped.lifecycle_drift).toEqual([])
    expect(scoped.structurally_valid).toBe(false)
  })

  it('counts do not move with limit either', async () => {
    const ctx = await dirtyGraph()
    const wide = JSON.parse(
      (await validateGraph({ scope: 'all', limit: 1000, skip_anti_patterns: true }, ctx))
        .content[0].text,
    )
    const narrow = JSON.parse(
      (await validateGraph({ scope: 'all', limit: 1, skip_anti_patterns: true }, ctx))
        .content[0].text,
    )
    expect(narrow.summary.edge_type_pair_drift).toBe(wide.summary.edge_type_pair_drift)
    expect(narrow.summary.graph_topology_self_loops).toBe(wide.summary.graph_topology_self_loops)
    expect(narrow.summary.property_type_drift).toBe(wide.summary.property_type_drift)
  })

  it('a clean graph still reports clean under every scope', async () => {
    const ctx = makeCtx(
      await loadStore(
        makeDoc(
          [
            { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' },
            { id: 'j1', type: 'job' as UPGEntityType, title: 'J' },
          ],
          [{ id: 'e1', source: 'p1', target: 'j1', type: 'persona_pursues_job' as UPGEdgeType }],
        ),
      ),
    )
    for (const scope of ['all', 'entity_drift', 'edge_type_pair_drift']) {
      const body = JSON.parse(
        (await validateGraph({ scope, skip_anti_patterns: true }, ctx)).content[0].text,
      )
      expect(body.summary.edge_type_pair_drift).toBe(0)
      expect(body.summary.graph_topology_self_loops).toBe(0)
      expect(body.structurally_valid).toBe(true)
    }
  })
})
