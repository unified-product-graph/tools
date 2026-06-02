/**
 * Cloud framework-exercise handlers (0.8.6 parity): apply_framework / score_entity.
 *
 * Drives the handlers through a lightweight in-memory store stub (no Postgres),
 * mirroring logic-parity.test.ts — the handler logic lives above the store. The
 * Postgres SQL for edge `properties` is covered separately in pg-store.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { applyFramework, scoreEntity } from '../tools/frameworks.js'
import type { CloudContext } from '../lib/server-context.js'

interface StubNode {
  id: string
  product_id: string
  type: string
  title: string
  status?: string
  properties?: Record<string, unknown>
}
interface StubEdge {
  id: string
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
}

function makeStore(seed: StubNode[]) {
  const nodes = new Map<string, StubNode>(seed.map((n) => [n.id, n]))
  const edges: StubEdge[] = []
  let seq = 0
  const store = {
    getNode: async (id: string) => nodes.get(id),
    addNode: async (pid: string, node: StubNode) => {
      const created = { ...node, product_id: pid }
      nodes.set(created.id, created)
      return created
    },
    getEdgesForNode: async (nodeId: string) =>
      edges.filter((e) => e.source === nodeId || e.target === nodeId),
    addEdge: async (_pid: string, edge: StubEdge) => {
      edges.push({ ...edge })
    },
    setEdgeProperties: async (
      id: string,
      values: Record<string, unknown>,
      opts: { merge?: boolean } = {},
    ) => {
      const edge = edges.find((e) => e.id === id)!
      edge.properties =
        opts.merge === false ? { ...values } : { ...(edge.properties ?? {}), ...values }
      return edge
    },
  } as unknown as CloudContext['store']
  return { ctx: { store } as CloudContext, edges, nextId: () => `gen_${seq++}` }
}

function body(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text)
}

const PRODUCT = 'p_1'
const seed = (): StubNode[] => [
  { id: 'feat_a', product_id: PRODUCT, type: 'feature', title: 'A' },
  { id: 'feat_b', product_id: PRODUCT, type: 'feature', title: 'B' },
]

describe('apply_framework (cloud)', () => {
  it('rejects a missing product_id / framework_id', async () => {
    const { ctx } = makeStore(seed())
    expect((await applyFramework({ framework_id: 'moscow' }, ctx)).isError).toBe(true)
    expect((await applyFramework({ product_id: PRODUCT }, ctx)).isError).toBe(true)
  })

  it('rejects an unknown framework id', async () => {
    const { ctx } = makeStore(seed())
    const r = await applyFramework({ product_id: PRODUCT, framework_id: 'not-a-fw' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/Unknown framework/)
  })

  it('creates a framework_exercise node + one includes edge per resolvable entity', async () => {
    const { ctx, edges } = makeStore(seed())
    const r = await applyFramework(
      { product_id: PRODUCT, framework_id: 'moscow', title: 'Q3', entity_ids: ['feat_a', 'feat_b', 'ghost'] },
      ctx,
    )
    const b = body(r)
    expect(b.exercise.type).toBe('framework_exercise')
    expect(b.exercise.properties.framework_id).toBe('moscow')
    expect(b.included).toHaveLength(2)
    expect(edges.every((e) => e.type === 'framework_exercise_includes_node')).toBe(true)
    // the unresolvable target is reported, not silently dropped
    expect(b.warnings.join(' ')).toMatch(/ghost/)
  })
})

describe('score_entity (cloud)', () => {
  it('rejects missing params and non-exercise nodes', async () => {
    const { ctx } = makeStore(seed())
    expect((await scoreEntity({ entity_id: 'feat_a', values: {} }, ctx)).isError).toBe(true)
    const bad = await scoreEntity({ exercise_id: 'feat_a', entity_id: 'feat_b', values: { x: 1 } }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toMatch(/not a framework_exercise/)
  })

  it('auto-includes a new entity and records the result on the edge', async () => {
    const { ctx, edges } = makeStore(seed())
    const applied = body(await applyFramework({ product_id: PRODUCT, framework_id: 'moscow' }, ctx))
    const r = await scoreEntity(
      { exercise_id: applied.exercise_id, entity_id: 'feat_a', values: { moscow: 'must' } },
      ctx,
    )
    const b = body(r)
    expect(b.edge.properties.moscow).toBe('must')
    expect(edges).toHaveLength(1)
    expect(edges[0].target).toBe('feat_a')
  })

  it('merges into an existing includes edge and warns on undeclared keys', async () => {
    const { ctx } = makeStore(seed())
    const applied = body(
      await applyFramework({ product_id: PRODUCT, framework_id: 'rice-scoring', entity_ids: ['feat_a'] }, ctx),
    )
    // first score sets reach; second merges impact + an undeclared key
    await scoreEntity({ exercise_id: applied.exercise_id, entity_id: 'feat_a', values: { reach: 800 } }, ctx)
    const r = await scoreEntity(
      { exercise_id: applied.exercise_id, entity_id: 'feat_a', values: { impact: 3, bogus: 1 } },
      ctx,
    )
    const b = body(r)
    expect(b.edge.properties).toMatchObject({ reach: 800, impact: 3, bogus: 1 }) // merged, not replaced
    expect(b.warnings.join(' ')).toMatch(/bogus/)
  })
})
