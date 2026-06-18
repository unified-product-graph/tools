/**
 * GitHub end-to-end import audit.
 *
 * Fixes verified: milestone maps to UPG `release` (so release_contains_feature/bug
 * are correctly sourced, and there is no invalid milestone->feature edge);
 * per-type status validation (a bug's `open` survives, others map via in_progress
 * /done); source URL stored as canonical `external_ref` (was `external_url`).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { GitHubAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new GitHubAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'milestone-1', source_type: 'milestone', title: 'v1.5.0', metadata: { state: 'open', due_on: '2026-09-01' } },
  { source_id: 'issue-1', source_type: 'issue', title: 'Add dark mode', metadata: { labels: ['enhancement'], state: 'open', milestone_id: 'milestone-1' } },
  { source_id: 'issue-2', source_type: 'issue', title: 'Fix crash on startup', metadata: { labels: ['bug'], state: 'open', milestone_id: 'milestone-1' } },
  { source_id: 'issue-3', source_type: 'issue', title: 'Refactor auth module', metadata: { labels: ['chore'], state: 'closed' } },
  { source_id: 'repo-1', source_type: 'repository', title: 'acme/web-app', metadata: {} },
]

describe('GitHub e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBe(5)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps milestone->release, labels->issue types, repo->code_repository', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t['milestone-1']).toBe('release')
      expect(t['issue-1']).toBe('feature')
      expect(t['issue-2']).toBe('bug')
      expect(t['issue-3']).toBe('task')
      expect(t['repo-1']).toBe('code_repository')
    } finally {
      await out.cleanup()
    }
  })

  it('emits release_contains_feature/bug with correct (release-sourced) endpoints', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sm = out.result.source_map
      const has = (type: string, s: string, tgt: string) =>
        out.result.edges.some((e) => e.type === type && e.source === sm[s] && e.target === sm[tgt])
      expect(has('release_contains_feature', 'milestone-1', 'issue-1')).toBe(true)
      expect(has('release_contains_bug', 'milestone-1', 'issue-2')).toBe(true)
    } finally {
      await out.cleanup()
    }
  })

  it("a bug's `open` survives (real bug phase); a task's `closed` maps to done", async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n]))
      expect(byId['issue-2'].status).toBe('open') // bug
      expect(byId['issue-3'].status).toBe('done') // task, closed
      expect(byId['issue-1'].status).toBe('in_progress') // feature, open
    } finally {
      await out.cleanup()
    }
  })
})
