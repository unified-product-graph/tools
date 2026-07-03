/**
 *.17.8 — concurrent-edit merge data-loss (P0).
 *
 * The three-way merge in `UPGFileStore.mergeWithDisk` only reconciled node/edge
 * ADD/DELETE (by ID membership) and, for a node present in BOTH our in-memory
 * state and disk, compared ONLY `title` and `status`. This produced TWO failures:
 *
 *   1. SILENT LOSS — any OTHER field another session changed on a shared node or
 *      edge (a property, description, tag, an edge deletion / re-parent, an edge
 *      property) was silently overwritten on our next save, with no conflict.
 *   2. MISSING CONFLICT — two sessions changing the SAME non-title/status field
 *      differently was resolved silently (one won), never surfaced as a conflict.
 *
 * Root cause: `snapshotBaseline()` stored only node/edge IDs, not content, so the
 * merge could not tell "we changed field X" from "we hold the baseline X while
 * they changed it" — hence the punt to title/status + keep-ours.
 *
 * (Separately, the title/status-only check also raised FALSE conflicts for a
 * one-sided title/status change — see scenario (g).)
 *
 * These tests drive TWO in-process stores on ONE `.upg` file — the real
 * concurrent-write path: session B mutates + flushes, then session A (holding its
 * own unrelated dirty edit) flushes and re-reads disk inside `saveLocked`, firing
 * `mergeWithDisk`. Watchers are stopped after load so the save-path merge (the
 * data-integrity-critical path, and the exact code the watcher path also calls)
 * is exercised DETERMINISTICALLY.
 *
 * A's "unrelated dirty edit" is a PROPERTY change on a shared node — deliberately
 * NOT title/status — so the pre-fix code takes its silent-loss path (the headline
 * P0) rather than tripping the title/status false-conflict. On the pre-fix tree,
 * (a)-(g) FAIL; (f1)-(f4) are regression guards that pass on BOTH trees.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore } from '../index.js'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

// A connected, well-formed graph. n_study1/2 + n_obs give us a re-parent target;
// n_job carries an initial `effort` property so scenario (e) has a real baseline
// value on both sides.
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
      { id: 'n_job', type: 'job', title: 'Eat well', slug: 'eat-well', properties: { effort: 'M' } },
      { id: 'n_study1', type: 'research_study', title: 'Study One', slug: 'study-one' },
      { id: 'n_study2', type: 'research_study', title: 'Study Two', slug: 'study-two' },
      { id: 'n_obs', type: 'observation', title: 'An observation', slug: 'an-observation' },
    ] as UPGBaseNode[],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
      // A shared edge that carries a property (scenario d).
      { id: 'e_prop', source: 'n_persona', target: 'n_job', type: 'framework_exercise_includes_node', properties: { bucket: 'must' } },
      // Observation currently parented under study 1; scenario (b) re-parents it.
      { id: 'e_contains', source: 'n_study1', target: 'n_obs', type: 'research_study_captures_observation' },
    ] as UPGEdge[],
  }
}

const cleanups: string[] = []
function writeTmpFixture(doc: unknown = fixtureDoc()): string {
  const f = path.join(os.tmpdir(), `upg-mergeloss-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(doc))
  cleanups.push(f)
  return f
}

afterEach(() => {
  while (cleanups.length) {
    const f = cleanups.pop()!
    try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(f + '.lock', { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(f + '.tmp', { force: true }) } catch { /* ignore */ }
  }
})

/** Load a save-capable store with the watcher stopped for deterministic saves. */
async function openStore(file: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  return store
}

/** Re-read the file from disk through a fresh read-only store for assertions. */
async function readBack(file: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.loadReadOnly(file)
  return store
}

// ── (a)-(g): silent-loss / missing-conflict repros (FAIL on pre-fix tree) ─────

