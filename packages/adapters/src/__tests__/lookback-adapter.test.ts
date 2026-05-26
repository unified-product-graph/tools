/**
 * Lookback Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation, timestamp_seconds preservation on moment (quote) nodes,
 * skipped types (recording, screenshare, tag), and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { LookbackAdapter } from '../adapters/lookback.js'
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

const adapter = new LookbackAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('LookbackAdapter — entity_type → UPG type mapping', () => {
  it('project maps to research_study with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Checkout Flow Study', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('lookback')
  })

  it('session maps to research_study', async () => {
    const items: SourceItem[] = [makeItem('s1', 'Interview with Alice', 'session')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('moment maps to quote with confidence high', async () => {
    const items: SourceItem[] = [makeItem('m1', 'User confused by button', 'moment')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('quote')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('note maps to observation', async () => {
    const items: SourceItem[] = [makeItem('n1', 'User paused for 10 seconds', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('insight maps to insight', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Checkout flow creates confusion', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('participant maps to participant', async () => {
    const items: SourceItem[] = [makeItem('part1', 'Carol Davis', 'participant')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Skipped types ────────────────────────────────────────────────────────────

describe('LookbackAdapter — skipped types', () => {
  it('recording is skipped with warning about binary data', async () => {
    const items: SourceItem[] = [
      makeItem('r1', 'Session Recording', 'recording'),
      makeItem('n1', 'Researcher note', 'note'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('observation')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('recording')
    expect(warnText).toContain('binary')
  })

  it('screenshare is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('ss1', 'Screen Recording', 'screenshare'),
      makeItem('m1', 'User moment', 'moment'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('quote')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('screenshare')
  })

  it('tag is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('tag1', 'confusion', 'tag'),
      makeItem('m1', 'User moment', 'moment'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.source_map['tag1']).toBeUndefined()
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('tag')
  })

  it('unknown entity_type is skipped with warning', async () => {
    const items: SourceItem[] = [
      makeItem('unk1', 'Heatmap thing', 'heatmap'),
      makeItem('p1', 'Project', 'project'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('heatmap')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('LookbackAdapter — status normalisation', () => {
  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'live' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('s1', 'Session', 'session', { status: 'live' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Timestamp preservation ───────────────────────────────────────────────────

describe('LookbackAdapter — timestamp_seconds on moment nodes', () => {
  it('timestamp_seconds is preserved on moment (quote) nodes', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'User said "this is confusing"', 'moment', { timestamp_seconds: 142 }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('quote')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.timestamp_seconds).toBe(142)
  })

  it('timestamp_seconds is NOT added to non-moment nodes', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Researcher note', 'note', { timestamp_seconds: 50 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.timestamp_seconds).toBeUndefined()
  })

  it('moment without timestamp_seconds does not crash', async () => {
    const items: SourceItem[] = [
      makeItem('m1', 'Moment without timestamp', 'moment'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('quote')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.timestamp_seconds).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('LookbackAdapter — edge emission', () => {
  it('research_study_captures_observation emitted when note has session parent', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Session 1', 'session'),
      makeItem('n1', 'Researcher note', 'note', { parent_id: 's1', parent_type: 'session' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'session→note')
    const edge = result.edges.find((e) => e.type === 'research_study_captures_observation')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')
  })

  it('observation_evidenced_by_quote emitted when moment has session parent', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Session 1', 'session'),
      makeItem('m1', 'Moment', 'moment', { parent_id: 's1', parent_type: 'session', timestamp_seconds: 90 }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'session→moment')
    const edge = result.edges.find((e) => e.type === 'observation_evidenced_by_quote')
    expect(edge).toBeDefined()
  })

  it('observation_evidenced_by_quote emitted when moment has note parent', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Note', 'note'),
      makeItem('m1', 'Moment', 'moment', { parent_id: 'n1', parent_type: 'note' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'note→moment')
    const edge = result.edges.find((e) => e.type === 'observation_evidenced_by_quote')
    expect(edge).toBeDefined()
  })

  it('research_study_produces_insight emitted when insight has project parent', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Project', 'project'),
      makeItem('i1', 'Checkout insight', 'insight', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project→insight')
    const edge = result.edges.find((e) => e.type === 'research_study_produces_insight')
    expect(edge).toBeDefined()
  })

  it('research_study_enrolls_participant emitted when participant has session parent', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Session', 'session'),
      makeItem('part1', 'Alice', 'participant', { parent_id: 's1', parent_type: 'session' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'session→participant')
    const edge = result.edges.find((e) => e.type === 'research_study_enrolls_participant')
    expect(edge).toBeDefined()
  })

  it('missing parent emits warning and skips edge', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Note', 'note', { parent_id: 'ghost', parent_type: 'session' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('ghost')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Project', 'project'),
      makeItem('s1', 'Session', 'session', { parent_id: 'p1', parent_type: 'project' }),
      makeItem('n1', 'Note', 'note', { parent_id: 's1', parent_type: 'session' }),
      makeItem('m1', 'Moment', 'moment', { parent_id: 'n1', parent_type: 'note', timestamp_seconds: 60 }),
      makeItem('i1', 'Insight', 'insight', { parent_id: 'p1', parent_type: 'project' }),
      makeItem('part1', 'Alice', 'participant', { parent_id: 's1', parent_type: 'session' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'LookbackAdapter full fixture')
    expect(result.nodes).toHaveLength(6)
  })
})

// ─── Insight warning ──────────────────────────────────────────────────────────

describe('LookbackAdapter — insight → opportunity warning', () => {
  it('emits warning when insight nodes are created', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Checkout confuses users', 'insight')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('insight_informs_opportunity')
    expect(warnText).toContain('PM judgement')
  })

  it('does NOT emit insight warning when no insights', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).not.toContain('insight_informs_opportunity')
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('LookbackAdapter — source_map and external fields', () => {
  it('source_map contains entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Project', 'project'),
      makeItem('m1', 'Moment', 'moment'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['p1']).toBeDefined()
    expect(result.source_map['m1']).toBeDefined()
  })

  it('skipped recording is NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('r1', 'Recording', 'recording')]
    const result = await adapter.convert(items)
    expect(result.source_map['r1']).toBeUndefined()
  })

  it('external_tool is always lookback', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('lookback')
  })

  it('external_id matches source_id', async () => {
    const items: SourceItem[] = [makeItem('lb-session-999', 'Session', 'session')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('lb-session-999')
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('LookbackAdapter — empty input', () => {
  it('returns empty result with warning when no items provided', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('No Lookback items were converted')
  })
})
