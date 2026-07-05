/**
 * HubSpot Adapter Tests
 *
 * Covers all object type mappings, edge emission from parent/child relationships,
 * status normalisation, the CRITICAL deal→`deal` (not `opportunity`) mapping,
 * and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { HubSpotAdapter } from '../adapters/hubspot.js'
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

function makeObject(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'crm_object',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new HubSpotAdapter()

// ─── Type mapping ─────────────────────────────────────────────────────────────

describe('HubSpotAdapter: object type → entity type mapping', () => {
  it('contact maps to participant with confidence high', async () => {
    const items: SourceItem[] = [makeObject('c1', 'Jane Smith', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('hubspot')
  })

  it('company maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeObject('co1', 'Acme Corp', 'company')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('ticket maps to support_ticket with confidence high', async () => {
    const items: SourceItem[] = [makeObject('t1', 'Login button broken', 'ticket')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('support_ticket')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('feedback_submission maps to customer_feedback with confidence medium', async () => {
    const items: SourceItem[] = [makeObject('f1', 'Love the dashboard', 'feedback_submission')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('note maps to observation', async () => {
    const items: SourceItem[] = [makeObject('n1', 'Customer mentioned churn risk', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('task maps to task with confidence high', async () => {
    const items: SourceItem[] = [makeObject('tk1', 'Follow up with demo', 'task')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('list maps to market_segment with confidence medium', async () => {
    const items: SourceItem[] = [makeObject('l1', 'High-value customers Q2', 'list')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('market_segment')
  })
})

// ─── CRITICAL: Deal name collision ───────────────────────────────────────────

describe('HubSpotAdapter: CRITICAL deal mapping', () => {
  it('deal maps to UPG `deal`, NOT `opportunity`', async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Acme Corp Enterprise Deal', 'deal', { amount: 50000 }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    // MUST be `deal`, never `opportunity`
    expect(result.nodes[0].type).toBe('deal')
    expect(result.nodes[0].type).not.toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('deal import emits the mandatory name collision warning', async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Enterprise Expansion Q2', 'deal'),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('deal')
    expect(warnText).toContain('opportunity')
    expect(warnText).toContain('different concepts')
  })

  it('deal amount is preserved under properties (not top-level)', async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Big Deal', 'deal', { amount: 125000 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect((node.properties as Record<string, unknown>).amount).toBe(125000)
    expect(node.amount).toBeUndefined()
  })

  it('multiple deals each emit a warning', async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Deal One', 'deal'),
      makeObject('d2', 'Deal Two', 'deal'),
    ]
    const result = await adapter.convert(items)
    // Both nodes map to `deal`
    expect(result.nodes.every((n) => n.type === 'deal')).toBe(true)
    // Both warnings should mention the deal names
    const warnText = result.warnings?.join('\n') ?? ''
    expect(warnText).toContain('Deal One')
    expect(warnText).toContain('Deal Two')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('HubSpotAdapter: skipped types with warnings', () => {
  it('meeting is skipped and a warning is emitted', async () => {
    const items: SourceItem[] = [
      makeObject('m1', 'Product demo call', 'meeting'),
      makeObject('c1', 'Jane Smith', 'contact'),
    ]
    const result = await adapter.convert(items)
    // Only the contact should be in nodes
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('participant')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('meeting')
    expect(warnText).toContain('no UPG equivalent')
  })

  it('call is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('call1', 'Discovery call', 'call')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('call')
  })

  it('email activity is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('e1', 'Sent intro email', 'email')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('email')
  })

  it('product (CRM) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('p1', 'Enterprise Plan', 'product')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('form is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('form1', 'Contact form', 'form')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('HubSpotAdapter: status normalisation', () => {
  it("ticket status 'new' normalises to 'open'", async () => {
    const items: SourceItem[] = [makeObject('t1', 'New ticket', 'ticket', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('open')
  })

  it("ticket status 'open' normalises to 'open'", async () => {
    const items: SourceItem[] = [makeObject('t1', 'Open ticket', 'ticket', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('open')
  })

  it("ticket status 'in_progress' stays 'in_progress' (valid support_ticket phase)", async () => {
    const items: SourceItem[] = [
      makeObject('t1', 'In progress ticket', 'ticket', { status: 'in_progress' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('in_progress')
  })

  it("deal_stage 'closed_won' stays 'closed_won' (valid deal phase)", async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Won deal', 'deal', { deal_stage: 'closed_won' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('closed_won')
  })

  it("deal_stage 'closed_lost' stays 'closed_lost' (valid deal phase)", async () => {
    const items: SourceItem[] = [
      makeObject('d1', 'Lost deal', 'deal', { deal_stage: 'closed_lost' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('closed_lost')
  })

  it("ticket status 'deferred' is omitted (not a valid support_ticket phase)", async () => {
    // 'deferred' maps to the deal phase 'closed_lost', invalid for support_ticket → dropped
    const items: SourceItem[] = [
      makeObject('t1', 'Deferred ticket', 'ticket', { status: 'deferred' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it('lifecycle-free types (account, participant) carry no status even with metadata.status set', async () => {
    const company = makeObject('co1', 'Acme Corp', 'company', { status: 'active' })
    const contact = makeObject('ct1', 'Jane Smith', 'contact', { status: 'open' })
    const result = await adapter.convert([company, contact])
    expect(result.nodes[0].status).toBeUndefined()
    expect(result.nodes[1].status).toBeUndefined()
  })
})

// ─── Tags and lifecycle_stage ─────────────────────────────────────────────────

describe('HubSpotAdapter: tags and lifecycle stage', () => {
  it('tags from metadata are applied to node', async () => {
    const items: SourceItem[] = [
      makeObject('c1', 'Jane Smith', 'contact', { tags: ['vip', 'enterprise'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('vip')
    expect(result.nodes[0].tags).toContain('enterprise')
  })

  it('lifecycle_stage is preserved as a tag', async () => {
    const items: SourceItem[] = [
      makeObject('c1', 'Jane Smith', 'contact', { lifecycle_stage: 'mql' }),
    ]
    const result = await adapter.convert(items)
    const tags = result.nodes[0].tags ?? []
    expect(tags.some((t) => t.includes('lifecycle') && t.includes('mql'))).toBe(true)
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('HubSpotAdapter: edge emission', () => {
  it('company->contact (account->participant) has no canonical edge, emits node_informs_node', async () => {
    // HubSpot contact maps to UPG participant; account->participant is uncatalogued,
    // so the resolver emits a generic node_informs_node link (source=account).
    const items: SourceItem[] = [
      makeObject('co1', 'Acme Corp', 'company'),
      makeObject('c1', 'Jane Smith', 'contact', {
        parent_id: 'co1',
        parent_type: 'company',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'account->participant fallback')
    const edge = result.edges.find((e) => e.source === result.source_map['co1'])
    expect(edge).toBeDefined()
    expect(edge?.type).toBe('node_informs_node')
    // The old code wrongly emitted account_contains_contact pointing at a participant.
    expect(result.edges.find((e) => e.type === 'account_contains_contact')).toBeUndefined()
  })

  it('account_negotiates_deal emitted when deal has company parent', async () => {
    const items: SourceItem[] = [
      makeObject('co1', 'Acme Corp', 'company'),
      makeObject('d1', 'Enterprise Deal', 'deal', {
        parent_id: 'co1',
        parent_type: 'company',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'account_negotiates_deal')
    const edge = result.edges.find((e) => e.type === 'account_negotiates_deal')
    expect(edge).toBeDefined()
  })

  it('node_informs_node fallback emitted for unrecognised parent/child pair', async () => {
    const items: SourceItem[] = [
      makeObject('l1', 'VIP Segment', 'list'),
      makeObject('c1', 'Jane Smith', 'contact', {
        parent_id: 'l1',
        parent_type: 'list',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_informs_node fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('missing parent_id emits a warning and no edge', async () => {
    const items: SourceItem[] = [
      makeObject('c1', 'Jane Smith', 'contact', {
        parent_id: 'nonexistent-99',
        parent_type: 'company',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent-99')
  })

  it('assertAllEdgesCatalogued: full fixture test', async () => {
    const items: SourceItem[] = [
      makeObject('co1', 'Acme Corp', 'company'),
      makeObject('c1', 'Jane Smith', 'contact', { parent_id: 'co1', parent_type: 'company' }),
      makeObject('d1', 'Enterprise Deal', 'deal', {
        parent_id: 'co1',
        parent_type: 'company',
        amount: 50000,
      }),
      makeObject('t1', 'Support request', 'ticket', { status: 'open' }),
      makeObject('f1', 'Love the product', 'feedback_submission'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'HubSpotAdapter full fixture')
    // company→contact and company→deal edges emitted
    expect(result.edges.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('HubSpotAdapter: source_map', () => {
  it('source_map contains an entry for each converted object', async () => {
    const items: SourceItem[] = [
      makeObject('co1', 'Acme Corp', 'company'),
      makeObject('c1', 'Jane Smith', 'contact'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['co1']).toBeDefined()
    expect(result.source_map['c1']).toBeDefined()
  })

  it('skipped objects are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeObject('m1', 'Meeting', 'meeting')]
    const result = await adapter.convert(items)
    expect(result.source_map['m1']).toBeUndefined()
  })
})

// ─── external_tool / external_id ──────────────────────────────────────────────

describe('HubSpotAdapter: external_tool and external_id', () => {
  it('external_tool is always hubspot', async () => {
    const items: SourceItem[] = [makeObject('c1', 'Jane', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('hubspot')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeObject('hs-99999', 'Jane', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('hs-99999')
  })
})
