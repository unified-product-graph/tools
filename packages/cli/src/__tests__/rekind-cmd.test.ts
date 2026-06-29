/**
 * Regression tests for `upg workspace rekind`, driven THROUGH Commander.
 *
 * The bug (caught by Field QA on 0.17.0): with two declared arguments
 * (`[action] [items...]`) Commander passes `(action, items, options, command)`,
 * so the third callback parameter is the parsed options object, NOT the Command.
 * The old code typed it `cmd` and called `cmd.opts()`, which threw
 * `cmd.opts is not a function` and crashed rekind for every kind. Existing CLI
 * tests exercised the SDK directly, so nothing drove the Commander path. These
 * run the BUILT binary end to end.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function productDoc(id = 'p_rekind', title = 'Rekind Test') {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [] as unknown[],
    edges: [] as unknown[],
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe('upg workspace rekind (Commander arg-order regression)', () => {
  let tmp: string
  let upgFile: string

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
  })

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-rekind-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    upgFile = path.join(upgDir, 'product.upg')
    await fsp.writeFile(upgFile, JSON.stringify(productDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('rekind --kind watched sets member_kind without crashing (--json)', () => {
    const r = run(['workspace', 'rekind', '--kind', 'watched', upgFile, '--json'], tmp)
    expect(r.stderr).not.toMatch(/cmd\.opts is not a function/)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as {
      ok: boolean
      kind: string
      results: Array<{ ok: boolean; changed: boolean }>
    }
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('watched')
    expect(out.results[0].changed).toBe(true)
    expect(fs.readFileSync(upgFile, 'utf-8')).toMatch(/"member_kind":\s*"watched"/)
  })

  it('rekind --kind operating_function is accepted (the 0.17.0 kind)', () => {
    const r = run(['workspace', 'rekind', '--kind', 'operating_function', upgFile, '--json'], tmp)
    expect(r.stderr).not.toMatch(/cmd\.opts is not a function/)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; kind: string }
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('operating_function')
  })

  it('rekind without --kind exits non-zero with a usage message that lists operating_function', () => {
    const r = run(['workspace', 'rekind', upgFile], tmp)
    expect(r.stderr).not.toMatch(/cmd\.opts is not a function/)
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/operating_function/)
  })

  it('rekind --kind bogus exits non-zero (invalid kind rejected)', () => {
    const r = run(['workspace', 'rekind', '--kind', 'bogus', upgFile], tmp)
    expect(r.stderr).not.toMatch(/cmd\.opts is not a function/)
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/Invalid --kind/)
  })
})