describe('concurrent-edit merge — data loss on shared nodes/edges (0.17.8 repro)', () => {
  it('(a) a node property added by session B survives session A\'s unrelated save', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B backfills a source_url property on the shared persona node, then saves.
    b.updateNode('n_persona', { properties: { source_url: 'https://example.com/interview' } })
    await b.flush()

    // A's own unrelated dirty edit is a PROPERTY change on a DIFFERENT node.
    a.updateNode('n_job', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    expect(disk.getNode('n_persona')?.properties?.source_url).toBe('https://example.com/interview')
    expect(disk.getNode('n_job')?.properties?.note).toBe('a-side') // A's edit preserved too
  })

  it('(b) a re-parent (edge delete + add) by session B survives session A\'s save', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B moves the observation from study 1 to study 2: drop the old contains
    // edge, add a new one. (Parenting is edge-based in UPG.)
    b.removeEdge('e_contains')
    b.addEdge({ id: 'e_contains2', source: 'n_study2', target: 'n_obs', type: 'research_study_captures_observation' } as UPGEdge, true)
    await b.flush()

    a.updateNode('n_persona', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    const edges = disk.getEdgesForNode('n_obs')
    // The move must survive: old parent edge gone, new one present. Not both.
    expect(edges.some((e) => e.id === 'e_contains')).toBe(false)
    expect(edges.some((e) => e.id === 'e_contains2' && e.source === 'n_study2')).toBe(true)
  })

  it('(c) description + tag + generic property changes by B all survive A\'s save', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.updateNode('n_persona', {
      description: 'A solo cook who values speed',
      tags: ['vip'],
      properties: { priority: 'high' },
    })
    await b.flush()

    a.updateNode('n_job', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    const persona = disk.getNode('n_persona')
    expect(persona?.description).toBe('A solo cook who values speed')
    expect(persona?.tags).toContain('vip')
    expect(persona?.properties?.priority).toBe('high')
  })

  it('(d) an edge property changed by B on a shared edge survives A\'s save', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.setEdgeProperties('e_prop', { bucket: 'should' })
    await b.flush()

    a.updateNode('n_persona', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    expect(disk.getEdge('e_prop')?.properties?.bucket).toBe('should')
  })

  it('(e) a TRUE conflict — both sessions change the same property differently — is surfaced', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // Baseline effort is 'M'. Both sessions change it, differently.
    b.updateNode('n_job', { properties: { effort: 'L' } })
    await b.flush()

    a.updateNode('n_job', { properties: { effort: 'S' } })
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    // A's write must have been refused: disk still holds B's value, not silently
    // overwritten by A.
    const disk = await readBack(file)
    expect(disk.getNode('n_job')?.properties?.effort).toBe('L')
  })

  it('(g) a one-sided title change is NOT a false conflict, and both sides land', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B changes an UNRELATED node's property; A changes n_persona.title. Only one
    // side touched the title, so there is no conflict — both changes must land.
    // (Pre-fix, the title/status-only check flags this as a false conflict.)
    b.updateNode('n_job', { properties: { note: 'b-side' } })
    await b.flush()

    a.updateNode('n_persona', { title: 'Home Cook' })
    await a.flush() // must not throw

    const disk = await readBack(file)
    expect(disk.getNode('n_persona')?.title).toBe('Home Cook')
    expect(disk.getNode('n_job')?.properties?.note).toBe('b-side')
  })
})

// ── (f): regression guards (green on BOTH the pre-fix and fixed tree) ─────────

describe('concurrent-edit merge — regression guards', () => {
  it('(f1) a node added by session B survives A\'s save', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.addNode({ id: 'n_new', type: 'feature', title: 'New Feature' } as UPGBaseNode)
    await b.flush()

    a.updateNode('n_persona', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    expect(disk.getNode('n_new')?.title).toBe('New Feature')
    expect(disk.getNode('n_persona')?.properties?.note).toBe('a-side')
  })

  it('(f2) a node deleted by B (untouched by A) is accepted as a deletion', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.removeNode('n_obs')
    await b.flush()

    a.updateNode('n_persona', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = await readBack(file)
    expect(disk.getNode('n_obs')).toBeUndefined()
  })

  it('(f3) a genuine title conflict still throws (unchanged loud behavior)', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.updateNode('n_persona', { title: 'Title From B' })
    await b.flush()

    a.updateNode('n_persona', { title: 'Title From A' })
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)
  })

  it('(f4) a single-session save (no concurrency) is unaffected', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)

    a.updateNode('n_persona', { title: 'Solo Only', properties: { source_url: 'https://solo.example' } })
    await a.flush()

    const disk = await readBack(file)
    expect(disk.getNode('n_persona')?.title).toBe('Solo Only')
    expect(disk.getNode('n_persona')?.properties?.source_url).toBe('https://solo.example')
  })
})

