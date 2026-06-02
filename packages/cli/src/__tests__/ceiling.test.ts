/**
 * Tier-1 "ceiling" verb tests — the stand-inside-the-graph surface.
 *
 * Drives the BUILT binary against a throwaway `.upg` graph and pins the wave's
 * load-bearing behaviours:
 *   - cursor state set / move / clear (session-local, co-located with the graph)
 *   - lens validation (canonical 8 + full; unknown ⇒ usage error)
 *   - `new` creates AND auto-links with an inferred edge (no --parent/--edge-type)
 *   - `link` infers the edge, auto-flips to canonical direction, and prompts
 *     ONLY on genuine ambiguity (and refuses to guess on a non-TTY)
 *   - `check` folds verify + health + gaps + anti-pattern lint into one verdict
 *   - the Tier-3 flat commands NEVER read the cursor/lens (CI determinism)
 *
 * Every new verb's `--help` safety is covered by help-safety.test.ts.
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

function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Ceiling Test', stage: 'concept' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Busy Parent' },
      { id: 'n_job', type: 'job', title: 'Plan dinner' },
      { id: 'n_metric_a', type: 'metric', title: 'Signups' },
      { id: 'n_metric_b', type: 'metric', title: 'Activation' },
    ],
    edges: [] as Array<{ id: string; source: string; target: string; type: string }>,
  }
}

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 15_000, env })
}

describe('Tier-1 ceiling verbs', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-ceiling-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  // ── cursor: set / move / clear ──────────────────────────────────────────────

  it('`at` sets the cursor (session-local, co-located with the graph)', () => {
    const r = run(args(['at', 'n_persona']), tmp)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('n_persona')
    // The session file lives next to the .upg, NOT inside the .upg document.
    const session = JSON.parse(fs.readFileSync(file + '.session.json', 'utf-8'))
    expect(session.cursor).toBe('n_persona')
    // The .upg document is untouched (no cursor leaks into the graph).
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.cursor).toBeUndefined()
  })

  it('`at` resolves a node by TITLE, not just id', () => {
    const r = run(args(['at', 'Busy Parent']), tmp)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('n_persona')
  })

  it('`here` reports the cursor; `here --clear` resets it', () => {
    run(args(['at', 'n_persona']), tmp)
    const here1 = run(args(['here', '--json']), tmp)
    expect(JSON.parse(here1.stdout).cursor.id).toBe('n_persona')

    const cleared = run(args(['here', '--clear']), tmp)
    expect(cleared.status).toBe(0)
    const here2 = run(args(['here', '--json']), tmp)
    expect(JSON.parse(here2.stdout).cursor).toBeNull()
  })

  it('a dangling cursor (node deleted) self-heals to root', () => {
    run(args(['at', 'n_persona']), tmp)
    // Delete the node out from under the cursor via the Tier-3 path.
    run(args(['delete', 'n_persona', '--yes']), tmp)
    const r = run(args(['here', '--json']), tmp)
    expect(JSON.parse(r.stdout).cursor).toBeNull()
  })

  // ── lens validation ─────────────────────────────────────────────────────────

  it('`use` accepts a canonical lens and persists it', () => {
    const r = run(args(['use', 'product']), tmp)
    expect(r.status).toBe(0)
    expect(JSON.parse(fs.readFileSync(file + '.session.json', 'utf-8')).lens).toBe('product')
  })

  it('`use full` is always available', () => {
    expect(run(args(['use', 'full']), tmp).status).toBe(0)
  })

  it('`use` rejects an unknown lens (usage error, exit 3)', () => {
    const r = run(args(['use', 'not_a_lens']), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('Unknown lens')
  })

  // ── new: create + auto-link with inferred edge ──────────────────────────────

  it('`new` creates a node AND auto-links it to the cursor, edge inferred', () => {
    run(args(['at', 'n_persona']), tmp)
    const r = run(args(['new', 'need', 'Decide fast', '--json']), tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.node.type).toBe('need')
    // The edge was inferred — no --parent / --edge-type was passed.
    expect(out.edge).not.toBeNull()
    expect(out.edge.source).toBe('n_persona')
    expect(out.edge.type).toBe('persona_experiences_need')
    expect(out.inferred.verb).toBe('experiences')
    // The new node becomes the cursor (depth-first authoring).
    expect(JSON.parse(fs.readFileSync(file + '.session.json', 'utf-8')).cursor).toBe(out.node.id)
  })

  it('`new` with no cursor creates an unlinked anchor', () => {
    const r = run(args(['new', 'persona', 'Anchor', '--json']), tmp)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).edge).toBeNull()
  })

  it('`new` rejects an unknown type (exit 1)', () => {
    expect(run(args(['new', 'not_a_type', 'X']), tmp).status).toBe(1)
  })

  // ── link: infer + auto-flip + prompt only on ambiguity ──────────────────────

  it('`link` infers the edge for an unambiguous pair', () => {
    const r = run(args(['link', 'n_persona', 'n_job', '--json']), tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge.type).toBe('persona_pursues_job')
    expect(out.inferred.flipped).toBe(false)
  })

  it('`link` auto-flips to the canonical direction and reports it', () => {
    // Named job-first; canonical edge is persona → job, so it must flip.
    const r = run(args(['link', 'n_job', 'n_persona', '--json']), tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge.source).toBe('n_persona') // flipped to canonical source
    expect(out.edge.target).toBe('n_job')
    expect(out.inferred.flipped).toBe(true)
  })

  it('`link` on an ambiguous pair refuses to guess on a non-TTY (exit 3, verbs not edge-strings as the prompt)', () => {
    // metric ↔ metric has several relations — the canonical ambiguous case.
    const r = run(args(['link', 'n_metric_a', 'n_metric_b']), tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('refusing to guess')
    // The menu offers VERBS (e.g. "drives", "measures"), and --as is the escape.
    expect(r.stderr).toContain('--as')
  })

  it('`link --as` resolves an ambiguous pair non-interactively', () => {
    const r = run(args(['link', 'n_metric_a', 'n_metric_b', '--as', 'drives', '--json']), tmp)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).edge.type).toBe('metric_drives_metric')
  })

  it('`link` on an incompatible pair is a policy violation (exit 2)', () => {
    // Build a second persona so persona↔persona (no canonical edge) is testable.
    const doc = fixtureDoc()
    doc.nodes.push({ id: 'n_persona2', type: 'persona', title: 'Solo Cook' })
    fs.writeFileSync(file, JSON.stringify(doc, null, 2))
    expect(run(args(['link', 'n_persona', 'n_persona2']), tmp).status).toBe(2)
  })

  // ── check: one verdict folding the four ─────────────────────────────────────

  it('`check --ci` aggregates structure + health + anti-patterns into one verdict', () => {
    const r = run(args(['check', '--ci']), tmp)
    const out = JSON.parse(r.stdout)
    expect(typeof out.health).toBe('number')
    expect(typeof out.structureValid).toBe('boolean')
    expect(Array.isArray(out.findings)).toBe(true)
    // A persona with no job at concept stage fires the high-severity lint.
    const ids = out.findings.map((f: { id: string }) => f.id)
    expect(ids).toContain('personas-without-jobs')
  })

  it('`check` exits 2 when a high-severity finding fires, 0 when clean', () => {
    // High finding present (persona without job) → exit 2.
    expect(run(args(['check']), tmp).status).toBe(2)

    // Link the persona to the job → the high finding clears → exit 0.
    run(args(['link', 'n_persona', 'n_job']), tmp)
    expect(run(args(['check']), tmp).status).toBe(0)
  })

  it('`fix` on a guided finding prints the step and never fabricates entities', () => {
    const before = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const r = run(args(['fix', '--yes', '--json']), tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.fixed).toBe(false)
    expect(out.reason).toBe('guided')
    // Nothing was created.
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(after.nodes.length).toBe(before.nodes.length)
  })

  // ── invariant: Tier-3 commands never read the cursor/lens ────────────────────

  it('Tier-3 `list` ignores the cursor (CI determinism)', () => {
    run(args(['at', 'n_persona']), tmp)
    const withCursor = run(args(['list', '--json']), tmp)
    run(args(['here', '--clear']), tmp)
    const noCursor = run(args(['list', '--json']), tmp)
    // Identical output regardless of session state.
    expect(withCursor.stdout).toBe(noCursor.stdout)
  })

  it('UPG_SESSION redirects session state away from the co-located file', () => {
    const sess = path.join(tmp, 'custom-session.json')
    const r = run(args(['at', 'n_persona']), tmp, { UPG_SESSION: sess })
    expect(r.status).toBe(0)
    expect(fs.existsSync(sess)).toBe(true)
    expect(JSON.parse(fs.readFileSync(sess, 'utf-8')).cursor).toBe('n_persona')
    // The co-located default was NOT written.
    expect(fs.existsSync(file + '.session.json')).toBe(false)
  })
})
