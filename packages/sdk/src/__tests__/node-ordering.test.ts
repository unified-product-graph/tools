/**
 * Meaning-aware node ordering (cli-next Phase A1). The intra-type tiebreaker
 * ladder: explicit order field -> semver -> lifecycle/status -> created_at ->
 * numeric-aware locale. Proves a release series reads sequentially, not lexically.
 */
import { describe, it, expect } from 'vitest'
import type { UPGBaseNode } from '@unified-product-graph/core'
import { getLifecycleForType } from '@unified-product-graph/core'
import { compareNodesWithinType, sortByType } from '../lib/tools.js'

const node = (over: Partial<UPGBaseNode> & { type: string; title: string }): UPGBaseNode =>
  ({ id: over.title, ...over }) as UPGBaseNode

const titles = (ns: UPGBaseNode[]) => ns.map((n) => n.title)

describe('compareNodesWithinType', () => {
  it('orders a release series by semantic version, not lexically', () => {
    const releases = ['Studio v5.10.0', 'Studio v5.2.0', 'Studio v6.0.0', 'Studio v5.9.0', 'Studio v5.0.0']
      .map((title) => node({ type: 'release', title, status: 'shipped' }))
    const sorted = [...releases].sort(compareNodesWithinType)
    expect(titles(sorted)).toEqual([
      'Studio v5.0.0', 'Studio v5.2.0', 'Studio v5.9.0', 'Studio v5.10.0', 'Studio v6.0.0',
    ])
  })

  it('an explicit order field beats every other signal', () => {
    const a = node({ type: 'journey_step', title: 'Zzz last by title', properties: { journey_step_order: 1 } })
    const b = node({ type: 'journey_step', title: 'Aaa first by title', properties: { journey_step_order: 2 } })
    expect(compareNodesWithinType(a, b)).toBeLessThan(0) // order 1 before order 2, despite titles
    const generic = [
      node({ type: 'feature', title: 'b', properties: { order: 30 } }),
      node({ type: 'feature', title: 'a', properties: { order: 10 } }),
    ]
    expect(titles([...generic].sort(compareNodesWithinType))).toEqual(['a', 'b'])
  })

  it('orders by lifecycle phase position when no order/version applies', () => {
    const lc = getLifecycleForType('feature')
    expect(lc, 'feature must have a lifecycle for this test').toBeDefined()
    const early = lc!.phases[0].id
    const later = lc!.phases[lc!.phases.length - 1].id
    expect(early).not.toBe(later)
    const a = node({ type: 'feature', title: 'same title', status: later })
    const b = node({ type: 'feature', title: 'same title', status: early })
    // early phase sorts before later phase
    expect(compareNodesWithinType(a, b)).toBeGreaterThan(0)
    expect(compareNodesWithinType(b, a)).toBeLessThan(0)
  })

  it('falls back to numeric-aware locale compare', () => {
    const items = ['Item 10', 'Item 2', 'Item 1'].map((title) => node({ type: 'note', title }))
    expect(titles([...items].sort(compareNodesWithinType))).toEqual(['Item 1', 'Item 2', 'Item 10'])
  })

  it('sortByType groups by type priority, then orders by meaning within a type', () => {
    const mixed = [
      node({ type: 'release', title: 'App v2.0.0', status: 'shipped' }),
      node({ type: 'persona', title: 'Bob' }),
      node({ type: 'release', title: 'App v10.0.0', status: 'shipped' }),
      node({ type: 'persona', title: 'Alice' }),
    ]
    const sorted = sortByType(mixed)
    // personas group together (higher priority), releases together + version-ordered.
    expect(titles(sorted)).toEqual(['Alice', 'Bob', 'App v2.0.0', 'App v10.0.0'])
  })
})
