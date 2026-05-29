/**
 * Maze Adapter Tests
 *
 * Covers type mapping, status normalisation, edge emission (especially the
 * prototype_tests_hypothesis warning), insight warning, skip cases, and the
 * full catalog check.
 *
 * IMPORTANT: insight_informs_opportunity is NEVER auto-emitted; always a warning.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { MazeAdapter } from '../adapters/maze.js'
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

function makeItem(
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

const adapter = new MazeAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('MazeAdapter: entity type mapping', () => {
  it('maze maps to research_study with high confidence', async () => {
    const items: SourceItem[] = [makeItem('m1', 'Onboarding usability test', 'maze')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('maze')
  })

  it('study also maps to research_study', async () => {
    const items: SourceItem[] = [makeItem('s1', 'Checkout flow test', 'study')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
  })

  it('tester maps to participant with high confidence', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Participant #42', 'tester')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('mission maps to test_plan with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('mi1', 'Complete checkout task', 'mission')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('test_plan')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('block also maps to test_plan', async () => {
    const items: SourceItem[] = [makeItem('b1', 'Task block', 'block')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('test_plan')
  })

  it('result maps to observation with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('r1', 'Participant response', 'result')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('insight maps to insight with high confidence', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users struggle with step 3', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('prototype maps to prototype with medium confidence', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Checkout prototype v2', 'prototype', {
        prototype_url: 'https://www.figma.com/proto/abc123',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('prototype')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('MazeAdapter: skip cases', () => {
  it('clip is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('cl1', 'Session recording', 'clip'),
      makeItem('m1', 'Study', 'maze'),
    ]
    const result = await adapter.convert(items)
    const studyNode = result.nodes.find((n) => n.type === 'research_study')
    expect(studyNode).toBeDefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('behavioral data')
  })

  it('heatmap is skipped', async () => {
    const items: SourceItem[] = [makeItem('hm1', 'Click heatmap', 'heatmap')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('MazeAdapter: status normalisation', () => {
  it("status 'draft' → 'draft'", async () => {
    const items: SourceItem[] = [makeItem('m1', 'Planned test', 'maze', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'running' → 'active'", async () => {
    const items: SourceItem[] = [makeItem('m1', 'Live test', 'maze', { status: 'running' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' → 'complete'", async () => {
    const items: SourceItem[] = [makeItem('m1', 'Done test', 'maze', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'archived' → 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('m1', 'Old test', 'maze', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Insight warning (NEVER auto-emits insight_informs_opportunity) ───────────

describe('MazeAdapter: insight_informs_opportunity is never auto-emitted', () => {
  it('insight node emits PM-judgment warning, not insight_informs_opportunity edge', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users drop off at step 3', 'insight')]
    const result = await adapter.convert(items)
    // No insight_informs_opportunity edge
    const badEdge = result.edges.find((e) => e.type === 'insight_informs_opportunity')
    expect(badEdge).toBeUndefined()
    // Warning must be emitted
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('insight_informs_opportunity')
    expect(warnText).toContain('PM judgment')
  })
})

// ─── prototype_tests_hypothesis warning ──────────────────────────────────────

describe('MazeAdapter: prototype_tests_hypothesis requires PM judgment', () => {
  it('prototype with prototype_url emits warning to create the link manually', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Checkout prototype v2', 'prototype', {
        prototype_url: 'https://www.figma.com/proto/abc123',
      }),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('prototype_tests_hypothesis')
    expect(warnText).toContain('PM judgment')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('MazeAdapter: edge emission', () => {
  it('research_study_enrolls_participant emitted when tester has maze parent', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Test study', 'maze'),
      makeItem('t1', 'Participant', 'tester', { parent_id: 'm1', parent_type: 'maze' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'research_study_enrolls_participant')
    const edge = result.edges.find((e) => e.type === 'research_study_enrolls_participant')
    expect(edge).toBeDefined()
  })

  it('research_study_captures_observation emitted when result has maze parent', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Test study', 'maze'),
      makeItem('r1', 'Response', 'result', { parent_id: 'm1', parent_type: 'maze' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'research_study_captures_observation')
    const edge = result.edges.find((e) => e.type === 'research_study_captures_observation')
    expect(edge).toBeDefined()
  })

  it('research_study_produces_insight emitted when insight has maze parent', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Test study', 'maze'),
      makeItem('i1', 'Key finding', 'insight', { parent_id: 'm1', parent_type: 'maze' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'research_study_produces_insight')
    const edge = result.edges.find((e) => e.type === 'research_study_produces_insight')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Onboarding study', 'maze', { status: 'complete' }),
      makeItem('t1', 'Participant 1', 'tester', { parent_id: 'm1', parent_type: 'maze' }),
      makeItem('t2', 'Participant 2', 'tester', { parent_id: 'm1', parent_type: 'maze' }),
      makeItem('r1', 'Task response 1', 'result', { parent_id: 'm1', parent_type: 'maze' }),
      makeItem('i1', 'Drop-off insight', 'insight', { parent_id: 'm1', parent_type: 'maze' }),
      makeItem('p1', 'Prototype v1', 'prototype', {
        prototype_url: 'https://figma.com/proto/abc',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'MazeAdapter full fixture')
    expect(result.edges.length).toBeGreaterThan(0)
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('MazeAdapter: source_map, external_tool, external_id', () => {
  it('source_map has entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Study', 'maze'),
      makeItem('t1', 'Tester', 'tester'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['m1']).toBeDefined()
    expect(result.source_map['t1']).toBeDefined()
  })

  it('external_tool is always maze', async () => {
    const items: SourceItem[] = [makeItem('m1', 'Study', 'maze')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('maze')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('maze-study-abc', 'Study', 'maze')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('maze-study-abc')
  })
})
