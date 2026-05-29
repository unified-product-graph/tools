/**
 * Jira Adapter Tests
 *
 * Covers all issue type mappings, structural entity mappings, hierarchy edge emission,
 * IssueLink edges, component/version membership edges, status normalisation, warning
 * emission, and source_map correctness.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { JiraAdapter } from '../adapters/jira.js'
import type { SourceItem } from '../types.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

function makeIssue(
  id: string,
  title: string,
  issueType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'issue',
    title,
    metadata: {
      issue_type: issueType,
      ...overrides,
    },
  }
}

function makeStructural(
  id: string,
  title: string,
  entityKind: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: entityKind,
    title,
    metadata: {
      entity_kind: entityKind,
      ...overrides,
    },
  }
}

const adapter = new JiraAdapter()

// ─── Issue type mapping ───────────────────────────────────────────────────────

describe('JiraAdapter: issue_type → entity type mapping', () => {
  it('story maps to user_story with confidence high', async () => {
    const items: SourceItem[] = [makeIssue('i1', 'User can log in', 'Story')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('user_story')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('jira')
  })

  it('"User Story" also maps to user_story', async () => {
    const items: SourceItem[] = [makeIssue('i2', 'User can sign up', 'User Story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('user_story')
  })

  it('task maps to task', async () => {
    const items: SourceItem[] = [makeIssue('i3', 'Update README', 'Task')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('sub-task maps to task', async () => {
    const items: SourceItem[] = [makeIssue('i4', 'Write unit tests', 'Sub-task')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
  })

  it('bug maps to bug with confidence high', async () => {
    const items: SourceItem[] = [makeIssue('i5', 'Login fails on Safari', 'Bug')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('epic maps to epic (literal mapping) with confidence medium and emits hierarchy warning', async () => {
    const items: SourceItem[] = [makeIssue('i6', 'Onboarding Revamp', 'Epic')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('epic')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('literal mapping')
    expect(warnText).toContain('semantic-mode')
  })

  it('incident (JSM) maps to incident', async () => {
    const items: SourceItem[] = [makeIssue('i7', 'Production outage', 'Incident')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('incident')
  })

  it('service request (JSM) maps to support_ticket', async () => {
    const items: SourceItem[] = [makeIssue('i8', 'Reset my password', 'Service Request')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('support_ticket')
  })

  it('initiative (Jira Align) maps to initiative', async () => {
    const items: SourceItem[] = [makeIssue('i9', 'Platform modernisation', 'Initiative')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
  })
})

// ─── Skip / warning cases ─────────────────────────────────────────────────────

describe('JiraAdapter: skip and warning cases', () => {
  it('sprint issue type is skipped and counted in a single warning', async () => {
    const items: SourceItem[] = [
      makeIssue('sp1', 'Sprint 22', 'sprint'),
      makeIssue('sp2', 'Sprint 23', 'sprint'),
      makeIssue('s1', 'User can log in', 'Story'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('user_story')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('sprint')
    expect(warnText).toContain('2 sprint item(s)')
  })

  it('theme (Jira Align) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeIssue('t1', 'Customer Growth Theme', 'Theme')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Theme')
  })

  it('board structural kind is skipped with a warning', async () => {
    const items: SourceItem[] = [makeStructural('b1', 'Eng Board', 'board')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('board')
  })

  it('"relates to" IssueLinks emit a warning and no edge', async () => {
    const items: SourceItem[] = [
      makeIssue('i1', 'Feature A', 'Story'),
      makeIssue('i2', 'Feature B', 'Story', {
        issue_links: [{ link_type: 'relates to', target_id: 'i1' }],
      }),
    ]
    const result = await adapter.convert(items)
    const relatesEdge = result.edges.find((e) => e.type === 'relates_to')
    expect(relatesEdge).toBeUndefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain("'relates to'")
    expect(warnText).toContain('typed edges')
  })
})

// ─── Structural entity types ──────────────────────────────────────────────────

describe('JiraAdapter: structural entity types', () => {
  it('project structural entity maps to project', async () => {
    const items: SourceItem[] = [makeStructural('p1', 'Eng Project', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('project')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('component structural entity maps to feature_area', async () => {
    const items: SourceItem[] = [makeStructural('c1', 'Auth Component', 'component')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature_area')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('version structural entity maps to release', async () => {
    const items: SourceItem[] = [makeStructural('v1', 'v2.0.0', 'version')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('release')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('JiraAdapter: status normalisation', () => {
  it("'To Do' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story', { status: 'To Do' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("'In Progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story', { status: 'In Progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("'Done' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story', { status: 'Done' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("\"Won't Do\" normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story', { status: "Won't Do" })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("'Cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story', { status: 'Cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Hierarchy edge emission ──────────────────────────────────────────────────

describe('JiraAdapter: hierarchy edge emission', () => {
  it('epic_specified_by_user_story emitted when story has epic parent', async () => {
    const items: SourceItem[] = [
      makeIssue('e1', 'Onboarding Revamp', 'Epic'),
      makeIssue('s1', 'User can complete step 1', 'Story', {
        parent_id: 'e1',
        parent_type: 'Epic',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'epic_specified_by_user_story')
    const edge = result.edges.find((e) => e.type === 'epic_specified_by_user_story')
    expect(edge).toBeDefined()
  })

  it('task_implements_user_story emitted when sub-task has story parent', async () => {
    const items: SourceItem[] = [
      makeIssue('s1', 'User can log in', 'Story'),
      makeIssue('t1', 'Write login test', 'Sub-task', {
        parent_id: 's1',
        parent_type: 'Story',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'task_implements_user_story')
    const edge = result.edges.find((e) => e.type === 'task_implements_user_story')
    expect(edge).toBeDefined()
  })

  it('project_delivers_epic emitted when epic has project parent', async () => {
    const items: SourceItem[] = [
      makeStructural('p1', 'Eng Project', 'project'),
      makeIssue('e1', 'Onboarding Revamp', 'Epic', {
        parent_id: 'p1',
        parent_type: 'project',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project_delivers_epic')
    const edge = result.edges.find((e) => e.type === 'project_delivers_epic')
    expect(edge).toBeDefined()
  })

  it('feature_area_contains_feature emitted when story lists a component_id', async () => {
    const items: SourceItem[] = [
      makeStructural('c1', 'Auth Component', 'component'),
      makeIssue('s1', 'User can log in', 'Story', {
        component_ids: ['c1'],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'feature_area_contains_feature')
    const edge = result.edges.find((e) => e.type === 'feature_area_contains_feature')
    expect(edge).toBeDefined()
  })

  it('release_contains_feature emitted when story lists a version_id', async () => {
    const items: SourceItem[] = [
      makeStructural('v1', 'v2.0.0', 'version'),
      makeIssue('s1', 'New login screen', 'Story', {
        version_ids: ['v1'],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
  })

  it('release_contains_bug emitted when bug lists a version_id', async () => {
    const items: SourceItem[] = [
      makeStructural('v1', 'v2.0.0', 'version'),
      makeIssue('b1', 'Login fails on Safari', 'Bug', {
        version_ids: ['v1'],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_bug')
    const edge = result.edges.find((e) => e.type === 'release_contains_bug')
    expect(edge).toBeDefined()
  })

  it('root_cause_causes_bug emitted from "causes" IssueLink', async () => {
    const items: SourceItem[] = [
      makeIssue('rc1', 'Memory leak in handler', 'Bug'),
      makeIssue('b1', 'App crashes on upload', 'Bug', {
        issue_links: [{ link_type: 'is caused by', target_id: 'rc1' }],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'root_cause_causes_bug')
    const edge = result.edges.find((e) => e.type === 'root_cause_causes_bug')
    expect(edge).toBeDefined()
  })

  it('dependency_blocks_team emitted from "blocks" IssueLink', async () => {
    const items: SourceItem[] = [
      makeIssue('s1', 'Auth service ready', 'Story'),
      makeIssue('s2', 'Dashboard needs auth', 'Story', {
        issue_links: [{ link_type: 'blocks', target_id: 's1' }],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'dependency_blocks_team')
    const edge = result.edges.find((e) => e.type === 'dependency_blocks_team')
    expect(edge).toBeDefined()
  })

  it('missing parent emits a warning and no edge', async () => {
    const items: SourceItem[] = [
      makeIssue('s1', 'User can log in', 'Story', {
        parent_id: 'unknown-epic',
        parent_type: 'Epic',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('unknown-epic')
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('JiraAdapter: source_map', () => {
  it('source_map contains an entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeIssue('i1', 'Story', 'Story'),
      makeStructural('p1', 'Project', 'project'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['i1']).toBeDefined()
    expect(result.source_map['p1']).toBeDefined()
  })

  it('skipped sprint items are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeIssue('sp1', 'Sprint 12', 'sprint')]
    const result = await adapter.convert(items)
    expect(result.source_map['sp1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('JiraAdapter: external_tool and external_id', () => {
  it('external_tool is always jira', async () => {
    const items: SourceItem[] = [makeIssue('i1', 'Story', 'Story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('jira')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeIssue('PROJ-123', 'Story', 'Story')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('PROJ-123')
  })
})

// ─── Full fixture ─────────────────────────────────────────────────────────────

describe('JiraAdapter: full fixture', () => {
  it('all emitted edges are in the UPG catalogue (full delivery tree)', async () => {
    const items: SourceItem[] = [
      makeStructural('p1', 'Engineering Project', 'project'),
      makeStructural('v1', 'v2.0.0', 'version'),
      makeStructural('c1', 'Auth Component', 'component'),
      makeIssue('e1', 'Onboarding Revamp', 'Epic', {
        parent_id: 'p1',
        parent_type: 'project',
      }),
      makeIssue('s1', 'User can complete step 1', 'Story', {
        parent_id: 'e1',
        parent_type: 'Epic',
        component_ids: ['c1'],
        version_ids: ['v1'],
      }),
      makeIssue('t1', 'Write step 1 test', 'Sub-task', {
        parent_id: 's1',
        parent_type: 'Story',
      }),
      makeIssue('b1', 'Step 1 shows blank screen', 'Bug', {
        version_ids: ['v1'],
      }),
      makeIssue('b2', 'App crashes after login', 'Bug', {
        issue_links: [{ link_type: 'is caused by', target_id: 'b1' }],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'JiraAdapter full fixture')
    // Edges expected:
    // project_delivers_epic (p1→e1)
    // epic_specified_by_user_story (e1→s1)
    // feature_area_contains_feature (c1→s1)
    // release_contains_feature (v1→s1)
    // task_implements_user_story (s1→t1)
    // release_contains_bug (v1→b1)
    // root_cause_causes_bug (b1→b2)
    expect(result.edges.length).toBe(7)
  })
})
