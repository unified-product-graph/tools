/**
 * get_tree (cloud, 0.9.16): server-side tree assembly. Drives the handler
 * through an in-memory store stub (no Postgres) and asserts it produces the same
 * nested-data + gaps shape as the local server, via the shared assembler in
 * @unified-product-graph/mcp-tooling.
 */
import { describe, it, expect } from 'vitest'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { UPG_TREE_PATTERNS } from '@unified-product-graph/core'
import { getTree } from '../tools/tree.js'
import { TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import type { CloudContext } from '../lib/server-context.js'

/** Minimal store stub exposing only what get_tree touches. */
function makeStore(nodes: UPGBaseNode[], edges: UPGEdge[]) {
  const store = {
    getAllNodes: async (_pid: string) => nodes,
    getAllEdges: async (_pid: string) => edges,
  } as unknown as CloudContext['store']
  return { store } as CloudContext
}
function bodyOf(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text)
}
const n = (id: string, type: string, title: string, properties?: Record<string, unknown>): UPGBaseNode =>
  ({ id, type, title, ...(properties ? { properties } : {}) }) as UPGBaseNode
const e = (id: string, source: string, target: string, type: string): UPGEdge =>
  ({ id, source, target, type }) as UPGEdge

describe('cloud get_tree (0.9.16)', () => {
  it('assembles the user pattern as nested data and reports a gap', async () => {
    const ctx = makeStore(
      [
        n('p1', 'persona', 'Developer'),
        n('j1', 'job', 'Ship faster'),
        n('n1', 'need', 'Less boilerplate'),
        n('do1', 'desired_outcome', 'Confidence'),
        n('p2', 'persona', 'Designer'), // no children -> gap
      ],
      [
        e('e1', 'p1', 'j1', 'persona_pursues_job'),
        e('e2', 'j1', 'n1', 'job_surfaces_need'),
        e('e3', 'p1', 'do1', 'persona_aspires_to_desired_outcome'),
      ],
    )
    const body = bodyOf(await getTree({ product_id: 'prod', pattern: 'user' }, ctx))
    expect(body.pattern).toBe('user')
    expect(body.anchor_used).toBe('persona')
    const dev = body.roots.find((r: { id: string }) => r.id === 'p1')
    expect(dev).toBeDefined()
    const childIds = dev.children.map((c: { id: string }) => c.id).sort()
    expect(childIds).toEqual(['do1', 'j1'])
    const job = dev.children.find((c: { id: string }) => c.id === 'j1')
    expect(job.children.map((c: { id: string }) => c.id)).toEqual(['n1'])
    const gap = body.gaps.find((g: { node_id: string }) => g.node_id === 'p2')
    expect(gap).toBeDefined()
    expect(gap.missing).toEqual(['job'])
  })

  it('renders a shared (multi-parent) node under every parent as a reference', async () => {
    const ctx = makeStore(
      [
        n('p1', 'persona', 'Developer'),
        n('p2', 'persona', 'Designer'),
        n('j1', 'job', 'Model content as code'),
        n('n1', 'need', 'Reuse without forking'),
      ],
      [
        e('e1', 'p1', 'j1', 'persona_pursues_job'),
        e('e2', 'p2', 'j1', 'persona_pursues_job'),
        e('e3', 'j1', 'n1', 'job_surfaces_need'),
      ],
    )
    const body = bodyOf(await getTree({ product_id: 'prod', pattern: 'user' }, ctx))
    const p1 = body.roots.find((r: { id: string }) => r.id === 'p1')
    const p2 = body.roots.find((r: { id: string }) => r.id === 'p2')
    const j1UnderP1 = p1.children.find((c: { id: string }) => c.id === 'j1')
    const j1UnderP2 = p2.children.find((c: { id: string }) => c.id === 'j1')
    expect(j1UnderP1).toBeDefined()
    expect(j1UnderP2).toBeDefined()
    expect(j1UnderP1.children.map((c: { id: string }) => c.id)).toEqual(['n1'])
    expect(j1UnderP2.shared).toBe(true)
    expect(j1UnderP2.children).toEqual([])
    expect(body.stats.shared_refs).toBe(1)
  })

  it('falls back to the product anchor for strategy and reports it', async () => {
    const ctx = makeStore(
      [
        n('prod', 'product', 'Studio'),
        n('t1', 'strategic_theme', 'Bet: AI-native'),
        n('i1', 'initiative', 'AI surface'),
      ],
      [
        e('e1', 'prod', 't1', 'product_organises_around_strategic_theme'),
        e('e2', 't1', 'i1', 'strategic_theme_pursues_initiative'),
      ],
    )
    const body = bodyOf(await getTree({ product_id: 'prod', pattern: 'strategy' }, ctx))
    expect(body.anchor_type).toBe('vision')
    expect(body.anchor_used).toBe('product')
    expect(body.anchor_resolved_from).toBe('vision')
    const root = body.roots.find((r: { id: string }) => r.id === 'prod')
    expect(root.children[0].id).toBe('t1')
    expect(root.children[0].children[0].id).toBe('i1')
  })

  it('honours from_id and include_properties', async () => {
    const ctx = makeStore(
      [n('o1', 'objective', 'O', { progress: 42 }), n('k1', 'key_result', 'KR')],
      [e('e1', 'o1', 'k1', 'objective_achieved_through_key_result')],
    )
    const body = bodyOf(
      await getTree({ product_id: 'prod', pattern: 'okr', from_id: 'o1', include_properties: ['progress'] }, ctx),
    )
    expect(body.roots[0].id).toBe('o1')
    expect(body.roots[0].properties.progress).toBe(42)
    expect(body.roots[0].children[0].id).toBe('k1')
  })

  it('rejects an unknown pattern', async () => {
    const ctx = makeStore([], [])
    const r = (await getTree({ product_id: 'prod', pattern: 'not-a-pattern' }, ctx)) as {
      content: { text: string }[]
    }
    expect(r.content[0].text).toMatch(/Unknown tree pattern/i)
  })

  it('requires product_id and pattern', async () => {
    const ctx = makeStore([], [])
    const noPid = (await getTree({ pattern: 'user' }, ctx)) as { content: { text: string }[] }
    expect(noPid.content[0].text).toMatch(/Missing required parameter: product_id/i)
    const noPattern = (await getTree({ product_id: 'prod' }, ctx)) as { content: { text: string }[] }
    expect(noPattern.content[0].text).toMatch(/Missing required parameter: pattern/i)
  })

  // Mirror of the local server's guard: the hand-maintained pattern-id enum in
  // the get_tree / get_tree_pattern descriptions must list every catalogue
  // pattern. Cloud and local share the catalogue, so a pattern added to core
  // must appear in BOTH servers' prose, not just whichever was hand-edited.
  describe('get_tree description enums stay in lockstep with UPG_TREE_PATTERNS', () => {
    const PATTERN_IDS = UPG_TREE_PATTERNS.map((p) => p.id)
    const def = (name: string) => {
      const d = TOOL_DEFINITIONS.find((t) => t.name === name)
      if (!d) throw new Error(`tool ${name} not in cloud TOOL_DEFINITIONS`)
      return d
    }
    const listsAll = (label: string, text: string) => {
      const missing = PATTERN_IDS.filter((id) => !text.includes(id))
      expect(missing, `${label} omits pattern id(s): ${missing.join(', ')}`).toEqual([])
    }

    it('get_tree tool description + pattern arg list every catalogue pattern', () => {
      const t = def('get_tree')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = t.inputSchema.properties as any
      listsAll('cloud get_tree.description', t.description)
      listsAll('cloud get_tree pattern arg', props.pattern.description)
    })

    // `get_tree_pattern` retired in 0.19.0 (folded into get_catalog_entry).
    // Its id-enum lockstep no longer applies.
  })
})
