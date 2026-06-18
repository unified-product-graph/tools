/**
 * Zendesk Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation, satisfaction_score preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ZendeskAdapter } from '../adapters/zendesk.js'
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

const adapter = new ZendeskAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('ZendeskAdapter: entity_type → UPG entity type mapping', () => {
  it('ticket maps to support_ticket with confidence high', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Cannot login', 'ticket')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('support_ticket')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('zendesk')
  })

  it('organization maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeItem('org1', 'Acme Corp', 'organization')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('user maps to participant with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('u1', 'Jane Smith', 'user')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('article maps to document with confidence high', async () => {
    const items: SourceItem[] = [makeItem('a1', 'How to reset password', 'article')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('group maps to team with confidence high', async () => {
    const items: SourceItem[] = [makeItem('g1', 'Enterprise Support', 'group')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('satisfaction_rating maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [
      makeItem('csat1', 'CSAT for ticket #1234', 'satisfaction_rating', {
        satisfaction_score: 'bad',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const node = result.nodes[0] as Record<string, unknown>
    const props = node.properties as Record<string, unknown> | undefined
    expect(props?.satisfaction_score).toBe('bad')
    expect(node.satisfaction_score).toBeUndefined()
  })

  it('post maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Feature request: dark mode', 'post')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('forum_topic maps to document with confidence medium', async () => {
    const items: SourceItem[] = [makeItem('ft1', 'API Questions', 'forum_topic')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Skipped entities ─────────────────────────────────────────────────────────

describe('ZendeskAdapter: skipped entity types', () => {
  it('section is skipped with no node emitted', async () => {
    const items: SourceItem[] = [
      makeItem('sec1', 'Getting Started', 'section'),
      makeItem('a1', 'How to begin', 'article'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
  })

  it('comment, tag, macro, trigger, view, ticket_field are silently batched', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'Reply from customer', 'comment'),
      makeItem('tag1', 'enterprise', 'tag'),
      makeItem('m1', 'Close ticket macro', 'macro'),
      makeItem('tr1', 'Auto-assign trigger', 'trigger'),
      makeItem('v1', 'All open tickets', 'view'),
      makeItem('tf1', 'Priority field', 'ticket_field'),
      makeItem('t1', 'Real ticket', 'ticket'),
    ]
    const result = await adapter.convert(items)
    // Only the ticket should be converted
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('support_ticket')
    // A batch warning about structural entities should be emitted
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('skipped')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ZendeskAdapter: status normalisation', () => {
  it("ticket status 'new' normalises to 'opened'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'New ticket', 'ticket', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('opened')
  })

  it("ticket status 'open' normalises to 'opened'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'Open ticket', 'ticket', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('opened')
  })

  it("ticket status 'pending' normalises to 'triaged'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'Pending ticket', 'ticket', { status: 'pending' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('triaged')
  })

  it("ticket status 'hold' normalises to 'in_progress'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'On hold', 'ticket', { status: 'hold' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('in_progress')
  })

  it("ticket status 'solved' normalises to 'resolved'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'Solved ticket', 'ticket', { status: 'solved' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('resolved')
  })

  it("ticket status 'closed' normalises to 'closed'", async () => {
    const items: SourceItem[] = [makeItem('t1', 'Closed ticket', 'ticket', { status: 'closed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('closed')
  })
})

// ─── Satisfaction score preservation ─────────────────────────────────────────

describe('ZendeskAdapter: satisfaction_score preservation', () => {
  it('satisfaction_score good is preserved under properties on customer_feedback node', async () => {
    const items: SourceItem[] = [
      makeItem('csat1', 'CSAT rating', 'satisfaction_rating', {
        satisfaction_score: 'good',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    const props = node.properties as Record<string, unknown> | undefined
    expect(props?.satisfaction_score).toBe('good')
    expect(node.satisfaction_score).toBeUndefined()
  })

  it('satisfaction_score bad is preserved under properties on customer_feedback node', async () => {
    const items: SourceItem[] = [
      makeItem('csat1', 'CSAT rating', 'satisfaction_rating', {
        satisfaction_score: 'bad',
      }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    const props = node.properties as Record<string, unknown> | undefined
    expect(props?.satisfaction_score).toBe('bad')
    expect(node.satisfaction_score).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('ZendeskAdapter: edge emission', () => {
  it('node_owned_by_team emitted when entity has group parent', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Enterprise Support', 'group'),
      makeItem('t1', 'Cannot login', 'ticket', {
        parent_id: 'g1',
        parent_type: 'group',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_owned_by_team')
    const edge = result.edges.find((e) => e.type === 'node_owned_by_team')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('node_informs_node emitted for ticket with organization_id link', async () => {
    const items: SourceItem[] = [
      makeItem('org1', 'Acme Corp', 'organization'),
      makeItem('t1', 'Billing issue', 'ticket', { organization_id: 'org1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ticket org link')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
  })

  it('warning emitted when parent_id not found in imported set', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'Orphaned ticket', 'ticket', {
        parent_id: 'missing-parent',
        parent_type: 'group',
      }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('missing-parent')
    expect(warnText).toContain('Edge skipped')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('g1', 'Enterprise Support', 'group'),
      makeItem('org1', 'Acme Corp', 'organization'),
      makeItem('t1', 'Cannot login', 'ticket', {
        parent_id: 'g1',
        parent_type: 'group',
        organization_id: 'org1',
        status: 'open',
      }),
      makeItem('csat1', 'CSAT for ticket', 'satisfaction_rating', {
        satisfaction_score: 'bad',
        parent_id: 't1',
        parent_type: 'ticket',
      }),
      makeItem('a1', 'Login troubleshooting guide', 'article'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ZendeskAdapter full fixture')
    expect(result.nodes.length).toBeGreaterThanOrEqual(4)
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('ZendeskAdapter: tags', () => {
  it('tags from metadata are preserved on the node', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'Tagged ticket', 'ticket', {
        tags: ['enterprise', 'urgent', 'billing'],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['enterprise', 'urgent', 'billing'])
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('ZendeskAdapter: source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeItem('t1', 'Ticket', 'ticket'),
      makeItem('org1', 'Org', 'organization'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['t1']).toBeDefined()
    expect(result.source_map['org1']).toBeDefined()
  })

  it('skipped section is NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('sec1', 'Getting Started', 'section')]
    const result = await adapter.convert(items)
    expect(result.source_map['sec1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('ZendeskAdapter: external_tool and external_id', () => {
  it('external_tool is always zendesk', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Ticket', 'ticket')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('zendesk')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('zdsk-9999', 'Ticket', 'ticket')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('zdsk-9999')
  })
})
