/**
 * Regression tests for UPG CLI Hardening Wave 2 — SDK-store cluster:
 *
 *   -: idempotent edge create. `upg connect P J` run three times used to
 *     append three identical `persona_pursues_job` edges (the CLI calls into the
 *     SDK store's edge-create; the same dup showed on MCP create_edge /
 *     batch_create_edges). The store now collapses an identical
 *     (source, target, type) re-create onto the existing edge and returns it.
 *
 *   -: loader robustness.
 *       (a) `nodes`/`edges` present but NOT an array → a clean
 *           "Invalid UPG document" error BEFORE any `.map`, not a raw
 *           `(...).map is not a function` TypeError.
 *       (b) a UTF-8 BOM-prefixed but otherwise-valid `.upg` loads (the BOM is
 *           stripped before JSON.parse), instead of "Not a valid .upg file".
 *
 * Each test writes a throwaway `.upg` so the file-backed store behaves exactly
 * as it does for an SDK / CLI consumer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore, createEdge } from '../index.js'

// A connected, well-formed graph. Mirrors the store-hardening fixture so the
// envelope/validation behaviour is identical.
function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_test', title: 'TestProduct' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-01T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'TestProduct' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Solo Cook', slug: 'solo-cook' },
      { id: 'n_job', type: 'job', title: 'Eat well', slug: 'eat-well' },
    ],
    edges: [] as Array<{ id: string; source: string; target: string; type: string }>,
  }
}

const cleanups: string[] = []
function writeTmpFixture(doc: unknown = fixtureDoc()): string {
  const f = path.join(os.tmpdir(), `upg-w2-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(doc))
  cleanups.push(f)
  return f
}
/** Write raw text verbatim (used for the BOM-prefixed fixture). */
function writeTmpRaw(text: string): string {
  const f = path.join(os.tmpdir(), `upg-w2-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, text)
  cleanups.push(f)
  return f
}

afterEach(() => {
  vi.restoreAllMocks()
  while (cleanups.length) {
    const f = cleanups.pop()!
    try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(f + '.lock', { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(f + '.tmp', { force: true }) } catch { /* ignore */ }
  }
})

// ──: idempotent edge create ───────────────────────────────────────────

describe(' idempotent edge create: same triple created N times = 1 edge', () => {
  it('3x createEdge(P, J, persona_pursues_job) → exactly 1 edge, same id each time', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await store.load(file)

    const r1 = createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    const r2 = createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    const r3 = createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    store.stopWatching()

    // None error.
    expect('error' in r1).toBe(false)
    expect('error' in r2).toBe(false)
    expect('error' in r3).toBe(false)

    // Exactly one edge in the graph for this triple.
    const matching = store
      .getAllEdges()
      .filter((e) => e.source === 'n_persona' && e.target === 'n_job' && e.type === 'persona_pursues_job')
    expect(matching.length).toBe(1)
    expect(store.getAllEdges().length).toBe(1)

    // Every call returned the SAME (existing) edge id — connect is a safe no-op.
    const id1 = (r1 as { edge: { id: string } }).edge.id
    const id2 = (r2 as { edge: { id: string } }).edge.id
    const id3 = (r3 as { edge: { id: string } }).edge.id
    expect(id2).toBe(id1)
    expect(id3).toBe(id1)
    // The returned id is the one that actually lives in the graph (truthful).
    expect(store.getEdge(id1)).toBeDefined()
  })

  it('persists exactly one edge to disk across reload', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await store.load(file)
    createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    await store.flush()
    store.stopWatching()

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(onDisk.nodes.length).toBe(2)
    expect(onDisk.edges.length).toBe(1)
  })

  it('a DIFFERENT triple (different target) is NOT deduped', async () => {
    // Add a second job so a distinct (source, target, type) is possible.
    const doc = fixtureDoc()
    doc.nodes.push({ id: 'n_job2', type: 'job', title: 'Save time', slug: 'save-time' })
    const file = writeTmpFixture(doc)
    const store = new UPGFileStore()
    await store.load(file)

    createEdge(store, { source_id: 'n_persona', target_id: 'n_job', type: 'persona_pursues_job' })
    createEdge(store, { source_id: 'n_persona', target_id: 'n_job2', type: 'persona_pursues_job' })
    store.stopWatching()

    // Two distinct edges — dedup must not collapse different targets.
    expect(store.getAllEdges().length).toBe(2)
  })

  it('store.addEdge returns the existing edge on a duplicate (return-shape contract)', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await store.load(file)

    const first = store.addEdge({ id: 'e_first', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' })
    const second = store.addEdge({ id: 'e_second', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' })
    store.stopWatching()

    // The second add is a no-op that returns the FIRST edge (its id), not the
    // fresh id we passed. Callers minting a fresh id must use this return value.
    expect(first.id).toBe('e_first')
    expect(second.id).toBe('e_first')
    expect(store.getEdge('e_second')).toBeUndefined()
    expect(store.getAllEdges().length).toBe(1)
  })
})

// ──: loader robustness ────────────────────────────────────────────────

describe(' loader robustness: BOM strip + array-shape guard', () => {
  it('(b) a BOM-prefixed otherwise-valid .upg loads (identical bytes, BOM stripped)', async () => {
    // Same bytes as a normal fixture, just with a leading U+FEFF BOM. Before the
    // fix this threw "Not a valid .upg file" at JSON.parse.
    const file = writeTmpRaw('﻿' + JSON.stringify(fixtureDoc()))
    const store = new UPGFileStore()
    await expect(store.load(file)).resolves.toBeUndefined()
    expect(store.getNode('n_persona')).toBeDefined()
    expect(store.getNode('n_job')).toBeDefined()
    store.stopWatching()
  })

  it('(a) nodes-as-string → clean "Invalid UPG document" error, NOT a raw .map TypeError', async () => {
    const doc = { ...fixtureDoc(), nodes: 'not-an-array' as unknown }
    const file = writeTmpFixture(doc)
    const store = new UPGFileStore()

    let caught: Error | undefined
    try {
      await store.load(file)
    } catch (err) {
      caught = err as Error
    }
    store.stopWatching()

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Invalid UPG document/)
    expect(caught!.message).toMatch(/nodes is required and must be an array/)
    // The whole point: NOT the opaque TypeError that leaked before.
    expect(caught!.message).not.toMatch(/\.map is not a function/)
    expect(caught).not.toBeInstanceOf(TypeError)
  })

  it('(a) edges-as-object → clean "Invalid UPG document" error, NOT a raw .map TypeError', async () => {
    const doc = { ...fixtureDoc(), edges: { not: 'an-array' } as unknown }
    const file = writeTmpFixture(doc)
    const store = new UPGFileStore()

    let caught: Error | undefined
    try {
      await store.load(file)
    } catch (err) {
      caught = err as Error
    }
    store.stopWatching()

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Invalid UPG document/)
    expect(caught!.message).toMatch(/edges is required and must be an array/)
    expect(caught!.message).not.toMatch(/\.map is not a function/)
  })

  it('(a) both nodes AND edges malformed → both reported in one error', async () => {
    const doc = { ...fixtureDoc(), nodes: 42 as unknown, edges: 'x' as unknown }
    const file = writeTmpFixture(doc)
    const store = new UPGFileStore()
    await expect(store.load(file)).rejects.toThrow(/nodes is required and must be an array[\s\S]*edges is required and must be an array/)
    store.stopWatching()
  })

  it('no regression: a normal valid doc still loads cleanly', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await expect(store.load(file)).resolves.toBeUndefined()
    expect(store.getAllNodes().length).toBe(2)
    store.stopWatching()
  })
})
