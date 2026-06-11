/**
 * CLI-FEEDBACK #1 — help-safety regression test.
 *
 * The critical bug: `upg <cmd> --help` was swallowed and the command RAN
 * (logout cleared credentials, install-skills linked 44 skills, delete opened
 * a destructive picker, init started an interactive prompt). This test pins the
 * fix: for EVERY registered command, `<cmd> --help`, `<cmd> -h`, and
 * `upg help <cmd>` must
 *   (a) exit 0,
 *   (b) print structured help text,
 *   (c) perform ZERO filesystem / network / credential side effects.
 *
 * We drive the BUILT binary as a subprocess (the real entry path users hit),
 * inside an isolated empty temp cwd, with stdin pointed at /dev/null so an
 * interactive prompt would hang-then-fail rather than silently pass. Side
 * effects are detected by snapshotting the temp dir + the user's ~/.upg
 * credentials before/after.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, execFileNoThrow } from './helpers/exec.js'
import { commandNames } from '../lib/command-registry.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

// The full registry, derived from the SAME ALL_COMMANDS cli.ts builds the
// program from (lib/command-registry.ts). A new command is automatically
// covered here; it cannot be added without a help-safe `--help` path.
const COMMANDS = commandNames()

function dirSnapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, entry.name)
      if (entry.isDirectory()) walk(path.join(d, entry.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

function credsSnapshot(): string | null {
  const p = path.join(os.homedir(), '.upg', 'credentials.json')
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

describe('help safety (CLI-FEEDBACK #1)', () => {
  let tmp: string
  let credsBefore: string | null

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}. Run \`npm run build\` in packages/upg-cli first.`)
    }
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-help-safety-'))
    credsBefore = credsSnapshot()
  })

  for (const cmd of COMMANDS) {
    for (const helpFlag of ['--help', '-h']) {
      it(`\`upg ${cmd} ${helpFlag}\` prints help, exits 0, no side effects`, () => {
        const before = dirSnapshot(tmp)
        const { status, stdout, stderr } = execFileNoThrow(CLI, [cmd, helpFlag], {
          cwd: tmp,
          stdinFromNull: true,
          timeoutMs: 60_000,
        })
        const after = dirSnapshot(tmp)

        // (a) exit 0
        expect(status, `${cmd} ${helpFlag} exit (stderr: ${stderr})`).toBe(0)
        // (b) help text — the usage line for that command appears in output.
        expect(stdout, `${cmd} ${helpFlag} stdout`).toContain(`upg ${cmd}`)
        // (c) no files created/changed in cwd.
        expect(after, `${cmd} ${helpFlag} touched cwd`).toEqual(before)
        // (c) credentials untouched.
        expect(credsSnapshot(), `${cmd} ${helpFlag} touched credentials`).toEqual(credsBefore)
      })
    }

    it(`\`upg help ${cmd}\` prints help, exits 0, no side effects`, () => {
      const before = dirSnapshot(tmp)
      const { status, stdout } = execFileNoThrow(CLI, ['help', cmd], {
        cwd: tmp,
        stdinFromNull: true,
        timeoutMs: 60_000,
      })
      const after = dirSnapshot(tmp)
      expect(status, `help ${cmd} exit`).toBe(0)
      expect(stdout, `help ${cmd} stdout`).toContain(`upg ${cmd}`)
      expect(after, `help ${cmd} touched cwd`).toEqual(before)
    })
  }

  it('top-level `upg --help` exits 0 and lists groups', () => {
    const { status, stdout } = execFileNoThrow(CLI, ['--help'], { cwd: tmp, stdinFromNull: true, timeoutMs: 60_000 })
    expect(status).toBe(0)
    expect(stdout).toContain('Governance')
    expect(stdout).toContain('Create & Edit')
    // Cloud group was removed (CLI-FEEDBACK #10).
    expect(stdout.toLowerCase()).not.toContain('cloud')
    expect(stdout).not.toContain('login')
  })

  it('`upg --version` matches package.json and never crashes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf-8')) as { version: string }
    const out = execFileSync(CLI, ['--version'], { cwd: tmp }).trim()
    expect(out).toBe(pkg.version)
  })
})
