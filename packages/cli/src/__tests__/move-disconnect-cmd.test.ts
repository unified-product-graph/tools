/**
 * Tests for `upg move` and `upg disconnect` commands.
 *
 * Both commands are graph-scoped and mutating. Driven against the BUILT binary.
 *
 * move:
 *   - moves a node under a new parent (exit 0, --json reports new edge)
 *   - unknown node id exits 1
 *   - unknown new-parent exits 1
 *   - self-move exits 3 (usage error)
 *   - incompatible type pair exits 2 (policy violation - no catalog edge)
 *   - human output contains the node title
 *
 * disconnect:
 *   - removes an edge by id (exit 0, --json reports deleted_edge_id)
 *   - unknown edge id exits 1
 *   - --yes skips confirmation in non-interactive shell
 *   - human output contains the edge id
 *   - after disconnect the edge is gone (file read confirms)
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

/**
 * Minimal graph with a hierarchy that supports moving:
 *
 *   product
 *     persona "Alice"              (n_persona)
 *       desired_outcome "Delight"  (n_outcome)  <- will be moved
 *     persona "Bob"                (n_bob)      <- new parent for the move
 *     need "Better search"         (n_need)
 *
 * Edge e_out: persona Alice -> desired_outcome (persona_aspires_to_desired_outcome,
 *   classification=hierarchy). This is the edge used to test `upg move`.
 *
 * Edge e_exp: persona Alice -> need (persona_experiences_need, semantic).
 *   This non-hierarchy semantic edge is used to test `upg disconnect`.
 */
function graphDoc() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Move Test' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Alice' },
      { id: 'n_bob', type: 'persona', title: 'Bob' },
      { id: 'n_outcome', type: 'desired_outcome', title: 'Delight' },
      { id: 'n_need', type: 'need', title: 'Better search' },
    ],
    edges: [
      { id: 'e_out', source: 'n_persona', target: 'n_outcome', type: 'persona_aspires_to_desired_outcome' },
      { id: 'e_exp', source: 'n_persona', target: 'n_need', type: 'persona_experiences_need' },
    ],
  }
}

// ── shared helpers ─────────────────────────────────────────────────────────────

function readEdges(file: string): Array<{ id: string; source: string; target: string; type: string }> {
  const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    edges: Array<{ id: string; source: string; target: string; type: string }>
  }
  return d.edges
}

// ─────────────────────────────────────────────────────────────────────────────
// upg move
// ─────────────────────────────────────────────────────────────────────────────

describe('upg move', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-move-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(graphDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file, '--yes'], {
      cwd: tmp,
      stdinFromNull: true,
      timeoutMs: 15_000,
    })
  }

  it('moves a desired_outcome node under a new persona parent (exit 0)', () => {
    const r = run(['move', 'n_outcome', 'n_bob'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
  })

  it('--json reports moved:true and the new edge id', () => {
    const r = run(['move', 'n_outcome', 'n_bob', '--json'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as {
      moved: boolean
      node_id: string
      new_parent_id: string
      new_edge: { id: string; type: string; source: string; target: string }
      removed_edge_id: string | null
    }
    expect(out.moved).toBe(true)
    expect(out.node_id).toBe('n_outcome')
    expect(out.new_parent_id).toBe('n_bob')
    expect(out.new_edge.source).toBe('n_bob')
    expect(out.new_edge.target).toBe('n_outcome')
    expect(out.new_edge.type).toBe('persona_aspires_to_desired_outcome')
    // The old parent edge (e_out) is removed.
    expect(out.removed_edge_id).toBe('e_out')
  })

  it('rewrites the hierarchy edge in the file after move', () => {
    run(['move', 'n_outcome', 'n_bob', '--json'])
    const edges = readEdges(file)
    // Old edge (Alice -> outcome) must be gone.
    expect(edges.find((e) => e.id === 'e_out')).toBeUndefined()
    // A new edge from Bob to outcome must exist.
    const newEdge = edges.find((e) => e.source === 'n_bob' && e.target === 'n_outcome')
    expect(newEdge).toBeDefined()
    expect(newEdge!.type).toBe('persona_aspires_to_desired_outcome')
  })

  it('human output contains the node title and new parent title', () => {
    const r = run(['move', 'n_outcome', 'n_bob'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    // The moved node title appears somewhere in combined output.
    const combined = r.stdout + r.stderr
    expect(combined).toContain('Delight')
    expect(combined).toContain('Bob')
  })

  it('unknown node id exits 1 (runtime error)', () => {
    const r = run(['move', 'n_does_not_exist', 'n_bob'])
    expect(r.status).toBe(1)
  })

  it('unknown new-parent id exits 1 (runtime error)', () => {
    const r = run(['move', 'n_outcome', 'n_does_not_exist'])
    expect(r.status).toBe(1)
  })

  it('self-move exits 3 (usage error)', () => {
    const r = run(['move', 'n_outcome', 'n_outcome'])
    expect(r.status).toBe(3)
  })

  it('incompatible type pair exits 2 (policy violation)', () => {
    // persona -> need: no catalog hierarchy edge from need to persona.
    const r = run(['move', 'n_persona', 'n_need'])
    expect(r.status).toBe(2)
  })

  it('missing id argument exits with non-zero', () => {
    const r = execFileNoThrow(CLI, ['move', '--file', file, '--yes'], {
      cwd: tmp,
      stdinFromNull: true,
      timeoutMs: 15_000,
    })
    expect(r.status).not.toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// upg disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('upg disconnect', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-disconnect-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(graphDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file, '--yes'], {
      cwd: tmp,
      stdinFromNull: true,
      timeoutMs: 15_000,
    })
  }

  it('removes an edge by id (exit 0)', () => {
    const r = run(['disconnect', 'e_exp'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
  })

  it('--json reports deleted_edge_id', () => {
    const r = run(['disconnect', 'e_exp', '--json'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { deleted_edge_id: string }
    expect(out.deleted_edge_id).toBe('e_exp')
  })

  it('edge is absent from the file after disconnect', () => {
    run(['disconnect', 'e_exp', '--json'])
    const edges = readEdges(file)
    expect(edges.find((e) => e.id === 'e_exp')).toBeUndefined()
  })

  it('other edges are untouched after disconnect', () => {
    run(['disconnect', 'e_exp', '--json'])
    const edges = readEdges(file)
    // The hierarchy edge (persona -> desired_outcome) must still be present.
    expect(edges.find((e) => e.id === 'e_out')).toBeDefined()
  })

  it('human output contains the edge id', () => {
    const r = run(['disconnect', 'e_exp'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const combined = r.stdout + r.stderr
    expect(combined).toContain('e_exp')
  })

  it('unknown edge id exits 1 (runtime error)', () => {
    const r = run(['disconnect', 'e_does_not_exist'])
    expect(r.status).toBe(1)
  })

  it('stdout prints the deleted edge id on success', () => {
    const r = run(['disconnect', 'e_exp'])
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe('e_exp')
  })

  it('missing edge-id argument exits with non-zero', () => {
    const r = execFileNoThrow(CLI, ['disconnect', '--file', file, '--yes'], {
      cwd: tmp,
      stdinFromNull: true,
      timeoutMs: 15_000,
    })
    expect(r.status).not.toBe(0)
  })
})
