/**
 * Storybook Adapter Tests
 *
 * Covers all entity_type mappings, story → component edge emission,
 * platform entity skipping, tag preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 * Status is intentionally omitted from Storybook nodes.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { StorybookAdapter } from '../adapters/storybook.js'
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

const adapter = new StorybookAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('StorybookAdapter — entity_type → UPG entity type mapping', () => {
  it('component maps to design_component with confidence high', async () => {
    const items: SourceItem[] = [makeItem('btn', 'Button', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('design_component')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('storybook')
  })

  it('story maps to design_component with confidence high', async () => {
    const items: SourceItem[] = [
      makeItem('btn-primary', 'Button/Primary', 'story', {
        component_id: 'btn',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('design_component')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('docs_page maps to document with confidence high', async () => {
    const items: SourceItem[] = [makeItem('btn-docs', 'Button Documentation', 'docs_page')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('story and component both emit design_component — same entity type', async () => {
    const items: SourceItem[] = [
      makeItem('card', 'Card', 'component'),
      makeItem('card-default', 'Card/Default', 'story', { component_id: 'card' }),
      makeItem('card-elevated', 'Card/Elevated', 'story', { component_id: 'card' }),
    ]
    const result = await adapter.convert(items)
    const designComponents = result.nodes.filter((n) => n.type === 'design_component')
    expect(designComponents).toHaveLength(3)
  })
})

// ─── Platform entity skipping ─────────────────────────────────────────────────

describe('StorybookAdapter — skipped platform entity types', () => {
  it('addon is skipped with no node emitted', async () => {
    const items: SourceItem[] = [
      makeItem('addon1', '@storybook/addon-docs', 'addon'),
      makeItem('btn', 'Button', 'component'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('design_component')
  })

  it('arg_type, decorator, play_function are silently batched', async () => {
    const items: SourceItem[] = [
      makeItem('at1', 'variant arg type', 'arg_type'),
      makeItem('dec1', 'ThemeDecorator', 'decorator'),
      makeItem('play1', 'Button click test', 'play_function'),
      makeItem('btn', 'Button', 'component'),
    ]
    const result = await adapter.convert(items)
    // Only the component should be converted
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('design_component')
    // A batch warning about platform entities should be emitted
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('skipped')
  })
})

// ─── No status on nodes ───────────────────────────────────────────────────────

describe('StorybookAdapter — no status field on nodes', () => {
  it('component node has no status property', async () => {
    const items: SourceItem[] = [makeItem('btn', 'Button', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it('story node has no status property', async () => {
    const items: SourceItem[] = [
      makeItem('btn-primary', 'Button/Primary', 'story', { component_id: 'btn' }),
    ]
    // Note: register the component so the story references something valid
    const allItems: SourceItem[] = [
      makeItem('btn', 'Button', 'component'),
      ...items,
    ]
    const result = await adapter.convert(allItems)
    const storyNode = result.nodes.find((n) => n.title === 'Button/Primary')
    expect(storyNode?.status).toBeUndefined()
  })
})

// ─── Story → component edge emission ─────────────────────────────────────────

describe('StorybookAdapter — story → component edge emission', () => {
  it('node_informs_node emitted from story to component when component_id present', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component'),
      makeItem('btn-primary', 'Button/Primary', 'story', { component_id: 'btn' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'story→component edge')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('story uses parent_id as fallback when component_id is absent', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component'),
      makeItem('btn-disabled', 'Button/Disabled', 'story', { parent_id: 'btn' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'story→component via parent_id fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })

  it('multiple stories each get their own edge to the parent component', async () => {
    const items: SourceItem[] = [
      makeItem('card', 'Card', 'component'),
      makeItem('card-default', 'Card/Default', 'story', { component_id: 'card' }),
      makeItem('card-elevated', 'Card/Elevated', 'story', { component_id: 'card' }),
      makeItem('card-featured', 'Card/Featured', 'story', { component_id: 'card' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'multiple stories per component')
    const storyEdges = result.edges.filter((e) => e.type === 'node_informs_node')
    expect(storyEdges).toHaveLength(3)
  })

  it('warning emitted when story component_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('btn-primary', 'Button/Primary', 'story', { component_id: 'btn-missing' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('btn-missing')
    expect(warnText).toContain('edge skipped')
  })

  it('no edge emitted for story with no component_id and no parent_id', async () => {
    const items: SourceItem[] = [
      makeItem('orphan-story', 'Orphan Story', 'story'),
    ]
    const result = await adapter.convert(items)
    // Node should still be created
    expect(result.nodes).toHaveLength(1)
    // But no edge, since there is nothing to link to
    expect(result.edges).toHaveLength(0)
  })
})

// ─── Component traceability warning ──────────────────────────────────────────

describe('StorybookAdapter — component traceability warning', () => {
  it('emits traceability warning when component or story is converted', async () => {
    const items: SourceItem[] = [makeItem('btn', 'Button', 'component')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('design_component')
    expect(warnText).toContain('features they implement')
  })

  it('traceability warning is emitted only once per batch', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component'),
      makeItem('card', 'Card', 'component'),
      makeItem('input', 'Input', 'component'),
    ]
    const result = await adapter.convert(items)
    const traceabilityWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('features they implement'),
    )
    expect(traceabilityWarnings).toHaveLength(1)
  })
})

// ─── Tags and story_kind ──────────────────────────────────────────────────────

describe('StorybookAdapter — tags and story_kind', () => {
  it('tags from metadata are preserved on the node', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component', {
        tags: ['atoms', 'interactive'],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('atoms')
    expect(result.nodes[0].tags).toContain('interactive')
  })

  it('story_kind is preserved as a tag', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component', {
        story_kind: 'Components/Atoms',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('story_kind:Components/Atoms')
  })
})

// ─── All edges catalogued fixture ────────────────────────────────────────────

describe('StorybookAdapter — full design system fixture', () => {
  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component', { story_kind: 'Components/Atoms', tags: ['atoms'] }),
      makeItem('btn-primary', 'Button/Primary', 'story', { component_id: 'btn' }),
      makeItem('btn-secondary', 'Button/Secondary', 'story', { component_id: 'btn' }),
      makeItem('btn-disabled', 'Button/Disabled', 'story', { component_id: 'btn' }),
      makeItem('card', 'Card', 'component', { story_kind: 'Components/Molecules', tags: ['molecules'] }),
      makeItem('card-default', 'Card/Default', 'story', { component_id: 'card' }),
      makeItem('btn-docs', 'Button Documentation', 'docs_page', { is_docs_page: true }),
      makeItem('addon1', '@storybook/addon-essentials', 'addon'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'StorybookAdapter full design system fixture')
    // 2 components + 4 stories + 1 docs_page = 7 nodes (addon skipped)
    expect(result.nodes).toHaveLength(7)
    // 4 story→component edges (btn has 3, card has 1)
    expect(result.edges).toHaveLength(4)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('StorybookAdapter — source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('btn', 'Button', 'component'),
      makeItem('btn-docs', 'Button Docs', 'docs_page'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['btn']).toBeDefined()
    expect(result.source_map['btn-docs']).toBeDefined()
  })

  it('skipped addon is NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('addon1', 'docs addon', 'addon')]
    const result = await adapter.convert(items)
    expect(result.source_map['addon1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('StorybookAdapter — external_tool and external_id', () => {
  it('external_tool is always storybook', async () => {
    const items: SourceItem[] = [makeItem('btn', 'Button', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('storybook')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('components-button--primary', 'Button/Primary', 'story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('components-button--primary')
  })
})
