/**
 * Slack Adapter Tests
 *
 * Covers type mapping, message/thread skip warnings, channel_name tag,
 * source_map, external_tool, external_id, and the full catalog check.
 *
 * CRITICAL: Regular messages and threads must ALWAYS be skipped with targeted
 * warnings recommending a Slack capture integration.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { SlackAdapter } from '../adapters/slack.js'
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

const adapter = new SlackAdapter()

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('SlackAdapter — entity type mapping', () => {
  it('canvas maps to document with high confidence', async () => {
    const items: SourceItem[] = [makeItem('cv1', 'Decision Log', 'canvas')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('slack')
  })

  it('bookmark maps to document with high confidence', async () => {
    const items: SourceItem[] = [makeItem('bk1', 'Design system link', 'bookmark')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('pinned_message maps to observation with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('pm1', 'Key decision pinned', 'pinned_message')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('file maps to document with medium confidence', async () => {
    const items: SourceItem[] = [makeItem('f1', 'Q3 strategy.pdf', 'file')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('SlackAdapter — skip cases', () => {
  it('regular message is skipped and counted in warning', async () => {
    const items: SourceItem[] = [
      makeItem('msg1', 'Hey team', 'message'),
      makeItem('msg2', 'Sounds good', 'message'),
      makeItem('cv1', 'Decision Log', 'canvas'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('document')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 regular Slack message')
    expect(warnText).toContain('Slack capture integration')
  })

  it('thread is skipped and counted in its own warning', async () => {
    const items: SourceItem[] = [
      makeItem('th1', 'Design thread', 'thread'),
      makeItem('th2', 'Follow-up thread', 'thread'),
      makeItem('cv1', 'Canvas', 'canvas'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('2 Slack thread')
    expect(warnText).toContain('Slack capture integration')
  })

  it('channel is skipped silently', async () => {
    const items: SourceItem[] = [makeItem('ch1', '#product', 'channel')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('workflow is skipped silently', async () => {
    const items: SourceItem[] = [makeItem('wf1', 'Daily standup bot', 'workflow')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('canvas_section is skipped silently', async () => {
    const items: SourceItem[] = [makeItem('cs1', 'Introduction section', 'canvas_section')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Message skip warning content ────────────────────────────────────────────

describe('SlackAdapter — message skip warning', () => {
  it('singular "message" in warning when count is 1', async () => {
    const items: SourceItem[] = [makeItem('msg1', 'One message', 'message')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('1 regular Slack message was skipped')
    expect(warnText).toContain('Slack capture integration')
  })

  it('thread warning mentions capture integration', async () => {
    const items: SourceItem[] = [makeItem('th1', 'Thread', 'thread')]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Slack capture integration')
  })
})

// ─── channel_name tag ─────────────────────────────────────────────────────────

describe('SlackAdapter — channel_name as tag', () => {
  it('channel_name is added as a tag on imported nodes', async () => {
    const items: SourceItem[] = [
      makeItem('cv1', 'Decision Log', 'canvas', { channel_name: 'product' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('channel:product')
  })

  it('node without channel_name has no channel tag', async () => {
    const items: SourceItem[] = [makeItem('cv1', 'Canvas', 'canvas')]
    const result = await adapter.convert(items)
    const channelTags = (result.nodes[0].tags ?? []).filter((t) => t.startsWith('channel:'))
    expect(channelTags).toHaveLength(0)
  })

  it('author is added as a tag when present', async () => {
    const items: SourceItem[] = [
      makeItem('pm1', 'Pinned note', 'pinned_message', {
        author: 'alice',
        channel_name: 'decisions',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('author:alice')
    expect(result.nodes[0].tags).toContain('channel:decisions')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('SlackAdapter — edge emission', () => {
  it('parent-child edges use node_informs_node (Slack structure is flat)', async () => {
    const items: SourceItem[] = [
      makeItem('cv1', 'Decision Log', 'canvas'),
      makeItem('bk1', 'Related bookmark', 'bookmark', {
        parent_id: 'cv1',
        parent_type: 'canvas',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'SlackAdapter edges')
    if (result.edges.length > 0) {
      expect(result.edges[0].type).toBe('node_informs_node')
    }
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makeItem('cv1', 'Hypothesis Backlog', 'canvas', { channel_name: 'product' }),
      makeItem('bk1', 'Design system link', 'bookmark', { channel_name: 'design' }),
      makeItem('pm1', 'Pinned decision', 'pinned_message', { channel_name: 'decisions' }),
      makeItem('f1', 'Strategy doc.pdf', 'file', { channel_name: 'strategy' }),
      makeItem('msg1', 'Just chatting', 'message'),
      makeItem('th1', 'Thread', 'thread'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'SlackAdapter full fixture')
    // Exactly 4 product knowledge nodes (canvas, bookmark, pinned, file)
    expect(result.nodes).toHaveLength(4)
    // 2 skip warnings (messages + threads)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('1 regular Slack message')
    expect(warnText).toContain('1 Slack thread')
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('SlackAdapter — source_map, external_tool, external_id', () => {
  it('source_map has entry for each converted item', async () => {
    const items: SourceItem[] = [
      makeItem('cv1', 'Canvas 1', 'canvas'),
      makeItem('bk1', 'Bookmark 1', 'bookmark'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['cv1']).toBeDefined()
    expect(result.source_map['bk1']).toBeDefined()
  })

  it('skipped messages are NOT in source_map', async () => {
    const items: SourceItem[] = [makeItem('msg1', 'Just a message', 'message')]
    const result = await adapter.convert(items)
    expect(result.source_map['msg1']).toBeUndefined()
  })

  it('external_tool is always slack', async () => {
    const items: SourceItem[] = [makeItem('cv1', 'Canvas', 'canvas')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('slack')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeItem('slack-canvas-abc', 'Canvas', 'canvas')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('slack-canvas-abc')
  })
})
