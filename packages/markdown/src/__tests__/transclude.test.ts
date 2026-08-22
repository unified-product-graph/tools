import { describe, it, expect, vi } from 'vitest'
import { parse } from '../parse.js'
import { buildIndex } from '../index-builder.js'
import { buildTransclusionEdges } from '../transclude.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOC_ID = 'doc-quarterly-pricing-review'

/** A well-formed .upg.md document. Body is appended per test. */
function doc(body: string): string {
  return `---
title: "Quarterly Pricing Review"
upg_product: lumenpath
upg_version: "0.34.0"
entity_type: document
entity_id: ${DOC_ID}
---

${body}
`
}

/** The graph the resolver stands in for. Invented names throughout. */
const GRAPH = new Map<string, string>([
  ['metric:weekly-active-crews', 'node-metric-0001'],
  ['persona:rina-field-lead', 'node-persona-0002'],
  ['specification:tier-boundaries', 'node-spec-0003'],
])

const resolveTarget = (key: string): string | null => GRAPH.get(key) ?? null

// ─── The anchor emits the edge ────────────────────────────────────────────────

describe('buildTransclusionEdges: an anchor in a document body', () => {
  it('produces exactly one edge, of the right type and direction', async () => {
    const result = parse(doc('Retention hinges on [[metric:weekly-active-crews]] this quarter.'))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      type: 'document_transcludes_node',
      source: DOC_ID,
      target: 'node-metric-0001',
      anchor: 'metric:weekly-active-crews',
    })
    expect(skipped).toEqual([])
  })

  it('sources on the document and targets on the node, never the reverse', async () => {
    const result = parse(doc('Retention hinges on [[metric:weekly-active-crews]].'))
    const { edges } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges[0].source).toBe(DOC_ID)
    expect(edges[0].target).toBe('node-metric-0001')
    expect(edges[0].target).not.toBe(DOC_ID)
  })

  it('carries no position property, however tempting the line number is', async () => {
    // The parser has the source line in hand and the index keeps it. The edge
    // must not: a stored line is wrong after the next paragraph is inserted
    // above it, and nothing would report the drift.
    const source = doc('First paragraph.\n\nRetention hinges on [[metric:weekly-active-crews]].')
    const result = parse(source)
    const { edges } = await buildTransclusionEdges(result, { resolveTarget })

    expect(Object.keys(edges[0]).sort()).toEqual(['anchor', 'source', 'target', 'type'])
    for (const key of Object.keys(edges[0])) {
      expect(key).not.toMatch(/line|offset|position|column|anchor_line/)
    }

    // The line does live on the index, which is where it belongs.
    const index = buildIndex(result)
    const anchorLine = result.body.split('\n').findIndex(l => l.includes('[[metric:')) + 1
    expect(index.entities.get('metric:weekly-active-crews')?.lines).toEqual([anchorLine])
  })
})

// ─── One edge per pair ────────────────────────────────────────────────────────

describe('buildTransclusionEdges: de-duplication', () => {
  it('collapses three occurrences of one reference into a single edge', async () => {
    const result = parse(doc([
      'Retention hinges on [[metric:weekly-active-crews]].',
      '',
      'The board reads [[metric:weekly-active-crews]] weekly.',
      '',
      'Pricing tiers move with [[metric:weekly-active-crews]].',
    ].join('\n')))

    const { edges } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(1)
    expect(edges[0].anchor).toBe('metric:weekly-active-crews')

    // The repeat count stays in the index, where it already lived.
    const index = buildIndex(result)
    expect(index.entities.get('metric:weekly-active-crews')?.count).toBe(3)
    expect(index.entities.get('metric:weekly-active-crews')?.lines).toHaveLength(3)
  })

  it('emits one edge per distinct pair when several nodes are anchored', async () => {
    const result = parse(doc(
      '[[metric:weekly-active-crews]] matters most to [[persona:rina-field-lead]], '
      + 'and again to [[persona:rina-field-lead]].',
    ))
    const { edges } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(2)
    expect(edges.map(e => e.anchor).sort()).toEqual([
      'metric:weekly-active-crews',
      'persona:rina-field-lead',
    ])
  })
})

// ─── The source must be a document ────────────────────────────────────────────

describe('buildTransclusionEdges: the source must be a document', () => {
  it('emits nothing when the frontmatter entity_type is not document', async () => {
    const source = `---
title: "Rina, Field Lead"
upg_product: lumenpath
upg_version: "0.34.0"
entity_type: persona
entity_id: persona-rina-field-lead
---

Rina watches [[metric:weekly-active-crews]] every morning.
`
    const spy = vi.fn(resolveTarget)
    const { edges, skipped } = await buildTransclusionEdges(parse(source), { resolveTarget: spy })

    expect(edges).toEqual([])
    expect(skipped).toEqual([
      { key: 'metric:weekly-active-crews', reason: 'source_not_a_document', isCreation: false },
    ])
    // Refused before resolution: there is no source, so there is nothing to look up.
    expect(spy).not.toHaveBeenCalled()
  })

  it('emits nothing when the document carries no entity_id to source on', async () => {
    const source = `---
title: "Quarterly Pricing Review"
upg_product: lumenpath
upg_version: "0.34.0"
entity_type: document
---

Retention hinges on [[metric:weekly-active-crews]].
`
    const { edges, skipped } = await buildTransclusionEdges(parse(source), { resolveTarget })

    expect(edges).toEqual([])
    expect(skipped[0].reason).toBe('source_missing_entity_id')
  })
})

