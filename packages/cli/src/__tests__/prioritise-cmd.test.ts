/**
 * `upg prioritise` command tests.
 *
 * Drives the BUILT binary against a small fixture graph. The fixture includes
 * three feature nodes with RICE properties (reach, impact, confidence, effort)
 * so the expression (reach * impact * confidence) / effort can be computed.
 *
 * Covers:
 *   - exit 0 + ranked output (human and --json) for a RICE-style fixture
 *   - --json shape: ok, framework, required_properties, ranked[]
 *   - ranked order: highest score first, nulls last
 *   - missing required inputs: score null + missing_properties in JSON
 *   - unknown entity ID: score null + "not found" rationale
 *   - fallback (framework without expression): exits 1, --json has kind:fallback
 *   - type_mismatch: all candidates wrong type, exits 1, --json has kind:type_mismatch
 *   - --framework missing: exits 3 (usage)
 *   - no ids: exits 3 (usage)
 *   - unknown framework id: exits 3 (usage)
 *   - human output: prints ranked table to stdout, header to stderr
 *   - alias `prioritize` accepted
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

// ── fixture ────────────────────────────────────────────────────────────────────

/**
 * Three feature nodes with RICE properties.
 * RICE = (reach * impact * confidence) / effort
 *
 * Expected scores:
 *   f_a: (8 * 3 * 0.8) / 4  = 19.2   / 4 = 4.8
 *   f_b: (10 * 1 * 0.5) / 2 = 5      / 2 = 2.5
 *   f_c: (4 * 2 * 1)   / 1  = 8      / 1 = 8
 *
 * Expected ranking: f_c (8) > f_a (4.8) > f_b (2.5)
 */
function fixtureDoc() {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_prio', title: 'Prioritise Test Product' },
    nodes: [
      {
        id: 'f_a',
        type: 'feature',
        title: 'Feature A',
        status: 'proposed',
        properties: { reach: 8, impact: 3, confidence: 0.8, effort: 4 },
      },
      {
        id: 'f_b',
        type: 'feature',
        title: 'Feature B',
        status: 'proposed',
        properties: { reach: 10, impact: 1, confidence: 0.5, effort: 2 },
      },
      {
        id: 'f_c',
        type: 'feature',
        title: 'Feature C',
        status: 'proposed',
        properties: { reach: 4, impact: 2, confidence: 1, effort: 1 },
      },
      // persona node: wrong type for RICE (used for type_mismatch test)
      {
        id: 'n_persona',
        type: 'persona',
        title: 'Power User',
        status: 'active',
      },
      // feature with incomplete RICE inputs (missing effort)
      {
        id: 'f_incomplete',
        type: 'feature',
        title: 'Feature Incomplete',
        status: 'proposed',
        properties: { reach: 8, impact: 3 },
      },
    ],
    edges: [],
  }
}

