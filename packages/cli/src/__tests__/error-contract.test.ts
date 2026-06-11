/**
 * (error contract) + (UX polish) + item 7 (fmt --check
 * validates). Drives the BUILT binary against throwaway graphs.
 *
 * D — error contract
 *   1. `--json` emits a JSON error envelope on the ERROR path, with the exit
 *      code in the body and on the process.
 *   2. Exit-code taxonomy: unknown entity type → 2 (was 1); malformed `--data`
 *      → 3 with ONE consistent message across create/update/score (was 1 in
 *      create/update, 3-with-a-different-message in score).
 *
 * fmt ( item 7)
 *   7. `fmt --check` validates the document and FAILS (exit 2) on a
 *      semantically invalid but byte-canonical file, instead of green-lighting.
 *
 * E — UX polish
 *   3. Duplicate-title resolution refuses to guess (exit 3, lists ids).
 *   4. Leaked internal strings are wrapped (incompatible edge; bad `--file`).
 *   5. `--data` over ~256 KB is rejected with a clear error.
 *   6. (`--` end-of-options escape — documented in help; smoke-tested here.)
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

/** A minimal valid graph with a persona, a job, and a persona→job edge. */
function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Error Contract Test' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Busy Parent' },
      { id: 'n_job', type: 'job', title: 'Plan dinner' },
    ],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
    ],
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe(' D1: --json error contract', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-err-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('emits a JSON envelope on stdout on an error path (not a human line)', () => {
    const r = run(args(['create', 'bogustype', 'Z', '--json']), tmp)
    expect(r.status).toBe(2)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.error.code).toBe(2)
    expect(out.error.message).toMatch(/unknown entity type/i)
    // The human stderr line is suppressed under --json.
    expect(r.stderr.trim()).toBe('')
  })

  it('the JSON error code matches the process exit code', () => {
    const r = run(args(['create', 'persona', 'X', '--data', 'not json', '--json']), tmp)
    expect(r.status).toBe(3)
    expect(JSON.parse(r.stdout).error.code).toBe(3)
  })

  it('a runtime error (missing node) is JSON with code 1 under --json', () => {
    const r = run(args(['update', 'n_missing', '--title', 'X', '--json']), tmp)
    expect(r.status).toBe(1)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.error.code).toBe(1)
  })

  it('without --json the error stays a human line on stderr', () => {
    const r = run(args(['create', 'bogustype', 'Z']), tmp)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown entity type/i)
    expect(r.stdout.trim()).toBe('')
  })
})

describe(' D2: exit-code taxonomy', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-tax-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('unknown entity type exits 2 in create (validation, was 1)', () => {
    expect(run(args(['create', 'not_a_type', 'X']), tmp).status).toBe(2)
  })

  it('unknown entity type exits 2 in new (validation, was 1)', () => {
    expect(run(args(['new', 'not_a_type', 'X']), tmp).status).toBe(2)
  })

  it('malformed --data exits 3 in create, update, and score (was 1/1/3)', () => {
    expect(run(args(['create', 'persona', 'X', '--data', '{bad']), tmp).status).toBe(3)
    expect(run(args(['update', 'n_persona', '--data', '{bad']), tmp).status).toBe(3)
    expect(run(args(['score', 'n_ex', 'n_job', '--data', '{bad']), tmp).status).toBe(3)
  })

  it('malformed --data uses ONE consistent message everywhere', () => {
    const msg = (r: { stderr: string }) => r.stderr.trim()
    const c = run(args(['create', 'persona', 'X', '--data', '{bad']), tmp)
    const u = run(args(['update', 'n_persona', '--data', '{bad']), tmp)
    const s = run(args(['score', 'n_ex', 'n_job', '--data', '{bad']), tmp)
    expect(msg(c)).toMatch(/--data must be valid JSON/)
    expect(msg(c)).toBe(msg(u))
    expect(msg(u)).toBe(msg(s))
  })
})

describe(' item 7: fmt --check validates', () => {
  let tmp: string
  const run2 = (args: string[]) => run(args, tmp)

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-fmt-'))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('fails (exit 2) on a byte-canonical but semantically invalid file', () => {
    // A doc with a dangling edge target. Canonicalise it first so the ONLY
    // reason --check could fail is validation, not formatting.
    const bad = fixtureDoc()
    bad.edges.push({ id: 'e_bad', source: 'n_persona', target: 'n_MISSING', type: 'persona_pursues_job' })
    const f = path.join(tmp, 'invalid.upg')
    fs.writeFileSync(f, JSON.stringify(bad, null, 2))
    expect(run2(['fmt', f]).status).toBe(0) // canonicalise in place
    const r = run2(['fmt', '--check', f])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/failed validation/i)
  })

  it('passes (exit 0) on a valid canonical file', () => {
    const f = path.join(tmp, 'valid.upg')
    fs.writeFileSync(f, JSON.stringify(fixtureDoc(), null, 2))
    expect(run2(['fmt', f]).status).toBe(0) // canonicalise
    expect(run2(['fmt', '--check', f]).status).toBe(0)
  })
})

