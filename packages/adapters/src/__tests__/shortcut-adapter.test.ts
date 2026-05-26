/**
 * Shortcut Adapter Tests
 *
 * Covers story_type discrimination, entity type mapping, status normalisation,
 * KR value field preservation, edge emission, iteration skipping, and
 * deprecated milestone handling.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ShortcutAdapter } from '../adapters/shortcut.js'
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

function makeStory(
  id: string,
  title: string,
  storyType?: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'story',
    title,
    metadata: {
      entity_type: 'story',
      ...(storyType ? { story_type: storyType } : {}),
      ...overrides,
    },
  }
}

function makeEntity(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: entityType,
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new ShortcutAdapter()

// ─── Story type discrimination ────────────────────────────────────────────────

describe('ShortcutAdapter — story_type discrimination', () => {
  it('story with story_type "feature" maps to story_statement with confidence high', async () => {
    const result = await adapter.convert([makeStory('s1', 'Add dark mode', 'feature')])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('story_statement')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('shortcut')
  })

  it('story with story_type "bug" maps to bug with confidence high', async () => {
    const result = await adapter.convert([makeStory('s1', 'Crash on login', 'bug')])
    expect(result.nodes[0].type).toBe('bug')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('story with story_type "chore" maps to task with confidence high', async () => {
    const result = await adapter.convert([makeStory('s1', 'Update dependencies', 'chore')])
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('story with missing story_type defaults to story_statement with confidence medium and warning', async () => {
    const result = await adapter.convert([makeStory('s1', 'Vague story')])
    expect(result.nodes[0].type).toBe('story_statement')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('no story_type field')
    expect(warnText).toContain('story_statement')
    expect(warnText).toContain('feature')
  })
})

// ─── Non-story entity type mapping ───────────────────────────────────────────

describe('ShortcutAdapter — entity type mapping', () => {
  it('epic maps to epic with confidence high', async () => {
    const result = await adapter.convert([makeEntity('e1', 'Auth revamp', 'epic')])
    expect(result.nodes[0].type).toBe('epic')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('objective maps to objective with confidence high', async () => {
    const result = await adapter.convert([makeEntity('o1', 'Grow retention', 'objective')])
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key_result maps to key_result with confidence high', async () => {
    const result = await adapter.convert([makeEntity('kr1', 'Reduce churn by 10%', 'key_result')])
    expect(result.nodes[0].type).toBe('key_result')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('key-result (hyphenated) also maps to key_result', async () => {
    const result = await adapter.convert([makeEntity('kr1', 'Churn rate', 'key-result')])
    expect(result.nodes[0].type).toBe('key_result')
  })

  it('team maps to team with confidence high', async () => {
    const result = await adapter.convert([makeEntity('t1', 'Growth team', 'team')])
    expect(result.nodes[0].type).toBe('team')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('project maps to project with confidence high', async () => {
    const result = await adapter.convert([makeEntity('p1', 'Mobile app', 'project')])
    expect(result.nodes[0].type).toBe('project')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('document maps to document with confidence high', async () => {
    const result = await adapter.convert([makeEntity('d1', 'Auth spec', 'document')])
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('task maps to task', async () => {
    const result = await adapter.convert([makeEntity('tk1', 'Write unit tests', 'task')])
    expect(result.nodes[0].type).toBe('task')
  })

  it('deprecated milestone maps to objective with confidence medium and a warning', async () => {
    const result = await adapter.convert([makeEntity('m1', 'Q3 Launch', 'milestone')])
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('deprecated')
    expect(warnText).toContain('objective')
    expect(warnText).toContain('release')
  })
})

// ─── Iteration skipping ───────────────────────────────────────────────────────

describe('ShortcutAdapter — iteration skipping', () => {
  it('iteration is skipped and a warning is emitted with count', async () => {
    const items: SourceItem[] = [
      makeEntity('it1', 'Sprint 12', 'iteration'),
      makeEntity('e1', 'Auth epic', 'epic'),
    ]
    const result = await adapter.convert(items)
    // Only the epic should be converted
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('epic')
    // Warning should mention iteration skip
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Iterations')
    expect(warnText).toContain('1 iteration was skipped')
  })

  it('multiple iterations produce a pluralised summary warning', async () => {
    const items: SourceItem[] = [
      makeEntity('it1', 'Sprint 12', 'iteration'),
      makeEntity('it2', 'Sprint 13', 'iteration'),
      makeEntity('e1', 'Auth epic', 'epic'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 iterations were skipped')
  })

  it('skipped iterations are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeEntity('it1', 'Sprint 12', 'iteration')]
    const result = await adapter.convert(items)
    expect(result.source_map['it1']).toBeUndefined()
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ShortcutAdapter — status normalisation', () => {
  it('"unstarted" normalises to "draft"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Not started', 'feature', { status: 'unstarted' })])
    expect(result.nodes[0].status).toBe('draft')
  })

  it('"to do" normalises to "draft"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Todo', 'feature', { status: 'to do' })])
    expect(result.nodes[0].status).toBe('draft')
  })

  it('"started" normalises to "active"', async () => {
    const result = await adapter.convert([makeStory('s1', 'In flight', 'feature', { status: 'started' })])
    expect(result.nodes[0].status).toBe('active')
  })

  it('"in progress" normalises to "active"', async () => {
    const result = await adapter.convert([makeStory('s1', 'WIP', 'feature', { status: 'in progress' })])
    expect(result.nodes[0].status).toBe('active')
  })

  it('"done" normalises to "complete"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Shipped', 'feature', { status: 'done' })])
    expect(result.nodes[0].status).toBe('complete')
  })

  it('"accepted" normalises to "complete"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Accepted story', 'feature', { status: 'accepted' })])
    expect(result.nodes[0].status).toBe('complete')
  })

  it('"cancelled" normalises to "abandoned"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Dropped', 'feature', { status: 'cancelled' })])
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it('objective with health_status "on_track" gets status "active"', async () => {
    const result = await adapter.convert([
      makeEntity('o1', 'Grow retention', 'objective', { health_status: 'on_track' }),
    ])
    expect(result.nodes[0].status).toBe('active')
  })

  it('objective health_status is preserved as a tag', async () => {
    const result = await adapter.convert([
      makeEntity('o1', 'At-risk objective', 'objective', { health_status: 'at_risk' }),
    ])
    const tags = result.nodes[0].tags ?? []
    expect(tags).toContain('health:at_risk')
  })
})

// ─── Key Result value fields ──────────────────────────────────────────────────

describe('ShortcutAdapter — key_result value field preservation', () => {
  it('current_value, target_value, and unit are preserved on key_result nodes', async () => {
    const result = await adapter.convert([
      makeEntity('kr1', 'Reduce churn by 10%', 'key_result', {
        current_value: 15,
        target_value: 10,
        unit: '%',
      }),
    ])
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(15)
    expect(node.target_value).toBe(10)
    expect(node.unit).toBe('%')
  })

  it('KR value fields are NOT emitted on non-key_result nodes', async () => {
    const result = await adapter.convert([
      makeStory('s1', 'Some feature', 'feature', {
        current_value: 5,
        target_value: 20,
        unit: 'users',
      }),
    ])
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
    expect(node.unit).toBeUndefined()
  })

  it('KR with partial values (only current_value) still preserves what is present', async () => {
    const result = await adapter.convert([
      makeEntity('kr1', 'Incomplete KR', 'key_result', { current_value: 42 }),
    ])
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(42)
    expect(node.target_value).toBeUndefined()
    expect(node.unit).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('ShortcutAdapter — edge emission', () => {
  it('objective_achieved_through_key_result emitted when key_result has objective parent', async () => {
    const items: SourceItem[] = [
      makeEntity('o1', 'Grow retention', 'objective'),
      makeEntity('kr1', 'Reduce churn by 10%', 'key_result', {
        parent_id: 'o1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective → key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['o1'])
    expect(edge?.target).toBe(result.source_map['kr1'])
  })

  it('project_delivers_epic emitted when epic has project parent', async () => {
    const items: SourceItem[] = [
      makeEntity('p1', 'Mobile app', 'project'),
      makeEntity('e1', 'Auth epic', 'epic', {
        parent_id: 'p1',
        parent_type: 'project',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project → epic')
    const edge = result.edges.find((e) => e.type === 'project_delivers_epic')
    expect(edge).toBeDefined()
  })

  it('epic_specified_by_story_statement emitted when feature story has epic parent', async () => {
    const items: SourceItem[] = [
      makeEntity('e1', 'Auth epic', 'epic'),
      makeStory('s1', 'As a user I want to login', 'feature', {
        parent_id: 'e1',
        parent_type: 'epic',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'epic → feature story')
    const edge = result.edges.find((e) => e.type === 'epic_specified_by_story_statement')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['e1'])
    expect(edge?.target).toBe(result.source_map['s1'])
  })

  it('task_implements_story_statement emitted when task has story (feature) parent', async () => {
    const items: SourceItem[] = [
      makeStory('s1', 'Login feature', 'feature'),
      makeEntity('tk1', 'Write login tests', 'task', {
        parent_id: 's1',
        parent_type: 'story',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'story → task')
    const edge = result.edges.find((e) => e.type === 'task_implements_story_statement')
    expect(edge).toBeDefined()
  })

  it('bug_affects_feature emitted when bug story has feature story parent', async () => {
    const items: SourceItem[] = [
      makeStory('s1', 'Login feature', 'feature'),
      makeStory('b1', 'Login crash on empty password', 'bug', {
        parent_id: 's1',
        parent_type: 'story',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'bug → feature')
    const edge = result.edges.find((e) => e.type === 'bug_affects_feature')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['b1'])
    expect(edge?.target).toBe(result.source_map['s1'])
  })

  it('node_owned_by_team emitted when entity has team_id pointing to a team in the batch', async () => {
    const items: SourceItem[] = [
      makeEntity('t1', 'Growth team', 'team'),
      makeStory('s1', 'Growth feature', 'feature', { team_id: 't1' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node → team')
    const edge = result.edges.find((e) => e.type === 'node_owned_by_team')
    expect(edge).toBeDefined()
    expect(edge?.source).toBe(result.source_map['s1'])
    expect(edge?.target).toBe(result.source_map['t1'])
  })

  it('objective→epic emits initiative_drives_outcome (approximation) with a warning', async () => {
    const items: SourceItem[] = [
      makeEntity('o1', 'Grow retention', 'objective'),
      makeEntity('e1', 'Auth epic', 'epic', {
        parent_id: 'o1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective → epic approximation')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('no direct objective→epic edge')
    expect(warnText).toContain('initiative_drives_outcome')
  })

  it('missing parent in batch emits a warning and no edge', async () => {
    const items: SourceItem[] = [
      makeEntity('e1', 'Auth epic', 'epic', {
        parent_id: 'nonexistent-999',
        parent_type: 'project',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent-999')
    expect(warnText).toContain('Edge skipped')
  })
})

// ─── Full fixture — assertAllEdgesCatalogued ──────────────────────────────────

describe('ShortcutAdapter — full fixture catalogue check', () => {
  it('all edges in a complete OKR + delivery chain are catalogued', async () => {
    const items: SourceItem[] = [
      makeEntity('o1', 'Grow retention', 'objective'),
      makeEntity('kr1', 'Reduce churn by 10%', 'key_result', {
        parent_id: 'o1',
        parent_type: 'objective',
        current_value: 15,
        target_value: 10,
        unit: '%',
      }),
      makeEntity('p1', 'Mobile app', 'project'),
      makeEntity('e1', 'Auth epic', 'epic', {
        parent_id: 'p1',
        parent_type: 'project',
      }),
      makeStory('s1', 'Login with email', 'feature', {
        parent_id: 'e1',
        parent_type: 'epic',
      }),
      makeStory('b1', 'Crash on empty password', 'bug', {
        parent_id: 's1',
        parent_type: 'story',
      }),
      makeEntity('tk1', 'Write login tests', 'task', {
        parent_id: 's1',
        parent_type: 'story',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ShortcutAdapter full OKR+delivery fixture')
    // 7 nodes converted (no iterations in fixture)
    expect(result.nodes).toHaveLength(7)
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('ShortcutAdapter — source_map', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeEntity('o1', 'Objective', 'objective'),
      makeStory('s1', 'Feature story', 'feature'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['o1']).toBeDefined()
    expect(result.source_map['s1']).toBeDefined()
  })

  it('skipped iterations are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeEntity('it1', 'Sprint 1', 'iteration')]
    const result = await adapter.convert(items)
    expect(result.source_map['it1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('ShortcutAdapter — external_tool and external_id', () => {
  it('external_tool is always "shortcut"', async () => {
    const result = await adapter.convert([makeStory('s1', 'Feature', 'feature')])
    expect(result.nodes[0].external_tool).toBe('shortcut')
  })

  it('external_id defaults to source_id', async () => {
    const result = await adapter.convert([makeStory('sc-123', 'Feature', 'feature')])
    expect(result.nodes[0].external_id).toBe('sc-123')
  })
})

// ─── Labels as tags ───────────────────────────────────────────────────────────

describe('ShortcutAdapter — labels as tags', () => {
  it('metadata.labels are merged into node tags', async () => {
    const result = await adapter.convert([
      makeStory('s1', 'Tagged story', 'feature', { labels: ['customer-requested', 'q2'] }),
    ])
    expect(result.nodes[0].tags).toEqual(['customer-requested', 'q2'])
  })
})

// ─── list() throws ────────────────────────────────────────────────────────────

describe('ShortcutAdapter — list()', () => {
  it('throws an error directing user to /upg-import', async () => {
    await expect(adapter.list({})).rejects.toThrow('Shortcut adapter requires Shortcut API connection')
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('ShortcutAdapter — edge cases', () => {
  it('returns empty-nodes warning for empty input', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings?.some((w) => w.includes('No entities were converted'))).toBe(true)
  })
})
