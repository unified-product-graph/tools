/**
 * Salesforce Adapter Tests
 *
 * Covers all object type mappings, edge emission from parent/child relationships,
 * status normalisation, the CRITICAL Opportunity→`deal` (NOT `opportunity`) mapping
 * with its batch warning, and general warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { SalesforceAdapter } from '../adapters/salesforce.js'
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
    source_type: 'sfdc_object',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new SalesforceAdapter()

// ─── Type mapping ─────────────────────────────────────────────────────────────

describe('SalesforceAdapter: object type → entity type mapping', () => {
  it('account maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeObject('a1', 'Acme Corp', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('salesforce')
  })

  it('contact maps to participant with confidence high', async () => {
    const items: SourceItem[] = [makeObject('c1', 'Jane Smith', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('lead maps to participant with confidence high', async () => {
    const items: SourceItem[] = [makeObject('l1', 'Prospect Inc', 'lead')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('case maps to support_ticket with confidence high', async () => {
    const items: SourceItem[] = [makeObject('ca1', 'Cannot export data', 'case')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('support_ticket')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('task maps to task with confidence medium', async () => {
    const items: SourceItem[] = [makeObject('t1', 'Follow up call', 'task')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
  })

  it('note maps to observation', async () => {
    const items: SourceItem[] = [makeObject('n1', 'Mentioned budget concerns', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
  })

  it('knowledge__kav maps to document', async () => {
    const items: SourceItem[] = [makeObject('k1', 'How to export data', 'knowledge__kav')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
  })

  it('idea maps to feature_request', async () => {
    const items: SourceItem[] = [makeObject('i1', 'Add bulk export', 'idea')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_request')
  })
})

// ─── CRITICAL: Opportunity name collision ─────────────────────────────────────

describe('SalesforceAdapter: CRITICAL Opportunity name collision', () => {
  it('opportunity maps to UPG `deal`, NOT `opportunity`', async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Acme Corp, Enterprise Q2', 'opportunity', {
        stage: 'Qualification',
        amount: 80000,
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    // MUST be `deal`, never `opportunity`
    expect(result.nodes[0].type).toBe('deal')
    expect(result.nodes[0].type).not.toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('batch warning is emitted once with the opportunity count', async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Deal One', 'opportunity'),
      makeObject('op2', 'Deal Two', 'opportunity'),
      makeObject('op3', 'Deal Three', 'opportunity'),
      makeObject('a1', 'Acme Corp', 'account'), // should not affect the count
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join('\n') ?? ''
    // Warning should mention the count (3)
    expect(warnText).toContain('3 Salesforce Opportunity')
    // Warning should mention both entity names
    expect(warnText).toContain('deal')
    expect(warnText).toContain('opportunity')
    expect(warnText).toContain('fundamentally different')
  })

  it('single opportunity still emits the batch warning', async () => {
    const items: SourceItem[] = [makeObject('op1', 'Solo Deal', 'opportunity')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join('\n') ?? ''
    expect(warnText).toContain('1 Salesforce Opportunity')
    expect(warnText).toContain('sales deal')
    expect(warnText).toContain('user problem')
  })

  it('no opportunity warning when there are no opportunity objects', async () => {
    const items: SourceItem[] = [
      makeObject('a1', 'Acme Corp', 'account'),
      makeObject('c1', 'Jane Smith', 'contact'),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join('\n') ?? ''
    expect(warnText).not.toContain('Salesforce Opportunity record')
  })

  it('opportunity amount is preserved on deal node', async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Big Deal', 'opportunity', { amount: 250000 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.amount).toBe(250000)
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('SalesforceAdapter: skipped types with warnings', () => {
  it('campaign is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeObject('cam1', 'Q2 Email Campaign', 'campaign'),
      makeObject('a1', 'Acme Corp', 'account'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('account')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('campaign')
  })

  it('event (calendar) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('ev1', 'Demo call', 'event')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('event')
  })

  it('contract is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('con1', 'MSA 2026', 'contract')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('product (catalog) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeObject('p1', 'Enterprise License', 'product')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('SalesforceAdapter: status normalisation', () => {
  it("case status 'new' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeObject('ca1', 'New case', 'case', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("case status 'open' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeObject('ca1', 'Open case', 'case', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("case status 'closed' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeObject('ca1', 'Closed case', 'case', { status: 'closed' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("opportunity stage 'Prospecting' normalises to 'draft'", async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Early stage', 'opportunity', { stage: 'Prospecting' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("opportunity stage 'Closed Won' normalises to 'complete'", async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Won deal', 'opportunity', { stage: 'Closed Won' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("opportunity stage 'Closed Lost' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [
      makeObject('op1', 'Lost deal', 'opportunity', { stage: 'Closed Lost' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('SalesforceAdapter: edge emission', () => {
  it('account_contains_contact emitted when contact has account parent', async () => {
    const items: SourceItem[] = [
      makeObject('a1', 'Acme Corp', 'account'),
      makeObject('c1', 'Jane Smith', 'contact', {
        parent_id: 'a1',
        parent_type: 'account',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'account_contains_contact')
    const edge = result.edges.find((e) => e.type === 'account_contains_contact')
    expect(edge).toBeDefined()
  })

  it('account_negotiates_deal emitted when opportunity has account parent', async () => {
    const items: SourceItem[] = [
      makeObject('a1', 'Acme Corp', 'account'),
      makeObject('op1', 'Enterprise Q2', 'opportunity', {
        parent_id: 'a1',
        parent_type: 'account',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'account_negotiates_deal')
    const edge = result.edges.find((e) => e.type === 'account_negotiates_deal')
    expect(edge).toBeDefined()
  })

  it('lead_becomes_account emitted when account has lead parent', async () => {
    const items: SourceItem[] = [
      makeObject('l1', 'Prospect Inc', 'lead'),
      makeObject('a1', 'Acme Corp', 'account', {
        parent_id: 'l1',
        parent_type: 'lead',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'lead_becomes_account')
    const edge = result.edges.find((e) => e.type === 'lead_becomes_account')
    expect(edge).toBeDefined()
  })

  it('customer_feedback_becomes_feature_request emitted when idea has case parent', async () => {
    const items: SourceItem[] = [
      makeObject('ca1', 'Export bug ticket', 'case'),
      makeObject('i1', 'Add CSV export', 'idea', {
        parent_id: 'ca1',
        parent_type: 'case',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'customer_feedback_becomes_feature_request')
    const edge = result.edges.find((e) => e.type === 'customer_feedback_becomes_feature_request')
    expect(edge).toBeDefined()
  })

  it('node_informs_node fallback for unrecognised pairs', async () => {
    const items: SourceItem[] = [
      makeObject('n1', 'CSM note', 'note'),
      makeObject('a1', 'Acme Corp', 'account', {
        parent_id: 'n1',
        parent_type: 'note',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_informs_node fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('assertAllEdgesCatalogued: full fixture test', async () => {
    const items: SourceItem[] = [
      makeObject('a1', 'Acme Corp', 'account'),
      makeObject('c1', 'Jane Smith', 'contact', { parent_id: 'a1', parent_type: 'account' }),
      makeObject('l1', 'Prospect Inc', 'lead'),
      makeObject('a2', 'Prospect Corp', 'account', { parent_id: 'l1', parent_type: 'lead' }),
      makeObject('op1', 'Enterprise Deal', 'opportunity', {
        parent_id: 'a1',
        parent_type: 'account',
        amount: 100000,
        stage: 'Qualification',
      }),
      makeObject('ca1', 'Support case', 'case', { status: 'open' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'SalesforceAdapter full fixture')
    // account→contact, account→deal, lead→account edges
    expect(result.edges.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('SalesforceAdapter: source_map', () => {
  it('source_map contains an entry for each converted object', async () => {
    const items: SourceItem[] = [
      makeObject('a1', 'Acme Corp', 'account'),
      makeObject('op1', 'Big Deal', 'opportunity'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['a1']).toBeDefined()
    expect(result.source_map['op1']).toBeDefined()
  })

  it('skipped objects are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeObject('cam1', 'Campaign', 'campaign')]
    const result = await adapter.convert(items)
    expect(result.source_map['cam1']).toBeUndefined()
  })
})

// ─── external_tool / external_id ──────────────────────────────────────────────

describe('SalesforceAdapter: external_tool and external_id', () => {
  it('external_tool is always salesforce', async () => {
    const items: SourceItem[] = [makeObject('a1', 'Acme', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('salesforce')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeObject('sfdc-001XXXXXX', 'Acme', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('sfdc-001XXXXXX')
  })
})
