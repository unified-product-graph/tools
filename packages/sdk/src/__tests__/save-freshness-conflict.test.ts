/**
 * — load-before-save freshness verification (P0, 2026-08-05 incident).
 *
 * Two MCP servers held the same `.upg` file. One (the spec server) carried a
 * day-stale in-memory copy; the other was actively writing. A single node-status
 * write routed through the stale server serialized its whole in-memory document
 * over the fresh file, destroying ~300 nodes of same-day work. The CONFLICT
 * mechanism never fired.
 *
 * Root cause: `mergeWithDisk()` FAILED OPEN. Its two guard clauses —
 * unparseable disk JSON, and `validateUPGDocument(disk).valid === false` —
 * both returned `{ merged: true, conflicts: [] }`, i.e. "our version wins", and
 * `saveLocked()` then wrote the stale document wholesale. The validation guard
 * is the live one: `loadInternal()` is deliberately PERMISSIVE about
 * content-validity errors (a stale enum on one node still loads), so the merge
 * boundary was strict where the load boundary was not. Any single content-level
 * validation error on the freshly written disk copy — routine when two servers
 * run different spec versions against one file — silently licensed the clobber.
 *
 * Two further unprotected paths were found and closed under the same invariant:
 *   - `saveLocked()` treated ANY `readFile` failure (EACCES/EBUSY/EIO, not just
 *     ENOENT) as "file doesn't exist, safe to write", skipping the check.
 *   - `UPGPortfolioStore.writeToDisk()` had NO freshness check and NO lock at
 *     all: the wholesale-workspace save. It now compare-and-swaps.
 *
 * The invariant enforced here: before any disk write, the on-disk bytes must
 * still be the bytes this store last read or wrote. If they are not and the
 * difference cannot be safely reconciled, the write is REFUSED with a CONFLICT
 * and the file on disk is left BYTE-IDENTICAL.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore, UPGPortfolioStore } from '../index.js'
import type { UPGBaseNode, UPGEdge, UPGCrossEdge } from '@unified-product-graph/core'

// ── Fixture ──────────────────────────────────────────────────────────────────
// Fictional product ("Kestrelbox") — no real companies, people, or brands.

function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_kestrelbox', title: 'Kestrelbox' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-08-01T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_kestrelbox', title: 'Kestrelbox' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Field Surveyor', slug: 'field-surveyor' },
      { id: 'n_job', type: 'job', title: 'Log a site visit', slug: 'log-a-site-visit', properties: { effort: 'M' } },
    ] as UPGBaseNode[],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
    ] as UPGEdge[],
  }
}

const cleanupDirs: string[] = []
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `upg-${tag}-`))
  cleanupDirs.push(d)
  return d
}

afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function writeFixture(dir: string, doc: unknown = fixtureDoc()): string {
  const f = path.join(dir, 'kestrelbox.upg')
  fs.writeFileSync(f, JSON.stringify(doc))
  return f
}

/** Load a save-capable store with the watcher stopped, so saves are deterministic. */
async function openStore(file: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  return store
}

/**
 * Simulate "the other server wrote the file" WITHOUT going through a store, so
 * the on-disk shape is exactly what we choose. Returns the new bytes.
 */
function externalWrite(file: string, mutate: (doc: ReturnType<typeof fixtureDoc>) => void): string {
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
  mutate(doc)
  const raw = JSON.stringify(doc)
  fs.writeFileSync(file, raw)
  return raw
}

// ── (a) external edit between load and save ──────────────────────────────────

