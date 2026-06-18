/**
 * Figma Adapter Tests
 *
 * Covers entity type mapping, skip cases, edge emission, status normalisation,
 * warning emission, source_map, external_tool, and the full fixture catalog check.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { FigmaAdapter } from '../adapters/figma.js'
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

const adapter = new FigmaAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('FigmaAdapter: entity type mapping', () => {
  it('file maps to document with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Product Screens', 'file')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    expect(result.nodes[0].external_tool).toBe('figma')
  })

  it('frame maps to screen with high confidence', async () => {
    const items: SourceItem[] = [makeItem('fr1', 'Onboarding Screen', 'frame')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('screen')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('component maps to design_component with high confidence', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Button/Primary', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('design_component')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('component_set maps to design_component', async () => {
    const items: SourceItem[] = [makeItem('cs1', 'Button variants', 'component_set')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('design_component')
  })

  it('prototype maps to prototype with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Checkout flow prototype', 'prototype')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('prototype')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('FigmaAdapter: skip cases', () => {
  it('variable is skipped and counted in warning', async () => {
    const items: SourceItem[] = [
      makeItem('v1', 'color/primary', 'variable'),
      makeItem('v2', 'color/secondary', 'variable'),
      makeItem('fr1', 'Dashboard', 'frame'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('screen')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 variables skipped')
  })

  it('style is skipped and counted with variables in warning', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Text/Heading', 'style'),
      makeItem('fr1', 'Screen', 'frame'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('variable')
  })

  it('page is skipped with warning', async () => {
    const items: SourceItem[] = [makeItem('pg1', 'Screens', 'page')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('section is skipped with warning', async () => {
    const items: SourceItem[] = [makeItem('sec1', 'Section A', 'section')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('branch is skipped', async () => {
    const items: SourceItem[] = [makeItem('b1', 'feature-branch', 'branch')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('FigmaAdapter: status normalisation (validated against target lifecycle)', () => {
  it("status 'active' is omitted (no clean target in the design lifecycles)", async () => {
    const items: SourceItem[] = [makeItem('fr1', 'Active Screen', 'frame', { status: 'active' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it("status 'archived' maps to 'deprecated' for a design_component", async () => {
    const items: SourceItem[] = [makeItem('c1', 'Old Button', 'component', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('deprecated')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('FigmaAdapter: edge emission', () => {
  it('file → frame falls back to a generic link (a Figma file maps to document, not product)', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Product Screens', 'file'),
      makeItem('fr1', 'Onboarding', 'frame', { parent_id: 'f1', parent_type: 'file' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'file->frame link')
    // No document -> screen edge exists, so an honest node_informs_node is emitted
    // instead of a product_contains_screen sourced from a document node.
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })

  it('file → component falls back to a generic link (no document -> design_component edge)', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Design System', 'file'),
      makeItem('c1', 'Button', 'component', { parent_id: 'f1', parent_type: 'file' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'file->component link')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })

  it('screen_renders_design_component emitted for frame → component', async () => {
    const items: SourceItem[] = [
      makeItem('fr1', 'Dashboard Screen', 'frame'),
      makeItem('c1', 'Card Component', 'component', {
        parent_id: 'fr1',
        parent_type: 'frame',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'screen_renders_design_component')
    const edge = result.edges.find((e) => e.type === 'screen_renders_design_component')
    expect(edge).toBeDefined()
  })

  it('prototype_simulates_screen emitted for prototype → frame', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Onboarding prototype', 'prototype'),
      makeItem('fr1', 'Step 1', 'frame', { parent_id: 'p1', parent_type: 'prototype' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'prototype_simulates_screen')
    const edge = result.edges.find((e) => e.type === 'prototype_simulates_screen')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Product Screens', 'file'),
      makeItem('fr1', 'Onboarding', 'frame', { parent_id: 'f1', parent_type: 'file' }),
      makeItem('fr2', 'Dashboard', 'frame', { parent_id: 'f1', parent_type: 'file' }),
      makeItem('c1', 'Button', 'component', { parent_id: 'f1', parent_type: 'file' }),
      makeItem('fr3', 'Step 2', 'frame', { parent_id: 'fr1', parent_type: 'frame' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'FigmaAdapter full fixture')
    expect(result.edges.length).toBeGreaterThan(0)
  })
})

// ─── Variable skip warning ────────────────────────────────────────────────────

describe('FigmaAdapter: variable skip warning', () => {
  it('emits a single warning with correct count for multiple variables', async () => {
    const items: SourceItem[] = [
      makeItem('v1', 'color/primary', 'variable'),
      makeItem('v2', 'color/surface', 'variable'),
      makeItem('v3', 'spacing/4', 'variable'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warns = result.warnings ?? []
    const variableWarn = warns.find((w) => w.includes('variable'))
    expect(variableWarn).toBeDefined()
    expect(variableWarn).toContain('3 variables skipped')
  })

  it('emits singular "variable" in warning when count is 1', async () => {
    const items: SourceItem[] = [makeItem('v1', 'color/primary', 'variable')]
    const result = await adapter.convert(items)
    const warns = result.warnings ?? []
    const variableWarn = warns.find((w) => w.includes('variable'))
    expect(variableWarn).toBeDefined()
    expect(variableWarn).toContain('1 variable skipped')
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('FigmaAdapter: source_map', () => {
  it('source_map has entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Screens', 'file'),
      makeItem('fr1', 'Onboarding', 'frame'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['f1']).toBeDefined()
    expect(result.source_map['fr1']).toBeDefined()
  })

  it('skipped variables are NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('v1', 'color/primary', 'variable')]
    const result = await adapter.convert(items)
    expect(result.source_map['v1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('FigmaAdapter: external_tool and external_id', () => {
  it('external_tool is always figma', async () => {
    const items: SourceItem[] = [makeItem('fr1', 'Screen', 'frame')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('figma')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('file-abc-123', 'Screen', 'frame')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('file-abc-123')
  })
})