// ─── No dangling edges ────────────────────────────────────────────────────────

describe('buildTransclusionEdges: unresolved references', () => {
  it('writes no edge for a reference the graph does not hold', async () => {
    const result = parse(doc('We still track [[metric:crew-churn-rate]] informally.'))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toEqual([])
    expect(skipped).toEqual([
      { key: 'metric:crew-churn-rate', reason: 'unresolved_anchor', isCreation: false },
    ])
  })

  it('keeps the resolved anchors when a sibling reference is stale', async () => {
    const result = parse(doc(
      '[[metric:weekly-active-crews]] is live; [[metric:crew-churn-rate]] is not.',
    ))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(1)
    expect(edges[0].anchor).toBe('metric:weekly-active-crews')
    expect(skipped.map(s => s.key)).toEqual(['metric:crew-churn-rate'])
  })
})

// ─── Creation anchors ─────────────────────────────────────────────────────────

describe('buildTransclusionEdges: creation anchors', () => {
  it('emits the edge once the caller has created the node', async () => {
    // The + marks node lifecycle, not prose semantics. Resolution is the gate,
    // so a creation anchor whose node now exists is a transclusion like any other.
    const result = parse(doc('Retention hinges on [[+metric:weekly-active-crews]].'))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(1)
    expect(edges[0].target).toBe('node-metric-0001')
    expect(skipped).toEqual([])
  })

  it('writes no edge while the node is still only requested, and says so', async () => {
    const result = parse(doc('Crews report a [[+need:mid-shift-handover-gap]].'))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toEqual([])
    expect(skipped).toEqual([
      { key: 'need:mid-shift-handover-gap', reason: 'unresolved_anchor', isCreation: true },
    ])
  })
})

// ─── Cross-product anchors ────────────────────────────────────────────────────

describe('buildTransclusionEdges: cross-product anchors', () => {
  it('writes no edge, and never asks the resolver for the foreign key', async () => {
    const result = parse(doc('Northwind tracks [[metric:weekly-active-crews@northwind]] too.'))
    const spy = vi.fn(resolveTarget)
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget: spy })

    expect(edges).toEqual([])
    expect(skipped).toEqual([
      {
        key: 'metric:weekly-active-crews@northwind',
        reason: 'cross_product_anchor',
        isCreation: false,
      },
    ])
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not mint a local edge even when a lenient resolver would match the bare id', async () => {
    // A resolver that strips the product slug is the realistic failure: it would
    // return the LOCAL node of the same id and point the edge at the wrong graph's
    // entity. Refusing before resolution is what makes that unreachable.
    const lenient = vi.fn((key: string) => GRAPH.get(key.split('@')[0]) ?? null)
    const result = parse(doc('Northwind tracks [[metric:weekly-active-crews@northwind]] too.'))
    const { edges } = await buildTransclusionEdges(result, { resolveTarget: lenient })

    expect(edges).toEqual([])
    expect(lenient).not.toHaveBeenCalled()
  })
})

// ─── Regression: the {{a -> b|verb}} form is untouched ────────────────────────

describe('buildTransclusionEdges: edge refs keep their own meaning', () => {
  const EDGE_REF_BODY =
    '{{persona:rina-field-lead -> metric:weekly-active-crews|informs}} the pricing model.'

  it('still produces its edge between the two referenced entities', () => {
    const index = buildIndex(parse(doc(EDGE_REF_BODY)))

    expect(index.edges).toHaveLength(1)
    expect(index.edges[0]).toMatchObject({
      source: 'persona:rina-field-lead',
      target: 'metric:weekly-active-crews',
      verb: 'informs',
    })
  })

  it('does not additionally pull the document into an edge', async () => {
    const result = parse(doc(EDGE_REF_BODY))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toEqual([])
    expect(skipped.map(s => s.reason)).toEqual(['not_an_anchor', 'not_an_anchor'])
    expect(skipped.map(s => s.key).sort()).toEqual([
      'metric:weekly-active-crews',
      'persona:rina-field-lead',
    ])
  })

  it('transcludes only the entity the prose actually anchored', async () => {
    const result = parse(doc(
      `Retention hinges on [[metric:weekly-active-crews]].\n\n${EDGE_REF_BODY}`,
    ))
    const { edges, skipped } = await buildTransclusionEdges(result, { resolveTarget })

    expect(edges).toHaveLength(1)
    expect(edges[0].anchor).toBe('metric:weekly-active-crews')
    expect(skipped).toEqual([
      { key: 'persona:rina-field-lead', reason: 'not_an_anchor', isCreation: false },
    ])
  })
})

// ─── Async resolvers ──────────────────────────────────────────────────────────

describe('buildTransclusionEdges: resolver shape', () => {
  it('accepts an async resolver, as validate() does', async () => {
    const result = parse(doc('Retention hinges on [[metric:weekly-active-crews]].'))
    const { edges } = await buildTransclusionEdges(result, {
      resolveTarget: async (key) => GRAPH.get(key) ?? null,
    })

    expect(edges).toHaveLength(1)
    expect(edges[0].target).toBe('node-metric-0001')
  })
})
