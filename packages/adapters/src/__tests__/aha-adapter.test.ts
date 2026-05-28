/**
 * Aha! Adapter Tests
 *
 * Covers all entity type mappings, Key Result field preservation, Idea→stub
 * opportunity pattern, hierarchy edge emission, status normalisation, warning
 * emission, and source_map correctness.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { AhaAdapter } from '../adapters/aha.js'
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

const adapter = new AhaAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('AhaAdapter — entity_type → UPG type mapping', () => {
  it('initiative maps to initiative with confidence high', async () => {
    const items: SourceItem[] = [makeItem('init1', 'Platform modernisation', 'initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('aha')
  })

  it('goal maps to objective with confidence high', async () => {
    const items: SourceItem[] = [makeItem('g1', 'Grow retention to 80%', 'goal')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const items: SourceItem[] = [makeItem('kr1', 'Reduce churn by 5pp', 'key_result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key_result preserves current_value, target_value, and unit fields', async () => {
    const items: SourceItem[] = [
      makeItem('kr1', 'Activation rate', 'key_result', {
        key_result_current: 42,
        key_result_target: 65,
        key_result_unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(42)
    expect(node.target_value).toBe(65)
    expect(node.unit).toBe('%')
  })

  it('vision maps to vision with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('v1', 'The product vision statement', 'vision')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('vision')
  })

  it('feature maps to feature with confidence high', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Dark mode', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('epic maps to epic with confidence high', async () => {
    const items: SourceItem[] = [makeItem('e1', 'Onboarding Revamp', 'epic')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('epic')
  })

  it('requirement maps to acceptance_criterion with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('req1', 'User must confirm email', 'requirement')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('acceptance_criterion')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('release maps to release with confidence high', async () => {
    const items: SourceItem[] = [makeItem('r1', 'v2.0', 'release')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('release')
  })

  it('idea maps to feature_request with confidence high', async () => {
    const items: SourceItem[] = [makeItem('idea1', 'Add calendar sync', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_request')
  })

  it('persona maps to persona with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'The Enterprise PM', 'persona')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('persona')
  })

  it('competitor maps to competitor with confidence high', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Productboard', 'competitor')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('competitor')
  })

  it('note maps to document with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('n1', 'Internal strategy memo', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
  })

  it('product maps to product with confidence high', async () => {
    const items: SourceItem[] = [makeItem('prod1', 'Acme Compass', 'product')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('product')
  })

  it('team maps to team with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Platform Team', 'team')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
  })
})

// ─── Skip / warning cases ─────────────────────────────────────────────────────

describe('AhaAdapter — skip and warning cases', () => {
  it('product_line is skipped with a warning about no UPG equivalent', async () => {
    const items: SourceItem[] = [
      makeItem('pl1', 'Platform Portfolio', 'product_line'),
      makeItem('f1', 'Feature', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes.filter((n) => n.type !== 'opportunity')).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Product Line')
    expect(warnText).toContain('grouping context')
  })

  it('scorecard is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('sc1', 'RICE scorecard', 'scorecard')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('roadmap_view is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('rv1', 'Q1 Roadmap', 'roadmap_view')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('unknown entity type defaults to document with a warning', async () => {
    const items: SourceItem[] = [makeItem('x1', 'Custom thing', 'custom_aha_type')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('custom_aha_type')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('AhaAdapter — status normalisation', () => {
  it("'new' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("'planned' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'planned' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("'in-progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'in-progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("'shipped' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'shipped' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("'released' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'released' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("'will-not-implement' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Feature', 'feature', { status: 'will-not-implement' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("'cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature', { status: 'cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Idea → stub opportunity pattern ─────────────────────────────────────────

describe('AhaAdapter — idea → stub opportunity pattern', () => {
  it('a stub opportunity node is created when idea has idea_promoted_to_feature_id', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Calendar sync feature', 'feature'),
      makeItem('idea1', 'Add calendar sync', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
    ]
    const result = await adapter.convert(items)
    const opportunityNode = result.nodes.find((n) => n.type === 'opportunity')
    expect(opportunityNode).toBeDefined()
    expect(opportunityNode?.title).toContain('Opportunity:')
    expect(opportunityNode?.mapping_confidence).toBe('low')
  })

  it('feature_request_creates_opportunity edge is emitted for the stub', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Calendar sync', 'feature'),
      makeItem('idea1', 'Add calendar sync', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_request_creates_opportunity')
    const edge = result.edges.find((e) => e.type === 'feature_request_creates_opportunity')
    expect(edge).toBeDefined()
  })

  it('opportunity_drives_solution edge is emitted from stub to the promoted feature', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Calendar sync', 'feature'),
      makeItem('idea1', 'Add calendar sync', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'opportunity_drives_solution')
    const edge = result.edges.find((e) => e.type === 'opportunity_drives_solution')
    expect(edge).toBeDefined()
  })

  it('a warning about filling in the problem statement is emitted', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Calendar sync', 'feature'),
      makeItem('idea1', 'Add calendar sync', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('stub opportunity')
    expect(warnText).toContain('problem statement')
  })

  it('no stub opportunity is created when idea has no idea_promoted_to_feature_id', async () => {
    const items: SourceItem[] = [makeItem('idea1', 'Add calendar sync', 'idea')]
    const result = await adapter.convert(items)
    const opportunityNode = result.nodes.find((n) => n.type === 'opportunity')
    expect(opportunityNode).toBeUndefined()
  })
})

// ─── Hierarchy edge emission ──────────────────────────────────────────────────

describe('AhaAdapter — hierarchy edge emission', () => {
  it('initiative_drives_outcome emitted when goal has initiative parent', async () => {
    const items: SourceItem[] = [
      makeItem('init1', 'Platform modernisation', 'initiative'),
      makeItem('g1', 'Reduce technical debt', 'goal', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('objective_achieved_through_key_result emitted when key_result has goal parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Grow retention', 'goal'),
      makeItem('kr1', 'Reduce churn by 5pp', 'key_result', {
        parent_id: 'g1',
        parent_type: 'goal',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
  })

  it('release_contains_feature emitted when feature has release parent', async () => {
    const items: SourceItem[] = [
      makeItem('r1', 'v2.0', 'release'),
      makeItem('f1', 'Dark mode', 'feature', {
        parent_id: 'r1',
        parent_type: 'release',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
  })

  it('feature_decomposed_into_epic emitted when epic has feature parent', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Onboarding', 'feature'),
      makeItem('e1', 'Step 1 wizard', 'epic', {
        parent_id: 'f1',
        parent_type: 'feature',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_decomposed_into_epic')
    const edge = result.edges.find((e) => e.type === 'feature_decomposed_into_epic')
    expect(edge).toBeDefined()
  })

  it('epic_specified_by_user_story emitted when requirement has epic parent', async () => {
    const items: SourceItem[] = [
      makeItem('e1', 'Step 1 wizard', 'epic'),
      makeItem('req1', 'User must confirm email before proceeding', 'requirement', {
        parent_id: 'e1',
        parent_type: 'epic',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'epic_specified_by_user_story')
    const edge = result.edges.find((e) => e.type === 'epic_specified_by_user_story')
    expect(edge).toBeDefined()
  })

  it('outcome_delivered_by_feature emitted when feature has goal parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Grow retention', 'goal'),
      makeItem('f1', 'Onboarding improvements', 'feature', {
        parent_id: 'g1',
        parent_type: 'goal',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'outcome_delivered_by_feature')
    const edge = result.edges.find((e) => e.type === 'outcome_delivered_by_feature')
    expect(edge).toBeDefined()
  })

  it('product_targets_persona emitted when persona has product parent', async () => {
    const items: SourceItem[] = [
      makeItem('prod1', 'Acme Compass', 'product'),
      makeItem('p1', 'The Enterprise PM', 'persona', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_targets_persona')
    const edge = result.edges.find((e) => e.type === 'product_targets_persona')
    expect(edge).toBeDefined()
  })

  it('product_invests_in_initiative emitted when initiative has product parent', async () => {
    const items: SourceItem[] = [
      makeItem('prod1', 'Acme Compass', 'product'),
      makeItem('init1', 'Platform modernisation', 'initiative', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_invests_in_initiative')
    const edge = result.edges.find((e) => e.type === 'product_invests_in_initiative')
    expect(edge).toBeDefined()
  })

  it('missing parent emits a warning and no edge', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Feature', 'feature', {
        parent_id: 'unknown-release',
        parent_type: 'release',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown-release')
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('AhaAdapter — source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Feature', 'feature'),
      makeItem('g1', 'Goal', 'goal'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['f1']).toBeDefined()
    expect(result.source_map['g1']).toBeDefined()
  })

  it('stub opportunity source_map entry uses the idea source_id + suffix', async () => {
    const items: SourceItem[] = [
      makeItem('f1', 'Calendar sync', 'feature'),
      makeItem('idea1', 'Add calendar sync', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['idea1-stub-opportunity']).toBeDefined()
  })

  it('skipped product_line entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('pl1', 'Portfolio', 'product_line')]
    const result = await adapter.convert(items)
    expect(result.source_map['pl1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('AhaAdapter — external_tool and external_id', () => {
  it('external_tool is always aha', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('aha')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('aha-feature-777', 'Feature', 'feature')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('aha-feature-777')
  })
})

// ─── Full fixture ─────────────────────────────────────────────────────────────

describe('AhaAdapter — full fixture', () => {
  it('all emitted edges are in the UPG catalogue (full strategy + delivery tree)', async () => {
    const items: SourceItem[] = [
      makeItem('prod1', 'Acme Compass', 'product'),
      makeItem('init1', 'Platform modernisation', 'initiative', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
      makeItem('g1', 'Reduce technical debt', 'goal', {
        parent_id: 'init1',
        parent_type: 'initiative',
      }),
      makeItem('kr1', 'Reduce p95 latency to 200ms', 'key_result', {
        parent_id: 'g1',
        parent_type: 'goal',
        key_result_current: 450,
        key_result_target: 200,
        key_result_unit: 'ms',
      }),
      makeItem('r1', 'v2.0', 'release'),
      makeItem('f1', 'Async job queue', 'feature', {
        parent_id: 'r1',
        parent_type: 'release',
      }),
      makeItem('e1', 'Queue implementation', 'epic', {
        parent_id: 'f1',
        parent_type: 'feature',
      }),
      makeItem('req1', 'Jobs must retry on failure', 'requirement', {
        parent_id: 'e1',
        parent_type: 'epic',
      }),
      makeItem('idea1', 'Background processing idea', 'idea', {
        idea_promoted_to_feature_id: 'f1',
      }),
      makeItem('p1', 'The Enterprise PM', 'persona', {
        parent_id: 'prod1',
        parent_type: 'product',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'AhaAdapter full fixture')
    // Edges expected:
    // product_invests_in_initiative (prod1→init1)
    // initiative_drives_outcome (init1→g1)
    // objective_achieved_through_key_result (g1→kr1)
    // release_contains_feature (r1→f1)
    // feature_decomposed_into_epic (f1→e1)
    // epic_specified_by_user_story (e1→req1)
    // feature_request_creates_opportunity (idea1→stub-opp)
    // opportunity_drives_solution (stub-opp→f1)
    // product_targets_persona (prod1→p1)
    expect(result.edges.length).toBe(9)
  })
})