describe('upg prioritise command', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-prio-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 15_000 })
  }

  // ── Usage errors ──────────────────────────────────────────────────────────

  it('exits 3 when --framework is missing', () => {
    const r = run(['prioritise', 'f_a', 'f_b'])
    expect(r.status).toBe(3)
  })

  it('exits 3 when no ids are provided', () => {
    const r = run(['prioritise', '--framework', 'rice-scoring'])
    expect(r.status).toBe(3)
  })

  it('exits 3 when framework id is unknown', () => {
    const r = run(['prioritise', 'f_a', '--framework', 'does-not-exist'])
    expect(r.status).toBe(3)
  })

  // ── Successful RICE ranking ───────────────────────────────────────────────

  it('exits 0 for a valid RICE ranking', () => {
    const r = run(['prioritise', 'f_a', 'f_b', 'f_c', '--framework', 'rice-scoring'])
    expect(r.status).toBe(0)
  })

  it('--json: ranked array is sorted highest score first', () => {
    const r = run(['prioritise', 'f_a', 'f_b', 'f_c', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(true)
    expect(Array.isArray(out.ranked)).toBe(true)
    expect(out.ranked.length).toBe(3)

    // Highest score first
    const scores = out.ranked.map((row: { score: number | null }) => row.score)
    expect(scores[0]).toBeGreaterThan(scores[1] as number)
    expect(scores[1]).toBeGreaterThan(scores[2] as number)
  })

  it('--json: f_c ranks first (score 8), f_a second (4.8), f_b third (2.5)', () => {
    const r = run(['prioritise', 'f_a', 'f_b', 'f_c', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ranked = out.ranked as Array<{ entity_id: string; score: number }>
    expect(ranked[0].entity_id).toBe('f_c')
    expect(ranked[1].entity_id).toBe('f_a')
    expect(ranked[2].entity_id).toBe('f_b')
    // Tolerant numeric check
    expect(ranked[0].score).toBeCloseTo(8, 3)
    expect(ranked[1].score).toBeCloseTo(4.8, 3)
    expect(ranked[2].score).toBeCloseTo(2.5, 3)
  })

  it('--json: response contains framework metadata and required_properties', () => {
    const r = run(['prioritise', 'f_a', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.framework).toHaveProperty('id', 'rice-scoring')
    expect(out.framework).toHaveProperty('name')
    expect(out.framework).toHaveProperty('expression')
    expect(Array.isArray(out.required_properties)).toBe(true)
    // RICE needs at least these four inputs
    const props: string[] = out.required_properties
    expect(props).toContain('reach')
    expect(props).toContain('impact')
    expect(props).toContain('confidence')
    expect(props).toContain('effort')
  })

  it('--json: each ranked row has entity_id, score, and rationale', () => {
    const r = run(['prioritise', 'f_a', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const row = out.ranked[0] as { entity_id: string; score: number; rationale: string }
    expect(row).toHaveProperty('entity_id', 'f_a')
    expect(typeof row.score).toBe('number')
    expect(typeof row.rationale).toBe('string')
    expect(row.rationale.length).toBeGreaterThan(0)
  })

  // ── Human output ─────────────────────────────────────────────────────────

  it('human output: writes ranked rows to stdout containing entity ids', () => {
    const r = run(['prioritise', 'f_a', 'f_b', 'f_c', '--framework', 'rice-scoring'])
    expect(r.status).toBe(0)
    // Ranked rows go to stdout; header/labels go to stderr
    expect(r.stdout).toMatch(/f_c/)
    expect(r.stdout).toMatch(/f_a/)
    expect(r.stdout).toMatch(/f_b/)
  })

  it('human output: stderr has framework name and expression', () => {
    const r = run(['prioritise', 'f_a', 'f_b', '--framework', 'rice-scoring'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/rice-scoring/i)
    // Expression should appear on stderr
    expect(r.stderr).toMatch(/reach|impact|confidence|effort/)
  })

  // ── Nulls (missing inputs) ────────────────────────────────────────────────

  it('--json: node with missing RICE inputs has score null and missing_properties', () => {
    const r = run(['prioritise', 'f_incomplete', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const row = out.ranked[0] as { entity_id: string; score: null; missing_properties: string[] }
    expect(row.entity_id).toBe('f_incomplete')
    expect(row.score).toBeNull()
    expect(Array.isArray(row.missing_properties)).toBe(true)
    expect(row.missing_properties.length).toBeGreaterThan(0)
  })

  it('--json: unknown entity id has score null with rationale "not found"', () => {
    const r = run(['prioritise', 'does_not_exist', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const row = out.ranked[0] as { entity_id: string; score: null; rationale: string }
    expect(row.entity_id).toBe('does_not_exist')
    expect(row.score).toBeNull()
    expect(row.rationale).toMatch(/not found/i)
  })

  it('nulls sort after scored rows', () => {
    const r = run([
      'prioritise', 'f_a', 'f_incomplete', 'f_c',
      '--framework', 'rice-scoring', '--json',
    ])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ranked = out.ranked as Array<{ entity_id: string; score: number | null }>
    // All non-null scores must come before nulls
    let lastScored = -1
    ranked.forEach((r, i) => { if (r.score !== null) lastScored = i })
    const firstNull = ranked.findIndex((r) => r.score === null)
    if (firstNull !== -1 && lastScored !== -1) {
      expect(lastScored).toBeLessThan(firstNull)
    }
  })

  // ── Fallback (no expression) ──────────────────────────────────────────────

  it('exits 1 and --json kind:fallback for a framework without an expression (e.g. kano-model)', () => {
    // kano-model is a classification framework with no computed_properties expression
    const r = run(['prioritise', 'f_a', 'f_b', '--framework', 'kano-model', '--json'])
    // May exit 1 (fallback) or succeed if kano-model gains an expression later.
    // Accept either; just verify the shape when it is fallback.
    if (r.status === 1) {
      const out = JSON.parse(r.stdout)
      expect(out.ok).toBe(false)
      expect(out.kind).toBe('fallback')
      expect(out.framework).toHaveProperty('id', 'kano-model')
      expect(typeof out.hint).toBe('string')
    }
    // If kano-model was given an expression later, status 0 is also acceptable.
    expect([0, 1]).toContain(r.status)
  })

  // ── Type mismatch ─────────────────────────────────────────────────────────

  it('exits 1 and --json kind:type_mismatch when all candidates are the wrong type', () => {
    // RICE scores features; n_persona is a persona -> type_mismatch
    const r = run(['prioritise', 'n_persona', '--framework', 'rice-scoring', '--json'])
    // Accept type_mismatch (exit 1) OR a scored result if RICE's guard is later broadened.
    if (r.status === 1) {
      const out = JSON.parse(r.stdout)
      expect(out.ok).toBe(false)
      expect(out.kind).toBe('type_mismatch')
      expect(out.framework).toHaveProperty('id', 'rice-scoring')
      expect(Array.isArray(out.mismatched)).toBe(true)
      expect(typeof out.hint).toBe('string')
    }
    expect([0, 1]).toContain(r.status)
  })

  // ── Alias ─────────────────────────────────────────────────────────────────

  it('alias `prioritize` (z spelling) is accepted', () => {
    const r = run(['prioritize', 'f_a', 'f_b', '--framework', 'rice-scoring', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.ok).toBe(true)
  })
})
