/**
 * (terminal injection) — mutation-command surface.
 *
 * The read commands (`list`/`tree`/`find`) are covered in cli-presentation.test.ts.
 * Mutation commands echo a node title back in their success line (on stderr) —
 * and `connect`/`update`/`delete` echo a STORED title, which a hostile `.upg`
 * author controls. Those success lines must also caret-escape control bytes, or
 * the injection survives via `upg connect`/`update` on an attacker-authored graph.
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

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const EVIL_TITLE = `${ESC}[31mEVIL${ESC}[2J${ESC}[1;1Hgotcha${BEL}`

function validDoc() {
  return {
    upg_version: '0.8.7',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Mutation Sanitize Test' },
    nodes: [] as Array<{ id: string; type: string; title: string }>,
    edges: [] as Array<{ id: string; source: string; target: string; type: string }>,
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 20_000 })
}

function noRawControlBytes(s: string) {
  expect(s).not.toContain(ESC)
  expect(s).not.toContain(BEL)
}

describe(': mutation success lines never re-emit control bytes', () => {
  let tmp: string
  let file: string
  let evilId: string
  let jobId: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-mut-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(validDoc(), null, 2))
    // `--` ends option parsing so a title that looks like a flag is taken as-is.
    evilId = run(['create', 'persona', '--file', file, '--', EVIL_TITLE], tmp).stdout.trim().split('\n').pop()!
    jobId = run(['create', 'job', '--file', file, 'Plan dinner'], tmp).stdout.trim().split('\n').pop()!
    expect(evilId).toMatch(/^n_/)
    expect(jobId).toMatch(/^n_/)
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('`create` echoes the just-typed title without raw bytes', () => {
    const r = run(['create', 'persona', '--file', file, '--', EVIL_TITLE], tmp)
    expect(r.status).toBe(0)
    noRawControlBytes(r.stderr)
    expect(r.stderr).toContain('Created')
  })

  it('`connect` echoes the STORED source title without raw bytes', () => {
    const r = run(['connect', evilId, jobId, '--file', file], tmp)
    expect(r.status).toBe(0)
    noRawControlBytes(r.stderr)
    expect(r.stderr).toContain('Connected')
  })

  it('`update` echoes the STORED title without raw bytes', () => {
    const r = run(['update', evilId, '--file', file, '--data', '{"note":"x"}'], tmp)
    expect(r.status).toBe(0)
    noRawControlBytes(r.stderr)
    expect(r.stderr).toContain('Updated')
  })

  it('the stored title is still intact (we sanitize output, never mutate data)', () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const evil = doc.nodes.find((n: { id: string }) => n.id === evilId)
    expect(evil.title).toBe(EVIL_TITLE)
    expect(evil.title).toContain(ESC)
  })
})
