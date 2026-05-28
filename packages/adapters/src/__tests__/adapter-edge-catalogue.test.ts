/**
 * Adapter Edge Catalogue Regression Tests
 *
 * Verifies that every edge type emitted by the import adapters is registered
 * in the canonical UPG edge catalogue. Adapters must resolve edges through
 * `resolveContainmentEdge` (or an equivalent typed lookup) rather than
 * concatenating raw template strings like `${parent}_contains_${child}`,
 * which produces uncatalogued edges at runtime.
 *
 * Each suite:
 * 1. Runs a small fixture through the adapter's `convert()` method.
 * 2. Asserts that every edge in the result has a `type` that is in
 *    `UPG_EDGE_TYPES` (the canonical catalogue set).
 * 3. Spot-checks that known catalogue-hit pairings return the exact key.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES, resolveContainmentEdge } from '@unified-product-graph/core'
import { MarkdownAdapter } from '../adapters/markdown.js'
import { NotionAdapter } from '../adapters/notion.js'
import { LinearAdapter } from '../adapters/linear.js'
import { GitHubAdapter } from '../adapters/github.js'
import type { SourceItem } from '../types.js'

// ─── Shared assertion helper ──────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

// ─── resolveContainmentEdge unit tests ───────────────────────────────────────

describe('resolveContainmentEdge', () => {
  it('returns the canonical key for a registered (parent, child) pair', () => {
    expect(resolveContainmentEdge('feature_area', 'feature')).toBe('feature_area_contains_feature')
    expect(resolveContainmentEdge('feature_area', 'feature_area')).toBe('feature_area_contains_feature_area')
    expect(resolveContainmentEdge('product', 'screen')).toBe('product_contains_screen')
    expect(resolveContainmentEdge('program', 'epic')).toBe('program_contains_epic')
    expect(resolveContainmentEdge('aggregate', 'domain_entity')).toBe('aggregate_contains_domain_entity')
  })

  it('returns null for pairs that are not in the catalogue', () => {
    // Truly uncatalogued pairs fall through to null so the adapter can use
    // node_informs_node. `feature → task` and `epic → task` were registered
    // as `feature_decomposes_into_task` / `epic_decomposes_into_task` after
    // this test was first written, so they now resolve non-null. Pick two
    // pairs that are still genuinely outside the catalog.
    expect(resolveContainmentEdge('feature', 'persona')).toBeNull()
    expect(resolveContainmentEdge('bug', 'persona')).toBeNull()
  })

  it('returns the correct edge for release containment (added to catalogue)', () => {
    expect(resolveContainmentEdge('release', 'feature')).toBe('release_contains_feature')
    expect(resolveContainmentEdge('release', 'bug')).toBe('release_contains_bug')
  })

  it('returns null for entirely unknown types', () => {
    expect(resolveContainmentEdge('widget', 'gadget')).toBeNull()
    expect(resolveContainmentEdge('user_story', 'task')).toBeNull()
  })
})

// ─── Markdown adapter ─────────────────────────────────────────────────────────

describe('MarkdownAdapter — edges are all catalogued', () => {
  const adapter = new MarkdownAdapter()

  it('emits only catalogued edge types for a flat product→feature tree', async () => {
    const items = await adapter.list({
      content: [
        '# My Product',
        '',
        '## Login Feature',
        '',
        '### User Authentication Epic',
      ].join('\n'),
    })
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'MarkdownAdapter flat tree')
    expect(result.nodes.length).toBeGreaterThan(0)
  })

  it('emits only catalogued edge types for a multi-entity document', async () => {
    const items = await adapter.list({
      content: [
        '# Product Vision',
        '',
        '## Feature Area',
        'Type: feature_area',
        '',
        '### Core Feature',
        'Type: feature',
        '',
        '## User Persona',
        'Type: persona',
        '',
        '### User Job',
        'Type: job',
      ].join('\n'),
    })
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'MarkdownAdapter multi-entity')
  })

  it('maps "story"/"user story" headings to user_story (not story_statement)', async () => {
    const items = await adapter.list({
      content: [
        '# Feature',
        '',
        '## User Story for login',
        '',
        '## Story: checkout flow',
      ].join('\n'),
    })
    const result = await adapter.convert(items)
    const storyNodes = result.nodes.filter((n) => n.type === 'user_story')
    const legacyNodes = result.nodes.filter((n) => n.type === 'story_statement')
    expect(storyNodes.length).toBeGreaterThan(0)
    expect(legacyNodes.length).toBe(0)
    assertAllEdgesCatalogued(result.edges, 'MarkdownAdapter user_story mapping')
  })

  it('experiment headings map to the canonical experiment type', async () => {
    const items = await adapter.list({
      content: [
        '# Product',
        '',
        '## Experiment: pricing test',
      ].join('\n'),
    })
    const result = await adapter.convert(items)
    const experimentNodes = result.nodes.filter((n) => n.type === 'experiment')
    expect(experimentNodes.length).toBeGreaterThan(0)
    assertAllEdgesCatalogued(result.edges, 'MarkdownAdapter experiment')
  })
})

// ─── Notion adapter ───────────────────────────────────────────────────────────

describe('NotionAdapter — edges are all catalogued', () => {
  const adapter = new NotionAdapter()

  const makeItem = (
    id: string,
    title: string,
    sourceType: string,
    dbName?: string,
    children?: SourceItem[],
  ): SourceItem => ({
    source_id: id,
    source_type: sourceType,
    title,
    metadata: dbName ? { database_name: dbName } : {},
    children,
  })

  it('emits only catalogued edge types for nested database items', async () => {
    const items: SourceItem[] = [
      makeItem('epic-1', 'Authentication epic', 'database_item', 'Epics', [
        makeItem('story-1', 'Login story', 'database_item', 'User Stories'),
        makeItem('feat-1', 'MFA feature', 'database_item', 'Features'),
      ]),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'NotionAdapter nested items')
    expect(result.edges.length).toBe(2)
  })

  it('"User Stories" database maps to user_story (not story_statement)', async () => {
    const items: SourceItem[] = [
      makeItem('s-1', 'As a user...', 'database_item', 'User Stories'),
    ]
    const result = await adapter.convert(items)
    const storyNodes = result.nodes.filter((n) => n.type === 'user_story')
    const legacyNodes = result.nodes.filter((n) => n.type === 'story_statement')
    expect(storyNodes.length).toBe(1)
    expect(legacyNodes.length).toBe(0)
  })

  it('emits only catalogued edge types for feature_area → feature hierarchy', async () => {
    const items: SourceItem[] = [
      makeItem('fa-1', 'Auth Area', 'database_item', 'Feature Areas', [
        makeItem('f-1', 'Login', 'database_item', 'Features'),
      ]),
    ]
    // Override: the test is checking edges when a feature_area contains a feature.
    // The notion adapter infers entityType from DB name; feature_area isn't in
    // DATABASE_TYPE_MAP, so it defaults to 'insight'. Verify edges are still catalogued.
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'NotionAdapter feature_area hierarchy')
  })
})

// ─── Linear adapter ───────────────────────────────────────────────────────────

describe('LinearAdapter — edges are all catalogued', () => {
  const adapter = new LinearAdapter()

  it('emits only catalogued edge types for project → issues hierarchy', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'proj-1',
        source_type: 'project',
        title: 'Authentication',
        metadata: {},
        children: [
          {
            source_id: 'issue-1',
            source_type: 'issue',
            title: 'Implement login',
            metadata: { labels: [] },
          },
          {
            source_id: 'issue-2',
            source_type: 'issue',
            title: 'Fix auth bug',
            metadata: { labels: ['bug'] },
          },
          {
            source_id: 'sub-1',
            source_type: 'sub_issue',
            title: 'Write tests',
            metadata: { labels: [] },
          },
        ],
      },
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'LinearAdapter project→issues hierarchy')
    expect(result.nodes.length).toBe(4)
  })

  it('emits only catalogued edge types for cycle (release) items', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'cycle-1',
        source_type: 'cycle',
        title: 'Sprint 12',
        metadata: {},
        children: [
          {
            source_id: 'issue-1',
            source_type: 'issue',
            title: 'Ship dark mode',
            metadata: { labels: ['feature'] },
          },
        ],
      },
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'LinearAdapter cycle hierarchy')
  })

  it('unlabelled issues default to task (not user_story or story_statement)', async () => {
    // The new LinearAdapter discriminates via issue_type (issueType.name from Linear API).
    // Without issue_type or recognised labels, unlabelled issues become task.
    const items: SourceItem[] = [
      {
        source_id: 'issue-1',
        source_type: 'issue',
        title: 'Allow users to reset password',
        metadata: { labels: [] },
      },
    ]
    const result = await adapter.convert(items)
    const taskNodes = result.nodes.filter((n) => n.type === 'task')
    const legacyNodes = result.nodes.filter((n) => n.type === 'user_story')
    expect(taskNodes.length).toBe(1)
    expect(legacyNodes.length).toBe(0)
  })
})

// ─── GitHub adapter ───────────────────────────────────────────────────────────

describe('GitHubAdapter — edges are all catalogued', () => {
  const adapter = new GitHubAdapter()

  it('emits only catalogued edge types for milestone → issue linkage', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'ms-1',
        source_type: 'milestone',
        title: 'v1.0',
        metadata: { state: 'open' },
      },
      {
        source_id: 'issue-1',
        source_type: 'issue',
        title: 'Add dark mode',
        metadata: { labels: ['enhancement'], state: 'open', milestone_id: 'ms-1' },
      },
      {
        source_id: 'issue-2',
        source_type: 'issue',
        title: 'Fix crash on startup',
        metadata: { labels: ['bug'], state: 'open', milestone_id: 'ms-1' },
      },
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'GitHubAdapter milestone→issues')
    expect(result.edges.length).toBe(2) // one per issue that has a milestone
  })

  it('emits only catalogued edge types when issues have child task items', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'issue-1',
        source_type: 'issue',
        title: 'Build authentication',
        metadata: { labels: ['feature'], state: 'open' },
        children: [
          {
            source_id: 'task-1',
            source_type: 'task_item',
            title: 'Write unit tests',
          },
          {
            source_id: 'task-2',
            source_type: 'task_item',
            title: 'Add E2E tests',
          },
        ],
      },
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'GitHubAdapter issue→tasks')
    expect(result.edges.length).toBe(2)
  })

  it('release→feature edge falls back to node_informs_node (not in catalogue)', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'ms-1',
        source_type: 'milestone',
        title: 'v2.0',
        metadata: { state: 'open' },
      },
      {
        source_id: 'issue-1',
        source_type: 'issue',
        title: 'New dashboard',
        metadata: { labels: ['feature'], state: 'open', milestone_id: 'ms-1' },
      },
    ]
    const result = await adapter.convert(items)
    // release_contains_feature is in the catalogue — adapter emits it directly.
    expect(result.edges.length).toBe(1)
    const releaseEdge = result.edges[0]
    expect(releaseEdge.type).toBe('release_contains_feature')
    expect(releaseEdge.mapping_confidence).toBe('medium')
  })
})
