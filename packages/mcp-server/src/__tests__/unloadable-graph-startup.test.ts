/**
 * R3 — an unloadable `.upg` is diagnosable, not silent.
 *
 * A regression audit reported the server hanging forever on a graph that fails
 * envelope validation. It was not hanging: it wrote the reason to stderr and
 * exited non-zero. Almost no MCP client surfaces a server's stderr, so what a
 * user saw was a server that connected and went quiet, with the diagnosis
 * somewhere they could not reach — and a client that waits on `initialize`
 * without watching for child exit waits forever. A dead server, not a wedged
 * one, and indistinguishable from the outside.
 *
 * Tracing it turned up the genuinely silent path as well: `preflight.js` ended
 * with a bare `await import('./index.js')` and relied on that module's
 * auto-start guard, which compares `process.argv[1]` against its own module
 * URL. Through preflight that comparison is false, so NOTHING started and the
 * process exited 0 with empty stdout and empty stderr.
 *
 * Every case here is bounded by a timeout, because "did not answer" is the
 * failure under test and a test that hangs cannot report it.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../../dist')
const ENTRY = join(DIST, 'index.js')
const PREFLIGHT = join(DIST, 'preflight.js')

const BOUND_MS = 20_000

interface Probe {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  frames: Array<Record<string, unknown>>
}

/**
 * Spawn the server against `file`, run the handshake plus one tool call, close
 * stdin, and wait for exit — all inside one bound. Never resolves late: on
 * timeout the child is killed and `timedOut` is reported, which is what the
 * assertions read.
 */
async function probe(entry: string, file: string): Promise<Probe> {
  const child = spawn(process.execPath, [entry, '--file', file], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: mkdtempSync(join(tmpdir(), 'upg-r3-cwd-')),
    env: { ...process.env, NO_COLOR: '1' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d.toString()))
  child.stderr.on('data', (d) => (stderr += d.toString()))

  const send = (o: unknown) => {
    try {
      child.stdin.write(JSON.stringify(o) + '\n')
    } catch {
      /* the child may already be gone; that is a result, not an error */
    }
  }

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'r3-probe', version: '1.0.0' },
    },
  })
  await new Promise((r) => setTimeout(r, 1200))
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_graph_digest', arguments: {} },
  })
  await new Promise((r) => setTimeout(r, 1200))
  try {
    child.stdin.end()
  } catch {
    /* already closed */
  }

  let timedOut = false
  const exitCode = await new Promise<number | null>((r) => {
    const t = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      r(null)
    }, BOUND_MS - 5_000)
    child.once('exit', (code) => {
      clearTimeout(t)
      r(code)
    })
  })

  const frames = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((f): f is Record<string, unknown> => f !== null)

  return { exitCode, timedOut, stdout, stderr, frames }
}

/** A file with a full `$upg` envelope that is missing exactly the two fields. */
function writeUnloadable(): string {
  const dir = mkdtempSync(join(tmpdir(), 'upg-r3-fixture-'))
  const file = join(dir, 'unloadable.upg')
  writeFileSync(
    file,
    JSON.stringify(
      {
        $upg: {
          format_version: '1.0.0',
          product: { id: 'p1', title: 'Unloadable' },
          counts: { nodes: 0, edges: 0 },
          provenance: { tool: 'unknown' },
        },
        product: { id: 'p1', title: 'Unloadable', stage: 'concept' },
        nodes: [],
        edges: [],
      },
      null,
      2,
    ),
  )
  return file
}

const hasDist = existsSync(ENTRY)
const describeIfBuilt = hasDist ? describe : describe.skip

describeIfBuilt('an unloadable graph does not hang the client (R3)', () => {
  it(
    'answers initialize, fails the tool call with the reason, and exits non-zero',
    async () => {
      const file = writeUnloadable()
      const r = await probe(ENTRY, file)

      expect(r.timedOut, 'the server must answer within the bound').toBe(false)
      expect(r.exitCode, 'an unloadable graph is a failure').toBe(1)

      // The handshake is answered, so a client is never left waiting.
      expect(r.frames.some((f) => f.id === 1)).toBe(true)

      // And the diagnosis reaches the client, not only stderr.
      const call = r.frames.find((f) => f.id === 2) as
        | { result?: { isError?: boolean; content?: Array<{ text: string }> } }
        | undefined
      expect(call?.result?.isError).toBe(true)
      const text = call?.result?.content?.[0]?.text ?? ''
      expect(text).toContain('cannot load')
      expect(text).toContain(file)
      expect(text).toContain('$upg.spec_version')
      expect(text).toContain('$upg.provenance.exported_at')
    },
    BOUND_MS,
  )

  it(
    'still writes the reason to stderr for a supervisor',
    async () => {
      const r = await probe(ENTRY, writeUnloadable())
      expect(r.timedOut).toBe(false)
      expect(r.stderr).toContain('cannot load')
      expect(r.stderr).toContain('$upg.spec_version')
      // Not `Fatal: Error: …` — the doubled prefix from stringifying an Error.
      expect(r.stderr).not.toContain('Fatal: Error:')
    },
    BOUND_MS,
  )

  it(
    'names the real on-disk field paths, not the post-normalisation ones',
    async () => {
      const r = await probe(ENTRY, writeUnloadable())
      expect(r.stderr).not.toContain('$.upg_version')
      expect(r.stderr).not.toContain('$.exported_at')
    },
    BOUND_MS,
  )

  it(
    'does not tell a file that HAS an envelope to stop hand-authoring a bare one',
    async () => {
      const r = await probe(ENTRY, writeUnloadable())
      expect(r.stderr).toContain('HAS a `$upg` envelope')
      expect(r.stderr).not.toContain('Don\'t hand-author a bare')
    },
    BOUND_MS,
  )
})

describeIfBuilt('the handshake itself says it is degraded (R3)', () => {
  it(
    'names the degradation in serverInfo and at the top of instructions',
    async () => {
      const file = writeUnloadable()
      const r = await probe(ENTRY, file)
      expect(r.timedOut).toBe(false)

      const init = r.frames.find((f) => f.id === 1) as
        | { result?: { serverInfo?: { name?: string }; instructions?: string } }
        | undefined
      expect(init).toBeDefined()

      // A client that renders the handshake and never calls a tool must still
      // learn the graph did not load. Byte-identical to a healthy server here
      // trades one silent failure for a quieter one.
      expect(init?.result?.serverInfo?.name).toContain('DEGRADED')
      const instructions = init?.result?.instructions ?? ''
      expect(instructions).toContain('DEGRADED')
      expect(instructions).toContain(file)
      expect(instructions).toContain('$upg.spec_version')
      // and the real instructions are still there underneath.
      expect(instructions.length).toBeGreaterThan(1000)
    },
    BOUND_MS,
  )
})

describeIfBuilt('the preflight entry point starts the server (R3)', () => {
  it(
    'no longer exits 0 in silence when the graph cannot load',
    async () => {
      const r = await probe(PREFLIGHT, writeUnloadable())
      expect(r.timedOut).toBe(false)
      expect(r.exitCode).toBe(1)
      expect(r.frames.some((f) => f.id === 1), 'initialize answered').toBe(true)
      expect(r.stderr.length).toBeGreaterThan(0)
    },
    BOUND_MS,
  )
})
