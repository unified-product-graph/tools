/**
 * validate_graph member-kind validation profiles (0.17.0).
 *
 * The server resolves the graph's effective member kind and grades it against
 * UPG_VALIDATION_PROFILES: which anti-pattern concern families are evaluated, and
 * which fired violations gate `valid` vs are advisory. Replaces the pre-0.17.0
 * hard-coded `member_kind === 'watched'` blanket-suppression branch.
 *
 * Uses only canonical `product` / `feature` nodes so no schema drift muddies the
 * `valid` verdict — the focus is the anti-pattern profile, not structure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { validateGraph } from '../tools/validation.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  return JSON.parse(r.content[0]?.text ?? '{}')
}

type Vio = { anti_pattern_id: string; gating?: boolean; concern?: string }

describe('validate_graph member-kind profiles (0.17.0)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-profiles-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  // Three feature nodes with no hypothesis: fires `features-without-hypotheses`
  // (product_spine) for a product, and total > 3 so the operating patterns apply.
  async function loadGraph(memberKind?: string): Promise<UPGFileStore> {
    const doc = {
      upg_version: '0.17.0',
      exported_at: '2026-06-29T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Fn', stage: 'growth' },
      ...(memberKind ? { member_kind: memberKind } : {}),
      nodes: [
        { id: 'p_root', type: 'product', title: 'Fn' },
        { id: 'f1', type: 'feature', title: 'F1' },
        { id: 'f2', type: 'feature', title: 'F2' },
        { id: 'f3', type: 'feature', title: 'F3' },
      ],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    return store
  }

  it('product (default): product-spine gates → valid false, operating patterns skipped', async () => {
    const store = await loadGraph()
    const res = await parse(validateGraph({}, makeCtx(store)))
    const ids = (res.anti_pattern_violations as Vio[]).map((v) => v.anti_pattern_id)
    expect(ids).toContain('features-without-hypotheses')
    expect(ids).not.toContain('operating-function-without-north-star')
    expect(res.valid).toBe(false)
    expect(res.advisory_profile).toBeUndefined()
  })

  it('operating_function: product-spine NOT evaluated; operating spine gates → valid false', async () => {
    const store = await loadGraph('operating_function')
    const res = await parse(validateGraph({}, makeCtx(store)))
    const vios = res.anti_pattern_violations as Vio[]
    const ids = vios.map((v) => v.anti_pattern_id)
    // Product-spine is a category error for a function: never even reported.
    expect(ids).not.toContain('features-without-hypotheses')
    // The operating spine fires and gates (no metric, no operating content).
    expect(ids).toContain('operating-function-without-north-star')
    expect(vios.find((v) => v.anti_pattern_id === 'operating-function-without-north-star')?.gating).toBe(true)
    expect(res.valid).toBe(false)
  })

  it('watched: product-spine reported but advisory → valid true, flags set (back-compat)', async () => {
    const store = await loadGraph('watched')
    const res = await parse(validateGraph({}, makeCtx(store)))
    const vios = res.anti_pattern_violations as Vio[]
    const fwh = vios.find((v) => v.anti_pattern_id === 'features-without-hypotheses')
    expect(fwh).toBeDefined() // still reported
    expect(fwh?.gating).toBe(false) // but advisory
    expect(res.valid).toBe(true) // structurally clean + nothing gates
    expect(res.advisory_profile).toBe('watched')
    expect(res.watched_intelligence_graph).toBe(true)
  })

  it('org_rollup: product-spine advisory (the 0.17.0 fix — it used to gate)', async () => {
    const store = await loadGraph('org_rollup')
    const res = await parse(validateGraph({}, makeCtx(store)))
    const vios = res.anti_pattern_violations as Vio[]
    expect(vios.find((v) => v.anti_pattern_id === 'features-without-hypotheses')?.gating).toBe(false)
    expect(res.valid).toBe(true)
    expect(res.advisory_profile).toBe('org_rollup')
  })
})
