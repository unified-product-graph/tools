/**
 * Intercom end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { IntercomAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new IntercomAdapter() as unknown as AdapterLike

/**
 * Fixture grounded in Intercom's public API shapes:
 * - Company  (Intercom Company object)
 * - Contact  (Intercom Contact with contact_company_id referencing co1)
 * - Conversation (support tag, status: open)
 * - Conversation (status: closed)
 * - Survey (NPS survey, references feature_request as parent)
 * - feature_request (pre-seeded pass-through, parent of survey)
 * - Team (Intercom Team; conversation is owned by this team)
 * - Article (Help Center article)
 * - Segment (Contact segment)
 */
const ITEMS = [
  {
    source_id: 'team1',
    source_type: 'intercom_entity',
    title: 'Support Team',
    metadata: { entity_type: 'team' },
  },
  {
    source_id: 'co1',
    source_type: 'intercom_entity',
    title: 'Acme Corp',
    metadata: { entity_type: 'company' },
  },
  {
    source_id: 'ct1',
    source_type: 'intercom_entity',
    title: 'Jane Smith',
    metadata: {
      entity_type: 'contact',
      contact_company_id: 'co1',
    },
  },
  {
    source_id: 'fr1',
    source_type: 'intercom_entity',
    title: 'Bulk CSV Export',
    metadata: { entity_type: 'feature_request', status: 'open' },
  },
  {
    source_id: 'conv1',
    source_type: 'intercom_entity',
    title: 'Dashboard fails to load after login',
    content: 'User reports blank screen after logging in.',
    metadata: {
      entity_type: 'conversation',
      status: 'open',
      conversation_rating: 3,
      parent_id: 'team1',
      parent_type: 'team',
    },
  },
  {
    source_id: 'conv2',
    source_type: 'intercom_entity',
    title: 'How do I change my plan?',
    metadata: {
      entity_type: 'conversation',
      status: 'closed',
    },
  },
  {
    source_id: 'sur1',
    source_type: 'intercom_entity',
    title: 'Q2 NPS Survey',
    metadata: {
      entity_type: 'survey',
      status: 'open',
      parent_id: 'fr1',
      parent_type: 'feature_request',
      tags: ['nps', 'q2'],
    },
  },
  {
    source_id: 'art1',
    source_type: 'intercom_entity',
    title: 'How to export your data',
    content: 'Step-by-step guide to exporting all your data from the app.',
    metadata: { entity_type: 'article', status: 'closed' },
  },
  {
    source_id: 'seg1',
    source_type: 'intercom_entity',
    title: 'Enterprise Customers',
    metadata: { entity_type: 'segment' },
  },
]

describe('Intercom e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, no off-schema fields)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps entity types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(t.team1).toBe('team')
      expect(t.co1).toBe('account')
      expect(t.ct1).toBe('participant')
      expect(t.fr1).toBe('feature_request')
      expect(t.conv1).toBe('support_ticket')
      expect(t.conv2).toBe('support_ticket')
      expect(t.sur1).toBe('customer_feedback')
      expect(t.art1).toBe('document')
      expect(t.seg1).toBe('market_segment')
    } finally {
      await out.cleanup()
    }
  })

  it('resolves statuses to valid lifecycle phase ids per type', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n]))
      // support_ticket: open -> open
      expect(byId.conv1.status).toBe('open')
      // support_ticket: closed -> closed
      expect(byId.conv2.status).toBe('closed')
      // customer_feedback (folded onto INCIDENT): open -> open
      expect(byId.sur1.status).toBe('open')
      // document: closed -> archived
      expect(byId.art1.status).toBe('archived')
      // team, account, market_segment are lifecycle-free -> no status
      expect(byId.team1.status).toBeUndefined()
      expect(byId.co1.status).toBeUndefined()
      expect(byId.seg1.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('preserves conversation_rating under properties (survives round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const conv1 = out.rawDoc.nodes.find((n) => n.source_id === 'conv1') as Record<string, unknown>
      expect(conv1.properties).toMatchObject({ conversation_rating: 3 })
      expect(conv1.conversation_rating).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits customer_feedback_becomes_feature_request with correct endpoints (customer_feedback -> feature_request)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const cfEdges = out.result.edges.filter((e) => e.type === 'customer_feedback_becomes_feature_request')
      expect(cfEdges.length).toBe(1)
      const nodeById = Object.fromEntries(out.result.nodes.map((n) => [n.id as string, n]))
      const e = cfEdges[0]
      expect(nodeById[e.source as string]?.type).toBe('customer_feedback')
      expect(nodeById[e.target as string]?.type).toBe('feature_request')
    } finally {
      await out.cleanup()
    }
  })

  it('emits node_owned_by_team with correct endpoints (owned-entity -> team)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const ownershipEdges = out.result.edges.filter((e) => e.type === 'node_owned_by_team')
      expect(ownershipEdges.length).toBeGreaterThan(0)
      const nodeById = Object.fromEntries(out.result.nodes.map((n) => [n.id as string, n]))
      for (const e of ownershipEdges) {
        // target must be the team node
        expect(nodeById[e.target as string]?.type).toBe('team')
        // source must not be team (that would be reversed)
        expect(nodeById[e.source as string]?.type).not.toBe('team')
      }
    } finally {
      await out.cleanup()
    }
  })
})
