/**
 * (CLI half) — numeric + --data boundary validation.
 *
 * (a) `verify --max-orphan-rate` used a bare `parseFloat` coercion, so garbage
 *     ("abc", "", "99", "Infinity") became NaN and `rate > NaN` is always false:
 *     a 100%-orphan graph PASSED the gate at exit 0. The fix requires a finite
 *     number in [0,1], rejected at parse time as a usage error (exit 3).
 *
 * (b) `parseDataOption` stored `[1,2,3]` / `42` / `true` verbatim as
 *     `properties`, dropped `null`, and let a bare `"hello"` fail late at exit 1
 *     with a leaked `[upg fmt]` string. The fix requires a non-null plain object
 *     at the shared parse point, rejected as a usage error (exit 3) at create
 *     time, before anything is written.
 *
 * Driven against the BUILT binary. The graph here is two isolated nodes — a
 * 100%-orphan graph — so a garbage `--max-orphan-rate` that wrongly passed would
 * be caught.
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

/** Two isolated nodes → orphan rate 100%. */
function orphanDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Boundary', stage: 'concept' },
    nodes: [
      { id: 'n_a', type: 'feature', title: 'Orphan A' },
      { id: 'n_b', type: 'feature', title: 'Orphan B' },
    ] as Array<Record<string, unknown>>,
    edges: [] as Array<Record<string, unknown>>,
  }
}

describe('upg boundary validation', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-boundary-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(orphanDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 60_000 })
  }

  // ---- (a) --max-orphan-rate ----

  describe('verify --max-orphan-rate requires a finite number in [0,1]', () => {
    for (const garbage of ['abc', '', '99', 'Infinity', '-1', 'NaN', '0.5x']) {
      it(`rejects "${garbage}" at exit 3 (a 100%-orphan graph must NOT pass)`, () => {
        const r = run(['verify', '--max-orphan-rate', garbage])
        expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(3)
        // The crucial regression guard: it must NOT have silently passed.
        expect(r.stdout).not.toContain('All checks passed')
        expect(r.stderr).toContain('--max-orphan-rate')
      })
    }

    it('accepts 1.0 — a 100%-orphan graph is within the limit → exit 0', () => {
      const r = run(['verify', '--max-orphan-rate', '1.0'])
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('All checks passed')
    })

    it('accepts 0.0 — a 100%-orphan graph exceeds it → exit 2 (violation)', () => {
      const r = run(['verify', '--max-orphan-rate', '0.0'])
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('max-orphan-rate')
    })
  })

  // ---- (b) parseDataOption non-object ----

  describe('create --data must be a non-null plain object', () => {
    for (const bad of ['[1,2,3]', '42', 'true', 'null', '"hello"']) {
      it(`rejects ${bad} at exit 3 at create time`, () => {
        const before = fs.readFileSync(file, 'utf-8')
        const r = run(['create', 'feature', 'X', '--data', bad])
        expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(3)
        expect(r.stderr).toContain('--data must be a JSON object')
        // No leaked `[upg fmt]` runtime string from a late failure.
        expect(r.stdout).not.toContain('[upg fmt]')
        expect(r.stderr).not.toContain('[upg fmt]')
        // Nothing persisted.
        expect(fs.readFileSync(file, 'utf-8')).toBe(before)
      })
    }

    it('accepts a valid object payload at exit 0', () => {
      const r = run(['create', 'feature', 'Good', '--data', '{"k":1}'])
      expect(r.status, r.stderr).toBe(0)
    })
  })
})
