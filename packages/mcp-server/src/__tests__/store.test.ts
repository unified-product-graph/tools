/**
 * Tests for UPGFileStore — the in-memory store backed by .upg files.
 *
 * Tests cover: load/parse, node CRUD, edge operations, content hash, and type migration.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<UPGDocument> = {}): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes: [],
    edges: [],
    ...overrides,
  }
}

function makeNode(overrides: Partial<UPGBaseNode> = {}): UPGBaseNode {
  return {
    id: `n_test_${Math.random().toString(36).slice(2, 10)}`,
    type: 'persona' as UPGEntityType,
    title: 'Test Node',
    ...overrides,
  }
}

function makeEdge(
  source: string,
  target: string,
  overrides: Partial<UPGEdge> = {},
): UPGEdge {
  return {
    id: `e_test_${Math.random().toString(36).slice(2, 10)}`,
    source,
    target,
    type: 'persona_pursues_job' as UPGEdge['type'],
    ...overrides,
  }
}

function writeTempUPG(doc: UPGDocument): string {
  const dir = mkdtempSync(join(tmpdir(), 'upg-store-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  return filePath
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const filePath = writeTempUPG(doc)
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

// ── Load / Parse ──────────────────────────────────────────────────────────────

describe('UPGFileStore — load/parse', () => {
  it('loads a valid .upg file', async () => {
    const doc = makeDoc({
      nodes: [makeNode({ id: 'n_1', title: 'Alice' })],
    })
    const store = await loadStore(doc)

    expect(store.getAllNodes()).toHaveLength(1)
    expect(store.getNode('n_1')?.title).toBe('Alice')
  })

  it('loads nodes and edges with correct indexes', async () => {
    const nodeA = makeNode({ id: 'n_a', type: 'persona' as UPGEntityType, title: 'Dev' })
    const nodeB = makeNode({ id: 'n_b', type: 'job' as UPGEntityType, title: 'Ship fast' })
    const edge = makeEdge('n_a', 'n_b', { id: 'e_1' })

    const store = await loadStore(makeDoc({ nodes: [nodeA, nodeB], edges: [edge] }))

    expect(store.getNode('n_a')).toBeDefined()
    expect(store.getNode('n_b')).toBeDefined()
    expect(store.getEdge('e_1')).toBeDefined()
    expect(store.getEdgesForNode('n_a')).toHaveLength(1)
    expect(store.getEdgesForNode('n_b')).toHaveLength(1)
  })

  it('throws on invalid document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upg-store-test-'))
    const filePath = join(dir, 'bad.upg')
    writeFileSync(filePath, JSON.stringify({ invalid: true }))

    const store = new UPGFileStore()
    await expect(store.load(filePath)).rejects.toThrow('Invalid UPG document')
  })

  it('exposes product info', async () => {
    const store = await loadStore(makeDoc())
    const product = store.getProduct()
    expect(product.title).toBe('Test Product')
    expect(product.id).toBe('p1')
  })

  // ──: soft-coercion of legacy product.stage values on read ────────

  it('Soft-coerces legacy "idea" stage to canonical "concept" in-memory', async () => {
    const doc = makeDoc({
      product: { id: 'p1', title: 'Legacy Idea', stage: 'idea' as never },
    })
    const filePath = writeTempUPG(doc)
    const store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()

    expect(store.getProduct().stage).toBe('concept')

    // The on-disk file is NOT mutated by coercion — the original value
    // survives until an explicit migration sweep.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as UPGDocument
    expect(onDisk.product.stage).toBe('idea')
  })

  it('Soft-coerces legacy "discovery" stage to canonical "validation"', async () => {
    const doc = makeDoc({
      product: { id: 'p1', title: 'Discovery Phase', stage: 'discovery' as never },
    })
    const filePath = writeTempUPG(doc)
    const store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()

    expect(store.getProduct().stage).toBe('validation')
  })

  it('Leaves canonical stage values unchanged on load', async () => {
    const doc = makeDoc({
      product: { id: 'p1', title: 'Already Canonical', stage: 'launch' },
    })
    const filePath = writeTempUPG(doc)
    const store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()

    expect(store.getProduct().stage).toBe('launch')
  })

  it('Keeps unknown stage values as-is and does not crash', async () => {
    // Truly unknown values fall through with a stderr warning. The on-disk
    // representation is preserved verbatim — readers should not silently
    // invent a value where coercion has no documented target.
    const doc = makeDoc({
      product: { id: 'p1', title: 'Unknown Stage', stage: 'xyz' as never },
    })
    const filePath = writeTempUPG(doc)
    const store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()

    expect(store.getProduct().stage).toBe('xyz')
  })
})

// ── Node CRUD ─────────────────────────────────────────────────────────────────

describe('UPGFileStore — node CRUD', () => {
  let store: UPGFileStore

  beforeEach(async () => {
    store = await loadStore(makeDoc())
  })

  it('addNode adds and indexes the node', () => {
    const node = makeNode({ id: 'n_new', title: 'New Persona' })
    store.addNode(node)

    expect(store.getNode('n_new')?.title).toBe('New Persona')
    expect(store.getAllNodes()).toHaveLength(1)
  })

  it('updateNode patches fields', () => {
    const node = makeNode({ id: 'n_u', title: 'Before' })
    store.addNode(node)

    const updated = store.updateNode('n_u', { title: 'After', status: 'active' })
    expect(updated.title).toBe('After')
    expect(updated.status).toBe('active')
    expect(store.getNode('n_u')?.title).toBe('After')
  })

  it('updateNode deep-merges properties', () => {
    const node = makeNode({
      id: 'n_p',
      title: 'Prop Node',
      properties: { a: 1, b: 2 },
    })
    store.addNode(node)

    store.updateNode('n_p', { properties: { b: 3, c: 4 } })
    const result = store.getNode('n_p')
    expect(result?.properties).toEqual({ a: 1, b: 3, c: 4 })
  })

  it('updateNode throws for nonexistent node', () => {
    expect(() => store.updateNode('n_ghost', { title: 'Nope' })).toThrow(
      'Node not found',
    )
  })

  it('removeNode deletes the node', () => {
    const node = makeNode({ id: 'n_del', title: 'Delete Me' })
    store.addNode(node)

    const { node: removed } = store.removeNode('n_del')
    expect(removed.title).toBe('Delete Me')
    expect(store.getNode('n_del')).toBeUndefined()
    expect(store.getAllNodes()).toHaveLength(0)
  })

  it('removeNode cascades edge deletion', () => {
    const a = makeNode({ id: 'n_ca', title: 'A' })
    const b = makeNode({ id: 'n_cb', title: 'B' })
    store.addNode(a)
    store.addNode(b)

    const edge = makeEdge('n_ca', 'n_cb', { id: 'e_cascade' })
    store.addEdge(edge)

    const { removedEdgeIds } = store.removeNode('n_ca')
    expect(removedEdgeIds).toContain('e_cascade')
    expect(store.getEdge('e_cascade')).toBeUndefined()
    expect(store.getAllEdges()).toHaveLength(0)
  })

  it('removeNode throws for nonexistent node', () => {
    expect(() => store.removeNode('n_ghost')).toThrow('Node not found')
  })
})

// ── Edge Operations ───────────────────────────────────────────────────────────

describe('UPGFileStore — edge operations', () => {
  let store: UPGFileStore

  beforeEach(async () => {
    store = await loadStore(makeDoc())
    store.addNode(makeNode({ id: 'n_s', title: 'Source' }))
    store.addNode(makeNode({ id: 'n_t', title: 'Target' }))
  })

  it('addEdge validates source exists', () => {
    const edge = makeEdge('n_missing', 'n_t')
    expect(() => store.addEdge(edge)).toThrow('Source node not found')
  })

  it('addEdge validates target exists', () => {
    const edge = makeEdge('n_s', 'n_missing')
    expect(() => store.addEdge(edge)).toThrow('Target node not found')
  })

  it('addEdge skips validation when flag is set', () => {
    const edge = makeEdge('n_missing', 'n_also_missing', { id: 'e_skip' })
    store.addEdge(edge, true)
    expect(store.getEdge('e_skip')).toBeDefined()
  })

  it('addEdge indexes the edge for both nodes', () => {
    const edge = makeEdge('n_s', 'n_t', { id: 'e_idx' })
    store.addEdge(edge)

    expect(store.getEdgesForNode('n_s')).toHaveLength(1)
    expect(store.getEdgesForNode('n_t')).toHaveLength(1)
  })

  it('removeEdge removes and un-indexes', () => {
    const edge = makeEdge('n_s', 'n_t', { id: 'e_rm' })
    store.addEdge(edge)

    const removed = store.removeEdge('e_rm')
    expect(removed.id).toBe('e_rm')
    expect(store.getEdge('e_rm')).toBeUndefined()
    expect(store.getEdgesForNode('n_s')).toHaveLength(0)
    expect(store.getEdgesForNode('n_t')).toHaveLength(0)
  })

  it('removeEdge throws for nonexistent edge', () => {
    expect(() => store.removeEdge('e_ghost')).toThrow('Edge not found')
  })

  it('getAllEdges returns all edges', () => {
    store.addEdge(makeEdge('n_s', 'n_t', { id: 'e_1' }))
    store.addEdge(makeEdge('n_t', 'n_s', { id: 'e_2' }))
    expect(store.getAllEdges()).toHaveLength(2)
  })
})

// ── Content Hash ──────────────────────────────────────────────────────────────

describe('UPGFileStore — content hash', () => {
  it('has a non-empty hash after load', async () => {
    const store = await loadStore(makeDoc())
    expect(store.getContentHash()).toBeTruthy()
    expect(store.getContentHash().length).toBeGreaterThan(0)
  })

  it('hash changes when a node is added', async () => {
    const store = await loadStore(makeDoc())
    const hashBefore = store.getContentHash()

    store.addNode(makeNode({ id: 'n_hash', title: 'Hash Test' }))
    // The hash is recomputed lazily on save, but for node count changes
    // it should change. Let's force a flush.
    await store.flush()

    const hashAfter = store.getContentHash()
    expect(hashAfter).not.toBe(hashBefore)
  })
})

// ── Type Migration ────────────────────────────────────────────────────────────

describe('UPGFileStore — migrateType', () => {
  it('migrates node types from old to new', async () => {
    const store = await loadStore(
      makeDoc({
        nodes: [
          makeNode({ id: 'n_pp1', type: 'pain_point' as UPGEntityType, title: 'Slow builds' }),
          makeNode({ id: 'n_pp2', type: 'pain_point' as UPGEntityType, title: 'Flaky tests' }),
          makeNode({ id: 'n_f1', type: 'feature' as UPGEntityType, title: 'CI Cache' }),
        ],
      }),
    )

    const result = store.migrateType('pain_point', 'need')
    expect(result.migratedNodes).toBe(2)
    expect(store.getNode('n_pp1')?.type).toBe('need')
    expect(store.getNode('n_pp2')?.type).toBe('need')
    // Unrelated node unchanged
    expect(store.getNode('n_f1')?.type).toBe('feature')
  })

  it('leaves an unmapped legacy edge type untouched (no substring substitution)', async () => {
    // Regression: pre-v0.2.10, migrate_type substring-substituted
    // `jtbd_has_pain_point` to `jtbd_has_need` — neither of which is in
    // UPG_EDGE_CATALOG. The catalog-aware path leaves unmapped edges alone
    // (the tool layer surfaces them under `unmapped_legacy_edges`).
    const nodes = [
      makeNode({ id: 'n_j', type: 'jtbd' as UPGEntityType, title: 'Build fast' }),
      makeNode({ id: 'n_pp', type: 'pain_point' as UPGEntityType, title: 'Slow CI' }),
    ]
    const edges = [
      makeEdge('n_j', 'n_pp', {
        id: 'e_jp',
        type: 'jtbd_has_pain_point' as UPGEdge['type'],
      }),
    ]

    const store = await loadStore(makeDoc({ nodes, edges }))
    const result = store.migrateType('pain_point', 'need')

    expect(result.edgeRenames).toHaveLength(0)
    expect(result.edgeDrops).toHaveLength(0)
    // Edge type left as-is — caller must hand-migrate via rename_edge_type
    expect(store.getEdge('e_jp')?.type).toBe('jtbd_has_pain_point')
  })

  it('applies default properties during migration', async () => {
    const store = await loadStore(
      makeDoc({
        nodes: [
          makeNode({
            id: 'n_m',
            type: 'kpi' as UPGEntityType,
            title: 'Conversion Rate',
            properties: { target: '5%' },
          }),
        ],
      }),
    )

    store.migrateType('kpi', 'metric', { unit: 'percentage' })
    const migrated = store.getNode('n_m')
    expect(migrated?.type).toBe('metric')
    // Existing properties take precedence
    expect(migrated?.properties?.target).toBe('5%')
    // Default property is added
    expect(migrated?.properties?.unit).toBe('percentage')
  })

  it('returns zero counts when no nodes match', async () => {
    const store = await loadStore(makeDoc())
    const result = store.migrateType('nonexistent_type', 'something')
    expect(result.migratedNodes).toBe(0)
    expect(result.edgeRenames).toHaveLength(0)
    expect(result.edgeDrops).toHaveLength(0)
  })
})

// ── Change Log ────────────────────────────────────────────────────────────────

describe('UPGFileStore — change log', () => {
  it('logs node creation', async () => {
    const store = await loadStore(makeDoc())
    store.addNode(makeNode({ id: 'n_log', title: 'Logged' }))

    const changes = store.getChanges()
    expect(changes).toHaveLength(1)
    expect(changes[0].action).toBe('create')
    expect(changes[0].entity).toBe('node')
    expect(changes[0].id).toBe('n_log')
  })

  it('logs node update', async () => {
    const store = await loadStore(makeDoc())
    store.addNode(makeNode({ id: 'n_upd', title: 'Before' }))
    store.updateNode('n_upd', { title: 'After' })

    const changes = store.getChanges()
    expect(changes).toHaveLength(2) // create + update
    expect(changes[1].action).toBe('update')
  })

  it('logs node and edge deletion', async () => {
    const store = await loadStore(makeDoc())
    store.addNode(makeNode({ id: 'n_dl1', title: 'A' }))
    store.addNode(makeNode({ id: 'n_dl2', title: 'B' }))
    store.addEdge(makeEdge('n_dl1', 'n_dl2', { id: 'e_dl' }))
    store.removeNode('n_dl1')

    const changes = store.getChanges()
    const deletes = changes.filter((c) => c.action === 'delete')
    expect(deletes.length).toBeGreaterThanOrEqual(2) // node + edge(s)
  })
})
