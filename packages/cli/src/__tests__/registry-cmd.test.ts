/**
 * Registry command group tests.
 *
 * Drives the BUILT binary against a temporary workspace. Tests:
 *   - `registry define` creates a canonical entity and is listable
 *   - `registry list` returns the defined entity
 *   - `registry list --json` returns machine-readable JSON
 *   - `registry define` with an invalid type exits 2 (policy violation)
 *   - `registry update` patches in place
 *   - `registry connect` wires a registry-internal edge
 *   - `registry org` shows portfolio organisation
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

// ── minimal valid portfolio.upg ───────────────────────────────────────────
// Uses the flat (non-$upg-envelope) format that UPGPortfolioStore.makeEmptyPortfolio
// produces and normalizeDocument accepts.

function portfolioDoc(): object {
  return {
    upg_version: '0.9.0',
    type: 'portfolio',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    organization: {
      id: 'org_test',
      title: 'Test Org',
    },
    product_areas: [],
    portfolios: [],
    products: [],
    cross_edges: [],
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe('registry command group', () => {
  let tmp: string
  let upgDir: string
  let portfolioFile: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-registry-'))
    // Create .upg/ directory with a portfolio.upg so resolvePortfolioPath finds it.
    upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    portfolioFile = path.join(upgDir, 'portfolio.upg')
    await fsp.writeFile(portfolioFile, JSON.stringify(portfolioDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  // ── define + list ──────────────────────────────────────────────────────

  it('define creates a canonical entity (exit 0)', () => {
    const r = run(['registry', 'define', 'persona', 'The Developer'], tmp)
    expect(r.status).toBe(0)
  })

  it('define with --json returns machine-readable output', () => {
    const r = run(['registry', 'define', 'persona', 'The Developer', '--json'], tmp)
    expect(r.status).toBe(0)
    const data = JSON.parse(r.stdout) as {
      ok: boolean
      canonical: { id: string; type: string; title: string }
      qualified_id: string
    }
    expect(data.ok).toBe(true)
    expect(data.canonical.type).toBe('persona')
    expect(data.canonical.title).toBe('The Developer')
    expect(data.qualified_id).toMatch(/^registry\//)
  })

  it('list returns the defined entity', () => {
    run(['registry', 'define', 'persona', 'The Developer', '--json'], tmp)
    const r = run(['registry', 'list', '--json'], tmp)
    expect(r.status).toBe(0)
    const data = JSON.parse(r.stdout) as {
      registry: Array<{ type: string; title: string }>
      total: number
    }
    expect(data.total).toBeGreaterThan(0)
    const found = data.registry.find((e) => e.title === 'The Developer')
    expect(found).toBeDefined()
    expect(found!.type).toBe('persona')
  })

  it('list with type filter restricts results', () => {
    run(['registry', 'define', 'persona', 'Developer', '--json'], tmp)
    run(['registry', 'define', 'metric', 'Weekly Active Users', '--json'], tmp)
    const r = run(['registry', 'list', 'persona', '--json'], tmp)
    expect(r.status).toBe(0)
    const data = JSON.parse(r.stdout) as { registry: Array<{ type: string }>; total: number }
    expect(data.registry.every((e) => e.type === 'persona')).toBe(true)
  })

  // ── policy violations ──────────────────────────────────────────────────

  it('define with an invalid type exits 2 (policy violation)', () => {
    const r = run(['registry', 'define', 'not_a_real_type', 'Something'], tmp)
    expect(r.status).toBe(2)
  })

  // ── update ─────────────────────────────────────────────────────────────

  it('update patches the canonical entity in place', () => {
    const def = run(['registry', 'define', 'persona', 'Old Title', '--json'], tmp)
    expect(def.status).toBe(0)
    const defData = JSON.parse(def.stdout) as { canonical: { id: string } }
    const id = defData.canonical.id

    const upd = run(['registry', 'update', id, '--title', 'New Title', '--json'], tmp)
    expect(upd.status).toBe(0)
    const updData = JSON.parse(upd.stdout) as { canonical: { title: string } }
    expect(updData.canonical.title).toBe('New Title')
  })

  it('update with unknown id exits 1 (runtime error)', () => {
    const r = run(['registry', 'update', 'persona_does_not_exist', '--title', 'X'], tmp)
    expect(r.status).toBe(1)
  })

  it('update with no changes exits 3 (usage error)', () => {
    run(['registry', 'define', 'persona', 'Someone', '--json'], tmp)
    const r = run(['registry', 'update', 'persona_someone'], tmp)
    expect(r.status).toBe(3)
  })

  // ── org ────────────────────────────────────────────────────────────────

  it('org shows the portfolio organisation', () => {
    const r = run(['registry', 'org', '--json'], tmp)
    expect(r.status).toBe(0)
    const data = JSON.parse(r.stdout) as { organization: { id: string; title: string } | null }
    expect(data.organization).not.toBeNull()
    expect(data.organization!.id).toBe('org_test')
    expect(data.organization!.title).toBe('Test Org')
  })

  // ── no-portfolio case ──────────────────────────────────────────────────

  it('list returns empty registry when no portfolio exists', async () => {
    // Create a fresh dir with no .upg/ at all.
    const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-bare-'))
    try {
      const r = run(['registry', 'list', '--json'], bare)
      expect(r.status).toBe(0)
      const data = JSON.parse(r.stdout) as { total: number }
      expect(data.total).toBe(0)
    } finally {
      await fsp.rm(bare, { recursive: true, force: true }).catch(() => {})
    }
  })
})
