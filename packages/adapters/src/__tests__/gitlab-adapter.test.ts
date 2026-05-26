/**
 * GitLab Adapter Tests
 *
 * Covers issue label discrimination, native Epic mapping, incident type,
 * milestone→release mapping, group/subgroup hierarchy, merge request and
 * pipeline skipping, status normalisation, edge emission, and the full
 * assertAllEdgesCatalogued fixture test.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import {
  GitLabAdapter,
  GITLAB_ISSUE_LABEL_MAP,
  GITLAB_ENTITY_TYPE_MAP,
  GITLAB_STATUS_MAP,
  inferIssueType,
} from '../adapters/gitlab.js'
import type { SourceItem } from '../types.js'

// ─── Catalogue guard ──────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const adapter = new GitLabAdapter()

function makeIssue(
  id: string,
  title: string,
  labels: string[],
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'issue',
    title,
    metadata: {
      entity_type: 'issue',
      labels,
      state: 'opened',
      ...overrides,
    },
  }
}

function makeEpic(
  id: string,
  title: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'epic',
    title,
    metadata: {
      entity_type: 'epic',
      state: 'opened',
      ...overrides,
    },
  }
}

function makeMilestone(
  id: string,
  title: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'milestone',
    title,
    metadata: {
      entity_type: 'milestone',
      state: 'active',
      ...overrides,
    },
  }
}

function makeMR(id: string, title: string): SourceItem {
  return {
    source_id: id,
    source_type: 'merge_request',
    title,
    metadata: { entity_type: 'merge_request' },
  }
}

function makePipeline(id: string, title: string): SourceItem {
  return {
    source_id: id,
    source_type: 'pipeline',
    title,
    metadata: { entity_type: 'pipeline' },
  }
}

function makeGroup(
  id: string,
  title: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'group',
    title,
    metadata: {
      entity_type: 'group',
      ...overrides,
    },
  }
}

function makeSubgroup(
  id: string,
  title: string,
  groupId: string,
): SourceItem {
  return {
    source_id: id,
    source_type: 'subgroup',
    title,
    metadata: {
      entity_type: 'subgroup',
      group_id: groupId,
    },
  }
}

function makeProject(
  id: string,
  title: string,
  groupId?: string,
): SourceItem {
  return {
    source_id: id,
    source_type: 'project',
    title,
    metadata: {
      entity_type: 'project',
      ...(groupId ? { group_id: groupId } : {}),
    },
  }
}

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

  it('feature label → story_statement', () => {
    expect(inferIssueType(['feature'])).toBe('story_statement')
  })

  it('enhancement label → story_statement', () => {
    expect(inferIssueType(['enhancement'])).toBe('story_statement')
  })

  it('feature request label → story_statement', () => {
    expect(inferIssueType(['feature request'])).toBe('story_statement')
  })

  it('epic label → epic', () => {
    expect(inferIssueType(['epic'])).toBe('epic')
  })

  it('task label → task', () => {
    expect(inferIssueType(['task'])).toBe('task')
  })

  it('chore label → task', () => {
    expect(inferIssueType(['chore'])).toBe('task')
  })

  it('tech-debt label → task', () => {
    expect(inferIssueType(['tech-debt'])).toBe('task')
  })

  it('tech debt label → task', () => {
    expect(inferIssueType(['tech debt'])).toBe('task')
  })

  it('no matching labels → task (default)', () => {
    expect(inferIssueType([])).toBe('task')
    expect(inferIssueType(['wontfix', 'duplicate'])).toBe('task')
  })

  it('issue_type incident overrides all labels', () => {
    expect(inferIssueType(['bug', 'feature'], 'incident')).toBe('incident')
    expect(inferIssueType([], 'incident')).toBe('incident')
  })

  it('bug takes precedence over feature when both labels present', () => {
    expect(inferIssueType(['bug', 'enhancement'])).toBe('bug')
  })

  it('labels are case-insensitive', () => {
    expect(inferIssueType(['Bug'])).toBe('bug')
    expect(inferIssueType(['ENHANCEMENT'])).toBe('story_statement')
    expect(inferIssueType(['Feature Request'])).toBe('story_statement')
  })
})

// ─── Issue entity type mapping ────────────────────────────────────────────────

describe('GitLabAdapter — issue type mapping via labels', () => {
  it('issue with "bug" label maps to bug', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Crash on save', ['bug'])])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('issue with "enhancement" label maps to story_statement', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Dark mode', ['enhancement'])])
    expect(result.nodes[0].type).toBe('story_statement')
  })

  it('issue with "feature" label maps to story_statement', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'New dashboard', ['feature'])])
    expect(result.nodes[0].type).toBe('story_statement')
  })

  it('issue with "epic" label maps to epic', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Auth system', ['epic'])])
    expect(result.nodes[0].type).toBe('epic')
  })

  it('issue with "chore" label maps to task', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Update deps', ['chore'])])
    expect(result.nodes[0].type).toBe('task')
  })

  it('issue with no recognised labels defaults to task with low confidence', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Misc work', [])])
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('low')
  })

  it('issue with issue_type incident maps to incident', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Production outage', ['bug'], { issue_type: 'incident' }),
    ])
    expect(result.nodes[0].type).toBe('incident')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Native Epic mapping ──────────────────────────────────────────────────────

describe('GitLabAdapter — native Epic mapping', () => {
  it('GitLab native Epic maps to epic with high confidence', async () => {
    const result = await adapter.convert([makeEpic('ep-1', 'Auth system epic')])
    expect(result.nodes[0].type).toBe('epic')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('gitlab')
  })

  it('external_id matches source_id for epics', async () => {
    const result = await adapter.convert([makeEpic('ep-42', 'Some epic')])
    expect(result.nodes[0].external_id).toBe('ep-42')
  })
})

// ─── Milestone → release ──────────────────────────────────────────────────────

describe('GitLabAdapter — milestone → release', () => {
  it('milestone maps to release', async () => {
    const result = await adapter.convert([makeMilestone('ms-1', 'v2.0')])
    expect(result.nodes[0].type).toBe('release')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Group / subgroup → product / feature_area ───────────────────────────────

describe('GitLabAdapter — group/subgroup mapping', () => {
  it('top-level group maps to product', async () => {
    const result = await adapter.convert([makeGroup('g-1', 'my-org')])
    expect(result.nodes[0].type).toBe('product')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('subgroup maps to feature_area', async () => {
    const result = await adapter.convert([makeSubgroup('sg-1', 'platform-team', 'g-1')])
    expect(result.nodes[0].type).toBe('feature_area')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('project maps to project', async () => {
    const result = await adapter.convert([makeProject('p-1', 'main-app')])
    expect(result.nodes[0].type).toBe('project')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Merge request + pipeline skipping ───────────────────────────────────────

describe('GitLabAdapter — merge request skipping', () => {
  it('merge request is skipped with warning', async () => {
    const result = await adapter.convert([makeMR('mr-1', 'Fix login bug')])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('merge request')
    expect(warnText).toContain('MRs are engineering collaboration objects')
  })

  it('multiple MRs produce a single summary warning', async () => {
    const result = await adapter.convert([
      makeMR('mr-1', 'MR 1'),
      makeMR('mr-2', 'MR 2'),
    ])
    expect(result.nodes).toHaveLength(0)
    const mrWarning = result.warnings?.find((w) => w.includes('merge requests were not exported'))
    expect(mrWarning).toBeDefined()
  })

  it('MRs skipped but other items convert normally', async () => {
    const result = await adapter.convert([
      makeMR('mr-1', 'Fix login'),
      makeIssue('i-1', 'Dark mode', ['feature']),
    ])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('story_statement')
  })
})

describe('GitLabAdapter — pipeline skipping', () => {
  it('pipeline is skipped with warning', async () => {
    const result = await adapter.convert([makePipeline('pl-1', 'main pipeline')])
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('pipeline')
    expect(warnText).toContain('operational infrastructure')
  })

  it('pipeline and MR together produce separate skip warnings', async () => {
    const result = await adapter.convert([
      makeMR('mr-1', 'A merge request'),
      makePipeline('pl-1', 'A pipeline'),
    ])
    expect(result.nodes).toHaveLength(0)
    const warnTexts = result.warnings?.join(' ') ?? ''
    expect(warnTexts).toContain('merge request')
    expect(warnTexts).toContain('pipeline')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('GitLabAdapter — status normalisation', () => {
  it('opened issue maps to active status', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Open issue', [], { state: 'opened' })])
    expect(result.nodes[0].status).toBe('active')
  })

  it('closed issue maps to complete status', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Done issue', [], { state: 'closed' })])
    expect(result.nodes[0].status).toBe('complete')
  })

  it('reopened issue maps to active status', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Reopened', [], { state: 'reopened' })])
    expect(result.nodes[0].status).toBe('active')
  })

  it('closed epic maps to complete status', async () => {
    const result = await adapter.convert([makeEpic('ep-1', 'Done epic', { state: 'closed' })])
    expect(result.nodes[0].status).toBe('complete')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('GitLabAdapter — edge emission', () => {
  it('release_contains_feature emitted when issue with feature label has milestone_id', async () => {
    const items: SourceItem[] = [
      makeMilestone('ms-1', 'v1.0'),
      makeIssue('i-1', 'Dark mode', ['feature'], { milestone_id: 'ms-1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['ms-1'])
    expect(edge?.target).toBe(result.source_map['i-1'])
  })

  it('release_contains_bug emitted when bug issue has milestone_id', async () => {
    const items: SourceItem[] = [
      makeMilestone('ms-1', 'v1.0'),
      makeIssue('i-1', 'Auth crash', ['bug'], { milestone_id: 'ms-1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_bug')
    const edge = result.edges.find((e) => e.type === 'release_contains_bug')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['ms-1'])
    expect(edge?.target).toBe(result.source_map['i-1'])
  })

  it('epic_specified_by_story_statement emitted when issue has epic_id', async () => {
    const items: SourceItem[] = [
      makeEpic('ep-1', 'Auth system'),
      makeIssue('i-1', 'Login page', ['feature'], { epic_id: 'ep-1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'epic_specified_by_story_statement')
    const edge = result.edges.find((e) => e.type === 'epic_specified_by_story_statement')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['ep-1'])
    expect(edge?.target).toBe(result.source_map['i-1'])
  })

  it('feature_decomposed_into_epic emitted for child epic with parent_id', async () => {
    const items: SourceItem[] = [
      makeEpic('ep-parent', 'Platform epic'),
      makeEpic('ep-child', 'Auth sub-epic', { parent_id: 'ep-parent' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_decomposed_into_epic')
    const edge = result.edges.find((e) => e.type === 'feature_decomposed_into_epic')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['ep-parent'])
    expect(edge?.target).toBe(result.source_map['ep-child'])
  })

  it('project_delivers_epic emitted when epic has project_id', async () => {
    const items: SourceItem[] = [
      makeProject('p-1', 'main-app'),
      makeEpic('ep-1', 'Auth epic', { project_id: 'p-1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project_delivers_epic')
    const edge = result.edges.find((e) => e.type === 'project_delivers_epic')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['p-1'])
    expect(edge?.target).toBe(result.source_map['ep-1'])
  })

  it('product_organises_into_feature_area emitted for subgroup with group_id', async () => {
    const items: SourceItem[] = [
      makeGroup('g-1', 'my-org'),
      makeSubgroup('sg-1', 'platform', 'g-1'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_organises_into_feature_area')
    const edge = result.edges.find((e) => e.type === 'product_organises_into_feature_area')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['g-1'])
    expect(edge?.target).toBe(result.source_map['sg-1'])
  })

  it('product_organises_into_feature_area emitted for project with group_id', async () => {
    const items: SourceItem[] = [
      makeGroup('g-1', 'my-org'),
      makeProject('p-1', 'main-app', 'g-1'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'product_organises_into_feature_area')
    const edge = result.edges.find((e) => e.type === 'product_organises_into_feature_area')
    expect(edge).toBeDefined()
  })

  it('edges NOT emitted when referenced source_ids are outside the import batch', async () => {
    // milestone_id references a milestone not in this batch
    const items: SourceItem[] = [
      makeIssue('i-1', 'Dark mode', ['feature'], { milestone_id: 'ms-external' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges.find((e) => e.type === 'release_contains_feature')).toBeUndefined()
  })
})

// ─── Full fixture: assertAllEdgesCatalogued ───────────────────────────────────

describe('GitLabAdapter — full fixture: all edges are in the UPG catalogue', () => {
  it('all emitted edges pass the catalogue guard', async () => {
    const items: SourceItem[] = [
      makeGroup('g-1', 'acme-org'),
      makeSubgroup('sg-1', 'platform', 'g-1'),
      makeProject('p-1', 'main-app', 'g-1'),
      makeMilestone('ms-1', 'v1.0'),
      makeEpic('ep-root', 'Platform epic', { project_id: 'p-1' }),
      makeEpic('ep-child', 'Auth sub-epic', { parent_id: 'ep-root', project_id: 'p-1' }),
      makeIssue('i-story', 'Login page', ['feature'], { epic_id: 'ep-child', milestone_id: 'ms-1' }),
      makeIssue('i-bug', 'Login crash', ['bug'], { epic_id: 'ep-child', milestone_id: 'ms-1' }),
      makeIssue('i-task', 'Write tests', ['task'], { milestone_id: 'ms-1' }),
      makeIssue('i-incident', 'Production down', ['bug'], { issue_type: 'incident' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'GitLabAdapter full fixture')
    // Nodes: g-1, sg-1, p-1, ms-1, ep-root, ep-child, i-story, i-bug, i-task, i-incident
    expect(result.nodes).toHaveLength(10)
    expect(result.nodes.find((n) => n.type === 'incident')).toBeDefined()
    expect(result.nodes.find((n) => n.type === 'product')).toBeDefined()
    expect(result.nodes.find((n) => n.type === 'feature_area')).toBeDefined()
    expect(result.nodes.find((n) => n.type === 'project')).toBeDefined()
    expect(result.nodes.find((n) => n.type === 'release')).toBeDefined()
    expect(result.nodes.filter((n) => n.type === 'epic')).toHaveLength(2)
  })
})

// ─── Source map, external_tool, external_id ───────────────────────────────────

describe('GitLabAdapter — source_map, external_tool, external_id', () => {
  it('source_map has entries for all converted items', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Feature', ['feature']),
      makeMilestone('ms-1', 'v1.0'),
      makeEpic('ep-1', 'Big epic'),
    ])
    expect(result.source_map['i-1']).toBeDefined()
    expect(result.source_map['ms-1']).toBeDefined()
    expect(result.source_map['ep-1']).toBeDefined()
  })

  it('skipped MRs are NOT in the source_map', async () => {
    const result = await adapter.convert([makeMR('mr-1', 'A MR')])
    expect(result.source_map['mr-1']).toBeUndefined()
  })

  it('external_tool is always gitlab', async () => {
    const result = await adapter.convert([makeIssue('i-1', 'Feature', ['feature'])])
    expect(result.nodes[0].external_tool).toBe('gitlab')
  })

  it('external_id defaults to source_id', async () => {
    const result = await adapter.convert([makeIssue('issue-999', 'Feature', ['feature'])])
    expect(result.nodes[0].external_id).toBe('issue-999')
  })
})

// ─── Exported maps ────────────────────────────────────────────────────────────

describe('GitLabAdapter — exported constants', () => {
  it('GITLAB_ISSUE_LABEL_MAP includes expected labels', () => {
    expect(GITLAB_ISSUE_LABEL_MAP['bug']).toBe('bug')
    expect(GITLAB_ISSUE_LABEL_MAP['enhancement']).toBe('story_statement')
    expect(GITLAB_ISSUE_LABEL_MAP['feature']).toBe('story_statement')
    expect(GITLAB_ISSUE_LABEL_MAP['epic']).toBe('epic')
    expect(GITLAB_ISSUE_LABEL_MAP['task']).toBe('task')
    expect(GITLAB_ISSUE_LABEL_MAP['tech-debt']).toBe('task')
  })

  it('GITLAB_ENTITY_TYPE_MAP maps merge_request to null', () => {
    expect(GITLAB_ENTITY_TYPE_MAP['merge_request']).toBeNull()
    expect(GITLAB_ENTITY_TYPE_MAP['pipeline']).toBeNull()
    expect(GITLAB_ENTITY_TYPE_MAP['epic']).toBe('epic')
    expect(GITLAB_ENTITY_TYPE_MAP['milestone']).toBe('release')
    expect(GITLAB_ENTITY_TYPE_MAP['group']).toBe('product')
    expect(GITLAB_ENTITY_TYPE_MAP['subgroup']).toBe('feature_area')
    expect(GITLAB_ENTITY_TYPE_MAP['project']).toBe('project')
  })

  it('GITLAB_STATUS_MAP normalises GitLab states correctly', () => {
    expect(GITLAB_STATUS_MAP['opened']).toBe('active')
    expect(GITLAB_STATUS_MAP['closed']).toBe('complete')
    expect(GITLAB_STATUS_MAP['merged']).toBe('complete')
    expect(GITLAB_STATUS_MAP['active']).toBe('active')
    expect(GITLAB_STATUS_MAP['upcoming']).toBe('draft')
  })
})

// ─── list() throws ────────────────────────────────────────────────────────────

describe('GitLabAdapter — list()', () => {
  it('throws an error directing user to /upg-import', async () => {
    await expect(adapter.list({})).rejects.toThrow('GitLab adapter requires GitLab API access')
  })
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('GitLabAdapter — edge cases', () => {
  it('returns empty-nodes warning for empty input', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('No items were converted'))).toBe(true)
  })

  it('label warning emitted for issues with non-matching labels', async () => {
    const result = await adapter.convert([
      makeIssue('i-1', 'Mystery issue', ['wontfix', 'duplicate']),
    ])
    expect(result.nodes[0].type).toBe('task')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('no matching type label')
    expect(warnText).toContain('defaulted to')
  })
})
