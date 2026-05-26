/**
 * Confluence Adapter Tests
 *
 * Covers page type inference from title and labels, entity type mapping,
 * skip cases, status normalisation, edge emission, and the full catalog check.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { ConfluenceAdapter, inferConfluencePageType } from '../adapters/confluence.js'
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

function makePage(
  id: string,
  title: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'page',
    title,
    metadata: {
      entity_type: 'page',
      ...overrides,
    },
  }
}

const adapter = new ConfluenceAdapter()

// ─── inferConfluencePageType helper ──────────────────────────────────────────

describe('inferConfluencePageType — title + label inference', () => {
  it('label "adr" → decision', () => {
    expect(inferConfluencePageType('Auth redesign', ['adr'])).toBe('decision')
  })

  it('label "research" → research_study', () => {
    expect(inferConfluencePageType('Q3 insights', ['research'])).toBe('research_study')
  })

  it('title contains "retrospective" → observation', () => {
    expect(inferConfluencePageType('Sprint 12 Retrospective', [])).toBe('observation')
  })

  it('title contains "prd" → document', () => {
    expect(inferConfluencePageType('PRD: Search overhaul', [])).toBe('document')
  })

  it('title contains "competitor" → competitor', () => {
    expect(inferConfluencePageType('Competitor analysis — Q3', [])).toBe('competitor')
  })

  it('title contains "persona" → persona', () => {
    expect(inferConfluencePageType('Persona: Power User', [])).toBe('persona')
  })

  it('label takes priority over title pattern', () => {
    // title says "decision" but label says "research"
    expect(inferConfluencePageType('Decision framework', ['research'])).toBe('research_study')
  })

  it('no match → document (default)', () => {
    expect(inferConfluencePageType('Team norms', [])).toBe('document')
  })

  it('title "ADR: Cache invalidation strategy" → decision', () => {
    expect(inferConfluencePageType('ADR: Cache invalidation strategy', [])).toBe('decision')
  })
})

// ─── Entity type mapping ──────────────────────────────────────────────────────

describe('ConfluenceAdapter — entity type mapping', () => {
  it('plain page maps to document by default', async () => {
    const items: SourceItem[] = [makePage('p1', 'Team handbook')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].external_tool).toBe('confluence')
  })

  it('page with "adr" label maps to decision', async () => {
    const items: SourceItem[] = [makePage('p1', 'Auth strategy', { labels: ['adr'] })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('decision')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('page titled "Retrospective" maps to observation', async () => {
    const items: SourceItem[] = [makePage('p1', 'Q2 Retrospective')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
  })

  it('blog post maps to document', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'bp1',
        source_type: 'blogpost',
        title: 'Company update',
        metadata: { entity_type: 'blogpost' },
      },
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
  })

  it('page with "competitor" in title maps to competitor', async () => {
    const items: SourceItem[] = [makePage('p1', 'Competitor analysis — Notion')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('competitor')
  })

  it('research_study mapped from label "user research"', async () => {
    const items: SourceItem[] = [
      makePage('p1', 'Customer discovery', { labels: ['user research'] }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('research_study')
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('ConfluenceAdapter — skip cases', () => {
  it('comment entity type is skipped', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'c1',
        source_type: 'comment',
        title: 'Re: architecture',
        metadata: { entity_type: 'comment' },
      },
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('attachment entity type is skipped', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'a1',
        source_type: 'attachment',
        title: 'diagram.png',
        metadata: { entity_type: 'attachment' },
      },
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('space entity type is skipped', async () => {
    const items: SourceItem[] = [
      {
        source_id: 'sp1',
        source_type: 'space',
        title: 'Engineering Space',
        metadata: { entity_type: 'space' },
      },
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('ConfluenceAdapter — status normalisation', () => {
  it("status 'current' normalises to 'active'", async () => {
    const items: SourceItem[] = [makePage('p1', 'Spec', { status: 'current' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'draft' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makePage('p1', 'Draft spec', { status: 'draft' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'archived' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [makePage('p1', 'Old spec', { status: 'archived' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('ConfluenceAdapter — edge emission', () => {
  it('document_describes_decision emitted when parent=document, child=decision', async () => {
    const items: SourceItem[] = [
      makePage('doc1', 'Architecture overview'),
      makePage('adr1', 'ADR: Use PostgreSQL', {
        labels: ['adr'],
        parent_id: 'doc1',
        parent_type: 'page',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'document_describes_decision')
    const edge = result.edges.find((e) => e.type === 'document_describes_decision')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('high')
  })

  it('document_describes_persona emitted when parent=document, child=persona', async () => {
    const items: SourceItem[] = [
      // Parent must be a generic doc (title must not match persona/decision/etc.)
      makePage('doc1', 'Team reference guide'),
      makePage('p1', 'Persona: Power User', { parent_id: 'doc1', parent_type: 'page' }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'document_describes_persona')
    const edge = result.edges.find((e) => e.type === 'document_describes_persona')
    expect(edge).toBeDefined()
  })

  it('all emitted edges are in the UPG catalogue (full fixture)', async () => {
    const items: SourceItem[] = [
      makePage('root', 'Architecture docs'),
      makePage('adr1', 'ADR: Auth strategy', {
        labels: ['adr'],
        parent_id: 'root',
        parent_type: 'page',
      }),
      makePage('research1', 'User research Q3', {
        labels: ['research'],
        parent_id: 'root',
        parent_type: 'page',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'ConfluenceAdapter full fixture')
  })
})

// ─── Default document warning ─────────────────────────────────────────────────

describe('ConfluenceAdapter — default document warning', () => {
  it('emits warning when pages are mapped to document by default', async () => {
    const items: SourceItem[] = [
      makePage('p1', 'Team handbook'),
      makePage('p2', 'Engineering norms'),
    ]
    const result = await adapter.convert(items)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain("'document' by default")
    expect(warnText).toContain('adr')
  })
})

// ─── Source map and external fields ──────────────────────────────────────────

describe('ConfluenceAdapter — source_map, external_tool, external_id', () => {
  it('source_map has entry for each converted page', async () => {
    const items: SourceItem[] = [makePage('p1', 'Doc 1'), makePage('p2', 'Doc 2')]
    const result = await adapter.convert(items)
    expect(result.source_map['p1']).toBeDefined()
    expect(result.source_map['p2']).toBeDefined()
  })

  it('external_tool is always confluence', async () => {
    const items: SourceItem[] = [makePage('p1', 'Doc')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('confluence')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makePage('conf-page-12345', 'Doc')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('conf-page-12345')
  })

  it('space_key is added as a tag', async () => {
    const items: SourceItem[] = [makePage('p1', 'Doc', { space_key: 'ENG' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toContain('space:ENG')
  })
})
