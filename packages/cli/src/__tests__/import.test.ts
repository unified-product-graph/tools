/**
 * `upg import` regression tests.
 *
 * The `--input <path>` flag is documented in both `upg import --help` and the
 * README, but the command never defined it: `upg import --from markdown --input
 * ./docs` exited 3 ("unknown option '--input'") and a positional path exited 3
 * ("too many arguments"). There was no way to point the importer at a source,
 * so the command was non-functional. These tests drive the BUILT binary the way
 * a user would and pin the wiring so it can never silently rot again:
 *   - `--from markdown --input <dir> --dry-run` previews entities (exit 0)
 *   - a bare positional path is accepted (exit 0)
 *   - a real import writes the previewed nodes into the target .upg (exit 0)
 *   - a bogus `--from` value is a usage error with a clear message (exit 3)
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

const FIXTURE_MD = [
  '# Busy Parent',
  '',
  'A persona who needs to plan dinner quickly on a weeknight.',
  '',
  '## Plan dinner',
  '',
  'They want to decide what to cook without much effort.',
  '',
].join('\n')

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000, env })
}

describe('upg import --input wiring', () => {
  let tmp: string
  let docs: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-import-'))
    docs = path.join(tmp, 'docs')
    await fsp.mkdir(docs, { recursive: true })
    await fsp.writeFile(path.join(docs, 'notes.md'), FIXTURE_MD)
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  it('`--from markdown --input <dir> --dry-run` previews entities (exit 0)', () => {
    const r = run(['import', '--from', 'markdown', '--input', docs, '--dry-run'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Preview')
    expect(r.stdout).toContain('Dry run')
    // The fixture yields at least one entity to preview.
    expect(r.stdout).toMatch(/\d+ entit/)
    // Nothing is written on a dry run.
    expect(fs.existsSync(path.join(tmp, 'product.upg'))).toBe(false)
  })

  it('accepts a bare positional source path (exit 0)', () => {
    const r = run(['import', '--from', 'markdown', docs, '--dry-run'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Preview')
  })

  it('a real import writes nodes into the target .upg (exit 0)', () => {
    const out = path.join(tmp, 'out.upg')
    const r = run(
      ['import', '--from', 'markdown', '--input', docs, '--output', out, '--yes'],
      tmp,
    )
    expect(r.status).toBe(0)
    expect(fs.existsSync(out)).toBe(true)

    const doc = JSON.parse(fs.readFileSync(out, 'utf-8'))
    expect(Array.isArray(doc.nodes)).toBe(true)
    expect(doc.nodes.length).toBeGreaterThan(0)
  })

  it('a bogus `--from` value is a usage error with a clear message (exit 3)', () => {
    const r = run(['import', '--from', 'bogus', '--input', docs, '--dry-run'], tmp)
    expect(r.status).toBe(3)
    // The message names the bad value and lists the valid choices.
    expect(r.stderr).toContain('bogus')
    expect(r.stderr).toContain('markdown')
  })
})
