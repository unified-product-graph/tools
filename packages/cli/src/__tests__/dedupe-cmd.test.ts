/**
 * `upg dedupe` command.
 *
 * Covers:
 *   - dry-run (default) detects duplicates without writing
 *   - dry-run --json returns structured groups
 *   - --apply merges duplicates (nodes removed, edges redirected)
 *   - --apply --json returns merged result shape
 *   - --type scopes detection to one entity type
 *   - --keep oldest keeps the first-inserted node
 *   - no duplicates found - exit 0, clean message
 *   - --apply without --yes exits 3 in non-TTY (refuses without confirmation)
 *   - invalid --keep value exits 2 (policy violation)
 *
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

// ── fixtures ───────────────────────────────────────────────────────────────

/** Graph with two duplicate persona nodes and one non-duplicate feature node. */
function dupGraph() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Dedupe Test' },
    nodes: [
      { id: 'n_p1', type: 'persona', title: 'The Developer' },
      { id: 'n_p2', type: 'persona', title: 'the developer' }, // duplicate (different case)
      { id: 'n_f1', type: 'feature', title: 'Unique Feature' },
      { id: 'n_j1', type: 'job', title: 'Ship the thing' },
    ],
    edges: [
      // Canonical edge on n_p1 (removed under the default keep=newest, which keeps
      // n_p2) so the merge must redirect it to the keeper.
      { id: 'e_1', source: 'n_p1', target: 'n_j1', type: 'persona_pursues_job' },
    ],
  }
}

/** Graph with NO duplicates. */
function noDupGraph() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'No Dup Test' },
    nodes: [
      { id: 'n_p1', type: 'persona', title: 'Alice' },
      { id: 'n_p2', type: 'persona', title: 'Bob' },
    ],
    edges: [],
  }
}

