/**
 * GitHub Adapter Tests
 *
 * Verifies issue type discrimination by label, pull request skipping,
 * non-issue entity type mapping, and cross-domain edge emission.
 */

import { describe, it, expect } from 'vitest'
import { GitHubAdapter, inferIssueType } from '../adapters/github.js'
import type { SourceItem } from '../types.js'

const adapter = new GitHubAdapter()

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeIssue = (
  id: string,
  title: string,
  labels: string[],
  overrides?: Partial<Record<string, unknown>>,
): SourceItem => ({
  source_id: id,
  source_type: 'issue',
  title,
  metadata: {
    entity_type: 'issue',
    labels,
    state: 'open',
    ...overrides,
  },
})

const makeMilestone = (id: string, title: string): SourceItem => ({
  source_id: id,
  source_type: 'milestone',
  title,
  metadata: { entity_type: 'milestone', state: 'open' },
})

const makeRelease = (
  id: string,
  title: string,
  overrides?: Partial<Record<string, unknown>>,
): SourceItem => ({
  source_id: id,
  source_type: 'release',
  title,
  metadata: { entity_type: 'release', ...overrides },
})

const makePR = (id: string, title: string): SourceItem => ({
  source_id: id,
  source_type: 'pull_request',
  title,
  metadata: { entity_type: 'pull_request' },
})

// ─── inferIssueType unit tests ────────────────────────────────────────────────

describe('inferIssueType', () => {
  it('bug label → bug', () => {
    expect(inferIssueType(['bug'])).toBe('bug')
  })

  it('defect label → bug', () => {
    expect(inferIssueType(['defect'])).toBe('bug')
  })

  it('fix label → bug', () => {
    expect(inferIssueType(['fix'])).toBe('bug')
  })

  it('enhancement label → feature', () => {
    expect(inferIssueType(['enhancement'])).toBe('feature')
  })

  it('feature label → feature', () => {
    expect(inferIssueType(['feature'])).toBe('feature')
  })

  it('epic label → epic', () => {
    expect(inferIssueType(['epic'])).toBe('epic')
  })

  it('story label → user_story', () => {
    expect(inferIssueType(['story'])).toBe('user_story')
  })

  it('user story label → user_story', () => {
    expect(inferIssueType(['user story'])).toBe('user_story')
  })

  it('tech debt label → task', () => {
    expect(inferIssueType(['tech debt'])).toBe('task')
  })

  it('chore label → task', () => {
    expect(inferIssueType(['chore'])).toBe('task')
  })

  it('no recognised labels → task (default)', () => {
    expect(inferIssueType([])).toBe('task')
    expect(inferIssueType(['wontfix', 'duplicate'])).toBe('task')
  })

  it('bug takes precedence over feature when both labels present', () => {
    expect(inferIssueType(['bug', 'enhancement'])).toBe('bug')
  })

  it('labels are case-insensitive', () => {
    expect(inferIssueType(['Bug'])).toBe('bug')
    expect(inferIssueType(['ENHANCEMENT'])).toBe('feature')
  })
})

// ─── Issue entity type mapping ────────────────────────────────────────────────

describe('GitHubAdapter: issue type mapping via labels', () => {
  it('issue with "bug" label maps to bug', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Crash on launch', ['bug'])])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('issue with "enhancement" label maps to feature', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Dark mode', ['enhancement'])])
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('issue with "feature" label maps to feature', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'New dashboard', ['feature'])])
    expect(result.nodes[0].type).toBe('feature')
  })

  it('issue with "epic" label maps to epic', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Auth system', ['epic'])])
    expect(result.nodes[0].type).toBe('epic')
  })

  it('issue with "story" label maps to user_story', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'As a user...', ['story'])])
    expect(result.nodes[0].type).toBe('user_story')
  })

  it('issue with "chore" label maps to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Update deps', ['chore'])])
    expect(result.nodes[0].type).toBe('task')
  })

  it('issue with no recognised labels defaults to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Misc work', [])])
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('low')
  })

  it('issue with unrecognised labels defaults to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Some work', ['wontfix', 'duplicate'])])
    expect(result.nodes[0].type).toBe('task')
  })
})

// ─── Pull request skipping ────────────────────────────────────────────────────

