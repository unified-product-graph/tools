/**
 * Condens Adapter Tests
 *
 * Covers all entity_type mappings, edge emission from parent/child relationships,
 * status normalisation, contact_id enrollment, deferred cluster→insight edges,
 * skipped types (tag), and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CondensAdapter } from '../adapters/condens.js'
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

const adapter = new CondensAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('CondensAdapter — entity_type → UPG type mapping', () => {
  it('project maps to research_study with confidence high', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Onboarding Study', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('condens')
  })

  it('session maps to research_study', async () => {
    const items: SourceItem[] = [makeItem('s1', 'Interview Session 1', 'session')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('transcript maps to observation', async () => {
    const items: SourceItem[] = [makeItem('t1', 'Raw Transcript', 'transcript')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('note maps to observation', async () => {
    const items: SourceItem[] = [makeItem('n1', 'User struggled with filter', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('highlight maps to quote', async () => {
    const items: SourceItem[] = [makeItem('h1', '"I can never find what I need"', 'highlight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('quote')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('category maps to affinity_cluster', async () => {
    const items: SourceItem[] = [makeItem('cat1', 'Navigation Pain Points', 'category')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('affinity_cluster')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('cluster maps to affinity_cluster', async () => {
    const items: SourceItem[] = [makeItem('cl1', 'Search Frustration Cluster', 'cluster')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('affinity_cluster')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('insight maps to insight', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users cannot find the filter', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('insight')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('contact maps to participant', async () => {
    const items: SourceItem[] = [makeItem('c1', 'Alice Smith', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('participant maps to participant', async () => {
    const items: SourceItem[] = [makeItem('part1', 'Bob Jones', 'participant')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Skipped types ────────────────────────────────────────────────────────────

describe('CondensAdapter — skipped types', () => {
  it('tag is skipped and a warning is emitted', async () => {
    const items: SourceItem[] = [
      makeItem('tag1', 'navigation', 'tag'),
      makeItem('n1', 'Real note', 'note'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('observation')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('tag')
    expect(result.source_map['tag1']).toBeUndefined()
  })

  it('unknown entity_type is skipped and a warning is emitted', async () => {
    const items: SourceItem[] = [
      makeItem('unk1', 'Unknown item', 'workspace'),
      makeItem('p1', 'Real project', 'project'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('workspace')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('CondensAdapter — status normalisation', () => {
  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'active' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'active' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })

  it("status 'complete' normalises to 'complete'", async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project', { status: 'complete' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('CondensAdapter — edge emission', () => {
  it('research_study_captures_observation emitted when note has project parent', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Onboarding Study', 'project'),
      makeItem('n1', 'User note', 'note', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project→note')
    const edge = result.edges.find((e) => e.type === 'research_study_captures_observation')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')
  })

  it('research_study_captures_observation emitted when transcript has session parent', async () => {
    const items: SourceItem[] = [
      makeItem('s1', 'Session 1', 'session'),
      makeItem('t1', 'Transcript', 'transcript', { parent_id: 's1', parent_type: 'session' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'session→transcript')
    const edge = result.edges.find((e) => e.type === 'research_study_captures_observation')
    expect(edge).toBeDefined()
  })

  it('observation_evidenced_by_quote emitted when highlight has note parent', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'User note', 'note'),
      makeItem('h1', '"I always get lost"', 'highlight', { parent_id: 'n1', parent_type: 'note' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'note→highlight')
    const edge = result.edges.find((e) => e.type === 'observation_evidenced_by_quote')
    expect(edge).toBeDefined()
  })

  it('research_study_clusters_into_affinity_cluster emitted when cluster has project parent', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Onboarding Study', 'project'),
      makeItem('cl1', 'Nav Cluster', 'cluster', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project→cluster')
    const edge = result.edges.find((e) => e.type === 'research_study_clusters_into_affinity_cluster')
    expect(edge).toBeDefined()
  })

  it('research_study_produces_insight emitted when insight has project parent', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Onboarding Study', 'project'),
      makeItem('i1', 'Users find nav confusing', 'insight', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project→insight')
    const edge = result.edges.find((e) => e.type === 'research_study_produces_insight')
    expect(edge).toBeDefined()
  })

  it('research_study_enrolls_participant emitted when contact has project parent', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Onboarding Study', 'project'),
      makeItem('c1', 'Alice Smith', 'contact', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'project→contact')
    const edge = result.edges.find((e) => e.type === 'research_study_enrolls_participant')
    expect(edge).toBeDefined()
  })

  it('research_study_enrolls_participant emitted via contact_ids on project node', async () => {
    const items: SourceItem[] = [
      makeItem('c1', 'Alice Smith', 'contact'),
      makeItem('p1', 'Onboarding Study', 'project', { contact_ids: ['c1'] }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'contact_ids enrollment')
    const edge = result.edges.find((e) => e.type === 'research_study_enrolls_participant')
    expect(edge).toBeDefined()
  })

  it('affinity_cluster_synthesises_insight edge emitted from deferred cluster_ids', async () => {
    const items: SourceItem[] = [
      makeItem('cl1', 'Nav Cluster', 'cluster'),
      makeItem('i1', 'Nav insight', 'insight', { cluster_ids: ['cl1'] }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'deferred cluster→insight')
    const edge = result.edges.find((e) => e.type === 'affinity_cluster_synthesises_insight')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('missing parent_id emits warning and skips edge', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Orphan note', 'note', { parent_id: 'nonexistent', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('nonexistent')
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Study', 'project'),
      makeItem('s1', 'Session 1', 'session', { parent_id: 'p1', parent_type: 'project' }),
      makeItem('t1', 'Transcript', 'transcript', { parent_id: 's1', parent_type: 'session' }),
      makeItem('n1', 'Note', 'note', { parent_id: 'p1', parent_type: 'project' }),
      makeItem('h1', 'Highlight', 'highlight', { parent_id: 'n1', parent_type: 'note' }),
      makeItem('cl1', 'Cluster', 'cluster', { parent_id: 'p1', parent_type: 'project' }),
      makeItem('i1', 'Insight', 'insight', { parent_id: 'p1', parent_type: 'project', cluster_ids: ['cl1'] }),
      makeItem('c1', 'Participant', 'contact', { parent_id: 'p1', parent_type: 'project' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'CondensAdapter full fixture')
    expect(result.nodes).toHaveLength(8)
  })
})

// ─── Insight warning ──────────────────────────────────────────────────────────

describe('CondensAdapter — insight → opportunity warning', () => {
  it('emits warning when insight nodes are created', async () => {
    const items: SourceItem[] = [makeItem('i1', 'Users find nav confusing', 'insight')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('insight')
    expect(warnText).toContain('insight_informs_opportunity')
    expect(warnText).toContain('PM judgement')
  })

  it('does NOT emit insight warning when no insight nodes are created', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Study', 'project')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).not.toContain('insight_informs_opportunity')
  })
})

// ─── Source map ───────────────────────────────────────────────────────────────

describe('CondensAdapter — source_map', () => {
  it('source_map contains an entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('p1', 'Project', 'project'),
      makeItem('i1', 'Insight', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['p1']).toBeDefined()
    expect(result.source_map['i1']).toBeDefined()
  })

  it('skipped tag items are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeItem('tag1', 'navigation', 'tag')]
    const result = await adapter.convert(items)
    expect(result.source_map['tag1']).toBeUndefined()
  })
})

// ─── External tool / external_id ──────────────────────────────────────────────

describe('CondensAdapter — external_tool and external_id', () => {
  it('external_tool is always condens', async () => {
    const items: SourceItem[] = [makeItem('p1', 'Project', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('condens')
  })

  it('external_id matches source_id', async () => {
    const items: SourceItem[] = [makeItem('condens-abc-123', 'Note', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('condens-abc-123')
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('CondensAdapter — tags', () => {
  it('tags array is preserved on the node', async () => {
    const items: SourceItem[] = [
      makeItem('n1', 'Note with tags', 'note', { tags: ['navigation', 'onboarding'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['navigation', 'onboarding'])
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('CondensAdapter — empty input', () => {
  it('returns empty result with warning when no items provided', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('No Condens items were converted')
  })
})
