/**
 * Jira end-to-end import audit (live adapter).
 *
 * Fixtures mirror list() output exactly (issues carry entity_kind:'issue').
 * Fixes verified: issues are no longer skipped (the pass-1 structural gate
 * treated entity_kind:'issue' as an unknown structural kind); per-type status
 * validation; catalogue-driven hierarchy/component/version edges (the old code
 * forced epic_specified_by_user_story onto tasks, task_implements_user_story
 * reversed, and feature_area/release_contains_feature onto non-feature issues).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { JiraAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new JiraAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'project-PROJ', source_type: 'project', title: 'Web App', metadata: { entity_kind: 'project', project_key: 'PROJ' } },
  { source_id: 'version-1', source_type: 'version', title: 'v2.4', metadata: { entity_kind: 'version', project_id: 'project-PROJ', released: false } },
  { source_id: 'component-1', source_type: 'component', title: 'Auth', metadata: { entity_kind: 'component', project_id: 'project-PROJ' } },
  { source_id: 'issue-EP1', source_type: 'issue', title: 'Auth epic', metadata: { entity_kind: 'issue', issue_type: 'Epic', status: 'In Progress', parent_id: 'project-PROJ', parent_type: 'project' } },
  { source_id: 'issue-ST1', source_type: 'issue', title: 'SSO login', metadata: { entity_kind: 'issue', issue_type: 'Story', status: 'In Progress', parent_id: 'issue-EP1', parent_type: 'Epic', version_ids: ['version-1'], component_ids: ['component-1'] } },
  { source_id: 'issue-SUB1', source_type: 'issue', title: 'Write integration tests', metadata: { entity_kind: 'issue', issue_type: 'Sub-task', status: 'To Do', parent_id: 'issue-ST1', parent_type: 'Story' } },
  { source_id: 'issue-BUG1', source_type: 'issue', title: 'Login crash on refresh', metadata: { entity_kind: 'issue', issue_type: 'Bug', status: 'Open', version_ids: ['version-1'], component_ids: ['component-1'] } },
]

describe('Jira e2e — convert conformance', () => {
  it('imports every item (issues no longer skipped) into a conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBe(7)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps structural + issue types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t['project-PROJ']).toBe('project')
      expect(t['version-1']).toBe('release')
      expect(t['component-1']).toBe('feature_area')
      expect(t['issue-EP1']).toBe('epic')
      expect(t['issue-ST1']).toBe('user_story')
      expect(t['issue-SUB1']).toBe('task')
      expect(t['issue-BUG1']).toBe('bug')
    } finally {
      await out.cleanup()
    }
  })

  it('emits canonical hierarchy edges with correct type + direction', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sm = out.result.source_map
      const has = (type: string, s: string, tgt: string) =>
        out.result.edges.some((e) => e.type === type && e.source === sm[s] && e.target === sm[tgt])
      // 0.41.0: the project -> work-item carrier moved to concrete containment.
      expect(has('project_contains_epic', 'project-PROJ', 'issue-EP1')).toBe(true)
      expect(has('epic_specified_by_user_story', 'issue-EP1', 'issue-ST1')).toBe(true)
      // sub-task -> story: task_implements_user_story is task-sourced (direction flips)
      expect(has('task_implements_user_story', 'issue-SUB1', 'issue-ST1')).toBe(true)
      expect(has('release_contains_bug', 'version-1', 'issue-BUG1')).toBe(true)
    } finally {
      await out.cleanup()
    }
  })

  it("validates status per type (bug 'Open' survives; task 'To Do' -> todo)", async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n]))
      expect(byId['issue-BUG1'].status).toBe('open')
      expect(byId['issue-SUB1'].status).toBe('todo')
      expect(byId['issue-EP1'].status).toBe('in_progress')
    } finally {
      await out.cleanup()
    }
  })
})
