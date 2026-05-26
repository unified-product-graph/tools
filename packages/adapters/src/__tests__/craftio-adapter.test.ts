/**
 * Craft.io Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 * Note: file name is craftio (not craft-io) to match adapter name convention.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CraftioAdapter } from '../adapters/craftio.js'
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
    source_type: 'item',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new CraftioAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('CraftioAdapter — entity_type → UPG type mapping', () => {
  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeItem('obj1', 'Grow retention', 'objective')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('craftio')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const items: SourceItem[] = [makeItem('kr1', 'Activation Rate 60%', 'key_result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('init1', 'Onboarding revamp', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feature maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Wizard feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('story maps to story_statement with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('s1', 'As a user I want...', 'story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('story_statement')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('milestone maps to milestone with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('m1', 'Q2 launch', 'milestone')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('milestone')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('release maps to release with confidence high', async () => {
    const items: SourceItem[] = [makeItem('r1', 'v2.0', 'release')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('release')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('persona maps to persona with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Power User', 'persona')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('persona')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feedback maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeItem('fb1', 'User wants dark mode', 'feedback')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('data_item maps to observation with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('d1', 'Survey result: 40% drop-off', 'data_item')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('roadmap is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeItem('rm1', 'Q2 Roadmap', 'roadmap'),
      makeItem('f1', 'Real feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('roadmap')
  })

  it('workspace is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('ws1', 'Main workspace', 'workspace')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('unknown entity_type defaults to document with warning', async () => {
    const items: SourceItem[] = [makeItem('x1', 'Unknown thing', 'custom_widget')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('CraftioAdapter — status normalisation', () => {
  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Draft feature', 'feature', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'planned' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Planned', 'feature', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'in_progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'In progress', 'feature', { status: 'in_progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'done' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Done', 'feature', { status: 'done' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Dropped', 'feature', { status: 'cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('CraftioAdapter — edge emission', () => {
  it('objective_achieved_through_key_result emitted when key_result has objective parent', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Grow retention', 'objective'),
      makeItem('kr1', 'Activation Rate', 'key_result', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted when objective has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('obj1', 'Grow activation', 'objective', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('outcome_delivered_by_feature emitted when feature has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_delivered_by_feature')
    const edge = result.edges.find((e) => e.type === 'outcome_delivered_by_feature')
    expect(edge).toBeDefined()
  })

  it('release_contains_feature emitted when feature has release parent', async () => {
    const items: SourceItem[] = [
      makeItem('r1', 'v2.0', 'release'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'r1',
        parent_type: 'release',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
  })

  it('product_targets_persona emitted when persona has product parent', async () => {
    const items: SourceItem[] = [
      makeItem('prod1', 'My Product', 'product'),
      makeItem('p1', 'Power User', 'persona', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_targets_persona')
    const edge = result.edges.find((e) => e.type === 'product_targets_persona')
    expect(edge).toBeDefined()
  })

  it('missing parent_id results in no edge and a warning', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Orphan feature', 'feature', {
        parent_id: 'nonexistent',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('not found')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Grow retention', 'objective'),
      makeItem('kr1', 'Activation Rate', 'key_result', { parent_id: 'obj1', parent_type: 'objective' }),
      makeItem('init1', 'Onboarding revamp', 'initiative'),
      makeItem('f1', 'Wizard', 'feature', { parent_id: 'init1', parent_type: 'initiative' }),
      makeItem('r1', 'v2.0', 'release'),
      makeItem('f2', 'Profile feature', 'feature', { parent_id: 'r1', parent_type: 'release' }),
      makeItem('prod1', 'My Product', 'product'),
      makeItem('p1', 'Power User', 'persona', { parent_id: 'prod1', parent_type: 'product' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'CraftioAdapter full fixture')
    expect(result.edges.length).toBe(4)
  })
})

// ─── Source map and identity ──────────────────────────────────────────────────

describe('CraftioAdapter — source_map and identity', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('obj1', 'Objective', 'objective'),
      makeItem('f1', 'Feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['obj1']).toBeDefined()
    expect(result.source_map['f1']).toBeDefined()
  })

  it('skipped entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('rm1', 'Roadmap', 'roadmap')]
    const result = await adapter.convert(items)
    expect(result.source_map['rm1']).toBeUndefined()
  })

  it('external_tool is always craftio', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('craftio')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('craftio-abc', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('craftio-abc')
  })
})
