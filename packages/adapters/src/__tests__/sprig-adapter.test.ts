/**
 * Sprig Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation (including 'paused' → 'active'), response_count and
 * nps_score preservation, deferred theme→insight edges, skipped types
 * (question, event), and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { SprigAdapter } from '../adapters/sprig.js'
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

const adapter = new SprigAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('SprigAdapter — entity_type → UPG type mapping', () => {
  it('study maps to research_study with confidence high', async () => {
    const items: SourceItem[] = [makeItem('st1', 'Onboarding NPS Survey', 'study')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('sprig')
  })

  it('survey maps to research_study (alternate API name)', async () => {
    const items: SourceItem[] = [makeItem('sv1', 'Feature Satisfaction Survey', 'survey')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('response maps to customer_feedback (NOT observation)', async () => {
    const items: SourceItem[] = [makeItem('r1', 'Response 1', 'response')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('respondent maps to participant', async () => {
    const items: SourceItem[] = [makeItem('resp1', 'User A', 'respondent')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('theme maps to affinity_cluster with confidence medium (AI-generated)', async () => {
    const items: SourceItem[] = [makeItem('th1', 'Pricing Confusion', 'theme')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('affinity_cluster')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('insight maps to insight', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users are confused by pricing', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('segment maps to market_segment with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('seg1', 'Power Users', 'segment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('market_segment')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Skipped types ────────────────────────────────────────────────────────────

describe('SprigAdapter — skipped types', () => {
  it('question is skipped with warning about survey instrument', async () => {
    const items: SourceItem[] = [
      makeItem('q1', 'How satisfied are you?', 'question'),
      makeItem('st1', 'Study', 'study'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('question')
    expect(warnText).toContain('instrument')
    expect(result.source_map['q1']).toBeUndefined()
  })

  it('event is skipped with warning about behavioral trigger', async () => {
    const items: SourceItem[] = [
      makeItem('ev1', 'completed_onboarding', 'event'),
      makeItem('st1', 'Study', 'study'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('event')
    expect(warnText).toContain('trigger')
  })

  it('unknown entity_type is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('int1', 'Mixpanel Integration', 'integration'),
      makeItem('st1', 'Study', 'study'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('integration')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('SprigAdapter — status normalisation', () => {
  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'running' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study', { status: 'running' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'paused' normalises to 'active' (still an active study, just paused)", async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study', { status: 'paused' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Quantitative field preservation ─────────────────────────────────────────

describe('SprigAdapter — quantitative field preservation', () => {
  it('response_count is preserved on research_study nodes', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Onboarding NPS', 'study', { response_count: 247 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.response_count).toBe(247)
  })

  it('nps_score is preserved on research_study nodes', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'NPS Study', 'study', { nps_score: 42 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.nps_score).toBe(42)
  })

  it('nps_score is preserved on customer_feedback (response) nodes', async () => {
    const items: SourceItem[] = [
      makeItem('r1', 'Response 1', 'response', { nps_score: 9 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.nps_score).toBe(9)
  })

  it('response_count is NOT added to non-research_study nodes', async () => {
    const items: SourceItem[] = [
      makeItem('th1', 'Theme', 'theme', { response_count: 50 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.response_count).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('SprigAdapter — edge emission', () => {
  it('research_study_enrolls_participant emitted when respondent has study parent', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Study', 'study'),
      makeItem('resp1', 'User A', 'respondent', { parent_id: 'st1', parent_type: 'study' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'study→respondent')
    const edge = result.edges.find((e) => e.type === 'research_study_enrolls_participant')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')
  })

  it('research_study_produces_insight emitted when insight has study parent', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Study', 'study'),
      makeItem('i1', 'Pricing insight', 'insight', { parent_id: 'st1', parent_type: 'study' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'study→insight')
    const edge = result.edges.find((e) => e.type === 'research_study_produces_insight')
    expect(edge).toBeDefined()
  })

  it('affinity_cluster_synthesises_insight emitted from deferred theme_ids', async () => {
    const items: SourceItem[] = [
      makeItem('th1', 'Pricing Confusion', 'theme'),
      makeItem('i1', 'Pricing insight', 'insight', { theme_ids: ['th1'] }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'deferred theme→insight')
    const edge = result.edges.find((e) => e.type === 'affinity_cluster_synthesises_insight')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('response (customer_feedback) under study emits node_informs_node with low confidence', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Study', 'study'),
      makeItem('r1', 'Response 1', 'response', { parent_id: 'st1', parent_type: 'study' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'study→response fallback')
    const edge = result.edges.find((e) => e.source !== undefined)
    expect(edge).toBeDefined()
    expect(edge?.type).toBe('node_informs_node')
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('missing parent emits warning and skips edge', async () => {
    const items: SourceItem[] = [
      makeItem('resp1', 'Respondent', 'respondent', { parent_id: 'nonexistent', parent_type: 'study' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent')
  })

  it('deferred theme→insight warns when theme not in batch', async () => {
    const items: SourceItem[] = [
      makeItem('i1', 'Insight', 'insight', { theme_ids: ['ghost-theme'] }),
    ]
    const result = await adapter.convert(items)
    const deferredEdge = result.edges.find((e) => e.type === 'affinity_cluster_synthesises_insight')
    expect(deferredEdge).toBeUndefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('ghost-theme')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Study', 'study', { response_count: 120 }),
      makeItem('resp1', 'User A', 'respondent', { parent_id: 'st1', parent_type: 'study' }),
      makeItem('r1', 'Response 1', 'response', { parent_id: 'st1', parent_type: 'study' }),
      makeItem('th1', 'Theme', 'theme', { parent_id: 'st1', parent_type: 'study' }),
      makeItem('i1', 'Insight', 'insight', { parent_id: 'st1', parent_type: 'study', theme_ids: ['th1'] }),
      makeItem('seg1', 'Power Users', 'segment'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'SprigAdapter full fixture')
    expect(result.nodes).toHaveLength(6)
  })
})

// ─── Insight warning ──────────────────────────────────────────────────────────

describe('SprigAdapter — insight → opportunity warning', () => {
  it('emits warning when insight nodes are created', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Pricing confuses users', 'insight')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('insight_informs_opportunity')
    expect(warnText).toContain('PM judgement')
  })

  it('does NOT auto-emit insight_informs_opportunity edge', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Pricing confuses users', 'insight')]
    const result = await adapter.convert(items)
    const opportunityEdge = result.edges.find((e) => e.type === 'insight_informs_opportunity')
    expect(opportunityEdge).toBeUndefined()
  })

  it('does NOT emit insight warning when no insights', async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).not.toContain('insight_informs_opportunity')
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('SprigAdapter — source_map and external fields', () => {
  it('source_map contains entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('st1', 'Study', 'study'),
      makeItem('th1', 'Theme', 'theme'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['st1']).toBeDefined()
    expect(result.source_map['th1']).toBeDefined()
  })

  it('skipped question is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('q1', 'How satisfied?', 'question')]
    const result = await adapter.convert(items)
    expect(result.source_map['q1']).toBeUndefined()
  })

  it('external_tool is always sprig', async () => {
    const items: SourceItem[] = [makeItem('st1', 'Study', 'study')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('sprig')
  })

  it('external_id matches source_id', async () => {
    const items: SourceItem[] = [makeItem('sprig-study-xyz', 'Study', 'study')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('sprig-study-xyz')
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('SprigAdapter — empty input', () => {
  it('returns empty result with warning when no items provided', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('No Sprig items were converted')
  })
})
