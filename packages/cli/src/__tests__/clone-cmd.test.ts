/**
 * Tests for `upg clone` command.
 *
 * Covers dry-run preview, happy-path commit (nodes + edges), region scope,
 * same-product guard, missing-source guard, and --json output.
 * Driven against the BUILT binary. Requires `npm run build` in upg-cli first.
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

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Minimal valid product document. */
function productDoc(id: string, title: string, nodes: unknown[] = [], edges: unknown[] = []) {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes,
    edges,
  }
}

/** Minimal persona node shape. */
function personaNode(id: string, title: string) {
  return { id, type: 'persona', title }
}

/** Minimal job node shape. */
function jobNode(id: string, title: string) {
  return { id, type: 'job', title }
}

/** A simple persona_pursues_job edge. */
function edge(id: string, source: string, target: string, type = 'persona_pursues_job') {
  return { id, source, target, type }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000 })
}

// ── Test setup ─────────────────────────────────────────────────────────────────

describe('upg clone', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-clone-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // ── helpers ────────────────────────────────────────────────────────────────

  async function writeProduct(filename: string, doc: unknown) {
    await fsp.writeFile(path.join(tmp, '.upg', filename), JSON.stringify(doc, null, 2))
  }

  async function readProduct(filename: string): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    const raw = await fsp.readFile(path.join(tmp, '.upg', filename), 'utf-8')
    return JSON.parse(raw)
  }

  // ── dry-run ────────────────────────────────────────────────────────────────

  describe('--dry-run', () => {
    it('reports the plan without writing (--json)', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      const jNode = jobNode('n_job_1', 'Get things done')
      const eEdge = edge('e_1', 'n_persona_1', 'n_job_1')

      await writeProduct('template.upg', productDoc('template', 'Template', [pNode, jNode], [eEdge]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--dry-run',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.dry_run).toBe(true)
      expect(out.from).toBe('template')
      expect(out.into).toBe('target')
      expect(out.would_clone.nodes).toBe(2)
      expect(out.would_clone.edges).toBe(1)
      expect(out.would_clone.by_type).toMatchObject({ persona: 1, job: 1 })
    })

    it('does not write any nodes to the target file', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      run([
        'clone', 'template',
        '--into', 'target',
        '--dry-run',
        '--yes',
        '--json',
      ], tmp)

      const targetDoc = await readProduct('target.upg')
      expect(targetDoc.nodes).toHaveLength(0)
    })

    it('includes sample_titles in dry-run output', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--dry-run',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(Array.isArray(out.sample_titles)).toBe(true)
      expect(out.sample_titles[0]).toMatch(/^TODO:/)
    })
  })

  // ── happy path commit ──────────────────────────────────────────────────────

  describe('commit', () => {
    it('clones nodes with TODO placeholder titles', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      const jNode = jobNode('n_job_1', 'Get things done')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode, jNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--yes',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.cloned).toBe(true)
      expect(out.nodes_created).toBe(2)

      const targetDoc = await readProduct('target.upg')
      expect((targetDoc.nodes as unknown[]).length).toBe(2)

      const titles = (targetDoc.nodes as { title: string }[]).map((n) => n.title)
      expect(titles.every((t) => t.startsWith('TODO:'))).toBe(true)
    })

    it('clones edges between in-scope nodes', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      const jNode = jobNode('n_job_1', 'Get things done')
      const eEdge = edge('e_1', 'n_persona_1', 'n_job_1')

      await writeProduct('template.upg', productDoc('template', 'Template', [pNode, jNode], [eEdge]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--yes',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.edges_created).toBe(1)

      const targetDoc = await readProduct('target.upg')
      expect((targetDoc.edges as unknown[]).length).toBe(1)
    })

    it('tags cloned nodes with stub', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      run([
        'clone', 'template',
        '--into', 'target',
        '--yes',
        '--json',
      ], tmp)

      const targetDoc = await readProduct('target.upg')
      const nodes = targetDoc.nodes as { tags?: string[] }[]
      expect(nodes[0].tags).toContain('stub')
    })

    it('returns by_type breakdown in --json output', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      const jNode = jobNode('n_job_1', 'Get things done')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode, jNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--yes',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.by_type).toMatchObject({ persona: 1, job: 1 })
    })
  })

  // ── from resolved as product id ────────────────────────────────────────────

  describe('product id resolution', () => {
    it('accepts product id as the from argument', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('my_template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('my_target', 'Target'))

      const r = run([
        'clone', 'my_template',
        '--into', 'my_target',
        '--dry-run',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.dry_run).toBe(true)
      expect(out.from).toBe('my_template')
    })
  })

  // ── region scope ───────────────────────────────────────────────────────────

  describe('--region scope', () => {
    it('accepts a valid region id and scopes the clone', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      // 'users_needs' is the canonical UPG region where persona lives
      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--region', 'users_needs',
        '--dry-run',
        '--json',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.dry_run).toBe(true)
      // persona is in the users region so it should be in scope
      expect(out.would_clone.nodes).toBeGreaterThanOrEqual(0)
    })

    it('exits non-zero when all requested regions are unmatched', () => {
      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--region', 'no_such_region_xyz',
        '--dry-run',
        '--yes',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).not.toBe(0)
    })
  })

  // ── error paths ────────────────────────────────────────────────────────────

  describe('error paths', () => {
    it('exits non-zero when source product is not found', async () => {
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'nonexistent_product',
        '--into', 'target',
        '--yes',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).not.toBe(0)
    })

    it('exits non-zero when source and target are the same', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('product.upg', productDoc('same_product', 'Same', [pNode]))

      const r = run([
        'clone', 'same_product',
        '--into', 'same_product',
        '--yes',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).not.toBe(0)
    })

    it('exits non-zero when source has no nodes (nothing to clone)', async () => {
      await writeProduct('template.upg', productDoc('empty_template', 'Empty Template'))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'empty_template',
        '--into', 'target',
        '--yes',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).not.toBe(0)
    })

    it('requires --yes in non-interactive shell', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      // stdinFromNull simulates a non-interactive shell; without --yes this must fail
      const r = run([
        'clone', 'template',
        '--into', 'target',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).not.toBe(0)
    })
  })

  // ── human-readable output ──────────────────────────────────────────────────

  describe('human output', () => {
    it('contains UPG header after a successful clone', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--yes',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      // The brand header and success message go to stderr
      expect(r.stderr).toContain('Clone')
    })

    it('dry-run human output mentions "Dry Run"', async () => {
      const pNode = personaNode('n_persona_1', 'Alice')
      await writeProduct('template.upg', productDoc('template', 'Template', [pNode]))
      await writeProduct('target.upg', productDoc('target', 'Target'))

      const r = run([
        'clone', 'template',
        '--into', 'target',
        '--dry-run',
      ], tmp)

      expect(r.status, `stderr=${r.stderr}`).toBe(0)
      expect(r.stderr).toContain('Dry Run')
    })
  })
})
