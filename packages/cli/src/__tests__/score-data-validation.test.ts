/**
 * (CLI half) — `upg score --data` framework validation.
 *
 * Drives the BUILT binary against throwaway `.upg` graphs and pins that an
 * invalid scoring payload is REJECTED at exit 2 with nothing persisted, while a
 * valid payload still records at exit 0. The SDK's `scoreEntity` only WARNS
 * (storage stays permissive); this gate lives in the CLI, which validates the
 * payload against the exercise's framework definition before writing.
 *
 * Repros pinned (all returned exit 0 before the fix):
 *   - MoSCoW with an invalid bucket          {"moscow":"definitely-maybe"}
 *   - MoSCoW with a key off the wrong schema {"reach":999}
 *   - RICE effort:0 (-Infinity hazard) + out-of-range {"reach":-50,...,"effort":0}
 *   - RICE with a string where a number is declared    {"reach":"lots"}
 *
 * Acceptance: each invalid payload → exit 2, nothing persisted on the includes
 * edge; valid payloads → exit 0 with the values recorded.
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

function baseDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Score Validation', stage: 'concept' },
    nodes: [{ id: 'n_feat', type: 'feature', title: 'A Feature' }] as Array<Record<string, unknown>>,
    edges: [] as Array<Record<string, unknown>>,
  }
}

describe('upg score — framework --data validation', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-score-validation-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(baseDoc(), null, 2))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 20_000 })
  }

  /** Create an exercise for `framework` and return its exercise id. */
  function applyFramework(framework: string): string {
    const r = run(['apply', framework, 'n_feat'])
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }

  /** The properties recorded on the includes edge, or {} when none. */
  function recordedScore(): Record<string, unknown> {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      edges: Array<{ type: string; properties?: Record<string, unknown> }>
    }
    const edge = doc.edges.find((e) => e.type === 'framework_exercise_includes_node')
    return edge?.properties ?? {}
  }

  it('rejects an invalid MoSCoW bucket at exit 2 and persists nothing', () => {
    const ex = applyFramework('moscow')
    const r = run(['score', ex, 'n_feat', '--data', '{"moscow":"definitely-maybe"}'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('definitely-maybe')
    expect(r.stderr).toMatch(/must, should, could, wont/)
    expect(recordedScore()).toEqual({})
  })

  it('rejects a key off the wrong schema (reach on MoSCoW) at exit 2', () => {
    const ex = applyFramework('moscow')
    const r = run(['score', ex, 'n_feat', '--data', '{"reach":999}'])
    expect(r.status).toBe(2)
    // Both the unknown key AND the missing required bucket are surfaced.
    expect(r.stderr).toContain('"reach" is not a moscow input')
    expect(r.stderr).toContain('Missing required "moscow"')
    expect(recordedScore()).toEqual({})
  })

  it('rejects RICE effort:0 and out-of-range values at exit 2 (the -Infinity hazard)', () => {
    const ex = applyFramework('rice-scoring')
    const r = run(['score', ex, 'n_feat', '--data', '{"reach":-50,"impact":99,"confidence":5,"effort":0}'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('"effort" = 0 is below the minimum 1')
    expect(r.stderr).toContain('"reach" = -50 is below the minimum 1')
    expect(r.stderr).toContain('"impact" = 99 is above the maximum 5')
    expect(recordedScore()).toEqual({})
  })

  it('rejects an in-the-thousands RICE reach at exit 2 (scale seam with verify)', () => {
    // RICE fields are 1-5 ASSESSMENT scales in core (reach -> reach_5), so the
    // classic raw-reach `{"reach":800,...}` is out of range. The range is derived
    // from the core scale, NOT hardcoded, so create-time agrees with the
    // verify-time scale check ( seam with Spock's verify validator).
    const ex = applyFramework('rice-scoring')
    const r = run(['score', ex, 'n_feat', '--data', '{"reach":800,"impact":3,"confidence":4,"effort":2}'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('"reach" = 800 is above the maximum 5 for the reach_5 scale')
    expect(recordedScore()).toEqual({})
  })

  it('rejects a string where RICE declares a number at exit 2', () => {
    const ex = applyFramework('rice-scoring')
    const r = run(['score', ex, 'n_feat', '--data', '{"reach":"lots"}'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('"reach" must be a number')
    expect(recordedScore()).toEqual({})
  })

  it('accepts a valid MoSCoW payload at exit 0 and records it', () => {
    const ex = applyFramework('moscow')
    const r = run(['score', ex, 'n_feat', '--data', '{"moscow":"must"}'])
    expect(r.status, r.stderr).toBe(0)
    expect(recordedScore()).toMatchObject({ moscow: 'must' })
  })

  it('accepts a valid RICE payload at exit 0 and records it', () => {
    const ex = applyFramework('rice-scoring')
    const r = run(['score', ex, 'n_feat', '--data', '{"reach":4,"impact":3,"confidence":5,"effort":2}'])
    expect(r.status, r.stderr).toBe(0)
    expect(recordedScore()).toMatchObject({ reach: 4, impact: 3, confidence: 5, effort: 2 })
  })

  it('still rejects a non-object --data at exit 3 (usage), before framework checks', () => {
    const ex = applyFramework('moscow')
    const r = run(['score', ex, 'n_feat', '--data', '[1,2,3]'])
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('--data must be a JSON object')
    expect(recordedScore()).toEqual({})
  })
})
