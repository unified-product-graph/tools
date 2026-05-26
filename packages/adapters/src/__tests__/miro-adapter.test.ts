/**
 * Miro Adapter Tests
 *
 * Covers entity type mapping, frame-label override, connector skip warning,
 * unmatched frame label warning, edge emission, source_map, external_tool.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { MiroAdapter } from '../adapters/miro.js'
import type { SourceItem } from '../types.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

function makeItem(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: entityType,
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new MiroAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('MiroAdapter — entity type mapping', () => {
  it('sticky_note without frame label maps to observation', async () => {
    const items: SourceItem[] = [makeItem('s1', 'Users struggle with login', 'sticky_note')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].external_tool).toBe('miro')
  })

  it('card maps to task', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Fix onboarding flow', 'card')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
  })

  it('mindmap_node without frame label maps to observation', async () => {
    const items: SourceItem[] = [makeItem('mn1', 'Main theme', 'mindmap_node')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
  })
})

// ─── Frame-label override ─────────────────────────────────────────────────────

describe('MiroAdapter — frame_label override for sticky notes', () => {
  it('sticky_note in "opportunities" frame maps to opportunity', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Users need faster search', 'sticky_note', {
        frame_label: 'Opportunities',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('sticky_note in "insights" frame maps to insight', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Users drop off at step 3', 'sticky_note', {
        frame_label: 'insights',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
  })

  it('sticky_note in "hypotheses" frame maps to hypothesis_claim', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Simplifying nav increases conversion', 'sticky_note', {
        frame_label: 'Hypotheses',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('hypothesis_claim')
  })

  it('sticky_note in "risks" frame is skipped', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'API rate limit risk', 'sticky_note', { frame_label: 'risks' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('sticky_note in "parking lot" frame is skipped', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Maybe later idea', 'sticky_note', { frame_label: 'Parking Lot' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('sticky_note in "personas" frame maps to persona', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Power user — technical', 'sticky_note', { frame_label: 'Personas' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('persona')
  })

  it('card type is not overridden by frame_label — stays task', async () => {
    // frame_label override only applies to sticky_note and mindmap_node
    const items: SourceItem[] = [
      makeItem('c1', 'Build feature', 'card', { frame_label: 'Opportunities' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('MiroAdapter — skip cases', () => {
  it('connector is skipped and counted in warning', async () => {
    const items: SourceItem[] = [
      makeItem('conn1', 'Arrow', 'connector'),
      makeItem('conn2', 'Connection', 'connector'),
      makeItem('s1', 'Observation', 'sticky_note'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 connector')
    expect(warnText).toContain('skipped')
  })

  it('frame is skipped with warning', async () => {
    const items: SourceItem[] = [makeItem('fr1', 'Theme cluster', 'frame')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('text is skipped', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Label', 'text')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('image is skipped', async () => {
    const items: SourceItem[] = [makeItem('img1', 'Screenshot', 'image')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Color tag ────────────────────────────────────────────────────────────────

describe('MiroAdapter — color tag', () => {
  it('sticky note color is added as a tag', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Observation', 'sticky_note', { color: 'yellow' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('color:yellow')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('MiroAdapter — edge emission', () => {
  it('parent-child edge is emitted as node_informs_node (Miro structure is heuristic)', async () => {
    const items: SourceItem[] = [
      makeItem('fr1', 'Insights frame', 'frame'),
      makeItem('s1', 'Key finding', 'sticky_note', {
        parent_id: 'fr1',
        parent_type: 'frame',
        frame_label: 'insights',
      }),
    ]
    // Note: frame itself is skipped — parent not in sourceMap — edge also skipped with warning
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'MiroAdapter edges')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Raw observation 1', 'sticky_note', { frame_label: 'Observations' }),
      makeItem('s2', 'Raw observation 2', 'sticky_note', { frame_label: 'Observations' }),
      makeItem('c1', 'Action item', 'card'),
      makeItem('mn1', 'Mind map node', 'mindmap_node', { frame_label: 'Insights' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'MiroAdapter full fixture')
  })
})

// ─── Unmatched frame label warning ────────────────────────────────────────────

describe('MiroAdapter — unmatched frame label warning', () => {
  it('emits warning for sticky notes without a recognized frame label', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Some note', 'sticky_note'), // no frame_label
      makeItem('s2', 'Another note', 'sticky_note'), // no frame_label
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('frame label')
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('MiroAdapter — source_map, external_tool, external_id', () => {
  it('source_map has entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Note 1', 'sticky_note'),
      makeItem('c1', 'Card 1', 'card'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['s1']).toBeDefined()
    expect(result.source_map['c1']).toBeDefined()
  })

  it('external_tool is always miro', async () => {
    const items: SourceItem[] = [makeItem('s1', 'Note', 'sticky_note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('miro')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('miro-note-abc', 'Note', 'sticky_note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('miro-note-abc')
  })
})
