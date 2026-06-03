/**
 * (F1 + F10) — blank titles must be rejected at the write boundary.
 *
 * An empty ("") or whitespace-only ("   ") title used to persist an invalid node
 * that then bricked every subsequent read AND the delete/update that could fix
 * it — the file became unusable via the CLI, recoverable only by hand-editing
 * JSON. `create` / `new` / `update` now reject blanks up front (exit 2 =
 * validation), so the bad node never reaches disk and the graph stays readable.
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

function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Blank Title Test', stage: 'concept' },
    nodes: [{ id: 'n_persona', type: 'persona', title: 'Busy Parent' }],
    edges: [] as Array<{ id: string; source: string; target: string; type: string }>,
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}

function nodeCount(file: string): number {
  return (JSON.parse(fs.readFileSync(file, 'utf-8')).nodes as unknown[]).length
}

describe(': blank titles rejected at the write boundary', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-blank-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('`create` rejects an empty title (exit 2) and writes nothing', () => {
    const r = run(args(['create', 'persona', '']), tmp)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/title is required/i)
    expect(nodeCount(file)).toBe(1) // unchanged
  })

  it('`create` rejects a whitespace-only title (exit 2)', () => {
    const r = run(args(['create', 'persona', '   ']), tmp)
    expect(r.status).toBe(2)
    expect(nodeCount(file)).toBe(1)
  })

  it('`new` rejects a blank title (exit 2)', () => {
    const r = run(args(['new', 'job', '   ']), tmp)
    expect(r.status).toBe(2)
    expect(nodeCount(file)).toBe(1)
  })

  it('`update --title ""` is rejected (exit 2); the node keeps its title', () => {
    const r = run(args(['update', 'n_persona', '--title', '']), tmp)
    expect(r.status).toBe(2)
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.nodes[0].title).toBe('Busy Parent')
  })

  it('a valid title still works (exit 0) and the graph stays readable (no brick)', () => {
    const c = run(args(['create', 'feature', 'Planner']), tmp)
    expect(c.status).toBe(0)
    expect(nodeCount(file)).toBe(2)
    // The brick never forms: a rejected blank create writes nothing, so reads
    // keep working afterwards.
    const rejected = run(args(['create', 'persona', '']), tmp)
    expect(rejected.status).toBe(2)
    const list = run(args(['list']), tmp)
    expect(list.status).toBe(0)
  })
})
