/**
 * GitLab end-to-end import audit (convert-only).
 *
 * Fixes verified: per-type status validation (opened/closed -> in_progress/done,
 * kept only where valid); source URL as canonical `external_ref` (was
 * `external_url`); deferred cross-domain edges are catalogue-driven (the old code
 * forced release_contains_feature onto user_story/task and
 * feature_decomposed_into_epic from an epic source).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { GitLabAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new GitLabAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'project-1', source_type: 'project', title: 'Web App', metadata: { entity_type: 'project' } },
  { source_id: 'milestone-1', source_type: 'milestone', title: 'v2.4', metadata: { entity_type: 'milestone' } },
  { source_id: 'epic-1', source_type: 'epic', title: 'Auth epic', metadata: { entity_type: 'epic', status: 'opened', project_id: 'project-1' } },
  { source_id: 'issue-1', source_type: 'issue', title: 'SSO login', metadata: { entity_type: 'issue', labels: ['feature'], status: 'opened', epic_id: 'epic-1', milestone_id: 'milestone-1' } },
  { source_id: 'issue-2', source_type: 'issue', title: 'Login crash', metadata: { entity_type: 'issue', labels: ['bug'], status: 'closed', milestone_id: 'milestone-1' } },
  { source_id: 'issue-3', source_type: 'issue', title: 'Refactor auth', metadata: { entity_type: 'issue', labels: ['chore'], status: 'opened' } },
]

describe('GitLab e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBe(6)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps gitlab kinds + labels to the right types', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t['project-1']).toBe('project')
      expect(t['milestone-1']).toBe('release')
      expect(t['epic-1']).toBe('epic')
      expect(t['issue-1']).toBe('user_story')
      expect(t['issue-2']).toBe('bug')
      expect(t['issue-3']).toBe('task')
    } finally {
      await out.cleanup()
    }
  })

  it('emits catalogue-correct cross-domain edges', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sm = out.result.source_map
      const has = (type: string, s: string, tgt: string) =>
        out.result.edges.some((e) => e.type === type && e.source === sm[s] && e.target === sm[tgt])
      expect(has('project_delivers_epic', 'project-1', 'epic-1')).toBe(true)
      expect(has('epic_specified_by_user_story', 'epic-1', 'issue-1')).toBe(true)
      expect(has('release_contains_bug', 'milestone-1', 'issue-2')).toBe(true)
    } finally {
      await out.cleanup()
    }
  })
})
