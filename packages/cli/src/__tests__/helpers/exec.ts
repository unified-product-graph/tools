/**
 * Subprocess helpers for CLI integration tests. Run the built binary the same
 * way a user / agent would, capturing exit code + stdout + stderr.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

export interface ExecOptions {
  cwd?: string
  /** Feed /dev/null to stdin so an interactive prompt hangs-then-times-out instead of passing. */
  stdinFromNull?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Run, never throwing on non-zero exit. Returns status + captured streams. */
export function execFileNoThrow(bin: string, args: string[], opts: ExecOptions = {}): ExecResult {
  const input = opts.stdinFromNull ? '' : undefined
  const res = spawnSync('node', [bin, ...args], {
    cwd: opts.cwd,
    input,
    timeout: opts.timeoutMs ?? 15_000,
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env, NO_COLOR: '1' },
  })
  if (res.error) {
    // ETIMEDOUT etc. — surface as a failing status so the test reports it.
    return { status: 124, stdout: res.stdout ?? '', stderr: String(res.error.message ?? res.error) }
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Run, throwing on non-zero exit. Returns stdout. */
export function execFileSync(bin: string, args: string[], opts: ExecOptions = {}): string {
  const res = execFileNoThrow(bin, args, opts)
  if (res.status !== 0) {
    throw new Error(`exit ${res.status}: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

/** Read a JSON file or return undefined. */
export function readJsonMaybe<T = unknown>(p: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T } catch { return undefined }
}
