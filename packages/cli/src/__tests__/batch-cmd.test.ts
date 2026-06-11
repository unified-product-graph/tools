/**
 * `upg batch` command: atomic create / update / delete.
 * Driven against the BUILT binary.
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

function emptyGraph() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Batch Test' },
    nodes: [{ id: 'n_seed', type: 'persona', title: 'Seed' }],
    edges: [],
  }
}

function run(args: string[], cwd: string, file: string) {
  return execFileNoThrow(CLI, [...args, '--file', file], { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}
function readNodes(file: string) {
  return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { nodes: Array<{ id: string; type: string }> }).nodes
}

describe('upg batch', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-batch-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(emptyGraph(), null, 2))
  })
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) })

  it('create --data writes multiple nodes atomically', async () => {
    const data = JSON.stringify([{ type: 'persona', title: 'Alice' }, { type: 'persona', title: 'Bob' }])
    const r = await run(['batch', 'create', '--data', data, '--json'], tmp, file)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; count: number }
    expect(out.ok).toBe(true)
    expect(out.count).toBe(2)
    expect(readNodes(file).filter((n) => n.type === 'persona')).toHaveLength(3) // seed + 2
  })

  it('create --dry-run validates without writing', async () => {
    const data = JSON.stringify([{ type: 'persona', title: 'Ghost' }])
    const r = await run(['batch', 'create', '--data', data, '--dry-run', '--json'], tmp, file)
    expect(r.status).toBe(0)
    expect(readNodes(file)).toHaveLength(1) // unchanged
  })

  it('create rejects malformed --data with exit 3', async () => {
    const r = await run(['batch', 'create', '--data', '{not json', '--json'], tmp, file)
    expect(r.status).toBe(3)
  })

  it('delete --ids removes nodes (requires --yes)', async () => {
    const noYes = await run(['batch', 'delete', '--ids', 'n_seed'], tmp, file)
    expect(noYes.status).toBe(2) // refuses without --yes
    const r = await run(['batch', 'delete', '--ids', 'n_seed', '--yes', '--json'], tmp, file)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    expect(readNodes(file).find((n) => n.id === 'n_seed')).toBeUndefined()
  })

  it('delete rejects unknown ids with exit 2', async () => {
    const r = await run(['batch', 'delete', '--ids', 'n_nope', '--yes'], tmp, file)
    expect(r.status).toBe(2)
  })
})
