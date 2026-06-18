/**
 * Salesforce end-to-end import audit (convert-only adapter).
 *
 * Salesforce's list() requires OAuth; convert() is the whole import story.
 * Representative CRM records (Account, Contact, Lead, Opportunity, Case, Idea)
 * run through convert -> writeToUPGFile -> reload, then conformanceIssues()
 * asserts the result is spec-clean.
 *
 * CRITICAL: Salesforce Opportunity -> UPG `deal`, NOT `opportunity`.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { SalesforceAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new SalesforceAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'acc1', source_type: 'sfdc_object', title: 'GlobalBank Ltd', metadata: { entity_type: 'account' } },
  {
    source_id: 'con1',
    source_type: 'sfdc_object',
    title: 'John Doe',
    metadata: { entity_type: 'contact', parent_id: 'acc1', parent_type: 'account' },
  },
  { source_id: 'lead1', source_type: 'sfdc_object', title: 'Prospect Co', metadata: { entity_type: 'lead' } },
  {
    source_id: 'opp1',
    source_type: 'sfdc_object',
    title: 'GlobalBank Enterprise Expansion',
    metadata: { entity_type: 'opportunity', parent_id: 'acc1', parent_type: 'account', stage: 'Negotiation', amount: 250000 },
  },
  {
    source_id: 'case1',
    source_type: 'sfdc_object',
    title: 'Integration error on quarterly report',
    content: 'API call fails with 500 error when running quarterly revenue report after midnight batch.',
    metadata: { entity_type: 'case', parent_id: 'acc1', parent_type: 'account', status: 'Working' },
  },
  {
    source_id: 'idea1',
    source_type: 'sfdc_object',
    title: 'Bulk CSV export for reports',
    content: 'Customers repeatedly request the ability to export any report as a CSV in one click.',
    metadata: { entity_type: 'idea', parent_id: 'case1', parent_type: 'case' },
  },
  { source_id: 'cam1', source_type: 'sfdc_object', title: 'Q3 Email Blast', metadata: { entity_type: 'campaign' } },
]

describe('Salesforce e2e — convert conformance', () => {
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
      const bySourceId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type as string]))
      expect(bySourceId['acc1']).toBe('account')
      expect(bySourceId['con1']).toBe('participant')
      expect(bySourceId['lead1']).toBe('participant')
      expect(bySourceId['opp1']).toBe('deal') // CRITICAL: NOT 'opportunity'
      expect(bySourceId['case1']).toBe('support_ticket')
      expect(bySourceId['idea1']).toBe('feature_request')
      expect(bySourceId['cam1']).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('CRITICAL: Opportunity maps to deal, never opportunity', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const opp = out.result.nodes.find((n) => n.source_id === 'opp1')
      expect(opp?.type).toBe('deal')
      expect(opp?.type).not.toBe('opportunity')
    } finally {
      await out.cleanup()
    }
  })

  it('deal amount survives round-trip under properties, never top-level', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const deal = out.rawDoc.nodes.find((n) => n.source_id === 'opp1') as Record<string, unknown>
      expect(deal.properties).toMatchObject({ amount: 250000 })
      expect(deal.amount).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('status for deal is a valid deal lifecycle phase', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const deal = out.rawDoc.nodes.find((n) => n.source_id === 'opp1') as Record<string, unknown>
      expect(deal.status).toBe('negotiation')
    } finally {
      await out.cleanup()
    }
  })

  it('status for support_ticket is a valid support_ticket lifecycle phase', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const ticket = out.rawDoc.nodes.find((n) => n.source_id === 'case1') as Record<string, unknown>
      expect(ticket.status).toBe('in_progress')
    } finally {
      await out.cleanup()
    }
  })

  it('lifecycle-free types carry no status even when metadata.status is set', async () => {
    const items = [
      { source_id: 'acc_s', source_type: 'sfdc_object', title: 'Acme Corp', metadata: { entity_type: 'account', status: 'active' } },
      { source_id: 'con_s', source_type: 'sfdc_object', title: 'Jane Smith', metadata: { entity_type: 'contact', status: 'open' } },
      { source_id: 'lead_s', source_type: 'sfdc_object', title: 'Prospect Inc', metadata: { entity_type: 'lead', status: 'working' } },
    ]
    const out = await runImportE2E({ adapter: adapter(), items })
    try {
      for (const n of out.rawDoc.nodes) {
        expect(n.status, `lifecycle-free type "${n.type}" should not have status`).toBeUndefined()
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
      const accountNode = out.rawDoc.nodes.find((n) => n.source_id === 'acc1')
      const dealNode = out.rawDoc.nodes.find((n) => n.source_id === 'opp1')
      expect(edge?.source).toBe(accountNode?.id)
      expect(edge?.target).toBe(dealNode?.id)
    } finally {
      await out.cleanup()
    }
  })

  it('account -> participant has no canonical edge, falls back to node_informs_node', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const accountNode = out.rawDoc.nodes.find((n) => n.source_id === 'acc1')
      const contactNode = out.rawDoc.nodes.find((n) => n.source_id === 'con1')
      const edge = out.rawDoc.edges.find(
        (e) => e.source === accountNode?.id && e.target === contactNode?.id,
      ) as Record<string, unknown> | undefined
      expect(edge).toBeDefined()
      expect(edge?.type).toBe('node_informs_node')
      expect(out.rawDoc.edges.find((e) => e.type === 'account_contains_contact')).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('support_ticket -> feature_request has no canonical edge, falls back to node_informs_node', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const caseNode = out.rawDoc.nodes.find((n) => n.source_id === 'case1')
      const ideaNode = out.rawDoc.nodes.find((n) => n.source_id === 'idea1')
      const edge = out.rawDoc.edges.find(
        (e) =>
          (e.source === caseNode?.id && e.target === ideaNode?.id) ||
          (e.source === ideaNode?.id && e.target === caseNode?.id),
      ) as Record<string, unknown> | undefined
      expect(edge).toBeDefined()
      expect(edge?.type).toBe('node_informs_node')
      expect(out.rawDoc.edges.find((e) => e.type === 'customer_feedback_becomes_feature_request')).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('skipped types emit warnings and are absent from the graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sourceIds = out.result.nodes.map((n) => n.source_id)
      expect(sourceIds).not.toContain('cam1')
      const warnText = (out.result.warnings ?? []).join(' ')
      expect(warnText).toContain('campaign')
    } finally {
      await out.cleanup()
    }
  })

  it('Opportunity batch warning is emitted', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const warnText = (out.result.warnings ?? []).join('\n')
      expect(warnText).toContain('Salesforce Opportunity')
      expect(warnText).toContain('deal')
    } finally {
      await out.cleanup()
    }
  })
})
