/**
 * Regression tests for the store-hardening wave:
 *   -: concurrency lost-update fix (advisory file lock around the
 *     read-modify-write window). N concurrent writers must persist N updates.
 *   -: load-tolerance. A content-invalid (but structurally sound)
 *     document must LOAD with a stderr warning + an integrity report entry
 *     rather than throwing, so reads and the delete/update that repairs the
 *     file still work. Hard failures (bad JSON, missing `$upg` envelope) still
 *     throw.
 *
 * Each test writes a throwaway `.upg` so the file-backed store behaves exactly
 * as it does for an SDK / CLI consumer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { UPGFileStore, createNode } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SDK_DIST = path.resolve(HERE, '../../dist/index.js')

// A connected, well-formed graph. Mirrors the seam-fixes fixture.
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
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
    ],
  }
}

const cleanups: string[] = []
function writeTmpFixture(doc: unknown = fixtureDoc()): string {
  const f = path.join(os.tmpdir(), `upg-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(doc))
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

// ──: concurrency lost-update ──────────────────────────────────────────

describe(' concurrency: N concurrent writers persist N updates', () => {
  it('12 concurrent CLI-style writers all persist (no lost update, file stays valid JSON)', async () => {
    // The verified repro is cross-PROCESS: `for i in $(seq 1 12); do upg create
    // ... & done; wait` lost one of twelve. We reproduce it faithfully by
    // spawning 12 child node processes that each import the BUILT sdk, load the
    // same file, create one node, and flush. Without the lock, the racing
    // atomic-renames clobber each other and < 12 persist.
    const file = writeTmpFixture()
    const N = 12
    const worker = `
      import { UPGFileStore, createNode } from ${JSON.stringify(SDK_DIST)}
      const store = new UPGFileStore()
      await store.load(process.argv[2])
      createNode(store, { type: 'feature', title: 'Worker-' + process.argv[3] })
      await store.flush()
      store.stopWatching()
    `
    const workerPath = path.join(os.tmpdir(), `upg-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(workerPath, worker)
    cleanups.push(workerPath)

    // Spawn all N concurrently, then await every exit.
    const children = Array.from({ length: N }, (_, i) =>
      spawn(process.execPath, [workerPath, file, String(i)], { stdio: 'ignore' }),
    )
    const codes = await Promise.all(
      children.map(
        (child) =>
          new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
      ),
    )
    expect(codes.every((c) => c === 0)).toBe(true)

    // File must still be valid JSON.
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const titles = (doc.nodes as Array<{ title: string }>)
      .map((n) => n.title)
      .filter((t) => t.startsWith('Worker-'))
    // Every one of the N writers' nodes must be present: no lost update.
    expect(titles.length).toBe(N)
    // And they must be the N distinct workers.
    expect(new Set(titles).size).toBe(N)
  }, 30_000)
})

// ──: load-tolerance ───────────────────────────────────────────────────

describe(' load-tolerance: content-invalid docs LOAD with a warning, not a throw', () => {
  it('a dangling-edge-endpoint doc loads (permissive) + records contentValidationErrors', async () => {
    // Structurally sound: full `$upg` envelope, valid JSON. Content-invalid: an
    // edge references a node id that does not exist.
    const doc = fixtureDoc()
    doc.edges.push({ id: 'e_bad', source: 'n_persona', target: 'n_missing', type: 'persona_pursues_job' })
    const file = writeTmpFixture(doc)

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const store = new UPGFileStore()
    // The key assertion: this does NOT throw.
    await expect(store.load(file)).resolves.toBeUndefined()
    store.stopWatching()

    // Graph is readable.
    expect(store.getNode('n_persona')).toBeDefined()

    // Errors are recorded on the integrity report, and a warning hit stderr.
    const report = store.getIntegrityReport()
    expect(report).toBeTruthy()
    expect(report!.contentValidationErrors.length).toBeGreaterThan(0)
    const warned = stderr.mock.calls.some((c) => String(c[0]).includes('[upg-load]'))
    expect(warned).toBe(true)
  })

  it('an unknown-enum / spec-content failure loads-with-warning (Spock stricter-spec scenario)', async () => {
    // Simulate a node carrying a structurally-required field that the validator
    // flags at the NODE level (content-validity), not the envelope level. Here:
    // a node missing its title is a `$.nodes[i].title` error — content, not
    // structural — so the load must tolerate it.
    const doc = fixtureDoc() as ReturnType<typeof fixtureDoc> & {
      nodes: Array<Record<string, unknown>>
    }
    doc.nodes.push({ id: 'n_untitled', type: 'feature' }) // missing title → content error
    const file = writeTmpFixture(doc)

    const store = new UPGFileStore()
    await expect(store.load(file)).resolves.toBeUndefined()
    store.stopWatching()

    const report = store.getIntegrityReport()
    expect(report!.contentValidationErrors.some((e) => /\$\.nodes\[/.test(e.path))).toBe(true)
  })

  it('after a permissive load, a delete REPAIRS the file (write path still works)', async () => {
    const doc = fixtureDoc()
    doc.edges.push({ id: 'e_bad', source: 'n_persona', target: 'n_missing', type: 'persona_pursues_job' })
    const file = writeTmpFixture(doc)

    const store = new UPGFileStore()
    await store.load(file)
    // Repair: drop the dangling edge.
    store.removeEdge('e_bad')
    await store.flush()
    store.stopWatching()

    // Re-load: now clean, and verify the dangling edge is gone.
    const store2 = new UPGFileStore()
    await store2.load(file)
    store2.stopWatching()
    expect(store2.getEdge('e_bad')).toBeUndefined()
    expect(store2.getIntegrityReport()!.contentValidationErrors.length).toBe(0)
  })

  it('HARD failure preserved: invalid JSON still throws', async () => {
    const file = path.join(os.tmpdir(), `upg-badjson-${Date.now()}.upg`)
    fs.writeFileSync(file, '{ this is not json ')
    cleanups.push(file)
    const store = new UPGFileStore()
    await expect(store.load(file)).rejects.toThrow()
    store.stopWatching()
  })

  it('HARD failure preserved: a bare { product, nodes, edges } with no $upg envelope still throws', async () => {
    // No `$upg` block → the validator reports missing upg_version/exported_at/
    // source (envelope-derived). These are STRUCTURAL → still a hard throw,
    // with the canonical envelope hint.
    const file = path.join(os.tmpdir(), `upg-noenvelope-${Date.now()}.upg`)
    fs.writeFileSync(
      file,
      JSON.stringify({
        product: { id: 'p', title: 'P' },
        nodes: [{ id: 'n', type: 'feature', title: 'F' }],
        edges: [],
      }),
    )
    cleanups.push(file)
    const store = new UPGFileStore()
    await expect(store.load(file)).rejects.toThrow(/Invalid UPG document/)
    store.stopWatching()
  })

  it('a clean, valid doc loads with NO content-validation errors (no regression)', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await store.load(file)
    // normal create still succeeds
    const r = createNode(store, { type: 'feature', title: 'Normal' })
    expect(r.node.title).toBe('Normal')
    await store.flush()
    store.stopWatching()
    expect(store.getIntegrityReport()!.contentValidationErrors.length).toBe(0)
  })
})

// ── / M7: writer provenance ───────────────────────────────────────────

describe(' / M7: writer provenance (last writer wins)', () => {
  function provOf(file: string) {
    return JSON.parse(fs.readFileSync(file, 'utf-8')).$upg.provenance as {
      tool: string
      tool_version?: string
    }
  }

  it('stamps the declared writer (tool + version) on flush, and updates to the last writer', async () => {
    const file = writeTmpFixture()

    const cli = new UPGFileStore()
    cli.setWriter('upg-cli', '9.9.9')
    await cli.load(file)
    createNode(cli, { type: 'feature', title: 'From CLI' })
    await cli.flush()
    cli.stopWatching()
    expect(provOf(file).tool).toBe('upg-cli')
    expect(provOf(file).tool_version).toBe('9.9.9')

    // A different tool writing next must record ITSELF, not keep the prior
    // CLI identity frozen (the M7 bug).
    const mcp = new UPGFileStore()
    mcp.setWriter('upg-mcp-local', '8.8.8')
    await mcp.load(file)
    createNode(mcp, { type: 'feature', title: 'From MCP' })
    await mcp.flush()
    mcp.stopWatching()
    expect(provOf(file).tool).toBe('upg-mcp-local')
    expect(provOf(file).tool_version).toBe('8.8.8')
  })

  it('without setWriter, preserves an existing tool (prior behaviour)', async () => {
    const file = writeTmpFixture()
    const s = new UPGFileStore()
    await s.load(file)
    createNode(s, { type: 'feature', title: 'X' })
    await s.flush()
    s.stopWatching()
    expect(provOf(file).tool).toBe('vitest') // the fixture's tool, not blanked
  })
})
