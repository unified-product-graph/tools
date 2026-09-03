/**
 * Regression guard for the entrypoint detection in `src/index.ts`.
 *
 * The server only starts when it detects that it is the process entrypoint.
 * The original check compared `process.argv[1]` to `fileURLToPath(import.meta.url)`
 * as raw strings, but `argv[1]` is the literal invocation path while
 * `import.meta.url` is symlink-resolved by the ESM loader. Any symlink in the
 * path (npx `.bin` shims, macOS `/tmp` → `/private/tmp`, global installs) made
 * the strings diverge, so the server silently exited 0 instead of starting and
 * MCP clients reported "Failed to connect".
 *
 * This test spawns the *built* binary through a symlink: the precise scenario
 * that broke `npx @unified-product-graph/mcp-server`, and asserts it boots.
 * It skips gracefully when `dist/` isn't built (CI runs `test` after `^build`,
 * so the artifact is present there).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const DIST_ENTRY = resolve(__dirname, '../../dist/index.js')

describe('mcp-server entrypoint detection (symlinked invocation)', () => {
  if (!existsSync(DIST_ENTRY)) {
    it.skip('dist/index.js not built; skipping (run `npm run build` first)', () => {})
    return
  }

  let tmp: string | undefined
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = undefined
    }
  })

  it('starts the server when invoked through a symlinked path', async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-mcp-entry-'))
    const link = resolve(tmp, 'upg-mcp-server-link.js')
    symlinkSync(DIST_ENTRY, link)

    const started = await new Promise<boolean>((resolvePromise) => {
      // cwd = tmp + --init so the server deliberately creates its blank
      // product.upg in the throwaway dir. Since 0.38.0 (F1) an empty cwd
      // without --init REFUSES rather than fabricating a graph, so the
      // opt-in flag is required here — which also gives the --init path
      // its coverage.
      const child = spawn(process.execPath, [link, '--init'], {
        cwd: tmp,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* already gone */ }
        resolvePromise(ok)
      }

      // The server announces readiness on stderr once it boots. Under the old
      // bug it never reached this line and exited 0 with no output.
      child.stderr.on('data', (d: Buffer) => {
        if (d.toString().includes('MCP server running')) finish(true)
      })
      // A JSON-RPC reply on stdout is equally conclusive.
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('"jsonrpc"')) finish(true)
      })
      child.on('exit', () => finish(false))

      // Drive a handshake so a started server has something to answer.
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'entrypoint-test', version: '1' },
          },
        }) + '\n',
      )

      const timer = setTimeout(() => finish(false), 15_000)
    })

    expect(started).toBe(true)
  }, 20_000)
})
