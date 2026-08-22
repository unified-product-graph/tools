/**
 * project_delivers_work_item: the explicit-emission contract.
 *
 * Five adapters read an authored project field (jira, gitlab, shortcut, linear,
 * notion). None of them can obtain this edge from a generic resolver: it is
 * flagged `deliberate_only`, AND in 0.33.0 its catalogue target widened to the
 * `node` wildcard, so `UPG_EDGE_PAIR_MAP['project:epic']` no longer exists at all.
 * Every one of the five must therefore emit it EXPLICITLY.
 *
 * This file exists because that edge was lost once with a fully green suite. The
 * 0.33.0 rename plus widening silently downgraded a project parent to
 * node_informs_node in linear and notion, and no test noticed. Each case below
 * fails if an adapter is ever "tidied" back onto the generic resolver.
 *
 * Two halves, and the second matters as much as the first:
 * 1. UNDER-FIRE: a project parent holding a work item emits the membership edge.
 * 2. OVER-FIRE: a project parent holding something that is NOT a work item keeps
 *    its own specific edge, or its honest generic fallback. The catalogue target
 *    is the `node` wildcard, so an adapter honouring it literally would swallow
 *    project_produces_deliverable and project_targets_milestone. The allowlist
 *    plus resolver-first ordering is what prevents that.
 */

import { describe, it, expect } from 'vitest'
import { resolveContainmentEdge, UPG_EDGE_TYPES } from '@unified-product-graph/core'
import {
  isProjectWorkItemMembership,
  PROJECT_WORK_ITEM_TYPES,
  PROJECT_WORK_ITEM_EDGE,
  resolvePairEdge,
  resolveContainmentEdgeInferrable,
} from '../adapters/resolve-pair-edge.js'
import { JiraAdapter } from '../adapters/jira.js'
import { GitLabAdapter } from '../adapters/gitlab.js'
import { ShortcutAdapter } from '../adapters/shortcut.js'
import { LinearAdapter } from '../adapters/linear.js'
import { NotionAdapter } from '../adapters/notion.js'
import type { SourceItem } from '../types.js'

const WORK_ITEMS = ['bug', 'epic', 'feature', 'task', 'user_story'] as const
const NOT_WORK_ITEMS = ['deliverable', 'milestone', 'release', 'feature_area'] as const

const typeOf = (edges: { source: string; target: string; type: string }[], type: string) =>
  edges.find((e) => e.type === type)

// ─── The seam itself ─────────────────────────────────────────────────────────

describe('project work-item membership seam', () => {
  it('the emitted edge is a real catalogue entry', () => {
    expect(new Set(UPG_EDGE_TYPES).has(PROJECT_WORK_ITEM_EDGE)).toBe(true)
  })

  it('no generic resolver can produce the edge, so explicit emission is the only route', () => {
    for (const child of WORK_ITEMS) {
      expect(resolvePairEdge('project', child), `project:${child} via pair map`).toBeNull()
      expect(
        resolveContainmentEdgeInferrable('project', child),
        `project:${child} via containment`,
      ).toBeNull()
    }
  })

  it('fires for every work-item child', () => {
    for (const child of WORK_ITEMS) {
      expect(isProjectWorkItemMembership('project', child), `project -> ${child}`).toBe(true)
    }
    expect([...PROJECT_WORK_ITEM_TYPES].sort()).toEqual([...WORK_ITEMS])
  })

  it('does NOT fire for a non-work-item child, so specific edges survive', () => {
    for (const child of NOT_WORK_ITEMS) {
      expect(isProjectWorkItemMembership('project', child), `project -> ${child}`).toBe(false)
    }
    // The two that would actually be swallowed by a literal `node` target.
    expect(resolveContainmentEdge('project', 'deliverable')).toBe('project_produces_deliverable')
    expect(resolveContainmentEdge('project', 'milestone')).toBe('project_targets_milestone')
  })

  it('does NOT fire when the parent is not a project', () => {
    for (const parent of ['epic', 'feature', 'release', 'product', 'team']) {
      expect(isProjectWorkItemMembership(parent, 'task'), `${parent} -> task`).toBe(false)
    }
  })
})