describe('GitHubAdapter: pull request skipping', () => {
  it('pull request is skipped with warning', async () => {
    const result = await adapter.convert([makePR('pr-1', 'Fix login bug')])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('pull request'))).toBe(true)
    expect(result.warnings?.some((w) => w.includes("PRs are code-layer artifacts below UPG's scope"))).toBe(true)
  })

  it('multiple PRs produce a single summary warning', async () => {
    const result = await adapter.convert([
      makePR('pr-1', 'PR 1'),
      makePR('pr-2', 'PR 2'),
      makePR('pr-3', 'PR 3'),
    ])
    expect(result.nodes).toHaveLength(0)
    const prWarning = result.warnings?.find((w) => w.includes('pull requests were not exported'))
    expect(prWarning).toBeDefined()
  })

  it('PRs skipped but other items in the batch convert normally', async () => {
    const result = await adapter.convert([
      makePR('pr-1', 'Fix login'),
      makeIssue('i-1', 'Dark mode', ['feature']),
    ])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
  })
})

// ─── Non-issue entity types ───────────────────────────────────────────────────

describe('GitHubAdapter: non-issue entity type mapping', () => {
  it('milestone maps to milestone', async () => {
    const result = await adapter.convert([makeMilestone('ms-1', 'v1.0')])
    expect(result.nodes[0].type).toBe('milestone')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('release maps to release', async () => {
    const result = await adapter.convert([makeRelease('rel-1', 'v2.0.0')])
    expect(result.nodes[0].type).toBe('release')
  })

  it('repository maps to code_repository', async () => {
    const item: SourceItem = {
      source_id: 'repo-1',
      source_type: 'repository',
      title: 'my-org/my-repo',
      metadata: { entity_type: 'repository' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('code_repository')
  })

  it('workflow maps to ci_pipeline', async () => {
    const item: SourceItem = {
      source_id: 'wf-1',
      source_type: 'workflow',
      title: 'CI Build',
      metadata: { entity_type: 'workflow' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('ci_pipeline')
  })

  it('discussion maps to document', async () => {
    const item: SourceItem = {
      source_id: 'disc-1',
      source_type: 'discussion',
      title: 'RFC: Auth strategy',
      metadata: { entity_type: 'discussion' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('document')
  })

  it('team maps to team', async () => {
    const item: SourceItem = {
      source_id: 'team-1',
      source_type: 'team',
      title: 'Platform team',
      metadata: { entity_type: 'team' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('team')
  })

  it('deployment maps to deployment', async () => {
    const item: SourceItem = {
      source_id: 'dep-1',
      source_type: 'deployment',
      title: 'Production deploy',
      metadata: { entity_type: 'deployment' },
    }
    const result = await adapter.convert([item])
    expect(result.nodes[0].type).toBe('deployment')
  })
})

// ─── Cross-domain edge emission ───────────────────────────────────────────────

describe('GitHubAdapter: cross-domain edge emission', () => {
  it('milestone_gates_release edge emitted when release has milestone_id', async () => {
    const items: SourceItem[] = [
      makeMilestone('ms-1', 'v1.0 milestone'),
      makeRelease('rel-1', 'v1.0 release', { milestone_id: 'ms-1' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'milestone_gates_release')
    expect(edge).toBeDefined()
    const milestoneNodeId = result.source_map['ms-1']
    const releaseNodeId = result.source_map['rel-1']
    expect(edge?.source).toBe(milestoneNodeId)
    expect(edge?.target).toBe(releaseNodeId)
  })

  it('milestone_gates_release NOT emitted when milestone is not in batch', async () => {
    const items: SourceItem[] = [
      makeRelease('rel-1', 'v1.0', { milestone_id: 'ms-external' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges.find((e) => e.type === 'milestone_gates_release')).toBeUndefined()
  })

  it('release_contains_feature emitted when feature has milestone_id linking to a milestone', async () => {
    const items: SourceItem[] = [
      makeMilestone('ms-1', 'v1.0'),
      makeIssue('i-1', 'Dark mode', ['enhancement'], { milestone_id: 'ms-1' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
  })

  it('release_contains_bug emitted when bug has milestone_id linking to a milestone', async () => {
    const items: SourceItem[] = [
      makeMilestone('ms-1', 'v1.0'),
      makeIssue('i-1', 'Auth crash', ['bug'], { milestone_id: 'ms-1' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'release_contains_bug')
    expect(edge).toBeDefined()
    const milestoneNodeId = result.source_map['ms-1']
    const bugNodeId = result.source_map['i-1']
    expect(edge?.source).toBe(milestoneNodeId)
    expect(edge?.target).toBe(bugNodeId)
  })

  it('bug_affects_feature emitted when bug parent_id resolves to a feature', async () => {
    const items: SourceItem[] = [
      makeIssue('feat-1', 'Dark mode', ['feature']),
      makeIssue('bug-1', 'Dark mode crash', ['bug'], { parent_id: 'feat-1' }),
    ]
    const result = await adapter.convert(items)
    const edge = result.edges.find((e) => e.type === 'bug_affects_feature')
    expect(edge).toBeDefined()
    const bugNodeId = result.source_map['bug-1']
    const featNodeId = result.source_map['feat-1']
    expect(edge?.source).toBe(bugNodeId)
    expect(edge?.target).toBe(featNodeId)
  })

  it('bug_affects_feature NOT emitted when parent_id resolves to non-feature', async () => {
    const items: SourceItem[] = [
      makeIssue('task-1', 'Some task', ['chore']),
      makeIssue('bug-1', 'Crash', ['bug'], { parent_id: 'task-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges.find((e) => e.type === 'bug_affects_feature')).toBeUndefined()
  })
})

// ─── Status mapping ───────────────────────────────────────────────────────────

describe('GitHubAdapter: issue state mapping', () => {
  it('open issue maps to active status', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Open issue', [], { state: 'open' })])
    expect(result.nodes[0].status).toBe('active')
  })

  it('closed issue maps to complete status', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Closed issue', [], { state: 'closed' })])
    expect(result.nodes[0].status).toBe('complete')
  })
})

// ─── Label filtering ──────────────────────────────────────────────────────────

describe('GitHubAdapter: label filtering from tags', () => {
  it('type-indicator labels are not included in node.tags', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Auth crash', ['bug', 'priority-high', 'auth-team']),
    ])
    // 'bug' should be filtered; 'priority-high' and 'auth-team' should remain
    expect(result.nodes[0].tags).toEqual(expect.arrayContaining(['priority-high', 'auth-team']))
    expect(result.nodes[0].tags).not.toContain('bug')
  })

  it('all labels are type-indicators → empty tags (no tags field)', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Feature', ['feature', 'enhancement']),
    ])
    // No non-type-indicator labels → tags should be absent or empty
    expect(result.nodes[0].tags?.length ?? 0).toBe(0)
  })
})

// ─── list() throws the right error ───────────────────────────────────────────

describe('GitHubAdapter: list()', () => {
  it('requires config.token / owner / repo when not provided', async () => {
    await expect(adapter.list({})).rejects.toThrow('GitHub adapter requires config.token')
  })
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('GitHubAdapter: edge cases', () => {
  it('returns empty-nodes warning for empty input', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('No items were converted'))).toBe(true)
  })

  it('external_tool is always github', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Feature', ['feature'])])
    expect(result.nodes[0].external_tool).toBe('github')
  })

  it('source_map has entries for all converted (non-PR) items', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Feature', ['feature']),
      makePR('pr-1', 'Fix'),
      makeMilestone('ms-1', 'v1.0'),
    ])
    expect(result.source_map['i-1']).toBeDefined()
    expect(result.source_map['ms-1']).toBeDefined()
    expect(result.source_map['pr-1']).toBeUndefined()
  })

  it('children of issues become task nodes with containment edge', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'i-1',
        source_type: 'issue',
        title: 'Build auth',
        metadata: { entity_type: 'issue', labels: ['feature'], state: 'open' },
        children: [
          {
            source_id: 'task-1',
            source_type: 'task_item',
            title: 'Write tests',
          },
        ],
      },
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(2)
    const taskNode = result.nodes.find((n) => n.title === 'Write tests')
    expect(taskNode?.type).toBe('task')
    expect(result.edges).toHaveLength(1)
  })
})