describe(' E3: duplicate-title resolution refuses to guess', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-dup-'))
    file = path.join(tmp, 'product.upg')
    const doc = fixtureDoc()
    // A second persona with the SAME title as the first.
    doc.nodes.push({ id: 'n_persona2', type: 'persona', title: 'Busy Parent' })
    await fsp.writeFile(file, JSON.stringify(doc, null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('`at` by an ambiguous title exits 3 and lists both ids', () => {
    const r = run(args(['at', 'Busy Parent']), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('n_persona')
    expect(r.stderr).toContain('n_persona2')
    expect(r.stderr).toMatch(/refusing to guess/i)
  })

  it('`link` by an ambiguous title exits 3', () => {
    const r = run(args(['link', 'Busy Parent', 'Plan dinner']), tmp)
    expect(r.status).toBe(3)
  })

  it('`new --at` an ambiguous title exits 3 and writes nothing', () => {
    const before = JSON.parse(fs.readFileSync(file, 'utf-8')).nodes.length
    const r = run(args(['new', 'feature', 'Planner', '--at', 'Busy Parent']), tmp)
    expect(r.status).toBe(3)
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')).nodes.length
    expect(after).toBe(before)
  })

  it('a UNIQUE title still resolves cleanly (exit 0)', () => {
    expect(run(args(['at', 'Plan dinner']), tmp).status).toBe(0)
  })
})

describe(' E4: leaked internal strings are wrapped', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-leak-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('an incompatible connect shows a user-facing message, not the catalog string', () => {
    const r = run(args(['connect', 'n_persona', 'n_persona']), tmp)
    expect(r.status).toBe(2)
    expect(r.stderr).not.toContain('UPG_EDGE_CATALOG')
    expect(r.stderr).toMatch(/cannot connect directly to/i)
    expect(r.stderr).toMatch(/no canonical relationship exists/i)
  })

  it('--file at a missing path: "No .upg file at <path>" (exit 1)', () => {
    const missing = path.join(tmp, 'nope.upg')
    const r = run(['list', '--file', missing], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`No .upg file at ${missing}`)
  })

  it('--file at a non-JSON file: "Not a valid .upg file: <path>" (exit 1)', () => {
    const notJson = path.join(tmp, 'bad.upg')
    fs.writeFileSync(notJson, 'this is not json\n')
    const r = run(['list', '--file', notJson], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Not a valid \.upg file/)
  })
})

describe(' E5: --data size guard', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-size-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // The 256 KB --data guard can only be exercised by passing a >256 KB value as a
  // single argv argument. On Linux a single argument cannot exceed MAX_ARG_STRLEN
  // (128 KB), so the OS rejects the spawn with E2BIG before the CLI ever runs (the
  // OS enforces an even tighter limit than the guard). The guard is exercised on
  // platforms with a high per-arg limit (macOS dev); skip where argv cannot hold it.
  it.skipIf(process.platform === 'linux')('rejects a --data payload over 256 KB (exit 3) and writes nothing', () => {
    const huge = JSON.stringify({ blob: 'a'.repeat(300_000) })
    const before = JSON.parse(fs.readFileSync(file, 'utf-8')).nodes.length
    const r = run(args(['create', 'persona', 'Big', '--data', huge]), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/too large/i)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).nodes.length).toBe(before)
  })

  it('a normal-sized --data payload still works (exit 0)', () => {
    const r = run(args(['create', 'persona', 'Small', '--data', '{"k":"v"}']), tmp)
    expect(r.status).toBe(0)
  })
})

describe('UPG QA 0.8.7 N3: commander option-errors print exactly once', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-n3-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // Count how many lines on stderr match an `error: ` prefix. The defect was a
  // double-log: Commander's default writeErr printed the message AND the catch
  // block re-printed it, yielding two identical lines.
  const errorLineCount = (stderr: string) =>
    stderr.split('\n').filter((l) => l.startsWith('error: ')).length

  it('a missing required option prints its error once (exit 3)', () => {
    // `score` requires --data; omitting it triggers commander.missingMandatoryOptionValue.
    const r = run(args(['score', 'n_ex', 'n_job']), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/required option '--data <json>' not specified/)
    expect(errorLineCount(r.stderr)).toBe(1)
  })

  it('an unknown option prints its error once (exit 3)', () => {
    const r = run(args(['list', '--definitely-not-a-flag']), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/unknown option/)
    expect(errorLineCount(r.stderr)).toBe(1)
  })

  it('under --json the same option-error is a single envelope, no human line', () => {
    const r = run(args(['score', 'n_ex', 'n_job', '--json']), tmp)
    expect(r.status).toBe(3)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.error.code).toBe(3)
    expect(r.stderr.trim()).toBe('')
  })
})

describe(' E6: -- end-of-options escape for flag-like titles', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-esc-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('`create <type> --file <f> -- "--draft"` treats the flag-like token as the title', () => {
    const r = run(['create', 'persona', '--file', file, '--', '--draft'], tmp)
    expect(r.status).toBe(0)
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.nodes.some((n: { title: string }) => n.title === '--draft')).toBe(true)
  })
})