// ─── Jira ────────────────────────────────────────────────────────────────────

describe('JiraAdapter: project membership', () => {
  const adapter = new JiraAdapter()
  const issue = (id: string, title: string, issueType: string, parent: string): SourceItem => ({
    source_id: id,
    source_type: 'jira_issue',
    title,
    metadata: { issue_type: issueType, parent_id: parent, parent_type: 'project' },
  })
  const project: SourceItem = {
    source_id: 'project-ORB',
    source_type: 'jira_project',
    title: 'Orbit Ledger',
    metadata: { entity_kind: 'project' },
  }

  it('emits the membership edge for every work-item issue type under a project', async () => {
    const result = await adapter.convert([
      project,
      issue('issue-EP1', 'Ledger rewrite', 'Epic', 'project-ORB'),
      issue('issue-ST1', 'Export a statement', 'Story', 'project-ORB'),
      issue('issue-TK1', 'Wire the exporter', 'Task', 'project-ORB'),
      issue('issue-BG1', 'Totals drift on rollover', 'Bug', 'project-ORB'),
    ])
    const membership = result.edges.filter((e) => e.type === PROJECT_WORK_ITEM_EDGE)
    expect(membership).toHaveLength(4)
    expect(membership.every((e) => e.source === result.source_map['project-ORB'])).toBe(true)
    expect(typeOf(result.edges, 'node_informs_node')).toBeUndefined()
  })

  it('does NOT emit it for a version or component under a project', async () => {
    const result = await adapter.convert([
      project,
      {
        source_id: 'version-1',
        source_type: 'jira_version',
        title: 'Release 4',
        metadata: { entity_kind: 'version', parent_id: 'project-ORB', parent_type: 'project' },
      },
      {
        source_id: 'component-1',
        source_type: 'jira_component',
        title: 'Statements',
        metadata: { entity_kind: 'component', parent_id: 'project-ORB', parent_type: 'project' },
      },
    ])
    expect(typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)).toBeUndefined()
  })
})

// ─── GitLab ──────────────────────────────────────────────────────────────────

describe('GitLabAdapter: project membership', () => {
  const adapter = new GitLabAdapter()

  it('emits the membership edge when an epic carries a project_id', async () => {
    const result = await adapter.convert([
      {
        source_id: 'p-1',
        source_type: 'project',
        title: 'orbit-ledger',
        metadata: { entity_type: 'project' },
      },
      {
        source_id: 'ep-1',
        source_type: 'epic',
        title: 'Ledger rewrite',
        metadata: { entity_type: 'epic', state: 'opened', project_id: 'p-1' },
      },
    ])
    const edge = typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['p-1'])
    expect(edge?.target).toBe(result.source_map['ep-1'])
  })

  // A bug IS in the work-item allowlist, so this proves the parent-side guard too:
  // the membership edge must not fire just because the child qualifies.
  it('does NOT hijack a pair the resolver can already answer', async () => {
    const result = await adapter.convert([
      {
        source_id: 'ms-1',
        source_type: 'milestone',
        title: 'Q4 cutover',
        metadata: { entity_type: 'milestone', state: 'active' },
      },
      {
        source_id: 'iss-1',
        source_type: 'issue',
        title: 'Totals drift on rollover',
        metadata: { entity_type: 'issue', labels: ['bug'], state: 'opened', milestone_id: 'ms-1' },
      },
    ])
    expect(typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)).toBeUndefined()
    expect(typeOf(result.edges, 'release_contains_bug')).toBeDefined()
  })
})

// ─── Shortcut ────────────────────────────────────────────────────────────────

