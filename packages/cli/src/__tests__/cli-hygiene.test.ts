/**
 * CLI hygiene QA: export --format validation (M6) + init flags (L3).
 * Spawns the built binary the way a user/agent would.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from './helpers/exec.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000, env })
}

function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Hygiene Test' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Busy Parent' },
      { id: 'n_feature', type: 'feature', title: 'Dark mode' },
    ],
    edges: [],
  }
}

describe('export --format validation (M6)', () => {
  let tmp: string
  let file: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-hyg-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('an unknown --format fails with a usage error (exit 3), not a silent empty exit 0', () => {
    const r = run(['export', '--format', 'bogus', '--file', file], tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/Unknown --format/i)
  })

  it('accepts "markdown" as an alias for md (exit 0, markdown output)', () => {
    const r = run(['export', '--format', 'markdown', '--file', file], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^##\s/m)
  })

  it('the documented formats still work', () => {
    expect(run(['export', '--format', 'md', '--file', file], tmp).status).toBe(0)
    expect(run(['export', '--format', 'json', '--file', file], tmp).status).toBe(0)
    expect(run(['export', '--format', 'csv', '--file', file], tmp).status).toBe(0)
  })

  it('an unknown --format under --json emits a JSON error envelope (exit 3)', () => {
    const r = run(['export', '--format', 'bogus', '--file', file, '--json'], tmp)
    expect(r.status).toBe(3)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(false)
    expect(out.error.code).toBe(3)
  })
})

describe('init non-interactive flags (L3)', () => {
  let tmp: string
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-init-'))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('--title + --yes is fully non-interactive (no prompt hang) and writes product.upg', () => {
    const r = run(['init', '--title', 'My Product', '--yes'], tmp)
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(tmp, 'product.upg'))).toBe(true)
  })

  it('--file sets an explicit output path', () => {
    const r = run(['init', '--file', 'custom.upg', '--title', 'X', '--yes'], tmp)
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(tmp, 'custom.upg'))).toBe(true)
  })

  it('honours $UPG_FILE for the output path', () => {
    const r = run(['init', '--title', 'Y', '--yes'], tmp, { ...process.env, UPG_FILE: 'from-env.upg' })
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(tmp, 'from-env.upg'))).toBe(true)
  })
})

describe('show framework exercise (M5)', () => {
  let tmp: string
  let file: string
  function exerciseDoc() {
    return {
      upg_version: '0.8.0',
      exported_at: new Date().toISOString(),
      source: { tool: 'test', tool_version: '0' },
      product: { id: 'p_test', title: 'Show Test' },
      nodes: [
        { id: 'n_fx', type: 'framework_exercise', title: 'Q3 release scope', status: 'active', properties: { framework_id: 'moscow' } },
        { id: 'n_f1', type: 'feature', title: 'SSO login', status: 'proposed' },
        { id: 'n_f2', type: 'feature', title: 'Dark mode', status: 'proposed' },
      ],
      edges: [
        { id: 'e1', source: 'n_fx', target: 'n_f1', type: 'framework_exercise_includes_node', properties: { moscow: 'must' } },
        { id: 'e2', source: 'n_fx', target: 'n_f2', type: 'framework_exercise_includes_node', properties: { moscow: 'could' } },
      ],
    }
  }
  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-show-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(exerciseDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('renders a table of the included entities and their recorded scores', () => {
    const r = run(['show', 'n_fx', '--file', file], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/SSO login/)
    expect(r.stdout).toMatch(/Dark mode/)
    expect(r.stdout).toMatch(/must/)
    expect(r.stdout).toMatch(/could/)
  })

  it('resolves the exercise by title', () => {
    const r = run(['show', 'Q3 release scope', '--file', file], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/SSO login/)
  })

  it('--json returns the included rows', () => {
    const r = run(['show', 'n_fx', '--file', file, '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.framework_id).toBe('moscow')
    expect(out.included).toHaveLength(2)
  })

  it('rejects a non-exercise node with a usage error (exit 3)', () => {
    const r = run(['show', 'n_f1', '--file', file], tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/not a framework_exercise/i)
  })
})
