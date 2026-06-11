/**
 * Tests for `upg area` command group.
 *
 * Covers area create and list against a real .upg workspace (tmp dir with
 * `.upg/` subdirectory). Driven against the BUILT binary.
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

/** Minimal valid product graph. */
function productDoc(id = 'p_test', title = 'Test Product') {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [] as unknown[],
    edges: [] as unknown[],
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}

describe('upg area', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-area-'))
    // create .upg workspace directory with one product file
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(
      path.join(upgDir, 'product.upg'),
      JSON.stringify(productDoc(), null, 2),
    )
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // ── list ───────────────────────────────────────────────────────────────────

  describe('area list', () => {
    it('returns empty list when no portfolio exists (--json)', () => {
      const r = run(['area', 'list', '--json'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.areas).toEqual([])
      expect(out.total).toBe(0)
    })

    it('returns human-readable output when no portfolio exists', () => {
      const r = run(['area', 'list'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      // stderr carries the brand header and guidance
      expect(r.stderr).toContain('Areas')
    })
  })

  // ── create ─────────────────────────────────────────────────────────────────

  describe('area create', () => {
    it('creates a new area and returns its id --json', () => {
      const r = run(['area', 'create', 'Core Platform', '--json'], tmp)
      expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.node).toBeDefined()
      expect(out.node.title).toBe('Core Platform')
      expect(out.node.id).toBeTruthy()
    })

    it('creates a new area with optional fields', () => {
      const r = run([
        'area', 'create', 'Growth',
        '--priority', 'high',
        '--owner', 'growth-team',
        '--description', 'Revenue growth area',
        '--json',
      ], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.node.title).toBe('Growth')
      expect(out.node.strategic_priority ?? out.node.properties?.strategic_priority).toBe('high')
    })

    it('creates and then lists the new area', () => {
      run(['area', 'create', 'Platform', '--json'], tmp)
      const r = run(['area', 'list', '--json'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.total).toBe(1)
      expect(out.areas[0].title).toBe('Platform')
    })

    it('creates multiple areas and lists them all', () => {
      run(['area', 'create', 'Alpha', '--json'], tmp)
      run(['area', 'create', 'Beta', '--json'], tmp)
      const r = run(['area', 'list', '--json'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.total).toBe(2)
      const titles = out.areas.map((a: { title: string }) => a.title)
      expect(titles).toContain('Alpha')
      expect(titles).toContain('Beta')
    })

    it('human output contains the area title after create', () => {
      const r = run(['area', 'create', 'Flagship'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      expect(r.stdout).toContain('Flagship')
    })
  })

  // ── subcommand help guard ──────────────────────────────────────────────────

  describe('area --help', () => {
    it('upg area with no subcommand exits 0 and prints help', () => {
      const r = run(['area'], tmp)
      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      expect(r.stderr).toContain('Area')
    })
  })
})