describe(' (a) — external edit between load and save', () => {
  it('refuses to write when the disk copy is unparseable, leaving the file byte-identical', async () => {
    const dir = tmpDir('fresh-parse')
    const file = writeFixture(dir)

    const stale = await openStore(file)
    stale.updateNode('n_job', { properties: { note: 'stale-session' } })

    // The other writer leaves the file in a state we cannot parse.
    const corrupt = '{ "nodes": [ truncated'
    fs.writeFileSync(file, corrupt)

    await expect(stale.flush()).rejects.toThrow(/CONFLICT/)
    // Byte-identical: we did not touch it.
    expect(fs.readFileSync(file, 'utf-8')).toBe(corrupt)
  })

  it('refuses to write when the disk copy is structurally not a UPG document', async () => {
    const dir = tmpDir('fresh-structural')
    const file = writeFixture(dir)

    const stale = await openStore(file)
    stale.updateNode('n_job', { properties: { note: 'stale-session' } })

    // Well-formed JSON, but no `$upg` envelope and no product → structural.
    const notUpg = JSON.stringify({ hello: 'world', nodes: [], edges: [] })
    fs.writeFileSync(file, notUpg)

    await expect(stale.flush()).rejects.toThrow(/CONFLICT/)
    expect(fs.readFileSync(file, 'utf-8')).toBe(notUpg)
  })

  it('THE INCIDENT: a content-validity error on the fresh disk copy must not license a wholesale overwrite', async () => {
    const dir = tmpDir('fresh-incident')
    const file = writeFixture(dir)

    // A day-stale server holds the file.
    const stale = await openStore(file)

    // The other server writes 300 new nodes AND leaves ONE node in a state this
    // server's validator reports as a content-validity error — here an untitled
    // draft node, exactly what an app server creates mid-session. `loadInternal`
    // tolerates this (permissive load boundary); pre-fix, `mergeWithDisk` did not,
    // and that single content error made it return "ours wins".
    externalWrite(file, (doc) => {
      for (let i = 0; i < 300; i++) {
        doc.nodes.push({
          id: `n_new_${i}`,
          type: 'observation',
          title: `Field note ${i}`,
          slug: `field-note-${i}`,
        } as UPGBaseNode)
      }
      doc.nodes.push({
        id: 'n_untitled_draft',
        type: 'observation',
        title: '   ',
        slug: 'untitled-draft',
      } as UPGBaseNode)
    })

    // Precondition: the disk copy really is content-invalid but structurally fine.
    {
      const { validateUPGDocument, normalizeDocument } = await import('@unified-product-graph/core')
      const parsed = normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf-8')))
      const v = validateUPGDocument(parsed)
      expect(v.valid).toBe(false)
      expect(v.errors.every((e) => e.path.startsWith('$.nodes['))).toBe(true)
    }

    // The small write that triggered the incident: a single node status update.
    stale.updateNode('n_job', { status: 'in_progress' })
    await stale.flush()

    // The 300 nodes must still be there. Either outcome is acceptable — merged in
    // (content drift is mergeable) or a refused write — but NEVER lost.
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
    const ids = new Set(after.nodes.map((n) => n.id))
    for (let i = 0; i < 300; i++) expect(ids.has(`n_new_${i}`)).toBe(true)
    expect(ids.has('n_untitled_draft')).toBe(true)
  })

  it('an unreadable (non-ENOENT) file is a CONFLICT, not a licence to write', async () => {
    const dir = tmpDir('fresh-eacces')
    const file = writeFixture(dir)

    const stale = await openStore(file)
    stale.updateNode('n_job', { properties: { note: 'stale-session' } })

    // A directory at the data path reproduces a non-ENOENT read failure (EISDIR)
    // deterministically and portably, without depending on uid or chmod support.
    fs.rmSync(file)
    fs.mkdirSync(file)

    await expect(stale.flush()).rejects.toThrow(/CONFLICT/)
    expect(fs.statSync(file).isDirectory()).toBe(true)
  })
})

// ── (b) the normal path still works ──────────────────────────────────────────

describe(' (b) — the normal load → write → save path is unaffected', () => {
  it('a clean load, mutate, save persists and updates the baseline for the next save', async () => {
    const dir = tmpDir('fresh-happy')
    const file = writeFixture(dir)

    const store = await openStore(file)
    store.updateNode('n_job', { status: 'in_progress' })
    await store.flush()

    let disk = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
    expect(disk.nodes.find((n) => n.id === 'n_job')?.status).toBe('in_progress')

    // A SECOND save from the same store must not self-conflict on its own write.
    store.updateNode('n_persona', { properties: { region: 'north' } })
    await store.flush()

    disk = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
    expect(disk.nodes.find((n) => n.id === 'n_persona')?.properties?.region).toBe('north')
    expect(disk.nodes.find((n) => n.id === 'n_job')?.status).toBe('in_progress')
  })

  it('two live sessions still three-way-merge disjoint edits (no false CONFLICT)', async () => {
    const dir = tmpDir('fresh-merge')
    const file = writeFixture(dir)

    const a = await openStore(file)
    const b = await openStore(file)

    b.updateNode('n_persona', { properties: { region: 'south' } })
    await b.flush()

    a.updateNode('n_job', { properties: { note: 'a-side' } })
    await a.flush()

    const disk = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
    expect(disk.nodes.find((n) => n.id === 'n_persona')?.properties?.region).toBe('south')
    expect(disk.nodes.find((n) => n.id === 'n_job')?.properties?.note).toBe('a-side')
  })
})

