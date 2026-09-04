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
import { mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, basename, dirname } from 'node:path'
import { listLocalProducts } from '../tools/workspace.js'
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

/**
 * 0.41.0 (F1 from the 0.41.0 feedback triage) — `--check`'s `products` count.
 *
 * It used to be a `readdir` of top-level `.upg` files, which is neither the
 * registry nor the inventory: it counted `portfolio.upg` (not a product) and
 * every unregistered scratch graph, while missing every graph in a registered
 * subfolder. The reporter's 54-graph workspace answered 2. This repo's own
 * answered 6 for 31. `--check` is what an install script asserts on, so a
 * wrong count passes a wrong check as readily as it fails a right one.
 *
 * The count now follows the rule `list_local_products` enumerates by, and
 * these cases pin the three ways the old one was wrong.
 */
describe('F1 — --check counts products the way list_local_products does', () => {
  /** A workspace with a registry, a subfolder graph, a portfolio, an archive. */
  function buildWorkspace(): string {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const ws = join(tmp, 'graphs')
    mkdirSync(join(ws, 'products'), { recursive: true })
    mkdirSync(join(ws, '_archive'), { recursive: true })
    copyFileSync(FIXTURE_UPG, join(ws, 'products', 'threadline.upg'))
    copyFileSync(FIXTURE_UPG, join(ws, 'products', 'second.upg'))
    // Unregistered ON PURPOSE: archived, not inventory.
    copyFileSync(FIXTURE_UPG, join(ws, '_archive', 'retired.upg'))
    // Not a product: no `product` header, carries portfolios instead.
    writeFileSync(
      join(ws, 'portfolio.upg'),
      JSON.stringify({ version: '1.0', organization: { title: 'Test Org' }, portfolios: [], product_areas: [] }, null, 2),
    )
    writeFileSync(
      join(ws, 'workspace.json'),
      JSON.stringify(
        {
          version: '1.0',
          default_product: 'products/threadline.upg',
          products: [
            { file: 'products/threadline.upg', title: 'Threadline' },
            { file: 'products/second.upg', title: 'Second' },
          ],
        },
        null,
        2,
      ),
    )
    return ws
  }

  /** What `list_local_products` answers for a workspace, run as --check runs. */
  async function toolCount(workspaceDir: string): Promise<number> {
    const before = process.cwd()
    try {
      // --check chdirs to the scan anchor before counting: the project root
      // for a `.upg`-named workspace, the workspace itself otherwise.
      process.chdir(basename(workspaceDir) === '.upg' ? dirname(workspaceDir) : workspaceDir)
      const r = (await Promise.resolve(listLocalProducts({}, {} as never))) as {
        content: Array<{ text: string }>
      }
      return (JSON.parse(r.content[0].text).products as unknown[]).length
    } finally {
      process.chdir(before)
    }
  }

  it('counts registered graphs in subfolders the top-level readdir never saw', () => {
    const ws = buildWorkspace()
    const r = run(['--check', '--workspace', ws], tmp!)
    expect(r.status).toBe(0)
    // The old rule was a readdir of ws/*.upg, which here is portfolio.upg
    // alone: 1, for a workspace holding two registered products. The registry
    // reaches both at any depth.
    expect(JSON.parse(r.stdout).products).toBeGreaterThanOrEqual(2)
  })

  it('excludes portfolio.upg, which is a registry document and not a product', () => {
    const ws = buildWorkspace()
    rmSync(join(ws, '_archive'), { recursive: true, force: true })
    const r = run(['--check', '--workspace', ws], tmp!)
    // Two products on disk, plus portfolio.upg, which has no `product` header.
    expect(JSON.parse(r.stdout).products).toBe(2)
  })

  it('answers exactly what list_local_products answers, which is the contract', async () => {
    const ws = buildWorkspace()
    const checkCount = JSON.parse(run(['--check', '--workspace', ws], tmp!).stdout).products
    expect(checkCount).toBe(await toolCount(ws))

    // And again with the archive removed, so agreement is not a coincidence
    // of one fixture. NOTE the number moves: in this layout the workspace IS
    // the scan anchor, so `_archive/` sits one level down and both the census
    // and the tool see it. Under a `.upg`-named workspace it sits two levels
    // down and neither does. That asymmetry belongs to `list_local_products`
    // and predates this count; what is pinned here is that --check never
    // disagrees with it.
    rmSync(join(ws, '_archive'), { recursive: true, force: true })
    const after = JSON.parse(run(['--check', '--workspace', ws], tmp!).stdout).products
    expect(after).toBe(await toolCount(ws))
    expect(after).toBeLessThan(checkCount)
  })

  it('a single-graph workspace still answers 1', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'upg-startup-'))
    const ws = join(tmp, 'graphs')
    mkdirSync(ws)
    copyFileSync(FIXTURE_UPG, join(ws, 'threadline.upg'))
    const r = run(['--check', '--workspace', ws], tmp)
    expect(JSON.parse(r.stdout).products).toBe(1)
  })

  it('still writes nothing while counting', () => {
    const ws = buildWorkspace()
    const before = readdirSync(ws).sort()
    run(['--check', '--workspace', ws], tmp!)
    expect(readdirSync(ws).sort()).toEqual(before)
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
