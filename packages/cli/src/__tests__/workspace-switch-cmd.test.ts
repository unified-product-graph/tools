/**
 * 0.38.0 (F4) — `upg workspace switch` is SESSION-ONLY; `set-default` is the
 * explicit tracked write.
 *
 * The field case: in a git-backed workspace, `workspace switch` rewrote
 * `default_product` in the committed workspace.json, so a read-only
 * exploration left the repo dirty and an agent's `git add -A` committed a
 * cursor move. The MCP server's `switch_product` already kept the active
 * product in memory; this brings the CLI to the server's own standard.
 * Driven against the BUILT binary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { serializeCanonical, type UPGDocument } from '@unified-product-graph/core'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function productDoc(id: string, title: string): UPGDocument {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [],
    edges: [],
  } as unknown as UPGDocument
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe('upg workspace switch / set-default (F4)', () => {
  let tmp: string
  let upgDir: string
  let wsPath: string
  let sessionPath: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-wsswitch-'))
    upgDir = path.join(tmp, '.upg')
    wsPath = path.join(upgDir, 'workspace.json')
    sessionPath = path.join(upgDir, 'workspace.session.json')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(path.join(upgDir, 'alpha.upg'), serializeCanonical(productDoc('p_a', 'Alpha')), 'utf-8')
    await fsp.writeFile(path.join(upgDir, 'beta.upg'), serializeCanonical(productDoc('p_b', 'Beta')), 'utf-8')
    await fsp.writeFile(
      wsPath,
      JSON.stringify(
        {
          version: '1.0',
          default_product: 'alpha.upg',
          products: [
            { file: 'alpha.upg', title: 'Alpha' },
            { file: 'beta.upg', title: 'Beta' },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  it('switch writes the session cursor and leaves workspace.json byte-identical', async () => {
    const before = await fsp.readFile(wsPath, 'utf-8')
    const r = await run(['workspace', 'switch', 'beta'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Switched to: Beta')
    // The whole point: the tracked file did not move.
    expect(await fsp.readFile(wsPath, 'utf-8')).toBe(before)
    const session = JSON.parse(await fsp.readFile(sessionPath, 'utf-8'))
    expect(session.active_product).toBe('beta.upg')
  })

  it('after a session switch, commands resolve the session product', async () => {
    await run(['workspace', 'switch', 'beta'], tmp)
    // `upg fmt --check` discovers via discoverUPGFile; drive something cheap
    // that prints the resolved product: `workspace list` marks the active row.
    const r = await run(['workspace', 'list'], tmp)
    expect(r.stdout).toContain('Beta  beta.upg (active, session)')
    expect(r.stdout).not.toContain('Alpha  alpha.upg (active)')
  })

  it('set-default is the explicit tracked write', async () => {
    const r = await run(['workspace', 'set-default', 'beta'], tmp)
    expect(r.status).toBe(0)
    const ws = JSON.parse(await fsp.readFile(wsPath, 'utf-8'))
    expect(ws.default_product).toBe('beta.upg')
  })

  it('a stale session cursor pointing at a deleted file is skipped, not fatal', async () => {
    await run(['workspace', 'switch', 'beta'], tmp)
    await fsp.rm(path.join(upgDir, 'beta.upg'))
    const r = await run(['workspace', 'list'], tmp)
    expect(r.status).toBe(0)
    // Falls back to the tracked default for "active".
    expect(r.stdout).toContain('Alpha')
  })

  it('switch with an unknown name still errors with the available list', async () => {
    const r = await run(['workspace', 'switch', 'gamma'], tmp)
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('Product not found')
  })
})
