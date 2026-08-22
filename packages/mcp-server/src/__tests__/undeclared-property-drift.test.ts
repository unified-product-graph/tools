/**
 * R7 — `get_node` and `validate_graph` agree about the same node.
 *
 * They used to contradict each other. `get_node` reported
 * `unknown_properties: ["lifecycle","updated_at"]` on a composition while
 * `validate_graph` reported `property_drift: 0` for that node, and whichever a
 * consumer trusted, the other said the opposite.
 *
 * Neither was lying: they asked different questions. `get_node` asks "is this
 * key DECLARED?"; `property_drift` asks "is this key covered by a migration
 * RULE I could run for you?" — and for a key nobody wrote a rule for, zero is
 * the honest answer. The gap was that `validate_graph` had no drift class of
 * ANY kind that could see an undeclared key, so a whole class of spec violation
 * was invisible to the graph-wide surface.
 *
 * `undeclared_property_drift` is that class. `property_drift` keeps its
 * rule-driven contract and its numbers unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UPGFileStore,
  checkUndeclaredProperties,
  isNamespacedPropertyKey,
} from '@unified-product-graph/sdk'
import { getNode, createNode } from '../tools/nodes.js'
import { validateGraph } from '../tools/validation.js'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeDoc(nodes: UPGDocument['nodes'] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes,
    edges: [],
  }
}

async function makeStore(nodes: UPGDocument['nodes'] = []): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-undeclared-drift-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(nodes), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as {
    isError?: boolean
    content: Array<{ text: string }>
  }
  if (r.isError) return { error: r.content[0].text }
  return JSON.parse(r.content[0].text)
}

/** The exact node shape a 0.34.0 `upsert_composition` used to write. */
const LEGACY_COMPOSITION = {
  id: 'audit-hint-view',
  type: 'composition',
  title: 'AUDIT Hint View',
  properties: {
    lifecycle: 'published',
    updated_at: '2026-08-22T00:00:00.000Z',
    rev: 1,
    members: [],
  },
} as unknown as UPGDocument['nodes'][number]

describe('the two surfaces agree about one node (R7)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore([LEGACY_COMPOSITION])
    ctx = makeCtx(store)
  })

  it('get_node still reports the undeclared keys', async () => {
    const read = await parse(getNode({ node_id: 'audit-hint-view' }, ctx))
    expect(read.unknown_properties).toEqual(['lifecycle', 'updated_at'])
  })

  it('validate_graph now reports them too, in undeclared_property_drift', async () => {
    const v = await parse(validateGraph({ skip_anti_patterns: true }, ctx))
    expect(v.summary.undeclared_property_drift).toBe(2)
    expect(v.undeclared_property_drift.map((e: { property: string }) => e.property)).toEqual([
      'lifecycle',
      'updated_at',
    ])
    expect(v.undeclared_property_drift[0]).toMatchObject({
      id: 'audit-hint-view',
      type: 'composition',
    })
  })

  it('property_drift keeps its rule-driven contract and stays 0', async () => {
    const v = await parse(validateGraph({ skip_anti_patterns: true }, ctx))
    expect(v.summary.property_drift).toBe(0)
    expect(v.property_drift).toEqual([])
  })

  it('does NOT gate structurally_valid, on purpose', async () => {
    const v = await parse(validateGraph({ skip_anti_patterns: true }, ctx))
    expect(v.summary.undeclared_property_drift).toBe(2)
    expect(v.structurally_valid).toBe(true)
  })

  it('honours the scope filter like every sibling class', async () => {
    const only = await parse(
      validateGraph({ scope: 'undeclared_property_drift', skip_anti_patterns: true }, ctx),
    )
    expect(only.undeclared_property_drift).toHaveLength(2)
    expect(only).not.toHaveProperty('property_drift')

    const other = await parse(
      validateGraph({ scope: 'property_drift', skip_anti_patterns: true }, ctx),
    )
    expect(other).not.toHaveProperty('undeclared_property_drift')
  })
})