describe('ShortcutAdapter: project membership', () => {
  const adapter = new ShortcutAdapter()
  const project: SourceItem = {
    source_id: 'p1',
    source_type: 'project',
    title: 'Orbit Ledger',
    metadata: { entity_type: 'project' },
  }
  const child = (
    id: string,
    title: string,
    entityType: string,
    storyType?: string,
  ): SourceItem => ({
    source_id: id,
    source_type: entityType,
    title,
    metadata: {
      entity_type: entityType,
      parent_id: 'p1',
      parent_type: 'project',
      ...(storyType ? { story_type: storyType } : {}),
    },
  })

  it('emits the membership edge for an epic and for a story of any story_type', async () => {
    const result = await adapter.convert([
      project,
      child('e1', 'Ledger rewrite', 'epic'),
      child('s1', 'Export a statement', 'story', 'feature'),
      child('s2', 'Totals drift on rollover', 'story', 'bug'),
      child('s3', 'Prune stale exports', 'story', 'chore'),
    ])
    expect(result.edges.filter((e) => e.type === PROJECT_WORK_ITEM_EDGE)).toHaveLength(4)
  })

  it('does NOT emit it for a document under a project', async () => {
    const result = await adapter.convert([project, child('d1', 'Ledger design note', 'document')])
    expect(typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)).toBeUndefined()
    expect(typeOf(result.edges, 'node_informs_node')).toBeDefined()
  })
})

// ─── Linear ──────────────────────────────────────────────────────────────────
//
// The regression case. Linear project memberships are the measured corpus the
// 0.33.0 widening was built for; before this contract they silently degraded to
// node_informs_node.

describe('LinearAdapter: project membership', () => {
  const adapter = new LinearAdapter()
  const issue = (id: string, title: string, labels: string[]): SourceItem => ({
    source_id: id,
    source_type: 'issue',
    title,
    metadata: { entity_kind: 'issue', labels },
  })
  const project = (children: SourceItem[]): SourceItem => ({
    source_id: 'proj-1',
    source_type: 'project',
    title: 'Orbit Ledger',
    metadata: { entity_kind: 'project' },
    children,
  })

  it('emits the membership edge for a work item nested under a project', async () => {
    const result = await adapter.convert([
      project([
        issue('iss-1', 'Ledger rewrite', ['epic']),
        issue('iss-2', 'Export a statement', []),
        issue('iss-3', 'Totals drift on rollover', ['bug']),
      ]),
    ])
    expect(result.edges.filter((e) => e.type === PROJECT_WORK_ITEM_EDGE)).toHaveLength(3)
    expect(typeOf(result.edges, 'node_informs_node')).toBeUndefined()
  })

  it('does NOT emit it for a milestone, which keeps project_targets_milestone', async () => {
    const result = await adapter.convert([
      project([
        {
          source_id: 'ms-1',
          source_type: 'milestone',
          title: 'Q4 cutover',
          metadata: { entity_kind: 'milestone' },
        },
      ]),
    ])
    expect(typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)).toBeUndefined()
    expect(typeOf(result.edges, 'project_targets_milestone')).toBeDefined()
  })
})

// ─── Notion ──────────────────────────────────────────────────────────────────

describe('NotionAdapter: project membership', () => {
  const adapter = new NotionAdapter()
  const page = (id: string, title: string, dbName: string, children?: SourceItem[]): SourceItem => ({
    source_id: id,
    source_type: 'database_item',
    title,
    metadata: { database_name: dbName },
    children,
  })

  it('emits the membership edge for a work-item page under a project page', async () => {
    const result = await adapter.convert([
      page('proj-1', 'Orbit Ledger', 'Projects', [
        page('ep-1', 'Ledger rewrite', 'Epics'),
        page('st-1', 'Export a statement', 'User Stories'),
      ]),
    ])
    expect(result.edges.filter((e) => e.type === PROJECT_WORK_ITEM_EDGE)).toHaveLength(2)
    expect(typeOf(result.edges, 'node_informs_node')).toBeUndefined()
  })

  it('does NOT emit it for a milestone page, which keeps project_targets_milestone', async () => {
    const result = await adapter.convert([
      page('proj-1', 'Orbit Ledger', 'Projects', [page('ms-1', 'Q4 cutover', 'Milestones')]),
    ])
    expect(typeOf(result.edges, PROJECT_WORK_ITEM_EDGE)).toBeUndefined()
    expect(typeOf(result.edges, 'project_targets_milestone')).toBeDefined()
  })
})
