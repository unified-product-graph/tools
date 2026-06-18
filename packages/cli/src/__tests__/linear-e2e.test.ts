/**
 * Linear end-to-end import audit.
 *
 * Linear's list() uses the Linear SDK; convert() is audited here for spec
 * conformance. Fixes verified: status is now read from metadata.status (list()
 * writes it there, convert() previously read metadata.state) and validated per
 * type; the source URL is stored as the canonical `external_ref` (was the
 * off-schema `external_url`).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { LinearAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new LinearAdapter() as unknown as AdapterLike

const ITEMS = [
  {
    source_id: 'proj1',
    source_type: 'project',
    title: 'Onboarding redesign',
    metadata: { status: 'In Progress' },
    children: [
      { source_id: 'epic1', source_type: 'issue', title: 'Auth epic', metadata: { issue_type: 'epic', status: 'In Progress' } },
      { source_id: 'feat1', source_type: 'issue', title: 'SSO login', metadata: { issue_type: 'feature', status: 'Todo', url: 'https://linear.app/acme/issue/feat1' } },
      { source_id: 'bug1', source_type: 'issue', title: 'Login crash on refresh', metadata: { issue_type: 'bug', status: 'Backlog' } },
      { source_id: 'story1', source_type: 'issue', title: 'As a user I can log in with SSO', metadata: { issue_type: 'story', status: 'In Progress', parent_id: 'epic1' } },
      { source_id: 'task1', source_type: 'issue', title: 'Write SSO integration tests', metadata: { issue_type: 'chore', status: 'Done', parent_id: 'story1' } },
    ],
  },
]

describe('Linear e2e — convert conformance', () => {
  it('produces a spec-conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBe(6)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('discriminates issue types and keeps the project hierarchy', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t.proj1).toBe('project')
      expect(t.epic1).toBe('epic')
      expect(t.feat1).toBe('feature')
      expect(t.bug1).toBe('bug')
      expect(t.story1).toBe('user_story')
      expect(t.task1).toBe('task')
    } finally {
      await out.cleanup()
    }
  })

  it('stores the source URL as canonical external_ref (survives persist)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const feat = out.rawDoc.nodes.find((n) => n.source_id === 'feat1') as Record<string, unknown>
      expect(feat.external_ref).toBe('https://linear.app/acme/issue/feat1')
    } finally {
      await out.cleanup()
    }
  })
})
