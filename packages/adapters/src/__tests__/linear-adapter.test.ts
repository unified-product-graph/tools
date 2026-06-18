/**
 * Linear Adapter Tests
 *
 * Verifies entity type mapping, status normalisation, cycle skipping,
 * and cross-domain edge emission.
 */

import { describe, it, expect } from 'vitest'
import { LinearAdapter, normalizeLinearStatus } from '../adapters/linear.js'
import type { SourceItem } from '../types.js'

const adapter = new LinearAdapter()

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeIssue = (
  id: string,
  title: string,
  issueType?: string,
  overrides?: Partial<Record<string, unknown>>,
): SourceItem => ({
  source_id: id,
  source_type: 'issue',
  title,
  metadata: {
    entity_type: 'issue',
    ...(issueType ? { issue_type: issueType } : {}),
    ...overrides,
  },
})

const makeProject = (
  id: string,
  title: string,
  overrides?: Partial<Record<string, unknown>>,
): SourceItem => ({
  source_id: id,
  source_type: 'project',
  title,
  metadata: {
    entity_type: 'project',
    ...overrides,
  },
})

const makeInitiative = (id: string, title: string): SourceItem => ({
  source_id: id,
  source_type: 'initiative',
  title,
  metadata: { entity_type: 'initiative' },
})

const makeCycle = (id: string, title: string): SourceItem => ({
  source_id: id,
  source_type: 'cycle',
  title,
  metadata: { entity_type: 'cycle' },
})

// ─── Issue type mapping ───────────────────────────────────────────────────────

