/**
 * Behavioural parity guard: cloud write-path handlers ↔ the canonical pure
 * logic in `@unified-product-graph/sdk/logic`.
 *
 * The existing `parity.test.ts` pins the tool-NAME surface. This file pins the
 * DISPOSITION: for a representative matrix of node pairs and property sets,
 * the cloud handlers must accept/reject exactly as the SDK's `inferEdgeTypeWithTier`
 * and `checkPropertyTypes` say they should. Without this guard, cloud could
 * silently re-diverge (e.g. drift back to a permissive `_contains_` fallback)
 * and the name-only parity test would never notice.
 *
 * Drives the handlers through a lightweight in-memory store stub (no Postgres
 * needed) because the decision logic lives entirely above the store.
 */
import { describe, it, expect } from 'vitest'
import {
  inferEdgeTypeWithTier,
  checkPropertyTypes,
} from '@unified-product-graph/sdk/logic'
import { createEdge } from '../tools/edges.js'
import { createNode } from '../tools/nodes.js'
import type { CloudContext } from '../lib/server-context.js'

interface StubNode { id: string; product_id: string; type: string; title: string; properties?: Record<string, unknown> }

/** Minimal store stub exposing only what the create handlers touch. */
function makeStore(seed: StubNode[]) {
  const byId = new Map<string, StubNode>(seed.map((n) => [n.id, n]))
  const addedEdges: Array<{ type: string }> = []
  const addedNodes: StubNode[] = []
  const store = {
    getNode: async (id: string) => byId.get(id) ?? null,
    addEdge: async (_pid: string, edge: { type: string }) => { addedEdges.push(edge) },
    addNode: async (_pid: string, node: StubNode) => { addedNodes.push(node); byId.set(node.id, node) },
  } as unknown as CloudContext['store']
  return { ctx: { store } as CloudContext, addedEdges, addedNodes }
}

// Canonical + non-canonical pairs spanning core and extended tiers.
const EDGE_PAIRS: Array<[string, string]> = [
  ['persona', 'job'],          // canonical
  ['job', 'need'],             // canonical
  ['feature', 'epic'],         // canonical
  ['product_area', 'feature'], // canonical
  ['feature', 'persona'],      // non-canonical
  ['epic', 'feature'],         // non-canonical
  ['need', 'persona'],         // non-canonical
]

describe('cloud vs SDK logic parity: create_edge inference', () => {
  for (const [s, t] of EDGE_PAIRS) {
    it(`${s} → ${t} disposition matches inferEdgeTypeWithTier`, async () => {
      const sdk = inferEdgeTypeWithTier(s, t)
      const { ctx, addedEdges } = makeStore([
        { id: 'src', product_id: 'p1', type: s, title: 'S' },
        { id: 'tgt', product_id: 'p1', type: t, title: 'T' },
      ])
      const res = await createEdge({ source_id: 'src', target_id: 'tgt' }, ctx)

      if (sdk.ok) {
        expect(res.isError, `cloud should accept canonical pair ${s}→${t}`).toBeFalsy()
        expect(addedEdges).toHaveLength(1)
        // Cloud must mint the SAME canonical type the SDK resolved.
        expect(addedEdges[0].type).toBe(sdk.edgeType)
      } else {
        expect(res.isError, `cloud should refuse non-canonical pair ${s}→${t}`).toBe(true)
        // And must NOT fabricate a `_contains_` edge.
        expect(addedEdges).toHaveLength(0)
      }
    })
  }
})

// (entityType, properties, label): at least one violating and one clean case.
const PROPERTY_CASES: Array<[string, Record<string, unknown>, string]> = [
  ['experiment', { sample_size: 'lots' }, 'wrong type (string for number) → reject'],
  ['experiment', { sample_size: 100 }, 'correct type → accept'],
  ['feature', {}, 'no properties → accept'],
]

describe('cloud vs SDK logic parity: create_node property validation', () => {
  for (const [type, properties, label] of PROPERTY_CASES) {
    it(`${type}: ${label}`, async () => {
      const sdkViolations = checkPropertyTypes(type, properties).violations
      const { ctx, addedNodes } = makeStore([])
      const res = await createNode({ product_id: 'p1', type, title: 'X', properties }, ctx)

      if (sdkViolations.length > 0) {
        expect(res.isError, `cloud should refuse ${type} with property violations`).toBe(true)
        expect(addedNodes, 'no node should be written on a property-type violation').toHaveLength(0)
      } else {
        expect(res.isError, `cloud should accept ${type} with valid properties`).toBeFalsy()
        expect(addedNodes).toHaveLength(1)
      }
    })
  }
})

// 0.17.4 keystone — cloud's OWN behavioural check (Postgres-backed; verified at the
// store seam, not inferred from the SDK): an auto-nest must DECLINE a deliberate-only
// defer edge and must NOT materialise it on any downstream step. Explicit create_edge
// still authors it.
describe('cloud 0.17.4: deliberate-only defer edges are never auto-nested', () => {
  it('createNode: objective ⊃ feature lands the node but writes NO parent defer edge', async () => {
    const { ctx, addedEdges, addedNodes } = makeStore([
      { id: 'obj', product_id: 'p1', type: 'objective', title: 'O' },
    ])
    const res = await createNode({ product_id: 'p1', type: 'feature', title: 'F', parent_id: 'obj' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(addedNodes).toHaveLength(1) // feature still lands
    expect(addedEdges, 'no parent edge materialised at the store seam').toHaveLength(0)
    expect(addedEdges.some((e) => e.type === 'objective_defers_feature')).toBe(false)
  })

  it('createNode: objective ⊃ capability writes NO parent defer edge either', async () => {
    const { ctx, addedEdges } = makeStore([
      { id: 'obj', product_id: 'p1', type: 'objective', title: 'O' },
    ])
    await createNode({ product_id: 'p1', type: 'capability', title: 'C', parent_id: 'obj' }, ctx)
    expect(addedEdges).toHaveLength(0)
    expect(addedEdges.some((e) => e.type === 'objective_defers_capability')).toBe(false)
  })

  it('explicit createEdge STILL materialises the defer edge (author on request)', async () => {
    const { ctx, addedEdges } = makeStore([
      { id: 'obj', product_id: 'p1', type: 'objective', title: 'O' },
      { id: 'feat', product_id: 'p1', type: 'feature', title: 'F' },
    ])
    const res = await createEdge({ source_id: 'obj', target_id: 'feat' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(addedEdges).toHaveLength(1)
    expect(addedEdges[0].type).toBe('objective_defers_feature')
  })
})
