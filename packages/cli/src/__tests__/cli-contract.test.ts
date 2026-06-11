/**
 * CLI contract tests (CLI-FEEDBACK #2,#3,#4,#6,#7,#8).
 *
 * Drives the BUILT binary against a throwaway copy of a real .upg graph and
 * pins the exit-code table, the --json mutation output, the non-interactive
 * --yes guard, lifecycle validation, and ambiguous-file resolution.
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

// A minimal but valid graph: a persona connected to a job (so we have a node
// with an edge to exercise delete cascade), plus a feature for lifecycle tests.
function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Contract Test' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Tester' },
      { id: 'n_job', type: 'job', title: 'Run the suite' },
      { id: 'n_feature', type: 'feature', title: 'A feature' },
    ],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
    ],
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe('CLI contract', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-contract-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // ── #2 / #6 exit-code table ────────────────────────────────────────────────

  it('verify on a clean graph exits 0', () => {
    expect(run(['verify', '--file', file], tmp).status).toBe(0)
  })

  it('verify on a dangling-edge graph exits 2 (violation)', async () => {
    const bad = fixtureDoc()
    bad.edges.push({ id: 'e_x', source: 'n_persona', target: 'n_missing', type: 'persona_pursues_job' })
    const badPath = path.join(tmp, 'bad.upg')
    await fsp.writeFile(badPath, JSON.stringify(bad, null, 2))
    expect(run(['verify', '--file', badPath], tmp).status).toBe(2)
  })

  it('a missing file is a runtime error (exit 1), not a violation', () => {
    expect(run(['verify', '--file', path.join(tmp, 'nope.upg')], tmp).status).toBe(1)
  })

  it('create with an unknown type exits 2 (policy)', () => {
    // D2: an unknown entity type is a validation/policy violation
    // (exit 2), matching `create --status <bad>` and `new`. (Was exit 1.)
    expect(run(['create', 'not_a_type', 'X', '--file', file], tmp).status).toBe(2)
  })

  it('connect of an incompatible pair exits 2 (policy)', () => {
    // persona -> persona has no inferable edge.
    const r = run(['connect', 'n_persona', 'n_persona', '--file', file], tmp)
    expect(r.status).toBe(2)
  })

  // ── #4 lifecycle validation on write ────────────────────────────────────────

  it('create with an invalid lifecycle status exits 2', () => {
    const r = run(['create', 'feature', 'Y', '--status', 'totally_invalid', '--file', file], tmp)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('not a valid phase')
  })

  it('update with an invalid lifecycle status exits 2 and does not write', () => {
    const r = run(['update', 'n_feature', '--status', 'totally_invalid', '--file', file], tmp)
    expect(r.status).toBe(2)
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const feat = after.nodes.find((n: { id: string }) => n.id === 'n_feature')
    expect(feat.status).toBeUndefined()
  })

  // ── #7 --json on mutations ───────────────────────────────────────────────────

  it('create --json emits the new node id on stdout', () => {
    const r = run(['create', 'persona', 'New One', '--json', '--file', file], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.node.id).toMatch(/^n_/)
    expect(out.node.type).toBe('persona')
  })

  it('delete --json reports the node and cascaded edges', () => {
    const r = run(['delete', 'n_persona', '--yes', '--json', '--file', file], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.deleted.id).toBe('n_persona')
    expect(out.removed_edges.map((e: { id: string }) => e.id)).toContain('e_pj')
  })

  it('connect --json emits the new edge', () => {
    const r = run(['connect', 'n_persona', 'n_job', '--json', '--file', file], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge.source).toBe('n_persona')
    expect(out.edge.target).toBe('n_job')
  })

  it('tree --json emits a nested structure', () => {
    const r = run(['tree', '--json', '--file', file], tmp)
    expect(r.status).toBe(0)
    const tree = JSON.parse(r.stdout)
    expect(Array.isArray(tree)).toBe(true)
    const persona = tree.find((n: { id: string }) => n.id === 'n_persona')
    expect(persona.children.map((c: { id: string }) => c.id)).toContain('n_job')
  })

  // ── #3 non-interactive delete guard ──────────────────────────────────────────

  it('delete without --yes in a non-TTY exits 3 and deletes nothing', () => {
    const r = run(['delete', 'n_persona', '--file', file], tmp)
    expect(r.status).toBe(3)
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(after.nodes.some((n: { id: string }) => n.id === 'n_persona')).toBe(true)
  })

  it('delete of a missing id exits 1', () => {
    expect(run(['delete', 'n_missing', '--yes', '--file', file], tmp).status).toBe(1)
  })

  // ── #8 file resolution ───────────────────────────────────────────────────────

  it('ambiguous .upg (no workspace, >1 file) exits 3', async () => {
    await fsp.writeFile(path.join(tmp, 'second.upg'), JSON.stringify(fixtureDoc(), null, 2))
    const r = run(['list'], tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('Multiple .upg files')
  })

  it('UPG_FILE is honoured when no --file is passed', () => {
    const r = execFileNoThrow(CLI, ['verify'], { cwd: tmp, stdinFromNull: true, env: { UPG_FILE: file } })
    expect(r.status).toBe(0)
  })
})
