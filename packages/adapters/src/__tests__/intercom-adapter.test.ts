/**
 * Intercom Adapter Tests
 *
 * Covers all entity_type mappings, edge emission, status normalisation,
 * conversation_rating preservation, skip+warning cases, source_map integrity,
 * and external_tool tagging.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { IntercomAdapter } from '../adapters/intercom.js'
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
    source_type: 'intercom_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new IntercomAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('IntercomAdapter: entity_type → UPG type mapping', () => {
  it('conversation maps to support_ticket with confidence high', async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Help with billing', 'conversation')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('support_ticket')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('intercom')
  })

  it('contact maps to participant with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('ct1', 'Jane Smith', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('company maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeItem('co1', 'Acme Corp', 'company')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('article maps to document with confidence high', async () => {
    const items: SourceItem[] = [makeItem('art1', 'How to export data', 'article')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('segment maps to market_segment with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('seg1', 'Enterprise Customers', 'segment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('market_segment')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('survey maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('sur1', 'Q2 NPS Survey', 'survey')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('unknown entity_type defaults to document with low confidence and warning', async () => {
    const items: SourceItem[] = [makeItem('u1', 'Mystery', 'tour')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown entity_type')
  })
})

// ─── Skip + warning cases ─────────────────────────────────────────────────────

describe('IntercomAdapter: skipped types + warnings', () => {
  it('news_item and series entities are skipped with aggregate outbound warning', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Product Update', 'news_item'),
      makeItem('s1', 'Onboarding Sequence', 'series'),
      makeItem('conv1', 'Help request', 'conversation'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('support_ticket')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('outbound messaging campaigns')
    expect(warnText).toContain('2 Intercom news item')
  })

  it('tag entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'vip', 'tag'),
      makeItem('conv1', 'Help request', 'conversation'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['t1']).toBeUndefined()
  })

  it('messenger_app entities are silently skipped', async () => {
    const items: SourceItem[] = [
      makeItem('ma1', 'Stripe App', 'messenger_app'),
      makeItem('conv1', 'Help request', 'conversation'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['ma1']).toBeUndefined()
  })

  it('skipped news_item is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('n1', 'Product Update', 'news_item')]
    const result = await adapter.convert(items)
    expect(result.source_map['n1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('IntercomAdapter: status normalisation', () => {
  it("status 'open' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Help request', 'conversation', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'pending' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Help request', 'conversation', { status: 'pending' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'snoozed' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Snoozed ticket', 'conversation', { status: 'snoozed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'closed' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Resolved ticket', 'conversation', { status: 'closed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it('absent status produces no status property', async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Ticket', 'conversation')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Conversation rating ──────────────────────────────────────────────────────

describe('IntercomAdapter: conversation_rating', () => {
  it('conversation_rating preserved on support_ticket nodes', async () => {
    const items: SourceItem[] = [
      makeItem('conv1', 'Billing issue', 'conversation', { conversation_rating: 5 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.conversation_rating).toBe(5)
  })

  it('conversation_rating not carried onto non-support_ticket nodes', async () => {
    const items: SourceItem[] = [
      makeItem('co1', 'Acme Corp', 'company', { conversation_rating: 4 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.conversation_rating).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('IntercomAdapter: edge emission', () => {
  it('customer_feedback_becomes_feature_request emitted when support_ticket has feature_request parent', async () => {
    const items: SourceItem[] = [
      makeItem('fr1', 'Add CSV export', 'feature_request'),
      makeItem('conv1', 'User asked for CSV export', 'conversation', {
        parent_id: 'fr1',
        parent_type: 'feature_request',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'customer_feedback_becomes_feature_request')
    const edge = result.edges.find((e) => e.type === 'customer_feedback_becomes_feature_request')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('node_owned_by_team emitted when parent_type is team', async () => {
    const items: SourceItem[] = [
      makeItem('team1', 'Support Team', 'team'),
      makeItem('conv1', 'Billing question', 'conversation', {
        parent_id: 'team1',
        parent_type: 'team',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_owned_by_team')
    const edge = result.edges.find((e) => e.type === 'node_owned_by_team')
    expect(edge).toBeDefined()
  })

  it('contact_company_id creates node_informs_node edge to company node', async () => {
    const items: SourceItem[] = [
      makeItem('co1', 'Acme Corp', 'company'),
      makeItem('ct1', 'Jane Smith', 'contact', { contact_company_id: 'co1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'contact_company_id edge')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })

  it('node_informs_node fallback emitted for unrecognised parent→child pair', async () => {
    const items: SourceItem[] = [
      makeItem('co1', 'Acme Corp', 'company'),
      makeItem('conv1', 'Help request', 'conversation', { parent_id: 'co1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'fallback edge')
    const edge = result.edges.find((e) => e.source === result.source_map['co1'])
    expect(edge).toBeDefined()
    expect(edge?.type).toBe('node_informs_node')
  })

  it('warning emitted when parent_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('conv1', 'Help request', 'conversation', { parent_id: 'nonexistent-fr' }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent-fr')
    expect(warnText).toContain('Edge skipped')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('team1', 'Support Team', 'team'),
      makeItem('co1', 'Acme Corp', 'company'),
      makeItem('ct1', 'Jane Smith', 'contact', { contact_company_id: 'co1' }),
      makeItem('fr1', 'Add export feature', 'feature_request'),
      makeItem('conv1', 'User wants exports', 'conversation', {
        parent_id: 'fr1',
        parent_type: 'feature_request',
        status: 'open',
        conversation_rating: 4,
      }),
      makeItem('conv2', 'Billing help', 'conversation', {
        parent_id: 'team1',
        parent_type: 'team',
        status: 'closed',
      }),
      makeItem('art1', 'How to export', 'article'),
      makeItem('seg1', 'Enterprise', 'segment'),
      makeItem('sur1', 'Q2 NPS', 'survey'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'IntercomAdapter full fixture')
    expect(result.nodes.length).toBeGreaterThanOrEqual(7)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('IntercomAdapter: source_map', () => {
  it('source_map contains entries for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('conv1', 'Help request', 'conversation'),
      makeItem('co1', 'Acme Corp', 'company'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['conv1']).toBeDefined()
    expect(result.source_map['co1']).toBeDefined()
  })

  it('skipped news_item is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('n1', 'Product Update', 'news_item')]
    const result = await adapter.convert(items)
    expect(result.source_map['n1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('IntercomAdapter: external_tool and external_id', () => {
  it('external_tool is always intercom', async () => {
    const items: SourceItem[] = [makeItem('conv1', 'Help request', 'conversation')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('intercom')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('intercom-conv-123', 'Help request', 'conversation')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('intercom-conv-123')
  })
})