describe('LinearAdapter: issue type mapping (via issue_type)', () => {
  it('feature issue maps to feature entity', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Dark mode', 'feature')])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('bug issue maps to bug entity', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Crash on launch', 'bug')])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('chore maps to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Update deps', 'chore')])
    expect(result.nodes[0].type).toBe('task')
  })

  it('story maps to user_story', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'As a user I want...', 'story')])
    expect(result.nodes[0].type).toBe('user_story')
  })

  it('epic issue maps to epic entity', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Auth epic', 'epic')])
    expect(result.nodes[0].type).toBe('epic')
  })

  it('unrecognised issue_type defaults to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Unknown type', 'spike')])
    expect(result.nodes[0].type).toBe('task')
  })

  it('issue without issue_type falls back to label-based inference', async () => {
    const item: SourceItem = {
      source_id: 'i-1',
      source_type: 'issue',
      title: 'Auth crash',
      metadata: { entity_type: 'issue', labels: ['bug'] },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('medium') // medium when no issue_type
  })

  it('issue without issue_type or labels defaults to task', async () => {
    const item: SourceItem = {
      source_id: 'i-1',
      source_type: 'issue',
      title: 'Some work',
      metadata: { entity_type: 'issue' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('task')
  })
})

// ─── Non-issue entity types ───────────────────────────────────────────────────

describe('LinearAdapter: non-issue entity types', () => {
  it('initiative maps to initiative', async () => {
    const result = await adapter.convert([makeInitiative('init-1', 'Grow retention')])
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('project maps to project', async () => {
    const result = await adapter.convert([makeProject('proj-1', 'Auth system')])
    expect(result.nodes[0].type).toBe('project')
  })

  it('milestone maps to milestone', async () => {
    const item: SourceItem = {
      source_id: 'ms-1',
      source_type: 'milestone',
      title: 'v2.0',
      metadata: { entity_type: 'milestone' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('milestone')
  })

  it('document maps to document', async () => {
    const item: SourceItem = {
      source_id: 'doc-1',
      source_type: 'document',
      title: 'Spec doc',
      metadata: { entity_type: 'document' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('document')
  })
})

// ─── Cycle skipping ───────────────────────────────────────────────────────────

describe('LinearAdapter: cycle skipping', () => {
  it('cycle item is skipped with warning', async () => {
    const result = await adapter.convert([makeCycle('cy-1', 'Sprint 42')])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('Cycle'))).toBe(true)
  })

  it('multiple cycles all skipped, summary warning emitted', async () => {
    const result = await adapter.convert([
      makeCycle('cy-1', 'Sprint 1'),
      makeCycle('cy-2', 'Sprint 2'),
    ])
    expect(result.nodes).toHaveLength(0)
    // Summary warning mentions count
    const summary = result.warnings?.find((w) => w.includes('Cycles were'))
    expect(summary).toBeDefined()
  })

  it('cycles are skipped but other items in the same batch convert normally', async () => {
    const result = await adapter.convert([
      makeCycle('cy-1', 'Sprint 1'),
      makeIssue('i-1', 'Auth feature', 'feature'),
    ])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('LinearAdapter: status normalisation (validated against the target lifecycle)', () => {
  // makeIssue with no issue_type resolves to `task` (lifecycle: todo, in_progress, in_review, done).
  it('"Done" on a task → done', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Done thing', undefined, { state: 'Done' })])
    expect(result.nodes[0].status).toBe('done')
  })

  it('"In Progress" on a task → in_progress', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'WIP', undefined, { state: 'In Progress' })])
    expect(result.nodes[0].status).toBe('in_progress')
  })

  it('"Todo" on a task → todo', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Todo', undefined, { state: 'Todo' })])
    expect(result.nodes[0].status).toBe('todo')
  })

  it('"Backlog" on a task is omitted (proposed is not a task phase)', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Backlog', undefined, { state: 'Backlog' })])
    expect(result.nodes[0].status).toBeUndefined()
  })

  it('"Cancelled" on a task is omitted (archived is not a task phase)', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Cancelled', undefined, { state: 'Cancelled' })])
    expect(result.nodes[0].status).toBeUndefined()
  })

  it('normalizeLinearStatus maps to UPG delivery phase ids', () => {
    expect(normalizeLinearStatus('Done')).toBe('done')
    expect(normalizeLinearStatus('Backlog')).toBe('proposed')
    expect(normalizeLinearStatus('In Progress')).toBe('in_progress')
    expect(normalizeLinearStatus('Cancelled')).toBe('archived')
    expect(normalizeLinearStatus('Todo')).toBe('todo')
  })
})

// ─── Cross-domain edges ───────────────────────────────────────────────────────

describe('LinearAdapter: cross-domain edge emission', () => {
  it('project_implements_initiative edge is emitted when initiative_id is present', async () => {
    const result = await adapter.convert([
      makeInitiative('init-1', 'Grow retention'),
      makeProject('proj-1', 'Auth system', { initiative_id: 'init-1' }),
    ])
    const edge = result.edges.find((e) => e.type === 'project_implements_initiative')
    expect(edge).toBeDefined()
    // Source is the project node, target is the initiative node
    const projectNodeId = result.source_map['proj-1']
    const initiativeNodeId = result.source_map['init-1']
    expect(edge?.source).toBe(projectNodeId)
    expect(edge?.target).toBe(initiativeNodeId)
  })

  it('project_implements_initiative is NOT emitted when initiative is not in the batch', async () => {
    // initiative-999 not in items; should silently skip the edge
    const result = await adapter.convert([
      makeProject('proj-1', 'Auth system', { initiative_id: 'initiative-999' }),
    ])
    expect(result.edges.find((e) => e.type === 'project_implements_initiative')).toBeUndefined()
  })

  it('epic_specified_by_user_story edge emitted when story parent_id points to an epic', async () => {
    const items: SourceItem[] = [
      makeIssue('epic-1', 'Auth epic', 'epic'),
      makeIssue('story-1', 'As a user...', 'story', { parent_id: 'epic-1' }),
    ]
    const result = await adapter.convert(items)
    const specEdge = result.edges.find((e) => e.type === 'epic_specified_by_user_story')
    expect(specEdge).toBeDefined()
    const epicNodeId = result.source_map['epic-1']
    const storyNodeId = result.source_map['story-1']
    expect(specEdge?.source).toBe(epicNodeId)
    expect(specEdge?.target).toBe(storyNodeId)
  })

  it('bug_affects_feature edge emitted when bug parent_id resolves to a feature node', async () => {
    const items: SourceItem[] = [
      makeIssue('feat-1', 'Dark mode', 'feature'),
      makeIssue('bug-1', 'Dark mode crash', 'bug', { parent_id: 'feat-1' }),
    ]
    const result = await adapter.convert(items)
    const bugEdge = result.edges.find((e) => e.type === 'bug_affects_feature')
    expect(bugEdge).toBeDefined()
    const bugNodeId = result.source_map['bug-1']
    const featNodeId = result.source_map['feat-1']
    expect(bugEdge?.source).toBe(bugNodeId)
    expect(bugEdge?.target).toBe(featNodeId)
  })

  it('bug_affects_feature is NOT emitted when bug parent_id resolves to a non-feature', async () => {
    // Parent is an epic, not a feature; edge should not fire
    const items: SourceItem[] = [
      makeIssue('epic-1', 'Auth epic', 'epic'),
      makeIssue('bug-1', 'Auth crash', 'bug', { parent_id: 'epic-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges.find((e) => e.type === 'bug_affects_feature')).toBeUndefined()
  })

  it('no cross-domain edges when no relation metadata is present', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Plain feature', 'feature')])
    expect(result.edges).toHaveLength(0)
  })
})

// ─── list() throws the right error ───────────────────────────────────────────

describe('LinearAdapter: list()', () => {
  it('requires config.api_key when not provided', async () => {
    await expect(adapter.list({})).rejects.toThrow('Linear adapter requires config.api_key')
  })
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('LinearAdapter: edge cases', () => {
  it('returns empty-nodes warning for empty input', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('No items were converted'))).toBe(true)
  })

  it('source_map has one entry per converted node', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Feature', 'feature'),
      makeIssue('i-2', 'Bug', 'bug'),
      makeCycle('cy-1', 'Sprint'), // skipped; should NOT be in source_map
    ])
    expect(Object.keys(result.source_map)).toHaveLength(2)
    expect(result.source_map['cy-1']).toBeUndefined()
  })

  it('tags come from metadata.labels', async () => {
    const item: SourceItem = {
      source_id: 'i-1',
      source_type: 'issue',
      title: 'Tagged issue',
      metadata: { entity_type: 'issue', issue_type: 'feature', labels: ['priority-high', 'q1'] },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].tags).toEqual(['priority-high', 'q1'])
  })

  it('external_tool is always linear', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Feature', 'feature')])
    expect(result.nodes[0].external_tool).toBe('linear')
  })
})
