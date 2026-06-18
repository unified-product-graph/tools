/**
 * Zendesk end-to-end import audit (convert-only adapter).
 *
 * convert() is the whole import story (list() needs a live API), so spec
 * conformance is the audit: valid types, valid per-type statuses, no off-schema
 * fields, and edges whose type AND endpoint types match the catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ZendeskAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new ZendeskAdapter() as unknown as AdapterLike

/**
 * Fixture grounded in Zendesk's public API shapes:
 * - Organization, User, Group (agent group)
 * - Ticket (open, owned by group, linked to organization)
 * - Ticket (closed)
 * - Satisfaction Rating (CSAT, child of ticket)
 * - Article (Help Center), Post (community feature request)
 * - Section (structural, skipped)
 */
const ITEMS = [
  { source_id: 'grp1', source_type: 'zendesk_entity', title: 'Enterprise Support', metadata: { entity_type: 'group' } },
  { source_id: 'org1', source_type: 'zendesk_entity', title: 'Acme Corp', metadata: { entity_type: 'organization' } },
  { source_id: 'usr1', source_type: 'zendesk_entity', title: 'Jane Smith', metadata: { entity_type: 'user' } },
  {
    source_id: 'tkt1',
    source_type: 'zendesk_entity',
    title: 'API rate limits breaking nightly sync',
    content: 'Our nightly sync job is being throttled and fails after 10 minutes.',
    metadata: {
      entity_type: 'ticket',
      status: 'open',
      organization_id: 'org1',
      parent_id: 'grp1',
      parent_type: 'group',
      tags: ['enterprise', 'api', 'rate-limit'],
    },
  },
  { source_id: 'tkt2', source_type: 'zendesk_entity', title: 'Cannot access billing page', metadata: { entity_type: 'ticket', status: 'closed' } },
  {
    source_id: 'csat1',
    source_type: 'zendesk_entity',
    title: 'CSAT: bad - waited 3 days for a response',
    metadata: {
      entity_type: 'satisfaction_rating',
      satisfaction_score: 'bad',
      parent_id: 'tkt1',
      parent_type: 'ticket',
    },
  },
  {
    source_id: 'art1',
    source_type: 'zendesk_entity',
    title: 'How to configure API rate limits',
    content: 'Step-by-step guide for configuring your API rate limit tier.',
    metadata: { entity_type: 'article' },
  },
  {
    source_id: 'post1',
    source_type: 'zendesk_entity',
    title: 'Allow custom rate limit tiers for enterprise accounts',
    metadata: { entity_type: 'post', tags: ['enterprise', 'api'] },
  },
  { source_id: 'sec1', source_type: 'zendesk_entity', title: 'Getting Started', metadata: { entity_type: 'section' } },
]

describe('Zendesk e2e — convert conformance', () => {
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
      expect(t.grp1).toBe('team')
      expect(t.org1).toBe('account')
      expect(t.usr1).toBe('participant')
      expect(t.tkt1).toBe('support_ticket')
      expect(t.tkt2).toBe('support_ticket')
      expect(t.csat1).toBe('customer_feedback')
      expect(t.art1).toBe('document')
      expect(t.post1).toBe('customer_feedback')
      expect(t.sec1).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('resolves statuses to valid lifecycle phase ids per type', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n]))
      expect(byId.tkt1.status).toBe('opened')
      expect(byId.tkt2.status).toBe('closed')
      // team, account, participant are lifecycle-free -> no status
      expect(byId.grp1.status).toBeUndefined()
      expect(byId.org1.status).toBeUndefined()
      expect(byId.usr1.status).toBeUndefined()
      expect(byId.csat1.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('preserves satisfaction_score under properties (survives round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const csat1 = out.rawDoc.nodes.find((n) => n.source_id === 'csat1') as Record<string, unknown>
      expect(csat1.properties).toMatchObject({ satisfaction_score: 'bad' })
      expect(csat1.satisfaction_score).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits node_owned_by_team with correct endpoints (owned-entity source, team target)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const ownershipEdges = out.result.edges.filter((e) => e.type === 'node_owned_by_team')
      expect(ownershipEdges.length).toBeGreaterThan(0)
      const nodeById = Object.fromEntries(out.result.nodes.map((n) => [n.id as string, n]))
      for (const e of ownershipEdges) {
        expect(nodeById[e.target as string]?.type).toBe('team')
        expect(nodeById[e.source as string]?.type).not.toBe('team')
      }
    } finally {
      await out.cleanup()
    }
  })

  it('emits node_informs_node for ticket -> organization link', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const orgEdges = out.result.edges.filter((e) => e.type === 'node_informs_node')
      expect(orgEdges.length).toBeGreaterThan(0)
    } finally {
      await out.cleanup()
    }
  })

  it('skips section (structural) and counts it in the structural warning', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const nodeIds = out.result.nodes.map((n) => n.source_id)
      expect(nodeIds).not.toContain('sec1')
      const warnText = (out.result.warnings ?? []).join(' ')
      expect(warnText).toMatch(/skipped/)
    } finally {
      await out.cleanup()
    }
  })

  it('tags are preserved on nodes', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const tkt1 = out.result.nodes.find((n) => n.source_id === 'tkt1')
      expect(tkt1?.tags).toEqual(['enterprise', 'api', 'rate-limit'])
    } finally {
      await out.cleanup()
    }
  })
})
