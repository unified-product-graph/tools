/**
 * Batch-4 0.9.4 — pre-commit preview (#18) + target-profile coverage (#22).
 *
 *   #18  validate_graph({ pending_nodes, pending_edges }) — evaluate anti-patterns
 *        against the current graph PLUS a proposed delta WITHOUT writing, and
 *        diff the verdict (newly_triggered / newly_resolved).
 *   #22  get_graph_digest / portfolio_digest coverage_profile — score coverage
 *        against a caller-chosen region set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGProductStage } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { validateGraph } from '../tools/validation.js'
import { getGraphDigest } from '../tools/context.js'
import { portfolioDigest } from '../tools/portfolio-read.js'

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[], stage: UPGProductStage = 'concept'): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Fixture', stage },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument, name = 'test.upg'): Promise<{ store: UPGFileStore; dir: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-b4pc-')))
  const filePath = join(dir, name)
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return { store, dir }
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

// ─── #18: validate_graph pre-commit preview ─────────────────────────────────

describe('validate_graph pending preview (#18)', () => {
  let store: UPGFileStore
  let dir: string
  let ctx: ToolContext

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('previews a delta without writing and returns the diff structure', async () => {
    ;({ store, dir } = await loadStore(makeDoc([{ id: 'p_per', type: 'persona' as UPGEntityType, title: 'P' } as UPGBaseNode], [])))
    ctx = makeCtx(store)
    const before = store.getAllNodes().length
    const body = bodyOf(
      validateGraph(
        { pending_nodes: [{ type: 'job', title: 'J' }], pending_edges: [{ from: 'p_per', to: '$0' }] },
        ctx,
      ) as { content: { text: string }[] },
    )
    expect(body.preview).toBe(true)
    expect(body.pending).toEqual({ nodes: 1, edges: 1 })
    expect(typeof body.would_be_valid).toBe('boolean')
    expect(typeof body.summary.hypothetical_violations).toBe('number')
    expect(typeof body.summary.current_violations).toBe('number')
    expect(Array.isArray(body.delta.newly_triggered)).toBe(true)
    expect(Array.isArray(body.delta.newly_resolved)).toBe(true)
    // Linking the persona to a job cannot ADD violations.
    expect(body.summary.hypothetical_violations).toBeLessThanOrEqual(body.summary.current_violations)
    // Nothing was written.
    expect(store.getAllNodes().length).toBe(before)
  })

  it('resolves an anti-pattern when the pending delta satisfies it', async () => {
    ;({ store, dir } = await loadStore(
      makeDoc(
        [
          { id: 'prod', type: 'product' as UPGEntityType, title: 'Prod' } as UPGBaseNode,
          { id: 'feat1', type: 'feature' as UPGEntityType, title: 'Canvas' } as UPGBaseNode,
        ],
        [],
      ),
    ))
    ctx = makeCtx(store)
    const current = bodyOf(validateGraph({}, ctx) as { content: { text: string }[] })
    const currentCount = current.summary.anti_pattern_violations_high + current.summary.anti_pattern_violations_medium + current.summary.anti_pattern_violations_low
    const body = bodyOf(
      validateGraph(
        {
          pending_nodes: [{ type: 'hypothesis', title: 'H' }],
          pending_edges: [{ from: 'feat1', to: '$0', type: 'feature_tests_hypothesis' }],
        },
        ctx,
      ) as { content: { text: string }[] },
    )
    // Wiring the feature to a hypothesis should not increase violations, and
    // should resolve at least the feature-hypothesis pattern if it was firing.
    expect(body.summary.hypothetical_violations).toBeLessThanOrEqual(currentCount)
    if (current.anti_pattern_violations?.some((v: { anti_pattern_id: string }) => v.anti_pattern_id.includes('hypothes'))) {
      expect(body.delta.newly_resolved.some((v: { anti_pattern_id: string }) => v.anti_pattern_id.includes('hypothes'))).toBe(true)
    }
  })

  it('rejects an invalid pending node type', async () => {
    ;({ store, dir } = await loadStore(makeDoc([], [])))
    ctx = makeCtx(store)
    const result = validateGraph({ pending_nodes: [{ type: 'banana' }] }, ctx) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/banana/)
  })
})

// ─── #22: coverage_profile ──────────────────────────────────────────────────

describe('coverage_profile (#22)', () => {
  let store: UPGFileStore
  let dir: string

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('get_graph_digest scores coverage against the requested profile', async () => {
    // A lone persona covers 1/5 of the `understanding` region → 20%.
    ;({ store, dir } = await loadStore(makeDoc([{ id: 'per', type: 'persona' as UPGEntityType, title: 'P' } as UPGBaseNode], [])))
    const ctx = makeCtx(store)
    const body = bodyOf(getGraphDigest({ coverage_profile: ['understanding'] }, ctx) as { content: { text: string }[] })
    expect(body.coverage.profile_summary).toBeDefined()
    expect(body.coverage.profile_summary.regions).toEqual(['understanding'])
    expect(body.coverage.profile_summary.regions_counted).toBe(1)
    expect(body.coverage.profile_summary.overall_pct).toBe(20)
  })

  it('reports unknown profile regions and ignores them in the score', async () => {
    ;({ store, dir } = await loadStore(makeDoc([{ id: 'per', type: 'persona' as UPGEntityType, title: 'P' } as UPGBaseNode], [])))
    const ctx = makeCtx(store)
    const body = bodyOf(getGraphDigest({ coverage_profile: ['understanding', 'not_a_region'] }, ctx) as { content: { text: string }[] })
    expect(body.coverage.profile_summary.regions).toEqual(['understanding'])
    expect(body.coverage.profile_summary.unknown_regions).toContain('not_a_region')
  })

  it('omits profile_summary when no coverage_profile is requested', async () => {
    ;({ store, dir } = await loadStore(makeDoc([{ id: 'per', type: 'persona' as UPGEntityType, title: 'P' } as UPGBaseNode], [])))
    const ctx = makeCtx(store)
    const body = bodyOf(getGraphDigest({}, ctx) as { content: { text: string }[] })
    expect(body.coverage.profile_summary).toBeUndefined()
  })
})

describe('portfolio_digest coverage_profile (#22)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-b4pd-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(
      join(cwd, '.upg', 'alpha.upg'),
      JSON.stringify(makeDoc([{ id: 'a_p', type: 'persona' as UPGEntityType, title: 'AP' } as UPGBaseNode], []), null, 2),
    )
    writeFileSync(
      join(cwd, '.upg', 'beta.upg'),
      JSON.stringify(
        { ...makeDoc([{ id: 'b_p', type: 'persona' as UPGEntityType, title: 'BP' } as UPGBaseNode], []), product: { id: 'p_beta', title: 'Beta', stage: 'concept' } },
        null,
        2,
      ),
    )
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'alpha.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('adds coverage_profile_pct to every product summary', async () => {
    const body = bodyOf(await portfolioDigest({ coverage_profile: ['understanding'] }, ctx))
    expect(body.coverage_profile).toEqual(['understanding'])
    expect(body.products.length).toBe(2)
    for (const p of body.products) {
      expect(typeof p.coverage_profile_pct).toBe('number')
    }
  })
})
