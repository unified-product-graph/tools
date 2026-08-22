/**
 * `upsert_composition` at the WIRE level (0.34.0).
 *
 * The SDK suite proves the write semantics. This suite proves the two things
 * that only exist on this side of the seam:
 *
 *   - The ARGUMENT PLUMBING. `members` omitted must reach the primitive as
 *     `undefined` (preserve the stored arrangement) and `members: []` must
 *     reach it as an empty array (clear it). Those are different instructions,
 *     and a handler that defaults one into the other loses a published layout
 *     the first time somebody retires a view.
 *   - The INPUT SCHEMA. Half the argument for this tool existing is that it
 *     declares `UPGViewQuery`, `UPGViewPresentation` and `CompositionMember`
 *     INLINE. `get_entity_schema('composition')` cannot: those are `object` /
 *     `object[]` in the runtime property registry, so an agent reading it gets
 *     three opaque blobs. If the shapes silently vanish from this schema the
 *     tool loses the reason it was not just three generic calls.
 *
 * Fixture is a fictional product ("Larkfield Tools").
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { readComposition } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { getToolHandler, TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
  type ToolResult,
} from '../lib/server-context.js'

const TOOL = 'upsert_composition'

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p_larkfield', title: 'Larkfield Tools', stage: 'concept' },
    nodes: [
      { id: 'n_surveyor', type: 'persona' as UPGEntityType, title: 'Field Surveyor' },
      { id: 'n_route', type: 'feature' as UPGEntityType, title: 'Route planner' },
    ] as UPGBaseNode[],
    edges: [],
  }
}

let store: UPGFileStore
let file: string
let ctx: ToolContext

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upg-upsert-composition-'))
  file = join(dir, 'larkfield.upg')
  writeFileSync(file, JSON.stringify(makeDoc(), null, 2))
  store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  ctx = {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
})

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const handler = getToolHandler(TOOL)
  if (!handler) throw new Error(`No handler registered for ${TOOL}`)
  return await handler(args, ctx)
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

function member(id: string, title: string, x: number) {
  return { id, href: `/view/${id}`, title, x, y: 0, width: 6, height: 4 }
}

// ── Registration ────────────────────────────────────────────────────────────

describe('registration', () => {
  it('is declared once and bound to a handler', () => {
    const defs = TOOL_DEFINITIONS.filter((d) => d.name === TOOL)
    expect(defs).toHaveLength(1)
    expect(getToolHandler(TOOL)).toBeTypeOf('function')
    expect(defs[0].inputSchema.required).toEqual(['slug', 'title', 'lifecycle'])
  })
})

// ── The inline schema, which is half the reason the tool exists ─────────────

describe('the input schema declares the view shapes inline', () => {
  const props = () =>
    TOOL_DEFINITIONS.find((d) => d.name === TOOL)!.inputSchema.properties as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >

  it('declares CompositionMember rather than leaving members an opaque object[]', () => {
    const items = props().members.items
    expect(Object.keys(items.properties).sort()).toEqual(
      ['collapsed', 'derived', 'height', 'href', 'id', 'title', 'width', 'x', 'y'].sort(),
    )
    expect(items.required).toEqual(['id', 'href', 'title', 'x', 'y', 'width', 'height'])
  })

  it('declares UPGViewQuery rather than leaving member_query an opaque object', () => {
    const q = props().member_query
    expect(q.type).toBe('object')
    for (const field of [
      'types',
      'status',
      'status_category',
      'tags',
      'classified_as',
      'properties',
      'include_archived',
      'match',
      'from_focus',
      'clauses',
    ]) {
      expect(Object.keys(q.properties)).toContain(field)
    }
    // `from_focus.depth` admits the named arm, not just a number: a relative
    // selection over a tree has no correct finite depth.
    expect(JSON.stringify(q.properties.from_focus.properties.depth)).toContain('unbounded')
  })

  it('reflects the 0.34.0 clause union: the type axis carries entity types', () => {
    const clause = props().member_query.properties.clauses.items
    expect(clause.oneOf).toHaveLength(2)
    const [typeArm, genericArm] = clause.oneOf
    expect(typeArm.properties.dimension.enum).toEqual(['type'])
    expect(genericArm.properties.dimension.enum).not.toContain('type')
    // Every other axis of UPGViewDimension is still reachable.
    expect(genericArm.properties.dimension.enum).toEqual([
      'status',
      'status_category',
      'tag',
      'classification',
      'property',
      'date',
      'edge',
    ])
  })

  it('reflects the 0.34.0 presentation shape including orphan_disposition', () => {
    const p = props().presentation
    expect(Object.keys(p.properties).sort()).toEqual(
      ['group_by', 'sort', 'layout', 'nest_by', 'orphan_disposition'].sort(),
    )
    expect(p.properties.orphan_disposition.enum).toEqual(['root', 'hide'])
    // Absent means root, and saying so is the whole safety argument: a consumer
    // that ignores the field must never silently drop a selected node.
    expect(p.properties.orphan_disposition.description).toContain('root')
    expect(p.properties.layout.enum).toEqual([
      'board',
      'table',
      'list',
      'cards',
      'timeline',
      'gallery',
      'tree',
    ])
  })
})

// ── Argument plumbing: omitted vs [] ────────────────────────────────────────

describe('omitted members vs an explicit empty array survive the argument bag', () => {
  it('omitting members preserves the stored arrangement across a withdrawal', async () => {
    await call({
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [member('blk_1', 'Awaiting pickup', 0), member('blk_2', 'On route', 6)],
    })

    const retired = await call({
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'retired',
    })
    expect(retired.isError).toBeUndefined()

    const stored = readComposition(store, 'depot-board')
    // 0.34.1: `retired` is a deprecated alias, stored and read back as the
    // spec's terminal phase for a composition.
    expect(stored?.lifecycle).toBe('archived')
    expect(stored?.members.map((m) => m.id)).toEqual(['blk_1', 'blk_2'])
  })

  it('passing [] clears them', async () => {
    await call({
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [member('blk_1', 'Awaiting pickup', 0)],
    })
    await call({
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [],
    })
    expect(readComposition(store, 'depot-board')?.members).toEqual([])
  })
})

// ── rev derivation and the precondition, over the wire ──────────────────────

describe('rev over the wire', () => {
  it('is derived, so a caller passing the rev it holds still lands on N+1', async () => {
    const first = await call({
      slug: 'weekly-rollup',
      title: 'Weekly rollup',
      lifecycle: 'published',
      rev: 0,
    })
    expect(body(first).status).toBe('ok')
    expect((body(first).composition as { rev: number }).rev).toBe(1)

    const second = await call({
      slug: 'weekly-rollup',
      title: 'Weekly rollup',
      lifecycle: 'published',
      rev: 1,
    })
    expect((body(second).composition as { rev: number }).rev).toBe(2)
  })

  it('refuses a stale precondition with a structured stale_revision body', async () => {
    await call({ slug: 'ops-review', title: 'Ops review', lifecycle: 'published' })
    await call({ slug: 'ops-review', title: 'Ops review', lifecycle: 'published' })

    const refused = await call({
      slug: 'ops-review',
      title: 'Ops review (my edit)',
      lifecycle: 'published',
      rev: 1,
    })

    expect(refused.isError).toBe(true)
    // The refusal carries its reason AS DATA, so a caller can branch on status
    // and read the stored revision without parsing prose.
    expect(body(refused)).toMatchObject({ status: 'stale_revision', stored_rev: 2 })
    expect(readComposition(store, 'ops-review')?.title).toBe('Ops review')
  })

  it('leaves the file byte-unchanged when the precondition refuses', async () => {
    await call({
      slug: 'field-digest',
      title: 'Field digest',
      lifecycle: 'published',
      members: [member('blk_1', 'Recent visits', 0)],
    })
    await store.flush()

    const before = readFileSync(file)
    const beforeMtime = statSync(file).mtimeMs

    const refused = await call({
      slug: 'field-digest',
      title: 'Field digest (stale)',
      lifecycle: 'published',
      members: [],
      rev: 0,
    })
    expect(refused.isError).toBe(true)

    expect(readFileSync(file).equals(before)).toBe(true)
    expect(statSync(file).mtimeMs).toBe(beforeMtime)
  })
})

// ── Focus edges ─────────────────────────────────────────────────────────────

describe('focus edges', () => {
  it('drops an id that does not resolve rather than writing a dangling edge', async () => {
    const result = await call({
      slug: 'persona-wall',
      title: 'Persona wall',
      lifecycle: 'published',
      focus_node_ids: ['n_surveyor', 'n_ghost'],
    })
    expect(result.isError).toBeUndefined()

    expect((body(result).composition as { focus_node_ids: string[] }).focus_node_ids).toEqual([
      'n_surveyor',
    ])
    expect(store.getAllEdges().some((e) => e.target === 'n_ghost')).toBe(false)
  })

  it('writes node and focus edges together, reachable through the generic readers', async () => {
    await call({
      slug: 'route-review',
      title: 'Route review',
      lifecycle: 'published',
      focus_node_ids: ['n_route'],
    })

    // get_node returns the node AND its edges, which IS the focus join. That is
    // why no get_composition tool was minted alongside this one.
    const getNode = getToolHandler('get_node')!
    const node = JSON.parse((await getNode({ id: 'route-review' }, ctx)).content[0].text) as {
      node: { type: string; properties?: Record<string, unknown> }
      edges_out?: Array<{ type: string; target: string }>
    }
    expect(node.node.type).toBe('composition')
    expect(node.node.properties?.rev).toBe(1)
    expect(
      (node.edges_out ?? []).some(
        (e) => e.type === 'composition_focuses_node' && e.target === 'n_route',
      ),
    ).toBe(true)
  })
})

// ── Stated refusals on malformed input ──────────────────────────────────────

describe('argument refusals', () => {
  it('requires slug, title and a canonical lifecycle', async () => {
    expect((await call({ title: 'X', lifecycle: 'draft' })).isError).toBe(true)
    expect((await call({ slug: 'x', lifecycle: 'draft' })).isError).toBe(true)
    expect((await call({ slug: 'x', title: 'X' })).isError).toBe(true)

    // `archived` became a CANONICAL phase at 0.34.1, so the invalid value here
    // is one the composition lifecycle genuinely does not have.
    const badPhase = await call({ slug: 'x', title: 'X', lifecycle: 'sunset' })
    expect(badPhase.isError).toBe(true)
    expect(badPhase.content[0].text).toContain('draft, published, archived, retired')
  })

  it('rejects a negative or fractional rev rather than coercing it', async () => {
    for (const rev of [-1, 1.5, '2']) {
      const bad = await call({ slug: 'x', title: 'X', lifecycle: 'draft', rev })
      expect(bad.isError).toBe(true)
    }
    expect(store.getNode('x')).toBeUndefined()
  })

  it('rejects members that are not member objects', async () => {
    const bad = await call({
      slug: 'x',
      title: 'X',
      lifecycle: 'draft',
      members: ['blk_1'],
    })
    expect(bad.isError).toBe(true)
    expect(store.getNode('x')).toBeUndefined()
  })

  it('refuses a slug already held by a node of another type', async () => {
    const refused = await call({ slug: 'n_route', title: 'Route review', lifecycle: 'published' })
    expect(refused.isError).toBe(true)
    expect(body(refused).status).toBe('conflict')
    expect(store.getNode('n_route')?.type).toBe('feature')
    expect(store.getNode('n_route')?.title).toBe('Route planner')
  })
})