// ── (c) the portfolio-workspace path — where the incident happened ───────────

describe(' (c) — portfolio workspace: the wholesale save', () => {
  const crossEdge = (id: string): UPGCrossEdge =>
    ({ id, source: 'p_kestrelbox/n_1', target: 'p_marlinway/n_2', type: 'depends_on_product' }) as UPGCrossEdge

  it('refuses to write a stale in-memory portfolio over a file another session changed', async () => {
    const dir = tmpDir('pf-stale')
    const pf = path.join(dir, 'portfolio.upg')

    const stale = new UPGPortfolioStore()
    await stale.loadOrInit(pf, 'Kestrelbox Group')
    stale.addCrossEdge(crossEdge('cx_a'))
    await stale.flush()

    // Another session adds its own edges and writes.
    const other = new UPGPortfolioStore()
    await other.loadOrInit(pf)
    other.addCrossEdge({ ...crossEdge('cx_b'), target: 'p_ternpoint/n_3' } as UPGCrossEdge)
    other.addCrossEdge({ ...crossEdge('cx_c'), target: 'p_gullrock/n_4' } as UPGCrossEdge)
    await other.flush()

    const freshBytes = fs.readFileSync(pf, 'utf-8')

    // The stale store makes a small change and saves. Pre-fix this serialized its
    // one-edge document over the three-edge file.
    stale.addCrossEdge({ ...crossEdge('cx_d'), target: 'p_pipitfield/n_5' } as UPGCrossEdge)
    await expect(stale.flush()).rejects.toThrow(/CONFLICT/)

    // Byte-identical — the other session's work is intact.
    expect(fs.readFileSync(pf, 'utf-8')).toBe(freshBytes)

    const verify = new UPGPortfolioStore()
    await verify.loadOrInit(pf)
    expect(verify.getAllCrossEdges().map((e) => e.id).sort()).toEqual(['cx_a', 'cx_b', 'cx_c'])
  })

  it('reload() clears the stale state so the retried write succeeds', async () => {
    const dir = tmpDir('pf-reload')
    const pf = path.join(dir, 'portfolio.upg')

    const stale = new UPGPortfolioStore()
    await stale.loadOrInit(pf, 'Kestrelbox Group')
    stale.addCrossEdge(crossEdge('cx_a'))
    await stale.flush()

    const other = new UPGPortfolioStore()
    await other.loadOrInit(pf)
    other.addCrossEdge({ ...crossEdge('cx_b'), target: 'p_ternpoint/n_3' } as UPGCrossEdge)
    await other.flush()

    stale.addCrossEdge({ ...crossEdge('cx_d'), target: 'p_pipitfield/n_5' } as UPGCrossEdge)
    await expect(stale.flush()).rejects.toThrow(/CONFLICT/)

    // In-band recovery, then redo the change.
    await stale.reload()
    stale.addCrossEdge({ ...crossEdge('cx_d'), target: 'p_pipitfield/n_5' } as UPGCrossEdge)
    await stale.flush()

    const verify = new UPGPortfolioStore()
    await verify.loadOrInit(pf)
    expect(verify.getAllCrossEdges().map((e) => e.id).sort()).toEqual(['cx_a', 'cx_b', 'cx_d'])
  })

  it('the ordinary single-session portfolio write path still works', async () => {
    const dir = tmpDir('pf-happy')
    const pf = path.join(dir, 'portfolio.upg')

    const store = new UPGPortfolioStore()
    await store.loadOrInit(pf, 'Kestrelbox Group')
    store.addCrossEdge(crossEdge('cx_a'))
    await store.flush()
    store.addCrossEdge({ ...crossEdge('cx_b'), target: 'p_ternpoint/n_3' } as UPGCrossEdge)
    await store.flush()

    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    const verify = new UPGPortfolioStore()
    await verify.loadOrInit(pf)
    expect(verify.getAllCrossEdges()).toHaveLength(2)
  })
})
