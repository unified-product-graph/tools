/**
 * `upg query` command tests.
 *
 * Drives the BUILT binary against a small fixture graph and asserts:
 *   - BFS from a type start set (human + JSON mode)
 *   - BFS from a node ID start set
 *   - edge type filtering via --traverse
 *   - negation traversal (!type)
 *   - --depth clamp
 *   - --limit truncation
 *   - --include field projection in JSON
 *   - --edge-include empty string omits edges
 *   - usage error when neither --from nor --from-id is supplied
 *   - runtime error for an unknown --from-id
 *   - JSON output matches the MCP query shape (nodes, edges, total_nodes, total_edges)
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

/**
 * A small graph with:
 *   persona -> job (persona_pursues_job)
 *   job -> need (job_generates_need)
 *   need -> opportunity (need_addressed_by_opportunity)
 *   persona -> feature (direct, separate cluster)
 *
 * Depth test: persona->job->need is 2 hops.
 */
function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Query Test Product' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Power User', status: 'active' },
      { id: 'n_job', type: 'job', title: 'Organise tasks', status: 'active' },
      { id: 'n_need', type: 'need', title: 'Quick capture', status: 'active' },
      { id: 'n_opp', type: 'opportunity', title: 'Inbox zero', status: 'proposed' },
      { id: 'n_feature', type: 'feature', title: 'Dark mode', status: 'proposed' },
    ],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
      { id: 'e_jn', source: 'n_job', target: 'n_need', type: 'job_generates_need' },
      { id: 'e_no', source: 'n_need', target: 'n_opp', type: 'need_addressed_by_opportunity' },
      { id: 'e_pf', source: 'n_persona', target: 'n_feature', type: 'persona_uses_feature' },
    ],
  }
}

describe('upg query command', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-query-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 60_000 })
  }

  // ---- Missing anchor ----

  it('exits 3 when neither --from nor --from-id is provided', () => {
    const r = run(['query'])
    expect(r.status).toBe(3)
  })

  // ---- --from type start set ----

  it('--from persona returns all persona nodes (human output, exit 0)', () => {
    const r = run(['query', '--from', 'persona'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Power User/)
  })

  it('--from persona with depth 3 reaches persona, job, need, opportunity (and feature via persona_uses_feature)', () => {
    const r = run(['query', '--from', 'persona', '--depth', '3', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ids = out.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain('n_persona')
    expect(ids).toContain('n_job')
    expect(ids).toContain('n_need')
    expect(ids).toContain('n_opp')
    expect(ids).toContain('n_feature')
  })

  // ---- --from-id single node start ----

  it('--from-id starts BFS from one node and follows edges', () => {
    const r = run(['query', '--from-id', 'n_job', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ids = out.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain('n_job')
    expect(ids).toContain('n_need')
    // persona is not reachable FROM job
    expect(ids).not.toContain('n_persona')
  })

  it('--from-id with an unknown ID exits 1 (runtime error)', () => {
    const r = run(['query', '--from-id', 'n_does_not_exist'])
    expect(r.status).toBe(1)
  })

  // ---- --traverse edge filter ----

  it('--traverse limits edges followed at each BFS level', () => {
    // Only follow persona_pursues_job: persona -> job (depth 1), then job's edges are filtered
    const r = run(['query', '--from', 'persona', '--traverse', 'persona_pursues_job', '--depth', '3', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ids = out.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain('n_persona')
    expect(ids).toContain('n_job')
    // Without matching edge for level 1 (persona_pursues_job repeats), need should NOT appear
    // because job->need is job_generates_need, not persona_pursues_job
    expect(ids).not.toContain('n_need')
  })

  // ---- --traverse negation ----

  it('!negation in --traverse skips that edge type', () => {
    // Skip persona_pursues_job: persona -> job should NOT be traversed
    const r = run(['query', '--from', 'persona', '--traverse', '!persona_pursues_job', '--depth', '2', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ids = out.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain('n_persona')
    // job is reached only via persona_pursues_job; with that negated, job should not appear
    expect(ids).not.toContain('n_job')
    // feature IS reachable (persona_uses_feature is not negated)
    expect(ids).toContain('n_feature')
  })

  // ---- --depth clamp ----

  it('--depth 1 only reaches direct neighbours of the start set', () => {
    const r = run(['query', '--from', 'persona', '--depth', '1', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const ids = out.nodes.map((n: { id: string }) => n.id)
    expect(ids).toContain('n_persona')
    // job and feature are depth-1 neighbours
    expect(ids).toContain('n_job')
    expect(ids).toContain('n_feature')
    // need is depth-2 (job->need); not reachable at depth 1
    expect(ids).not.toContain('n_need')
  })

  // ---- --limit truncation ----

  it('--limit 1 truncates to 1 node and sets truncated: true in JSON', () => {
    const r = run(['query', '--from', 'persona', '--limit', '1', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.total_nodes).toBe(1)
    expect(out.truncated).toBe(true)
  })

  // ---- JSON output shape ----

  it('JSON output has the MCP query shape: nodes, edges, total_nodes, total_edges', () => {
    const r = run(['query', '--from', 'job', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(typeof out.total_nodes).toBe('number')
    expect(typeof out.total_edges).toBe('number')
    expect(Array.isArray(out.nodes)).toBe(true)
    expect(Array.isArray(out.edges)).toBe(true)
    // Each node has at least id and type
    for (const n of out.nodes as Array<{ id: string; type: string }>) {
      expect(typeof n.id).toBe('string')
      expect(typeof n.type).toBe('string')
    }
  })

  // ---- --include field projection ----

  it('--include title,status projects only those fields plus id and type', () => {
    const r = run(['query', '--from', 'persona', '--include', 'title,status', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    const node = out.nodes[0] as Record<string, unknown>
    expect('id' in node).toBe(true)
    expect('type' in node).toBe(true)
    expect('title' in node).toBe(true)
    expect('status' in node).toBe(true)
    // description and properties were not requested
    expect('description' in node).toBe(false)
    expect('properties' in node).toBe(false)
  })

  // ---- --edge-include empty omits edges ----

  it('--edge-include "" omits all edges from the result', () => {
    const r = run(['query', '--from', 'persona', '--edge-include', '', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.edges).toHaveLength(0)
    expect(out.total_edges).toBe(0)
  })

  // ---- start set is empty ----

  it('--from for a type with no nodes exits 0 with empty output', () => {
    const r = run(['query', '--from', 'competitor', '--json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.total_nodes).toBe(0)
    expect(out.nodes).toHaveLength(0)
  })

  // ---- human output sanity ----

  it('human output (no --json) exits 0 and prints node titles', () => {
    const r = run(['query', '--from', 'persona', '--depth', '1'])
    expect(r.status).toBe(0)
    // stdout should contain the persona title
    const combined = r.stdout + r.stderr
    expect(combined).toMatch(/Power User/)
  })
})
