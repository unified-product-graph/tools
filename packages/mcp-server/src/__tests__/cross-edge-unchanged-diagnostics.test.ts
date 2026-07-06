/**
 * Regression: `create_cross_product_edge` first-time write + diagnosable
 * `unchanged` (upg-feedback-2026-07-06, UPG 0.22.1).
 *
 * Ground truth for the 0.22.0 report: a first-time curated cross-edge IS written
 * (status "created", applied true) and IS resolvable/deletable by the returned id
 * via `delete_cross_product_edge`. The reporter's "phantom id" was a real,
 * already-existing edge; every read they tried (`delete_edge`, `export_edges`,
 * `get_node.edges_in`) reads the PRODUCT graph and structurally never sees
 * portfolio cross-edges. The 0.22.1 fix makes the idempotent `unchanged` response
 * self-explanatory (existing id + the right read/delete tools) and flags a stale
 * edge whose endpoints no longer resolve.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteCrossProductEdge } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import { createCrossProductEdge } from '../tools/workspace.js'

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  const text = r.content[0]?.text ?? ''
  let body: Record<string, unknown> | undefined
  try { body = JSON.parse(text) } catch { body = undefined }
  return { isError: r.isError, text, body }
}

function doc(id: string, title: string, nodes: Array<{ id: string; type: string; title: string }>): UPGDocument {
  return {
    upg_version: '0.22.1',
    exported_at: '2026-07-06T00:00:00Z',
    source: { tool: 'test' },
    product: { id, title, stage: 'growth' },
    nodes,
    edges: [],
  } as unknown as UPGDocument
}

const ARGS = {
  source_id: 'org_rollup/n_theme',
  target_id: 'p_member/n_obj',
  type: 'strategic_theme_contains_objective',
  auto_create_portfolio: true,
}

describe('create_cross_product_edge — first-time write + diagnosable unchanged (0.22.1)', () => {
  let cwd: string
  let originalCwd: string
  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-cx-'))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'rollup.upg'), JSON.stringify(doc('org_rollup', 'Rollup', [{ id: 'n_theme', type: 'strategic_theme', title: 'Theme' }]), null, 2))
    writeFileSync(join(cwd, '.upg', 'member.upg'), JSON.stringify(doc('p_member', 'Member', [{ id: 'n_obj', type: 'objective', title: 'Objective' }]), null, 2))
    writeFileSync(
      join(cwd, '.upg', 'workspace.json'),
      JSON.stringify({ version: '1.0', default_product: 'rollup.upg', products: [{ file: 'rollup.upg', title: 'Rollup' }, { file: 'member.upg', title: 'Member' }] }, null, 2),
    )
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes a first-time curated cross-edge (applied:true) that is resolvable and deletable by id', async () => {
    // dry-run forecasts a create on the empty portfolio
    const dry = await parse(createCrossProductEdge({ ...ARGS, dry_run: true }, {} as never))
    expect(dry.body?.would).toBe('create')

    const res = await parse(createCrossProductEdge(ARGS, {} as never))
    expect(res.isError).toBeFalsy()
    expect(res.body?.status).toBe('created')
    expect(res.body?.applied).toBe(true)
    const createdId = (res.body?.edge as { id: string }).id

    // persisted to portfolio.upg
    const pf = JSON.parse(readFileSync(join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
    expect((pf.cross_edges ?? []).length).toBe(1)
    expect(pf.cross_edges[0].id).toBe(createdId)

    // the returned id RESOLVES — deletable via the correct tool (not delete_edge)
    const del = await deleteCrossProductEdge(cwd, createdId)
    expect(del.deleted).toBe(true)
  })

  it('an idempotent re-create returns unchanged WITH the existing id + guidance (not a silent no-op)', async () => {
    const first = await parse(createCrossProductEdge(ARGS, {} as never))
    const existingId = (first.body?.edge as { id: string }).id

    const again = await parse(createCrossProductEdge(ARGS, {} as never))
    expect(again.body?.status).toBe('unchanged')
    expect(again.body?.applied).toBe(false)
    expect(again.body?.already_exists).toBe(true)
    expect(again.body?.existing_edge_id).toBe(existingId)
    expect(String(again.body?.message)).toContain('delete_cross_product_edge')
    expect(String(again.body?.hint)).toContain(existingId)
    // endpoints resolve → NOT flagged dangling
    expect(again.body?.dangling).toBeUndefined()

    // dry-run on the existing edge carries the same diagnostics
    const dry = await parse(createCrossProductEdge({ ...ARGS, dry_run: true }, {} as never))
    expect(dry.body?.would).toBe('unchanged')
    expect(dry.body?.already_exists).toBe(true)
    expect(dry.body?.existing_edge_id).toBe(existingId)
  })

  it('flags a stale edge whose endpoints no longer resolve as dangling', async () => {
    await parse(createCrossProductEdge(ARGS, {} as never))
    // Remove the target node so the stored edge's target no longer resolves.
    writeFileSync(join(cwd, '.upg', 'member.upg'), JSON.stringify(doc('p_member', 'Member', []), null, 2))

    const again = await parse(createCrossProductEdge(ARGS, {} as never))
    expect(again.body?.status).toBe('unchanged')
    expect(again.body?.already_exists).toBe(true)
    expect(Array.isArray(again.body?.dangling)).toBe(true)
    expect(String(again.body?.message)).toContain('STALE')
  })
})
