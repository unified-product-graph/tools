/**
 * `upg spec` command group tests.
 *
 * Drives the BUILT binary. Exercises the read-only spec catalogue browser:
 * regions, lifecycle, resolve-edge, version, schema, anti-patterns, and
 * --json output. No .upg file required - all commands read from
 * `@unified-product-graph/core` directly.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function run(args: string[]) {
  return execFileNoThrow(CLI, args, { stdinFromNull: true, timeoutMs: 15_000 })
}

// Fail the whole suite fast when there is no build yet.
beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
})

// ── spec regions ─────────────────────────────────────────────────────────────

describe('spec regions', () => {
  it('exits 0 and lists regions', () => {
    const r = run(['spec', 'regions'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/strategy_outcomes|users_needs|foundations/)
  })

  it('--json returns a structured object with count and regions array', () => {
    const r = run(['spec', 'regions', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.count).toBe('number')
    expect(out.count).toBeGreaterThan(5)
    expect(Array.isArray(out.regions)).toBe(true)
    expect(out.regions[0]).toHaveProperty('id')
    expect(out.regions[0]).toHaveProperty('label')
  })

  it('spec region <id> returns full record --json', () => {
    const r = run(['spec', 'region', 'users_needs', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.id).toBe('users_needs')
    expect(Array.isArray(out.entities)).toBe(true)
  })

  it('spec region with unknown id exits 1', () => {
    const r = run(['spec', 'region', 'does_not_exist'])
    expect(r.status).toBe(1)
  })

  it('spec region-for persona --json returns region containing persona', () => {
    const r = run(['spec', 'region-for', 'persona', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.id).toBeTruthy()
    expect(typeof out.id).toBe('string')
  })
})

// ── spec lifecycle / status-values ──────────────────────────────────────────

describe('spec lifecycle', () => {
  it('spec lifecycle feature exits 0 and shows phases', () => {
    const r = run(['spec', 'lifecycle', 'feature'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/feature/)
  })

  it('spec lifecycle feature --json has initial_phase and phases', () => {
    const r = run(['spec', 'lifecycle', 'feature', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.entity_type).toBe('feature')
    expect(typeof out.initial_phase).toBe('string')
    expect(Array.isArray(out.phases)).toBe(true)
    expect(out.phases.length).toBeGreaterThan(0)
  })

  it('spec lifecycle unknown_type exits 1', () => {
    const r = run(['spec', 'lifecycle', 'not_a_real_type_xyz'])
    expect(r.status).toBe(1)
  })

  it('spec status-values feature --json has initial_status and values', () => {
    const r = run(['spec', 'status-values', 'feature', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.entity_type).toBe('feature')
    expect(out.lifecycle_free).toBe(false)
    expect(typeof out.initial_status).toBe('string')
    expect(Array.isArray(out.values)).toBe(true)
    expect(out.values[0]).toHaveProperty('status')
    expect(out.values[0]).toHaveProperty('terminal')
  })
})

// ── spec resolve-edge ────────────────────────────────────────────────────────

describe('spec resolve-edge', () => {
  it('spec resolve-edge persona job exits 0 and returns an edge_type', () => {
    const r = run(['spec', 'resolve-edge', 'persona', 'job', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.source_type).toBe('persona')
    expect(out.target_type).toBe('job')
    expect(typeof out.edge_type).toBe('string')
    expect(out.edge_type).not.toBe('')
  })

  it('spec resolve-edge with unknown pair returns edge_type null with hints', () => {
    const r = run(['spec', 'resolve-edge', 'persona', 'scale', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edge_type).toBeNull()
  })

  it('spec resolve-edge missing args exits 3 (usage error)', () => {
    const r = run(['spec', 'resolve-edge', 'persona'])
    expect(r.status).toBe(3)
  })
})

// ── spec version ─────────────────────────────────────────────────────────────

describe('spec version', () => {
  it('exits 0 and prints upg_version', () => {
    const r = run(['spec', 'version'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/upg_version/)
  })

  it('--json returns structured counts', () => {
    const r = run(['spec', 'version', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.upg_version).toBe('string')
    expect(typeof out.entity_count).toBe('number')
    expect(out.entity_count).toBeGreaterThan(100)
    expect(typeof out.edge_count).toBe('number')
    expect(out.edge_count).toBeGreaterThan(100)
    expect(typeof out.region_count).toBe('number')
  })
})

// ── spec schema ──────────────────────────────────────────────────────────────

describe('spec schema', () => {
  it('spec schema persona exits 0', () => {
    const r = run(['spec', 'schema', 'persona'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/persona/)
  })

  it('spec schema persona --json returns edges_out and valid_children', () => {
    const r = run(['spec', 'schema', 'persona', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.type).toBe('persona')
    expect(Array.isArray(out.edges_out)).toBe(true)
    expect(Array.isArray(out.edges_in)).toBe(true)
    expect(Array.isArray(out.valid_children)).toBe(true)
  })

  it('spec schema unknown_type exits 1', () => {
    const r = run(['spec', 'schema', 'not_a_type_zzz'])
    expect(r.status).toBe(1)
  })
})

// ── spec types / type / children ─────────────────────────────────────────────

describe('spec types', () => {
  it('spec types exits 0 and lists entity types', () => {
    const r = run(['spec', 'types'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/persona|feature|job/)
  })

  it('spec types --json has types array', () => {
    const r = run(['spec', 'types', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.total).toBe('number')
    expect(Array.isArray(out.types)).toBe(true)
    expect(out.types.some((t: { name: string }) => t.name === 'persona')).toBe(true)
  })

  it('spec type persona --json returns metadata', () => {
    const r = run(['spec', 'type', 'persona', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.name).toBe('persona')
    expect(typeof out.maturity).toBe('string')
  })

  it('spec children persona --json returns valid_children array', () => {
    const r = run(['spec', 'children', 'persona', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.parent_type).toBe('persona')
    expect(Array.isArray(out.valid_children)).toBe(true)
  })
})

// ── spec edges / edge ─────────────────────────────────────────────────────────

describe('spec edges', () => {
  it('spec edges exits 0', () => {
    const r = run(['spec', 'edges'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/persona/)
  })

  it('spec edges --json returns count and edges array', () => {
    const r = run(['spec', 'edges', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.count).toBe('number')
    expect(out.count).toBeGreaterThan(100)
    expect(Array.isArray(out.edges)).toBe(true)
    const e = out.edges[0]
    expect(e).toHaveProperty('type')
    expect(e).toHaveProperty('source_type')
    expect(e).toHaveProperty('target_type')
  })

  it('spec edge persona_pursues_job --json returns full definition', () => {
    const r = run(['spec', 'edge', 'persona_pursues_job', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.type).toBe('persona_pursues_job')
    expect(out.source_type).toBe('persona')
    expect(out.target_type).toBe('job')
  })

  it('spec edge unknown exits 1', () => {
    const r = run(['spec', 'edge', 'no_such_edge'])
    expect(r.status).toBe(1)
  })
})

// ── spec anti-patterns ────────────────────────────────────────────────────────

describe('spec anti-patterns', () => {
  it('spec anti-patterns exits 0 and lists patterns', () => {
    const r = run(['spec', 'anti-patterns'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/features|personas|hypotheses|anti/)
  })

  it('spec anti-patterns --json returns anti_patterns array', () => {
    const r = run(['spec', 'anti-patterns', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.anti_patterns)).toBe(true)
    expect(out.anti_patterns.length).toBeGreaterThan(0)
    const p = out.anti_patterns[0]
    expect(p).toHaveProperty('id')
    expect(p).toHaveProperty('severity')
  })
})

// ── spec stages / migrations ──────────────────────────────────────────────────

describe('spec stages and migrations', () => {
  it('spec stages --json returns stages array', () => {
    const r = run(['spec', 'stages', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.stages)).toBe(true)
    expect(out.stages).toContain('concept')
    expect(out.stages).toContain('launch')
  })

  it('spec migrations --json returns type_migrations and edge_migrations', () => {
    const r = run(['spec', 'migrations', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toHaveProperty('type_migrations')
    expect(out).toHaveProperty('edge_migrations')
    expect(out).toHaveProperty('split_migrations')
    expect(typeof out.type_migrations.total).toBe('number')
  })
})

// ── spec cross-edges / domains / frameworks ───────────────────────────────────

describe('spec cross-edges, domains, frameworks', () => {
  it('spec cross-edges --json returns types array', () => {
    const r = run(['spec', 'cross-edges', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.types)).toBe(true)
    expect(out.types.length).toBeGreaterThan(0)
  })

  it('spec domains --json returns domains with anchor_entity', () => {
    const r = run(['spec', 'domains', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.domains)).toBe(true)
    expect(out.domains[0]).toHaveProperty('domain_id')
    expect(out.domains[0]).toHaveProperty('anchor_entity')
  })

  it('spec frameworks --json returns frameworks summary', () => {
    const r = run(['spec', 'frameworks', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.frameworks)).toBe(true)
    expect(out.frameworks.length).toBeGreaterThan(5)
    expect(out.frameworks[0]).toHaveProperty('id')
    expect(out.frameworks[0]).toHaveProperty('category')
  })
})
