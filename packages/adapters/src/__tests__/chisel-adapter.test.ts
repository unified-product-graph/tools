/**
 * Chisel Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * impact/effort score preservation, and the Idea → opportunity mapping NOTE.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ChiselAdapter } from '../adapters/chisel.js'
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

const adapter = new ChiselAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('ChiselAdapter: entity_type → UPG type mapping', () => {
  it('goal maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeItem('g1', 'Grow retention', 'goal')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('chisel')
  })

  it('pillar maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Activation pillar', 'pillar')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('idea maps to opportunity with confidence high', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users struggle with onboarding', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('idea → opportunity mapping emits a NOTE with "opportunity" in the text', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users struggle with onboarding', 'idea')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('opportunity')
    expect(warnText).toContain('product opportunity')
  })

  it('feature maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Onboarding wizard', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('user_story maps to user_story with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('us1', 'As a user I want...', 'user_story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('user_story')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('persona maps to persona with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Power User', 'persona')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('persona')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feedback maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeItem('fb1', 'Users want dark mode', 'feedback')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('insight maps to insight with confidence high', async () => {
    const items: SourceItem[] = [makeItem('ins1', 'Synthesised insight', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('roadmap_item maps to feature with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('rm1', 'Roadmap item', 'roadmap_item')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('team maps to team with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Growth Team', 'team')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('sprint is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeItem('sp1', 'Sprint 12', 'sprint'),
      makeItem('f1', 'Real feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('sprint')
    expect(warnText).toContain('no UPG equivalent')
  })

  it('unknown entity_type defaults to document with warning', async () => {
    const items: SourceItem[] = [makeItem('x1', 'Unknown', 'custom_thing')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Impact and effort score preservation ────────────────────────────────────

describe('ChiselAdapter: impact_score and effort_score on opportunity nodes', () => {
  it('impact_score and effort_score are preserved on idea (opportunity) nodes', async () => {
    const items: SourceItem[] = [
      makeItem('i1', 'Onboarding pain', 'idea', {
        impact_score: 8,
        effort_score: 3,
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.impact_score).toBe(8)
    expect(node.effort_score).toBe(3)
  })

  it('impact_score is NOT added to non-opportunity nodes', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Feature', 'feature', { impact_score: 7 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.impact_score).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ChiselAdapter: status normalisation', () => {
  it("status 'new' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('i1', 'New idea', 'idea', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'in_progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('i1', 'Active idea', 'idea', { status: 'in_progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'done' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('i1', 'Done', 'idea', { status: 'done' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('i1', 'Archived idea', 'idea', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('ChiselAdapter: edge emission', () => {
  it('initiative_drives_outcome emitted when goal has pillar parent', async () => {
    const items: SourceItem[] = [
      makeItem('pil1', 'Activation pillar', 'pillar'),
      makeItem('g1', 'Grow retention', 'goal', {
        parent_id: 'pil1',
        parent_type: 'pillar',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome (pillar→goal)')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted when idea has pillar parent', async () => {
    const items: SourceItem[] = [
      makeItem('pil1', 'Activation pillar', 'pillar'),
      makeItem('i1', 'Onboarding pain', 'idea', {
        parent_id: 'pil1',
        parent_type: 'pillar',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome (pillar→idea)')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('opportunity_drives_solution emitted when feature has idea parent', async () => {
    const items: SourceItem[] = [
      makeItem('i1', 'Onboarding pain', 'idea'),
      makeItem('f1', 'Wizard feature', 'feature', {
        parent_id: 'i1',
        parent_type: 'idea',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'opportunity_drives_solution')
    const edge = result.edges.find((e) => e.type === 'opportunity_drives_solution')
    expect(edge).toBeDefined()
  })

  it('feature_request_creates_opportunity emitted when idea has feedback parent', async () => {
    const items: SourceItem[] = [
      makeItem('fb1', 'Users want faster onboarding', 'feedback'),
      makeItem('i1', 'Onboarding pain', 'idea', {
        parent_id: 'fb1',
        parent_type: 'feedback',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_request_creates_opportunity')
    const edge = result.edges.find((e) => e.type === 'feature_request_creates_opportunity')
    expect(edge).toBeDefined()
  })

  it('product_targets_persona emitted when persona has team parent', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'Growth Team', 'team'),
      makeItem('p1', 'Power User', 'persona', {
        parent_id: 't1',
        parent_type: 'team',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_targets_persona (team→persona)')
    const edge = result.edges.find((e) => e.type === 'product_targets_persona')
    expect(edge).toBeDefined()
  })

  it('insight_informs_opportunity emitted when idea has insight parent', async () => {
    const items: SourceItem[] = [
      makeItem('ins1', 'Research finding', 'insight'),
      makeItem('i1', 'Onboarding pain', 'idea', {
        parent_id: 'ins1',
        parent_type: 'insight',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'insight_informs_opportunity')
    const edge = result.edges.find((e) => e.type === 'insight_informs_opportunity')
    expect(edge).toBeDefined()
  })

  it('missing parent_id results in no edge and a warning', async () => {
    const items: SourceItem[] = [
      makeItem('i1', 'Orphan idea', 'idea', {
        parent_id: 'nonexistent',
        parent_type: 'pillar',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('not found')
  })

  it('all emitted edges are in the UPG catalogue (full discovery chain)', async () => {
    const items: SourceItem[] = [
      makeItem('pil1', 'Activation pillar', 'pillar'),
      makeItem('g1', 'Grow retention', 'goal', { parent_id: 'pil1', parent_type: 'pillar' }),
      makeItem('ins1', 'Research insight', 'insight'),
      makeItem('i1', 'Onboarding pain', 'idea', { parent_id: 'ins1', parent_type: 'insight' }),
      makeItem('f1', 'Wizard', 'feature', { parent_id: 'i1', parent_type: 'idea' }),
      makeItem('p1', 'Power User', 'persona'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ChiselAdapter full discovery chain')
    expect(result.edges.length).toBe(3)
  })
})

// ─── Source map and identity ──────────────────────────────────────────────────

describe('ChiselAdapter: source_map and identity', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Goal', 'goal'),
      makeItem('i1', 'Idea', 'idea'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['g1']).toBeDefined()
    expect(result.source_map['i1']).toBeDefined()
  })

  it('skipped sprint cards are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('sp1', 'Sprint 12', 'sprint')]
    const result = await adapter.convert(items)
    expect(result.source_map['sp1']).toBeUndefined()
  })

  it('external_tool is always chisel', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Idea', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('chisel')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('chisel-xyz', 'Idea', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('chisel-xyz')
  })
})
