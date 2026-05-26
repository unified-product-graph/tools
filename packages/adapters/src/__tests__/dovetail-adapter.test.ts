/**
 * Dovetail Adapter Tests
 *
 * Covers the full entity mapping from Dovetail source types to UPG entity types,
 * edge emission for parent-child relationships, confidence scoring rules,
 * and the insight→opportunity warning.
 *
 */

import { describe, it, expect } from 'vitest'
import { DovetailAdapter } from '../adapters/dovetail.js'
import type { SourceItem } from '../types.js'

// ─── Shared factory ───────────────────────────────────────────────────────────

function makeItem(
  id: string,
  title: string,
  sourceType: string,
  meta: Record<string, unknown> = {},
  content?: string,
): SourceItem {
  return {
    source_id: id,
    source_type: sourceType,
    title,
    ...(content ? { content } : {}),
    metadata: meta,
  }
}

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('DovetailAdapter — entity type mapping', () => {
  const adapter = new DovetailAdapter()

  it('project maps to research_study', async () => {
    const items: SourceItem[] = [makeItem('p-1', 'Mobile usability study', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('research_study')
    expect(result.nodes[0].external_tool).toBe('dovetail')
    expect(result.nodes[0].external_id).toBe('p-1')
  })

  it('data maps to observation', async () => {
    const items: SourceItem[] = [
      makeItem('d-1', 'User struggled with checkout', 'data', {}, 'Took 3 minutes to find the button'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('observation')
  })

  it('note (legacy) maps to observation', async () => {
    const items: SourceItem[] = [makeItem('n-1', 'Confusion at onboarding', 'note')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('observation')
  })

  it('highlight (text) maps to quote with confidence high', async () => {
    const items: SourceItem[] = [
      makeItem('h-1', '"I had no idea where to go"', 'highlight', {}, '"I had no idea where to go"'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('quote')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('highlight (video clip) maps to quote with media_type video and confidence medium', async () => {
    const items: SourceItem[] = [
      makeItem('h-2', 'Session clip', 'highlight', {
        is_video_clip: true,
        start_s: 45,
        end_s: 62,
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const node = result.nodes[0]
    expect(node.type).toBe('quote')
    expect(node.title).toBe('Clip 45s–62s')
    expect(node.mapping_confidence).toBe('medium')
    expect(node.properties).toMatchObject({
      start_timestamp_s: 45,
      end_timestamp_s: 62,
      media_type: 'video',
    })
  })

  it('doc maps to insight', async () => {
    const items: SourceItem[] = [makeItem('doc-1', 'Users want faster checkout', 'doc')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('insight')
  })

  it('insight (legacy name) maps to insight', async () => {
    const items: SourceItem[] = [makeItem('i-1', 'Navigation is confusing', 'insight')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('insight')
  })

  it('theme maps to affinity_cluster', async () => {
    const items: SourceItem[] = [makeItem('t-1', 'Checkout friction', 'theme')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('affinity_cluster')
  })

  it('theme with ai_generated true has confidence medium', async () => {
    const items: SourceItem[] = [
      makeItem('t-2', 'AI-grouped theme', 'theme', { ai_generated: true }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('affinity_cluster')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('contact maps to participant', async () => {
    const items: SourceItem[] = [makeItem('c-1', 'Priya S.', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('participant')
  })

  it('channel maps to feedback_program', async () => {
    const items: SourceItem[] = [makeItem('ch-1', 'Enterprise feedback channel', 'channel')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feedback_program')
  })

  it('topic maps to feedback_theme', async () => {
    const items: SourceItem[] = [makeItem('tp-1', 'Onboarding pain', 'topic')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feedback_theme')
  })

  it('story maps to document', async () => {
    const items: SourceItem[] = [makeItem('s-1', 'Research story', 'story')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
  })
})

// ─── Skipped types ────────────────────────────────────────────────────────────

describe('DovetailAdapter — skipped types', () => {
  const adapter = new DovetailAdapter()

  it('reel is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('r-1', 'Highlight reel Q1', 'reel')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w) => w.includes('reel') || w.includes('Reel'))).toBe(true)
  })

  it('board is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('b-1', 'Analysis board', 'board')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings!.some((w) => w.includes('board') || w.includes('Board'))).toBe(true)
  })

  it('unknown source type is skipped with a warning', async () => {
    const items: SourceItem[] = [makeItem('x-1', 'Mystery item', 'widget')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    expect(result.warnings!.some((w) => w.includes('widget'))).toBe(true)
  })

  it('valid items in same batch are not affected by skipped types', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Study', 'project'),
      makeItem('r-1', 'Reel', 'reel'),
      makeItem('d-1', 'Observation', 'data'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.map((n) => n.type).sort()).toEqual(['observation', 'research_study'])
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('DovetailAdapter — status normalisation', () => {
  const adapter = new DovetailAdapter()

  it('published doc → status complete', async () => {
    const items: SourceItem[] = [
      makeItem('doc-1', 'Insight doc', 'doc', { published: true }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it('unpublished doc → status draft', async () => {
    const items: SourceItem[] = [
      makeItem('doc-1', 'Draft insight', 'doc', { published: false }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it('project has no status set', async () => {
    const items: SourceItem[] = [makeItem('p-1', 'Study', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('DovetailAdapter — edge emission', () => {
  const adapter = new DovetailAdapter()

  it('research_study_captures_observation emitted when data has project_id', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Mobile study', 'project'),
      makeItem('d-1', 'Session observation', 'data', { project_id: 'p-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(1)
    const edge = result.edges[0]
    expect(edge.type).toBe('research_study_captures_observation')
    // Source is the project node, target is the observation node
    expect(edge.source).toBe(result.source_map['p-1'])
    expect(edge.target).toBe(result.source_map['d-1'])
    expect(edge.mapping_confidence).toBe('high')
  })

  it('observation_evidenced_by_quote emitted when highlight has datum_id', async () => {
    const items: SourceItem[] = [
      makeItem('d-1', 'Checkout session', 'data'),
      makeItem('h-1', '"The button was invisible"', 'highlight', { datum_id: 'd-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(1)
    const edge = result.edges[0]
    expect(edge.type).toBe('observation_evidenced_by_quote')
    expect(edge.source).toBe(result.source_map['d-1'])
    expect(edge.target).toBe(result.source_map['h-1'])
    expect(edge.mapping_confidence).toBe('high')
  })

  it('research_study_clusters_into_affinity_cluster emitted when theme has project_id', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Mobile study', 'project'),
      makeItem('t-1', 'Checkout friction', 'theme', { project_id: 'p-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].type).toBe('research_study_clusters_into_affinity_cluster')
    expect(result.edges[0].source).toBe(result.source_map['p-1'])
    expect(result.edges[0].target).toBe(result.source_map['t-1'])
  })

  it('research_study_enrolls_participant emitted when contact has project_id', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Onboarding study', 'project'),
      makeItem('c-1', 'Anya', 'contact', { project_id: 'p-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].type).toBe('research_study_enrolls_participant')
    expect(result.edges[0].source).toBe(result.source_map['p-1'])
    expect(result.edges[0].target).toBe(result.source_map['c-1'])
    expect(result.edges[0].mapping_confidence).toBe('high')
  })

  it('affinity_cluster_synthesises_insight emitted via deferred resolution (theme_ids)', async () => {
    const items: SourceItem[] = [
      makeItem('t-1', 'Checkout friction', 'theme'),
      makeItem('i-1', 'Users abandon checkout due to unclear pricing', 'insight', { theme_ids: ['t-1'] }),
    ]
    const result = await adapter.convert(items)
    const synthEdge = result.edges.find((e) => e.type === 'affinity_cluster_synthesises_insight')
    expect(synthEdge).toBeDefined()
    expect(synthEdge!.source).toBe(result.source_map['t-1'])
    expect(synthEdge!.target).toBe(result.source_map['i-1'])
  })

  it('observation_yields_insight emitted when insight has datum_id', async () => {
    const items: SourceItem[] = [
      makeItem('d-1', 'Checkout observation', 'data'),
      makeItem('i-1', 'Pricing clarity is the root issue', 'insight', { datum_id: 'd-1' }),
    ]
    const result = await adapter.convert(items)
    const yieldEdge = result.edges.find((e) => e.type === 'observation_yields_insight')
    expect(yieldEdge).toBeDefined()
    expect(yieldEdge!.source).toBe(result.source_map['d-1'])
    expect(yieldEdge!.target).toBe(result.source_map['i-1'])
  })

  it('feedback_program_identifies_feedback_theme emitted when topic has channel_id', async () => {
    const items: SourceItem[] = [
      makeItem('ch-1', 'Enterprise channel', 'channel'),
      makeItem('tp-1', 'Onboarding pain', 'topic', { channel_id: 'ch-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].type).toBe('feedback_program_identifies_feedback_theme')
    expect(result.edges[0].source).toBe(result.source_map['ch-1'])
    expect(result.edges[0].target).toBe(result.source_map['tp-1'])
  })

  it('no edges emitted when metadata parent IDs are absent', async () => {
    const items: SourceItem[] = [
      makeItem('d-1', 'Standalone observation', 'data'),  // no project_id
      makeItem('h-1', 'Standalone quote', 'highlight'),  // no datum_id
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
  })

  it('multiple observations linked to same project', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Mobile study', 'project'),
      makeItem('d-1', 'Observation 1', 'data', { project_id: 'p-1' }),
      makeItem('d-2', 'Observation 2', 'data', { project_id: 'p-1' }),
      makeItem('d-3', 'Observation 3', 'data', { project_id: 'p-1' }),
    ]
    const result = await adapter.convert(items)
    const capturesEdges = result.edges.filter((e) => e.type === 'research_study_captures_observation')
    expect(capturesEdges).toHaveLength(3)
  })
})

// ─── Insight → opportunity warning ───────────────────────────────────────────

describe('DovetailAdapter — insight opportunity warning', () => {
  const adapter = new DovetailAdapter()

  it('emits warning when insight nodes are created', async () => {
    const items: SourceItem[] = [
      makeItem('i-1', 'Checkout is confusing', 'insight'),
    ]
    const result = await adapter.convert(items)
    expect(result.warnings).toBeDefined()
    const insightWarning = result.warnings!.find(
      (w) => w.includes('insight') && w.includes('opportunit'),
    )
    expect(insightWarning).toBeDefined()
  })

  it('insight warning includes count', async () => {
    const items: SourceItem[] = [
      makeItem('i-1', 'Insight 1', 'insight'),
      makeItem('i-2', 'Insight 2', 'doc'),
      makeItem('i-3', 'Insight 3', 'doc'),
    ]
    const result = await adapter.convert(items)
    const insightWarning = result.warnings!.find(
      (w) => w.includes('3 insight'),
    )
    expect(insightWarning).toBeDefined()
  })

  it('no insight warning when no insight nodes are created', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Study', 'project'),
      makeItem('d-1', 'Observation', 'data'),
    ]
    const result = await adapter.convert(items)
    const insightWarning = result.warnings?.find(
      (w) => w.includes('insight') && w.includes('opportunit'),
    )
    expect(insightWarning).toBeUndefined()
  })
})

// ─── source_map traceability ──────────────────────────────────────────────────

describe('DovetailAdapter — source_map traceability', () => {
  const adapter = new DovetailAdapter()

  it('source_map contains entries for all converted items', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Study', 'project'),
      makeItem('d-1', 'Observation', 'data', { project_id: 'p-1' }),
      makeItem('h-1', 'Quote', 'highlight', { datum_id: 'd-1' }),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['p-1']).toBeDefined()
    expect(result.source_map['d-1']).toBeDefined()
    expect(result.source_map['h-1']).toBeDefined()
  })

  it('skipped items (reel) are not in source_map', async () => {
    const items: SourceItem[] = [
      makeItem('r-1', 'Reel', 'reel'),
      makeItem('p-1', 'Study', 'project'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['r-1']).toBeUndefined()
    expect(result.source_map['p-1']).toBeDefined()
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('DovetailAdapter — tags', () => {
  const adapter = new DovetailAdapter()

  it('metadata.tags are attached to the node', async () => {
    const items: SourceItem[] = [
      makeItem('p-1', 'Study', 'project', { tags: ['mobile', 'checkout', 'q1-2026'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['mobile', 'checkout', 'q1-2026'])
  })

  it('nodes without tags have no tags property', async () => {
    const items: SourceItem[] = [makeItem('p-1', 'Study', 'project')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toBeUndefined()
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('DovetailAdapter — empty input', () => {
  const adapter = new DovetailAdapter()

  it('returns empty result with warning for empty input', async () => {
    const result = await adapter.convert([])
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.warnings!.some((w) => w.includes('No items'))).toBe(true)
  })
})