/** Graph with duplicates across two entity types. */
function multiTypeDupGraph() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Multi Dup Test' },
    nodes: [
      { id: 'n_p1', type: 'persona', title: 'Alice' },
      { id: 'n_p2', type: 'persona', title: 'Alice' }, // dup persona
      { id: 'n_f1', type: 'feature', title: 'Alpha' },
      { id: 'n_f2', type: 'feature', title: 'Alpha' }, // dup feature
    ],
    edges: [],
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function run(args: string[], cwd: string, file: string) {
  return execFileNoThrow(CLI, [...args, '--file', file], { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}

function readNodes(file: string): Array<Record<string, unknown>> {
  const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as { nodes: Array<Record<string, unknown>> }
  return d.nodes
}

// ── test suite ─────────────────────────────────────────────────────────────

describe('upg dedupe', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-dedupe-'))
    file = path.join(tmp, 'product.upg')
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // ── dry-run (default) ──────────────────────────────────────────────────

  it('dry-run detects duplicates without writing', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const before = fs.readFileSync(file, 'utf-8')

    const r = run(['dedupe', '--dry-run'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    // File must be unchanged.
    const after = fs.readFileSync(file, 'utf-8')
    expect(after).toBe(before)
  })

  it('dry-run exits 0 even when duplicates exist', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--dry-run'], tmp, file)
    expect(r.status).toBe(0)
  })

  it('dry-run --json returns structured groups', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--dry-run', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as {
      duplicates: Array<{ title: string; type: string; count: number; ids: string[] }>
      total_groups: number
      total_duplicate_nodes: number
      dry_run: boolean
      message: string
    }

    expect(out.dry_run).toBe(true)
    expect(out.total_groups).toBe(1)
    expect(out.total_duplicate_nodes).toBe(1)
    expect(out.duplicates).toHaveLength(1)
    expect(out.duplicates[0].type).toBe('persona')
    expect(out.duplicates[0].count).toBe(2)
  })

  // ── no duplicates ──────────────────────────────────────────────────────

  it('exits 0 with empty result when no duplicates found', async () => {
    await fsp.writeFile(file, JSON.stringify(noDupGraph(), null, 2))
    const r = run(['dedupe', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as { duplicates: unknown[] }
    expect(out.duplicates).toHaveLength(0)
  })

  // ── apply ──────────────────────────────────────────────────────────────

  it('--apply --yes removes duplicate nodes', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--apply', '--yes'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const nodes = readNodes(file)
    const personas = nodes.filter((n) => n.type === 'persona')
    // One persona kept, one removed.
    expect(personas).toHaveLength(1)
    // The non-duplicate feature node is untouched.
    const features = nodes.filter((n) => n.type === 'feature')
    expect(features).toHaveLength(1)
  })

  it('--apply --yes --json returns merged shape', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--apply', '--yes', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as {
      merged: boolean
      groups_merged: number
      nodes_removed: number
      edges_redirected: number
      strategy: string
    }

    expect(out.merged).toBe(true)
    expect(out.groups_merged).toBe(1)
    expect(out.nodes_removed).toBe(1)
    expect(out.strategy).toBe('newest')
  })

  it('--apply redirects edges from removed node to keeper', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--apply', '--yes', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as { edges_redirected: number }
    // The edge targeting n_p2 (the removed dup) should be redirected to n_p1.
    expect(out.edges_redirected).toBeGreaterThanOrEqual(1)
  })

  // ── --type scoping ─────────────────────────────────────────────────────

  it('--type scopes detection to one entity type', async () => {
    await fsp.writeFile(file, JSON.stringify(multiTypeDupGraph(), null, 2))

    // Only look at persona dups.
    const r = run(['dedupe', '--dry-run', '--type', 'persona', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as {
      total_groups: number
      duplicates: Array<{ type: string }>
    }
    expect(out.total_groups).toBe(1)
    expect(out.duplicates.every((d) => d.type === 'persona')).toBe(true)
  })

  it('--type --apply --yes only merges the scoped type', async () => {
    await fsp.writeFile(file, JSON.stringify(multiTypeDupGraph(), null, 2))
    const r = run(['dedupe', '--type', 'persona', '--apply', '--yes'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const nodes = readNodes(file)
    const personas = nodes.filter((n) => n.type === 'persona')
    const features = nodes.filter((n) => n.type === 'feature')

    // persona dup merged (1 kept)
    expect(personas).toHaveLength(1)
    // feature dups untouched (both still there)
    expect(features).toHaveLength(2)
  })

  // ── --keep oldest ──────────────────────────────────────────────────────

  it('--keep oldest keeps the first node in the group', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--apply', '--yes', '--keep', 'oldest', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as { strategy: string }
    expect(out.strategy).toBe('oldest')

    // n_p1 was inserted first; it should survive.
    const nodes = readNodes(file)
    const personaIds = nodes.filter((n) => n.type === 'persona').map((n) => n.id)
    expect(personaIds).toContain('n_p1')
    expect(personaIds).not.toContain('n_p2')
  })

  // ── safety: non-TTY without --yes ──────────────────────────────────────

  it('--apply without --yes exits 3 in a non-TTY context', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    // stdinFromNull simulates non-interactive (no TTY): the command must refuse.
    const r = run(['dedupe', '--apply'], tmp, file)
    expect(r.status).toBe(3)
  })

  // ── --keep validation ──────────────────────────────────────────────────

  it('invalid --keep value exits 2 (policy violation)', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const r = run(['dedupe', '--keep', 'random', '--json'], tmp, file)
    expect(r.status).toBe(2)
  })

  // ── default is dry-run (no --apply given) ─────────────────────────────

  it('omitting --apply defaults to dry-run: file unchanged', async () => {
    await fsp.writeFile(file, JSON.stringify(dupGraph(), null, 2))
    const before = fs.readFileSync(file, 'utf-8')

    // No --dry-run flag and no --apply: should still be a dry-run.
    const r = run(['dedupe', '--json'], tmp, file)
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as { dry_run?: boolean }
    expect(out.dry_run).toBe(true)

    const after = fs.readFileSync(file, 'utf-8')
    expect(after).toBe(before)
  })
})
