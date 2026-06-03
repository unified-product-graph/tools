/**
 * (CLI half) — edge integrity.
 *
 * (b) `connect --type <t>` accepted any string (e.g. `total_nonsense_edge`) at
 *     exit 0, persisting a non-canonical edge that trips the schema-drift summary
 *     on every later read. The fix validates `--type` against the edge-type
 *     catalog and rejects an unknown type at exit 2.
 *
 * (c) A not-found referenced node exited 1, but an incompatible pair exits 2 and
 *     the help promises rejection at exit 2. The fix maps a not-found
 *     referenced-node to exit 2 for consistency, in both `connect` and `link`.
 *
 * NOTE: duplicate-edge dedup is the SDK's job (geordi / store.ts); this suite
 * does not assert idempotency.
 *
 * Driven against the BUILT binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function doc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Edge Integrity', stage: 'concept' },
    nodes: [
      { id: 'n_feat', type: 'feature', title: 'A Feature' },
      { id: 'n_need', type: 'need', title: 'A Need' },
    ] as Array<Record<string, unknown>>,
    edges: [] as Array<Record<string, unknown>>,
  }
}

describe('upg edge integrity', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-edge-integrity-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(doc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 15_000 })
  }

  function edgeCount(): number {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as { edges: unknown[] }
    return d.edges.length
  }

  // ---- (b) --type catalog validation ----

  it('rejects an unknown --type at exit 2 and persists nothing', () => {
    const r = run(['connect', 'n_feat', 'n_need', '--type', 'total_nonsense_edge'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Unknown edge type')
    expect(r.stderr).toContain('total_nonsense_edge')
    expect(edgeCount()).toBe(0)
  })

  it('accepts a valid canonical --type at exit 0', () => {
    const r = run(['connect', 'n_feat', 'n_need', '--type', 'feature_addresses_need'])
    expect(r.status, r.stderr).toBe(0)
    expect(edgeCount()).toBe(1)
  })

  it('still auto-infers the canonical edge when --type is omitted (exit 0)', () => {
    const r = run(['connect', 'n_feat', 'n_need'])
    expect(r.status, r.stderr).toBe(0)
    expect(edgeCount()).toBe(1)
  })

  // ---- (c) not-found referenced node → exit 2 ----

  it('connect: a missing source node exits 2 (was 1)', () => {
    const r = run(['connect', 'n_missing', 'n_need'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Source node not found')
    expect(edgeCount()).toBe(0)
  })

  it('connect: a missing target node exits 2 (was 1)', () => {
    const r = run(['connect', 'n_feat', 'n_missing'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Target node not found')
    expect(edgeCount()).toBe(0)
  })

  it('link: an unresolvable reference exits 2 (was 1)', () => {
    const r = run(['link', 'n_missing', 'n_need'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Could not resolve')
    expect(edgeCount()).toBe(0)
  })

  // ---- cross-cluster seam with the SDK dedup ----
  //
  // Geordi made `store.addEdge` dedup on (source, target, type) and RETURN the
  // canonical edge. connect.ts now reports THAT edge's id (not its locally minted
  // one). The truthful invariant that holds in BOTH worlds — before AND after the
  // dedup SDK composes — is: every id `connect` PRINTS actually exists on disk.
  // Before this seam fix, a repeat connect against the dedup SDK printed a fresh
  // id that was nowhere in the graph.
  describe('repeat connect reports an id that exists on disk (SDK dedup seam)', () => {
    function diskEdgeIds(): string[] {
      const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as { edges: Array<{ id: string }> }
      return d.edges.map((e) => e.id)
    }

    it('every printed id is a real edge; dedup collapses to one same-id edge when active', () => {
      const ids = [0, 1, 2].map(() => {
        const r = run(['connect', 'n_feat', 'n_need'])
        expect(r.status, r.stderr).toBe(0)
        return r.stdout.trim()
      })

      const onDisk = diskEdgeIds()
      // Invariant (both worlds): no printed id is fabricated.
      for (const id of ids) expect(onDisk).toContain(id)

      if (onDisk.length === 1) {
        // Dedup SDK composed: all three connects report the one surviving edge.
        expect(new Set(ids).size).toBe(1)
        expect(ids[0]).toBe(onDisk[0])
      } else {
        // Pre-dedup base SDK: each connect appends a distinct, real edge.
        expect(onDisk.length).toBe(3)
        expect(new Set(ids).size).toBe(3)
      }
    })
  })
})
