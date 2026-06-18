/**
 * HubSpot end-to-end import audit (convert-only adapter).
 *
 * HubSpot's list() requires a live API; convert() is the whole import story.
 * Representative CRM records run through convert -> writeToUPGFile -> reload,
 * then conformanceIssues() asserts the result is spec-clean: valid entity
 * types, valid per-type lifecycle statuses, no off-schema fields, catalogued
 * edges with correct endpoint types, clean round-trip.
 *
 * Fixture grounded in HubSpot's public CRM API objects:
 *   GET /crm/v3/objects/companies | contacts | deals | tickets
 *       /feedback_submissions | notes ; GET /crm/v3/lists
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { HubSpotAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new HubSpotAdapter() as unknown as AdapterLike

/**
 * company -> contact (account -> participant: no canonical edge -> node_informs_node)
 * company -> deal    (account_negotiates_deal)
 * feedback_submission standalone (customer_feedback)
 * ticket standalone (support_ticket)
 * note standalone (observation, lifecycle-free -> no status)
 * list standalone (market_segment, lifecycle-free -> no status)
 * meeting -> skipped
 */
const ITEMS = [
  {
    source_id: 'co1',
    source_type: 'crm_object',
    title: 'TechCorp Inc',
    metadata: { entity_type: 'company' },
  },
  {
    source_id: 'ct1',
    source_type: 'crm_object',
    title: 'Sarah Chen',
    metadata: {
      entity_type: 'contact',
      parent_id: 'co1',
      parent_type: 'company',
      lifecycle_stage: 'customer',
      tags: ['enterprise', 'champion'],
    },
  },
  {
    source_id: 'd1',
    source_type: 'crm_object',
    title: 'TechCorp Enterprise Renewal',
    metadata: {
      entity_type: 'deal',
      parent_id: 'co1',
      parent_type: 'company',
      deal_stage: 'negotiation',
      amount: 84000,
      mrr: 7000,
    },
  },
  {
    source_id: 't1',
    source_type: 'crm_object',
    title: 'API rate limits blocking our workflow',
    content: 'Customer reports hitting rate limits on the /events endpoint at peak usage.',
    metadata: {
      entity_type: 'ticket',
      status: 'in_progress',
    },
  },
  {
    source_id: 'f1',
    source_type: 'crm_object',
    title: 'Dashboard export is too slow',
    content: 'NPS response: exporting CSV takes 30+ seconds for large datasets.',
    metadata: {
      entity_type: 'feedback_submission',
    },
  },
  {
    source_id: 'n1',
    source_type: 'crm_object',
    title: 'Call notes: churn risk flagged',
    content: 'Customer mentioned switching to competitor if bulk upload is not fixed by Q3.',
    metadata: {
      entity_type: 'note',
    },
  },
  {
    source_id: 'l1',
    source_type: 'crm_object',
    title: 'High-Value Accounts Q2',
    metadata: {
      entity_type: 'list',
    },
  },
  // Skipped type: should not appear as a node
  {
    source_id: 'mtg1',
    source_type: 'crm_object',
    title: 'Product demo call',
    metadata: { entity_type: 'meeting' },
  },
]

describe('HubSpot e2e — convert conformance', () => {
  it('produces a spec-conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps all CRM object types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const bySourceId = Object.fromEntries(
        out.result.nodes.map((n) => [n.source_id as string, n.type as string]),
      )
      expect(bySourceId['co1']).toBe('account')
      expect(bySourceId['ct1']).toBe('participant')
      expect(bySourceId['d1']).toBe('deal')
      expect(bySourceId['t1']).toBe('support_ticket')
      expect(bySourceId['f1']).toBe('customer_feedback')
      expect(bySourceId['n1']).toBe('observation')
      expect(bySourceId['l1']).toBe('market_segment')
      // Skipped types must not appear
      expect(bySourceId['mtg1']).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('deal amount and mrr survive the round-trip under properties', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const deal = out.rawDoc.nodes.find((n) => n.source_id === 'd1') as Record<string, unknown>
      expect(deal).toBeDefined()
      expect(deal.properties).toMatchObject({ amount: 84000, mrr: 7000 })
      // Must NOT be top-level (off-schema = lost on persist)
      expect(deal.amount).toBeUndefined()
      expect(deal.mrr).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('status for deal is a valid deal lifecycle phase', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const deal = out.rawDoc.nodes.find((n) => n.source_id === 'd1') as Record<string, unknown>
      // deal_stage: 'negotiation' -> phase 'negotiation'
      expect(deal.status).toBe('negotiation')
    } finally {
      await out.cleanup()
    }
  })

  it('status for support_ticket is a valid support_ticket lifecycle phase', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const ticket = out.rawDoc.nodes.find((n) => n.source_id === 't1') as Record<string, unknown>
      // status: 'in_progress' -> phase 'in_progress'
      expect(ticket.status).toBe('in_progress')
    } finally {
      await out.cleanup()
    }
  })

  it('lifecycle-free types carry no status even when metadata.status is set', async () => {
    const items = [
      {
        source_id: 'co_s',
        source_type: 'crm_object',
        title: 'Acme Corp',
        metadata: { entity_type: 'company', status: 'active' },
      },
      {
        source_id: 'ct_s',
        source_type: 'crm_object',
        title: 'Jane Smith',
        metadata: { entity_type: 'contact', status: 'open' },
      },
    ]
    const out = await runImportE2E({ adapter: adapter(), items })
    try {
      for (const n of out.rawDoc.nodes) {
        expect(n.status).toBeUndefined()
      }
    } finally {
      await out.cleanup()
    }
  })

  it('account_negotiates_deal edge is emitted with correct direction', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const edge = out.rawDoc.edges.find((e) => e.type === 'account_negotiates_deal') as Record<string, unknown> | undefined
      expect(edge).toBeDefined()
      const accountNode = out.rawDoc.nodes.find((n) => n.source_id === 'co1')
      const dealNode = out.rawDoc.nodes.find((n) => n.source_id === 'd1')
      expect(edge?.source).toBe(accountNode?.id)
      expect(edge?.target).toBe(dealNode?.id)
    } finally {
      await out.cleanup()
    }
  })

  it('account -> participant has no canonical edge, falls back to node_informs_node', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const accountNode = out.rawDoc.nodes.find((n) => n.source_id === 'co1')
      const contactNode = out.rawDoc.nodes.find((n) => n.source_id === 'ct1')
      const edge = out.rawDoc.edges.find(
        (e) => e.source === accountNode?.id && e.target === contactNode?.id,
      ) as Record<string, unknown> | undefined
      expect(edge).toBeDefined()
      expect(edge?.type).toBe('node_informs_node')
      // The old code emitted account_contains_contact pointing at a participant (wrong endpoint).
      expect(out.rawDoc.edges.find((e) => e.type === 'account_contains_contact')).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('deal maps to UPG deal, never opportunity', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const deal = out.result.nodes.find((n) => n.source_id === 'd1')
      expect(deal?.type).toBe('deal')
      expect(deal?.type).not.toBe('opportunity')
    } finally {
      await out.cleanup()
    }
  })

  it('skipped types emit warnings and are absent from the graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sourceIds = out.result.nodes.map((n) => n.source_id)
      expect(sourceIds).not.toContain('mtg1')
      const warnText = (out.result.warnings ?? []).join(' ')
      expect(warnText).toContain('meeting')
    } finally {
      await out.cleanup()
    }
  })
})
