/**
 * renderTree DAG-honesty (cli-next Phase B1). A graph is a DAG: a node reached
 * by several paths must render its subtree ONCE and appear as a `↗ shown above`
 * reference elsewhere, never re-exploded and never silently dropped. Cycles must
 * terminate. Pure-function test (no subprocess), so it cannot flake on a timeout.
 */
import { describe, it, expect } from 'vitest'
import type { UPGBaseNode } from '@unified-product-graph/core'
import { renderTree, renderAssembledTree, type RenderableTreeNode } from '../lib/formatter.js'

const n = (id: string, title: string): UPGBaseNode => ({ id, type: 'feature', title } as UPGBaseNode)
const occurrences = (s: string, sub: string) => s.split(sub).length - 1

describe('renderTree DAG handling', () => {
  it('renders a shared subtree once and references it elsewhere', () => {
    // A and B both parent S; S has child L. Diamond.
    const nodes: Record<string, UPGBaseNode> = {
      a: n('a', 'Alpha'), b: n('b', 'Beta'), s: n('s', 'Shared'), l: n('l', 'Leaf'),
    }
    const kids: Record<string, string[]> = { a: ['s'], b: ['s'], s: ['l'] }
    const childrenOf = (id: string) => (kids[id] ?? []).map((cid) => nodes[cid])
    const out = renderTree([nodes.a, nodes.b], childrenOf, 10)

    // Shared node appears under both parents...
    expect(occurrences(out, 'Shared')).toBe(2)
    // ...but its subtree (the leaf) expands exactly once.
    expect(occurrences(out, 'Leaf')).toBe(1)
    // ...and the second occurrence is marked as a reference.
    expect(occurrences(out, '↗ shown above')).toBe(1)
  })

  it('renderAssembledTree honours the pre-set shared flag and nested children', () => {
    const forest: RenderableTreeNode[] = [
      { type: 'persona', title: 'Dev', children: [
        { type: 'job', title: 'Ship', children: [{ type: 'need', title: 'Less toil', children: [] }] },
      ] },
      { type: 'persona', title: 'Designer', children: [
        { type: 'job', title: 'Ship', shared: true, children: [] }, // reference, no re-expand
      ] },
    ]
    const out = renderAssembledTree(forest)
    expect(occurrences(out, 'Less toil')).toBe(1) // subtree expanded once
    expect(occurrences(out, '↗ shown above')).toBe(1) // the shared job reference
    expect(occurrences(out, 'Ship')).toBe(2) // appears under both personas
  })

  it('terminates on a cycle', () => {
    const nodes: Record<string, UPGBaseNode> = { a: n('a', 'A'), b: n('b', 'B') }
    const kids: Record<string, string[]> = { a: ['b'], b: ['a'] } // a <-> b
    const childrenOf = (id: string) => (kids[id] ?? []).map((cid) => nodes[cid])
    const out = renderTree([nodes.a], childrenOf, 50)
    // a (root) -> b -> a(ref). Terminates with one reference, no stack overflow.
    expect(occurrences(out, '↗ shown above')).toBe(1)
    expect(out.split('\n').length).toBe(3)
  })
})
