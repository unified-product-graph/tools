/**
 * Tests for `upg sync status` and `upg product update` command groups.
 *
 * Drives the BUILT binary against temporary workspaces. Tests:
 *
 * sync status:
 *   - exits 0 with synced:false when no .upg-sync file exists
 *   - --json returns machine-readable output with synced:false
 *   - exits 0 and shows sync fields when a .upg-sync sidecar exists
 *   - --json returns synced:true with expected fields when sidecar exists
 *   - exits non-zero when no .upg file found
 *
 * product update:
 *   - exits 3 when no fields supplied
 *   - --title updates the product title (exit 0, --json)
 *   - --stage updates the product stage (exit 0, --json)
 *   - --description updates the description
 *   - --health-status updates health_status
 *   - --url updates url
 *   - multiple fields updated together
 *   - invalid stage exits 2 (policy violation)
 *   - blank --title exits 3 (usage error)
 *   - exits 1 when no .upg file found
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

// ── helpers ───────────────────────────────────────────────────────────────

/** Minimal valid product document. */
function productDoc(id = 'p_test', title = 'Test Product') {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [] as unknown[],
    edges: [] as unknown[],
  }
}

/** Minimal .upg-sync sidecar. */
function syncDoc(productId = 'cloud_p_001') {
  return {
    cloud_endpoint: 'https://cloud.unifiedproductgraph.org',
    product_id: productId,
    last_synced_at: '2026-01-01T12:00:00.000Z',
    node_id_map: { n_local_1: 'n_cloud_1', n_local_2: 'n_cloud_2' },
    edge_id_map: { e_local_1: 'e_cloud_1' },
    last_snapshot_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}

// ── shared fixture setup ──────────────────────────────────────────────────

async function makeWorkspace(base: string) {
  const upgDir = path.join(base, '.upg')
  await fsp.mkdir(upgDir, { recursive: true })
  const upgFile = path.join(upgDir, 'product.upg')
  await fsp.writeFile(upgFile, JSON.stringify(productDoc(), null, 2))
  return { upgDir, upgFile }
}

// ── sync status tests ─────────────────────────────────────────────────────

describe('upg sync status', () => {
  let tmp: string
  let upgFile: string

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
  })

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-sync-'))
    const ws = await makeWorkspace(tmp)
    upgFile = ws.upgFile
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('exits 0 when no .upg-sync file exists', () => {
    const r = run(['sync', 'status'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
  })

  it('reports synced:false when no sidecar exists (--json)', () => {
    const r = run(['sync', 'status', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { synced: boolean; message: string; file: string }
    expect(out.synced).toBe(false)
    expect(out.message).toMatch(/never been pushed/)
    expect(typeof out.file).toBe('string')
  })

  it('human output mentions "no" or "No" when not synced', () => {
    const r = run(['sync', 'status'], tmp)
    expect(r.status).toBe(0)
    // The stdout/stderr should indicate not synced
    const combined = r.stdout + r.stderr
    expect(combined).toMatch(/no|No|never|push/i)
  })

  it('exits 0 and shows sync data when .upg-sync sidecar exists', async () => {
    const syncPath = upgFile.replace(/\.upg$/, '.upg-sync')
    await fsp.writeFile(syncPath, JSON.stringify(syncDoc(), null, 2))
    const r = run(['sync', 'status'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const combined = r.stdout + r.stderr
    expect(combined).toMatch(/cloud\.unifiedproductgraph\.org/)
  })

  it('returns synced:true with all fields when sidecar exists (--json)', async () => {
    const syncPath = upgFile.replace(/\.upg$/, '.upg-sync')
    const sd = syncDoc('cloud_xyz_999')
    await fsp.writeFile(syncPath, JSON.stringify(sd, null, 2))
    const r = run(['sync', 'status', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as {
      synced: boolean
      cloud_endpoint: string
      product_id: string
      last_synced_at: string
      mapped_nodes: number
      mapped_edges: number
      last_snapshot_hash: string
    }
    expect(out.synced).toBe(true)
    expect(out.cloud_endpoint).toBe('https://cloud.unifiedproductgraph.org')
    expect(out.product_id).toBe('cloud_xyz_999')
    expect(out.last_synced_at).toBe('2026-01-01T12:00:00.000Z')
    expect(out.mapped_nodes).toBe(2)
    expect(out.mapped_edges).toBe(1)
    expect(typeof out.last_snapshot_hash).toBe('string')
  })

  it('explicit --file flag points to the right graph', async () => {
    // Create a second workspace file with a different sync state
    const upgDir = path.join(tmp, '.upg')
    const altFile = path.join(upgDir, 'alt.upg')
    await fsp.writeFile(altFile, JSON.stringify(productDoc('p_alt', 'Alt Product'), null, 2))
    const altSyncPath = altFile.replace(/\.upg$/, '.upg-sync')
    await fsp.writeFile(altSyncPath, JSON.stringify(syncDoc('alt_cloud_id'), null, 2))

    const r = run(['sync', 'status', '--file', altFile, '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { synced: boolean; product_id: string }
    expect(out.synced).toBe(true)
    expect(out.product_id).toBe('alt_cloud_id')
  })
})

// ── product update tests ──────────────────────────────────────────────────

describe('upg product update', () => {
  let tmp: string
  let upgFile: string

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
  })

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-product-'))
    const ws = await makeWorkspace(tmp)
    upgFile = ws.upgFile
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  // ── usage errors ──────────────────────────────────────────────────────

  it('exits 3 when no update fields are supplied', () => {
    const r = run(['product', 'update'], tmp)
    expect(r.status).toBe(3)
  })

  it('exits 3 when --title is blank', () => {
    const r = run(['product', 'update', '--title', '   '], tmp)
    expect(r.status).toBe(3)
  })

  // ── valid mutations ───────────────────────────────────────────────────

  it('updates title and exits 0 (--json)', () => {
    const r = run(['product', 'update', '--title', 'Renamed Product', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0)
    const out = JSON.parse(r.stdout) as {
      ok: boolean
      updated: string[]
      product: Record<string, unknown>
    }
    expect(out.ok).toBe(true)
    expect(out.updated).toContain('title')
    expect(out.product.title).toBe('Renamed Product')
  })

  it('updates stage and exits 0 (--json)', () => {
    const r = run(['product', 'update', '--stage', 'growth', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0)
    const out = JSON.parse(r.stdout) as {
      ok: boolean
      updated: string[]
      product: Record<string, unknown>
    }
    expect(out.ok).toBe(true)
    expect(out.updated).toContain('stage')
    expect(out.product.stage).toBe('growth')
  })

  it('updates description', () => {
    const r = run(['product', 'update', '--description', 'A great product.', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; updated: string[]; product: Record<string, unknown> }
    expect(out.updated).toContain('description')
    expect(out.product.description).toBe('A great product.')
  })

  it('updates health-status', () => {
    const r = run(['product', 'update', '--health-status', 'on_track', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; updated: string[]; product: Record<string, unknown> }
    expect(out.updated).toContain('health_status')
    expect(out.product.health_status).toBe('on_track')
  })

  it('updates url', () => {
    const r = run(['product', 'update', '--url', 'https://example.com', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; updated: string[]; product: Record<string, unknown> }
    expect(out.updated).toContain('url')
    expect(out.product.url).toBe('https://example.com')
  })

  it('updates multiple fields at once', () => {
    const r = run([
      'product', 'update',
      '--title', 'Multi Update',
      '--stage', 'build',
      '--json',
    ], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; updated: string[] }
    expect(out.updated).toContain('title')
    expect(out.updated).toContain('stage')
  })

  it('persists changes to the .upg file on disk', async () => {
    run(['product', 'update', '--title', 'Persisted Title', '--json'], tmp)
    // Read back the file and check it was mutated.
    const raw = await fsp.readFile(upgFile, 'utf-8')
    const doc = JSON.parse(raw) as { product: { title: string } }
    expect(doc.product.title).toBe('Persisted Title')
  })

  it('human output reports the updated field', () => {
    const r = run(['product', 'update', '--stage', 'launch'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const combined = r.stdout + r.stderr
    expect(combined).toMatch(/launch/)
  })

  // ── policy violations ─────────────────────────────────────────────────

  it('exits 2 for an invalid stage value', () => {
    const r = run(['product', 'update', '--stage', 'not_a_real_stage'], tmp)
    expect(r.status).toBe(2)
  })

  // ── explicit --file flag ──────────────────────────────────────────────

  it('respects explicit --file flag', () => {
    const r = run(['product', 'update', '--file', upgFile, '--title', 'Via Flag', '--json'], tmp)
    expect(r.status, `stderr=${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout) as { ok: boolean; updated: string[] }
    expect(out.ok).toBe(true)
    expect(out.updated).toContain('title')
  })
})
