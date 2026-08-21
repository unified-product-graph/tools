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

// ─── Cycles: imported since 0.32.0, skipped before it ────────────────────────

describe('LinearAdapter: cycles import as planning_cycle', () => {
  // These three tests previously asserted that every cycle was DROPPED with a
  // warning saying cycles had "no UPG equivalent". `planning_cycle` shipped at
  // spec 0.20.0 and that line was stale for eleven releases; the 0.32.0
  // scheduling widening made the round trip possible, so the assertions invert.
  it('a cycle converts to a planning_cycle node, with no warning', async () => {
    const result = await adapter.convert([makeCycle('cy-1', 'Sprint 42')])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('planning_cycle')
    expect(result.nodes[0].title).toBe('Sprint 42')
    expect(result.warnings?.some((w) => w.includes('no UPG equivalent'))).toBeFalsy()
  })

  it('carries the required cadence_kind and the source term it was called by', async () => {
    const result = await adapter.convert([makeCycle('cy-1', 'Sprint 1')])
    const props = result.nodes[0].properties as Record<string, unknown>
    // `cadence_kind` is REQUIRED on planning_cycle, and a Linear Cycle is an
    // execution box rather than a coarse period or a buffer.
    expect(props.cadence_kind).toBe('iteration')
    // Dual-band, the same idea as workflow_state: the canonical granularity is
    // reasoned over, the source's own word is preserved beside it.
    expect(props.cadence_label).toBe('cycle')
  })

  it('multiple cycles all convert', async () => {
    const result = await adapter.convert([
      makeCycle('cy-1', 'Sprint 1'),
      makeCycle('cy-2', 'Sprint 2'),
    ])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.every((n) => n.type === 'planning_cycle')).toBe(true)
  })

  it('cycles and issues in one batch both convert', async () => {
    const result = await adapter.convert([
      makeCycle('cy-1', 'Sprint 1'),
      makeIssue('i-1', 'Auth feature', 'feature'),
    ])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.map((n) => n.type).sort()).toEqual(['feature', 'planning_cycle'])
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

  it('"Backlog" on a task maps to the backlog phase (0.32.0: WORK_ITEM gained it)', async () => {
    // This test previously asserted the status was OMITTED, and that assertion
    // was correct about the code and wrong about the world: "Backlog" is the
    // single largest state on a real board (183 of a measured 1,032-issue
    // corpus), and every one of those issues was arriving with no status.
    const result = await adapter.convert([makeIssue('i-1', 'Backlog', undefined, { state: 'Backlog' })])
    expect(result.nodes[0].status).toBe('backlog')
  })

  it('"In Review" on a task maps to in_review rather than falling through', async () => {
    // The normaliser had no review branch, so "In Review" survived as the
    // literal string "in review", failed the lifecycle check, and was dropped.
    const result = await adapter.convert([makeIssue('i-1', 'In Review', undefined, { state: 'In Review' })])
    expect(result.nodes[0].status).toBe('in_review')
  })

  it('"Duplicate" on a task maps to cancelled, which names duplicate explicitly', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Dup', undefined, { state: 'Duplicate' })])
    expect(result.nodes[0].status).toBe('cancelled')
  })

  it('the raw source label always survives on workflow_state, mapped or not', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Backlog', undefined, { state: 'Backlog' })])
    const props = result.nodes[0].properties as Record<string, unknown>
    expect(props.workflow_state).toBe('Backlog')
    expect(props.workflow_state_category).toBe('backlog')
  })

  it('"Cancelled" on a task maps to the cancelled phase (0.25.1: WORK_ITEM gained the off-ramp)', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Cancelled', undefined, { state: 'Cancelled' })])
    expect(result.nodes[0].status).toBe('cancelled')
  })

  it('"Canceled" (Linear\'s default US spelling) on a task also maps to cancelled', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Canceled', undefined, { state: 'Canceled' })])
    expect(result.nodes[0].status).toBe('cancelled')
  })

  it('"Canceled" on a bug falls back through the cancel family to closed', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Canceled', undefined, { state: 'Canceled', issue_type: 'Bug' }),
    ])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].status).toBe('closed')
  })

  it('normalizeLinearStatus maps to UPG delivery phase ids', () => {
    expect(normalizeLinearStatus('Done')).toBe('done')
    expect(normalizeLinearStatus('Backlog')).toBe('backlog')
    expect(normalizeLinearStatus('Triage')).toBe('triage')
    expect(normalizeLinearStatus('In Review')).toBe('in_review')
    expect(normalizeLinearStatus('Duplicate')).toBe('cancelled')
    expect(normalizeLinearStatus('In Progress')).toBe('in_progress')
    expect(normalizeLinearStatus('Cancelled')).toBe('cancelled')
    expect(normalizeLinearStatus('Canceled')).toBe('cancelled')
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

  it('source_map has one entry per converted node, cycles included', async () => {
    // The cycle used to be excluded here because it was dropped. Now it
    // converts, so it earns a source_map entry — and it MUST have one, or the
    // deferred planning_cycle_schedules_work_item edge has nothing to resolve
    // its source against and the scheduling link is silently lost.
    const result = await adapter.convert([
      makeIssue('i-1', 'Feature', 'feature'),
      makeIssue('i-2', 'Bug', 'bug'),
      makeCycle('cy-1', 'Sprint'),
    ])
    expect(Object.keys(result.source_map)).toHaveLength(3)
    expect(result.source_map['cy-1']).toBeDefined()
  })

  it('an issue in a cycle gets a scheduling edge from the cycle, not a property', async () => {
    // cycle_id was an undeclared stringly-typed stand-in for this edge.
    const result = await adapter.convert([
      makeCycle('cy-1', 'Sprint 42'),
      makeIssue('i-1', 'Ship it', undefined, { cycle_id: 'cy-1' }),
    ])
    const cycleNode = result.nodes.find((n) => n.type === 'planning_cycle')!
    const issueNode = result.nodes.find((n) => n.type !== 'planning_cycle')!
    const sched = result.edges.find((e) => e.type === 'planning_cycle_schedules_work_item')
    expect(sched, 'the scheduling edge must exist').toBeDefined()
    // Direction matters: the cycle SCHEDULES the item.
    expect(sched!.source).toBe(cycleNode.id)
    expect(sched!.target).toBe(issueNode.id)
    expect((issueNode.properties as Record<string, unknown>)?.cycle_id).toBeUndefined()
  })

  it('the citable key survives on the node, not as a vendor property', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Ship it', undefined, { identifier: 'LTN-311' }),
    ])
    expect(result.nodes[0].key).toBe('LTN-311')
    expect((result.nodes[0].properties as Record<string, unknown>)?.linear_identifier).toBeUndefined()
  })

  it('priority is translated from Linear\'s integer to the string enum', async () => {
    // Was written through raw: a live type violation on 958 of 1,032 issues.
    const cases: Array<[number, string]> = [
      [0, 'none'], [1, 'urgent'], [2, 'high'], [3, 'medium'], [4, 'low'],
    ]
    for (const [raw, expected] of cases) {
      const result = await adapter.convert([makeIssue(`i-${raw}`, 'P', undefined, { priority: raw })])
      expect((result.nodes[0].properties as Record<string, unknown>).priority).toBe(expected)
    }
  })

  it('estimate lands on `effort` with its unit, not on an undeclared field', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Sized', undefined, { estimate: 3 })])
    const props = result.nodes[0].properties as Record<string, unknown>
    expect(props.effort).toBe('3 points')
    expect(props.estimate).toBeUndefined()
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

// ─── Public surface ───────────────────────────────────────────────────────────

describe('barrel exports', () => {
  // Regression pin for G4 (Linear-parity Phase 3 importer dry-run, 2026-08-21).
  // Both normalisers existed and were tested, but only via the deep path above.
  // The package barrel exported LinearAdapter alone, so an importer doing its
  // own fetching had to reimplement the status and priority mapping or reach
  // past the package boundary. Every other adapter exports its normaliser; this
  // asserts Linear is no longer the exception.
  it('exposes the Linear normalisers from the package entry point', async () => {
    const barrel = await import('../index.js')
    expect(typeof barrel.normalizeLinearStatus).toBe('function')
    expect(typeof barrel.mapLinearPriority).toBe('function')
    expect(barrel.normalizeLinearStatus).toBe(normalizeLinearStatus)
  })
})
