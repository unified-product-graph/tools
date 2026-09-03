/**
 * 0.38.0 (cloud-agent hardening, F1 + F2) — startup resolution behaviors,
 * driven against the BUILT entrypoint the way a real MCP client launches it.
 *
 * F1: an empty resolution REFUSES (exit 1, names cwd + checked paths, creates
 * NOTHING) instead of fabricating a phantom `product.upg`. The field case: a
 * cloud VM launches the stdio server with an uncontrolled cwd; under the old
 * fallback every tool call "succeeded" against a blank graph and writes were
 * lost with no signal.
 *
 * F2: `--check` resolves exactly as the server would, prints a JSON assertion
 * payload, exits 0/1, never starts the transport, never writes. `--help`
 * prints usage and exits 0 (it was an unknown-option error).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST_ENTRY = resolve(HERE, '../../dist/index.js')
const FIXTURE_UPG = resolve(HERE, '../../../../.upg/threadline.upg')

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [DIST_ENTRY, ...args], {
    cwd,
    env: { ...process.env, UPG_WORKSPACE: '', ...env },
    encoding: 'utf-8',
    timeout: 15_000,
  })
}

let tmp: string | undefined
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = undefined
  }
})

describe('F1 — empty resolution refuses instead of fabricating', () => {
  it('exits 1 in an empty cwd, names the cwd and checked paths, creates nothing', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const r = run([], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('refusing to start')
    expect(r.stderr).toContain(tmp)
    expect(r.stderr).toContain('workspace.json')
    expect(r.stderr).toContain('--init')
    // The trap the refusal exists to prevent: nothing fabricated.
    expect(readdirSync(tmp)).toEqual([])
  })

  it('--file with a non-existent path refuses without --init', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const target = join(tmp, 'new-graph.upg')
    const r = run(['--file', target], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('refusing to create')
    expect(existsSync(target)).toBe(false)
  })

  it('--workspace pointing at a dir with no graphs refuses and says why', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const empty = join(tmp, 'not-a-workspace')
    mkdirSync(empty)
    const r = run(['--workspace', empty], tmp)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no workspace.json and no *.upg files')
    expect(r.stderr).toContain(empty)
  })
})

describe('F2 — --check and --help', () => {
  it('--help prints usage and exits 0', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const r = run(['--help'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--workspace')
    expect(r.stdout).toContain('--check')
    expect(r.stdout).toContain('--init')
  })

  it('--check against a real workspace prints the assertion payload and exits 0', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const ws = join(tmp, 'graphs')
    mkdirSync(ws)
    copyFileSync(FIXTURE_UPG, join(ws, 'threadline.upg'))
    const r = run(['--check', '--workspace', ws], tmp)
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout)
    expect(payload.ok).toBe(true)
    // realpath may resolve /var → /private/var on macOS; assert the suffix.
    expect(payload.workspace.endsWith('/graphs')).toBe(true)
    expect(payload.resolved_file.endsWith('threadline.upg')).toBe(true)
    expect(payload.products).toBe(1)
    expect(typeof payload.spec_version).toBe('string')
    expect(typeof payload.server_version).toBe('string')
  })

  it('--check in an empty cwd exits 1 with an error naming the cwd', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const r = run(['--check'], tmp)
    expect(r.status).toBe(1)
    const payload = JSON.parse(r.stdout)
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain(tmp)
  })

  it('--check never writes: no workspace.json auto-created, no graph fabricated', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const ws = join(tmp, 'graphs')
    mkdirSync(ws)
    copyFileSync(FIXTURE_UPG, join(ws, 'threadline.upg'))
    run(['--check', '--workspace', ws], tmp)
    expect(readdirSync(ws)).toEqual(['threadline.upg'])
  })
})

describe('F1 — UPG_WORKSPACE env is honoured like --workspace', () => {
  it('--check resolves through the env var alone', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const ws = join(tmp, 'graphs')
    mkdirSync(ws)
    copyFileSync(FIXTURE_UPG, join(ws, 'threadline.upg'))
    const r = run(['--check'], tmp, { UPG_WORKSPACE: ws })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).ok).toBe(true)
  })
})