describe('a namespaced extension key is not drift (R7)', () => {
  it('checkUndeclaredProperties exempts `<tool>:<key>`', () => {
    const { unknown_properties } = checkUndeclaredProperties('composition', {
      'entopo:view_blocks': [1, 2],
      lifecycle: 'published',
    })
    expect(unknown_properties).toEqual(['lifecycle'])
  })

  it('validate_graph exempts it too', async () => {
    const store = await makeStore([
      {
        id: 'ns-view',
        type: 'composition',
        title: 'Namespaced',
        properties: { 'entopo:view_blocks': [], rev: 0 },
      },
    ] as unknown as UPGDocument['nodes'])
    const v = await parse(validateGraph({ skip_anti_patterns: true }, makeCtx(store)))
    expect(v.summary.undeclared_property_drift).toBe(0)
  })

  it('get_node exempts it too, so the two still agree', async () => {
    const store = await makeStore([
      {
        id: 'ns-view',
        type: 'composition',
        title: 'Namespaced',
        properties: { 'entopo:view_blocks': [], rev: 0 },
      },
    ] as unknown as UPGDocument['nodes'])
    const read = await parse(getNode({ node_id: 'ns-view' }, makeCtx(store)))
    expect(read.unknown_properties).toBeUndefined()
  })

  it('recognises a namespace only when there is one on both sides of the colon', () => {
    expect(isNamespacedPropertyKey('linear:state_history')).toBe(true)
    expect(isNamespacedPropertyKey('linear_state_history')).toBe(false)
    expect(isNamespacedPropertyKey(':leading')).toBe(false)
    expect(isNamespacedPropertyKey('trailing:')).toBe(false)
  })
})

describe('the summary count is the TRUE total, not the page (N1)', () => {
  /** 12 undeclared keys across 4 nodes, so a small `limit` must clip the page. */
  async function driftyStore(): Promise<UPGFileStore> {
    const nodes = [0, 1, 2, 3].map((i) => ({
      id: `n_${i}`,
      type: 'persona',
      title: `P${i}`,
      properties: Object.fromEntries([0, 1, 2].map((k) => [`undeclared_${i}_${k}`, 1])),
    }))
    return makeStore(nodes as unknown as UPGDocument['nodes'])
  }

  it('reports 12 at a limit of 2, and the page carries 2', async () => {
    const v = await parse(
      validateGraph({ skip_anti_patterns: true, limit: 2 }, makeCtx(await driftyStore())),
    )
    expect(v.summary.undeclared_property_drift).toBe(12)
    expect(v.undeclared_property_drift).toHaveLength(2)
  })

  it('does not move when the caller changes the page size', async () => {
    const totals: number[] = []
    for (const limit of [2, 5, 100]) {
      const v = await parse(
        validateGraph({ skip_anti_patterns: true, limit }, makeCtx(await driftyStore())),
      )
      totals.push(v.summary.undeclared_property_drift)
    }
    expect(totals).toEqual([12, 12, 12])
  })

  it('matches the sibling contract: a total beside a clipped list', async () => {
    const v = await parse(
      validateGraph({ skip_anti_patterns: true, limit: 2 }, makeCtx(await driftyStore())),
    )
    expect(v.summary.undeclared_property_drift).toBeGreaterThan(
      v.undeclared_property_drift.length,
    )
  })
})

describe('a namespaced key is exempt on the WRITE surface too (N2)', () => {
  let ctx: ToolContext

  beforeEach(async () => {
    ctx = makeCtx(await makeStore())
  })

  it('create_node emits no warning for `<tool>:<key>`', async () => {
    const res = await parse(
      createNode(
        { type: 'persona', title: 'NS', properties: { 'entopo:private_note': 'ok' } },
        ctx,
      ),
    )
    expect(res.warning).toBeUndefined()
    expect(res.unknown_properties).toBeUndefined()
  })

  it('create_node STILL warns for a genuinely undeclared key', async () => {
    const res = await parse(
      createNode(
        { type: 'persona', title: 'Bad', properties: { totally_undeclared: 1 } },
        ctx,
      ),
    )
    expect(res.unknown_properties).toEqual(['totally_undeclared'])
  })

  it('one call never carries two verdicts about one key', async () => {
    const res = await parse(
      createNode(
        {
          type: 'persona',
          title: 'Mixed',
          properties: { 'entopo:fine': 1, actually_undeclared: 2 },
        },
        ctx,
      ),
    )
    expect(res.unknown_properties).toEqual(['actually_undeclared'])
    expect(res.warning).not.toContain('entopo:fine')
  })
})

describe('a canonical graph reports nothing (R7)', () => {
  it('summary.undeclared_property_drift is 0', async () => {
    const store = await makeStore([
      {
        id: 'clean-view',
        type: 'composition',
        title: 'Clean',
        status: 'published',
        properties: { rev: 1, members: [] },
      },
    ] as unknown as UPGDocument['nodes'])
    const v = await parse(validateGraph({ skip_anti_patterns: true }, makeCtx(store)))
    expect(v.summary.undeclared_property_drift).toBe(0)
    expect(v.structurally_valid).toBe(true)
  })
})
