/**
 * (terminal injection) + (error hygiene) — end-to-end against
 * the BUILT binary, the way a user or a hostile `.upg` author would hit it.
 *
 *: a shared `.upg` may carry a title with raw terminal control bytes
 * (ANSI escapes, BEL). `list` / `find` / `tree` must NEVER re-emit those raw
 * bytes — they get caret-escaped — while `--json` stays byte-identical (it was
 * already `\uXXXX`-safe and machine consumers depend on it).
 *
 *: raw Node errno strings and lockfile internals must surface as human
 * sentences (exit 1), and a structurally invalid document must exit 2 on reads
 * (matching `verify`), not the generic runtime 1.
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
// The exact attack title from the ticket.
const EVIL_TITLE = `${ESC}[31mEVIL${ESC}[2J${ESC}[1;1Hgotcha${BEL}`

function validDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Presentation Test' },
    nodes: [] as Array<{ id: string; type: string; title: string }>,
    edges: [] as Array<{ id: string; source: string; target: string; type: string }>,
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 20_000 })
}

describe(': control bytes never re-emitted on human output', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pres-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(validDoc(), null, 2))
    // Author a node whose title carries the raw control bytes (as if imported).
    // `--` ends option parsing so a title that looks like a flag is taken as-is.
    const id = run(['create', 'persona', '--file', file, '--', EVIL_TITLE], tmp).stdout.trim().split('\n').pop()!
    expect(id).toMatch(/^n_/)
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('the title is STORED with the raw bytes intact (we do not mutate data)', () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.nodes[0].title).toBe(EVIL_TITLE)
    expect(doc.nodes[0].title).toContain(ESC)
  })

  it('`list` emits ZERO raw ESC/BEL bytes (caret-escaped instead)', () => {
    const r = run(['list', '--file', file], tmp)
    expect(r.status).toBe(0)
    const human = r.stdout
    expect(human).not.toContain(ESC)
    expect(human).not.toContain(BEL)
    expect(human).toContain('^[[2J') // the screen-clear is now inert text
  })

  it('`tree` emits ZERO raw ESC/BEL bytes', () => {
    const r = run(['tree', '--file', file], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain(ESC)
    expect(r.stdout).not.toContain(BEL)
    expect(r.stdout).toContain('^[[31m')
  })

  it('`find` (non-interactive) emits ZERO raw ESC/BEL bytes', () => {
    const r = run(['find', 'EVIL', '--file', file], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain(ESC)
    expect(r.stdout).not.toContain(BEL)
  })

  it('`list --json` keeps the raw bytes \\u-escaped (machine path untouched)', () => {
    const r = run(['list', '--file', file, '--json'], tmp)
    expect(r.status).toBe(0)
    // Round-trips back to the exact stored title — JSON is lossless and safe.
    const parsed = JSON.parse(r.stdout)
    expect(parsed[0].title).toBe(EVIL_TITLE)
    // The raw bytes are encoded, not literal, in the JSON text stream.
    expect(r.stdout).toContain('\\u001b')
    expect(r.stdout).not.toContain(ESC)
  })

  it('`tree --json` keeps the raw bytes \\u-escaped', () => {
    const r = run(['tree', '--file', file, '--json'], tmp)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)[0].title).toBe(EVIL_TITLE)
    expect(r.stdout).not.toContain(ESC)
  })
})

describe(': errno + lockfile + invalid-doc hygiene', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-hyg-'))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('EISDIR (--file points at a directory) → friendly message, exit 1', () => {
    const dir = path.join(tmp, 'adir.upg')
    fs.mkdirSync(dir)
    const r = run(['create', 'persona', 'Hello', '--file', dir], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/^EISDIR/m)
    expect(r.stderr).toMatch(/it is a directory/i)
  })

  it('ENAMETOOLONG (300-char filename) → "Path too long", exit 1', () => {
    const longName = 'a'.repeat(300) + '.upg'
    const r = run(['list', '--file', path.join(tmp, longName)], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/^ENAMETOOLONG/m)
    expect(r.stderr).toMatch(/path too long/i)
  })

  it('EACCES (chmod 000 file) → "Permission denied", exit 1', function () {
    // Root ignores file mode; skip if we somehow can still read it.
    const f = path.join(tmp, 'locked.upg')
    fs.writeFileSync(f, JSON.stringify(validDoc()))
    fs.chmodSync(f, 0o000)
    const r = run(['list', '--file', f], tmp)
    fs.chmodSync(f, 0o644)
    if (r.status === 0) return // running as root; nothing to assert
    expect(r.status).toBe(1)
    expect(r.stderr).not.toMatch(/^EACCES/m)
    expect(r.stderr).toMatch(/permission denied/i)
  })

  it('a structurally invalid document exits 2 on a READ (list), matching verify', () => {
    // Bare { product, nodes, edges } with no $upg/provenance envelope → the SDK
    // throws "Invalid UPG document". verify maps this to 2; list now does too.
    const f = path.join(tmp, 'structural.upg')
    fs.writeFileSync(f, JSON.stringify({ product: { id: 'p', title: 'T' }, nodes: [], edges: [] }))
    expect(run(['verify', '--file', f], tmp).status).toBe(2)
    expect(run(['list', '--file', f], tmp).status).toBe(2)
    expect(run(['tree', '--file', f], tmp).status).toBe(2)
  })

  it('the invalid-doc mapping holds under --json too (envelope code 2)', () => {
    const f = path.join(tmp, 'structural.upg')
    fs.writeFileSync(f, JSON.stringify({ product: { id: 'p', title: 'T' }, nodes: [], edges: [] }))
    const r = run(['list', '--file', f, '--json'], tmp)
    expect(r.status).toBe(2)
    expect(JSON.parse(r.stdout).error.code).toBe(2)
  })
})