// ── delete/modify conflicts (0.17.8 widening) ────────────────────────────────
//
// Captain's bar: ZERO silent-resolution paths. A delete on one side and a modify
// on the other — either direction, node or edge — must surface a CONFLICT, never
// silently resurrect (keep-ours) or silently drop (lose-theirs). A CLEAN delete
// (the other side did not modify) must still be accepted silently — no false
// conflicts. On the pre-widening (0.17.8-frozen) tree, (9a)/(9b)/double-parent
// resolve silently (no throw); after the widening they raise CONFLICT.

describe('concurrent-edit merge — delete/modify conflicts (0.17.8 widening)', () => {
  it('(9a-node) WE modified a node, THEY deleted it → CONFLICT (no silent resurrect)', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B deletes the node; A (independently) modifies it.
    b.removeNode('n_obs')
    await b.flush()

    a.updateNode('n_obs', { properties: { source_url: 'https://a.example' } })
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    // A's write must have been refused — disk still reflects B's deletion.
    const disk = await readBack(file)
    expect(disk.getNode('n_obs')).toBeUndefined()
  })

  it('(9a-edge) WE modified an edge, THEY deleted it → CONFLICT', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.removeEdge('e_prop')
    await b.flush()

    a.setEdgeProperties('e_prop', { bucket: 'should' })
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    const disk = await readBack(file)
    expect(disk.getEdge('e_prop')).toBeUndefined() // B's deletion stands; A refused
  })

  it('(9a-edge double-parent) A modified an edge while B re-parented it → CONFLICT, no double-parent', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B re-parents: delete the old contains-edge, add a new one.
    b.removeEdge('e_contains')
    b.addEdge({ id: 'e_contains2', source: 'n_study2', target: 'n_obs', type: 'research_study_captures_observation' } as UPGEdge, true)
    await b.flush()

    // A modifies the SAME edge B deleted. This must conflict, not silently keep
    // e_contains AND adopt e_contains2 (the double-parent bug).
    a.setEdgeProperties('e_contains', { weight: 2 })
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    // Nothing applied: disk is exactly B's re-parented state, not double-parented.
    const disk = await readBack(file)
    const obsEdges = disk.getEdgesForNode('n_obs')
    expect(obsEdges.some((e) => e.id === 'e_contains')).toBe(false)
    expect(obsEdges.some((e) => e.id === 'e_contains2')).toBe(true)
  })

  it('(9b-node) WE deleted a node, THEY modified it → CONFLICT (no silent loss of their edit)', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B modifies the node; A deletes it.
    b.updateNode('n_obs', { properties: { source_url: 'https://b.example' } })
    await b.flush()

    a.removeNode('n_obs')
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    // A's deletion must have been refused — disk still holds B's modified node.
    const disk = await readBack(file)
    expect(disk.getNode('n_obs')?.properties?.source_url).toBe('https://b.example')
  })

  it('(9b-edge) WE deleted an edge, THEY modified it → CONFLICT', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.setEdgeProperties('e_prop', { bucket: 'should' })
    await b.flush()

    a.removeEdge('e_prop')
    await expect(a.flush()).rejects.toThrow(/CONFLICT/)

    const disk = await readBack(file)
    expect(disk.getEdge('e_prop')?.properties?.bucket).toBe('should') // B's edit survived
  })

  // ── clean-delete guards: a delete with NO concurrent modify stays silent ────

  it('(9b-clean) WE deleted a node the other session did NOT modify → accepted, no conflict', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    // B modifies a DIFFERENT node; A deletes n_obs (untouched by B).
    b.updateNode('n_persona', { properties: { note: 'b-side' } })
    await b.flush()

    a.removeNode('n_obs')
    await a.flush() // must not throw

    const disk = await readBack(file)
    expect(disk.getNode('n_obs')).toBeUndefined() // our clean deletion stands
    expect(disk.getNode('n_persona')?.properties?.note).toBe('b-side') // B's edit kept
  })

  it('(9a-clean-edge) THEY deleted an edge we did NOT modify → accepted, no conflict', async () => {
    const file = writeTmpFixture()
    const a = await openStore(file)
    const b = await openStore(file)

    b.removeEdge('e_prop')
    await b.flush()

    a.updateNode('n_persona', { properties: { note: 'a-side' } })
    await a.flush() // must not throw

    const disk = await readBack(file)
    expect(disk.getEdge('e_prop')).toBeUndefined() // B's clean deletion accepted
  })
})
