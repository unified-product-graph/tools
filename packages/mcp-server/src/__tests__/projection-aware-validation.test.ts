/**
 * Per-projection anti-pattern evaluation and configuration drift (0.30.0, D4).
 *
 * The acceptance case for the release, and the reason projection-aware
 * validation was made mandatory rather than optional: in the UNION, two
 * alternatives both carry their occupancy edges, so a place that renders three
 * occupants in either configuration looks like it holds six. A contention check
 * reading that sees a graph no configuration produces, which is precisely the
 * false-positive class 0.29.0 spent a release removing.
 *
 * Fixture names are invented, per the standing anonymity rule.
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
  const r = (await Promise.resolve(result)) as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0]?.text ?? '{}')
}

const CONTENTION = 'contended-surface-without-arbitration'

describe('projection-aware validation (0.30.0)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-projection-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function load(nodes: unknown[], edges: unknown[]): Promise<UPGFileStore> {
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [{ id: 'p_root', type: 'product', title: 'Wayfarer' }, ...nodes],
      edges,
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    return store
  }

  /**
   * The alternation case. Two surfaces alternate on one axis; each holds three
   * occupants and each declares capacity 3, so NEITHER is contended in the
   * configuration it exists in. In the union both sets of occupancy edges are
   * present, and a check that cannot project sees a place over its capacity.
   */
  async function alternationGraph() {
    const occupants = Array.from({ length: 6 }, (_, n) => ({
      id: `feat_${n}`,
      type: 'feature',
      title: `Feature ${n}`,
    }))
    return load(
      [
        {
          id: 'ax_nav',
          type: 'configuration_axis',
          title: 'Navigation layout',
          properties: { values: ['legacy', 'split'], default_value: 'legacy', kind: 'feature_flag' },
        },
        { id: 'sf_shell', type: 'surface', title: 'Shell', properties: { surface_kind: 'shell' } },
        {
          id: 'sf_chips',
          type: 'surface',
          title: 'Named chips',
          properties: { surface_kind: 'region', capacity: 3 },
        },
        {
          id: 'sf_badge',
          type: 'surface',
          title: 'Summary badge',
          properties: { surface_kind: 'region', capacity: 3 },
        },
        ...occupants,
      ],
      [
        { id: 'e_ax', source: 'p_root', target: 'ax_nav', type: 'product_defines_configuration_axis' },
        {
          id: 'e_v1',
          source: 'sf_chips',
          target: 'ax_nav',
          type: 'surface_varies_by_configuration_axis',
          properties: { present_under: ['legacy'] },
        },
        {
          id: 'e_v2',
          source: 'sf_badge',
          target: 'ax_nav',
          type: 'surface_varies_by_configuration_axis',
          properties: { present_under: ['split'] },
        },
        { id: 'e_alt', source: 'sf_chips', target: 'sf_badge', type: 'surface_alternates_with_surface' },
        { id: 'e_p1', source: 'sf_shell', target: 'sf_chips', type: 'surface_contains_surface' },
        { id: 'e_p2', source: 'sf_shell', target: 'sf_badge', type: 'surface_contains_surface' },
        // Three occupants each: within capacity in the configuration each lives in.
        ...[0, 1, 2].map((n) => ({
          id: `e_o${n}`,
          source: `feat_${n}`,
          target: 'sf_chips',
          type: 'feature_occupies_surface',
        })),
        ...[3, 4, 5].map((n) => ({
          id: `e_o${n}`,
          source: `feat_${n}`,
          target: 'sf_badge',
          type: 'feature_occupies_surface',
        })),
      ],
    )
  }

  /**
   * The superposition case, and the one that actually motivates D4.
   *
   * ONE slot with capacity 1, occupied by a different feature under each value.
   * In every configuration it holds exactly one occupant and is perfectly well
   * behaved. In the UNION both occupancy edges are present, so it reads as two
   * occupants in a capacity-1 place: a contention that no configuration
   * produces.
   *
   * Worth recording how this fixture was arrived at: the first version of it
   * used two ALTERNATING surfaces with three occupants each, which does not
   * double-count at all, because occupancy is per-surface and neither surface
   * inherits the other's edges. The suppression test failed and was right to.
   * Superposition needs the qualified edges to land on the SAME node.
   */
  async function superpositionGraph() {
    return load(
      [
        {
          id: 'ax_nav',
          type: 'configuration_axis',
          title: 'Navigation layout',
          properties: { values: ['legacy', 'split'], default_value: 'legacy', kind: 'feature_flag' },
        },
        {
          id: 'sf_slot',
          type: 'surface',
          title: 'Primary action slot',
          properties: { surface_kind: 'slot', capacity: 1 },
        },
        { id: 'feat_old', type: 'feature', title: 'Legacy action' },
        { id: 'feat_new', type: 'feature', title: 'Split action' },
      ],
      [
        { id: 'e_ax', source: 'p_root', target: 'ax_nav', type: 'product_defines_configuration_axis' },
        {
          id: 'e_o_old',
          source: 'feat_old',
          target: 'sf_slot',
          type: 'feature_occupies_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['legacy'] } },
        },
        {
          id: 'e_o_new',
          source: 'feat_new',
          target: 'sf_slot',
          type: 'feature_occupies_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['split'] } },
        },
      ],
    )
  }

  it('does not report contention that no configuration actually produces', async () => {
    // The slot holds exactly one occupant in each configuration. Reading the
    // union alone it holds two in a capacity-1 place, which is the false
    // positive this release exists to keep from coming back.
    const store = await superpositionGraph()
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    const ids = (res.anti_pattern_violations ?? []).map(
      (v: { anti_pattern_id: string }) => v.anti_pattern_id,
    )
    expect(ids).not.toContain(CONTENTION)
  })

  it('still reports contention that a real configuration does produce', async () => {
    // Same shape, but the chips surface genuinely holds more than it declares.
    // Projection must not become a way for real findings to disappear.
    const store = await alternationGraph()
    await store.updateNode('sf_chips', { properties: { surface_kind: 'region', capacity: 1 } })
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    const hit = (res.anti_pattern_violations ?? []).find(
      (v: { anti_pattern_id: string }) => v.anti_pattern_id === CONTENTION,
    )
    expect(hit).toBeDefined()
    expect(hit.target_node_ids).toEqual(['sf_chips'])
    // It holds in one configuration, not both, so it reports qualified.
    expect(hit.configurations).toEqual([{ axis: 'ax_nav', value: 'legacy' }])
  })

  it('a graph declaring no axes behaves exactly as before', async () => {
    // The declare-to-earn posture: projection-aware validation costs nothing
    // until someone declares an axis, and never annotates a finding that holds
    // everywhere.
    const store = await load(
      [
        {
          id: 'sf_panel',
          type: 'surface',
          title: 'Detail panel',
          properties: { surface_kind: 'pane', capacity: 1 },
        },
        { id: 'feat_a', type: 'feature', title: 'A' },
        { id: 'feat_b', type: 'feature', title: 'B' },
      ],
      [
        { id: 'e1', source: 'feat_a', target: 'sf_panel', type: 'feature_occupies_surface' },
        { id: 'e2', source: 'feat_b', target: 'sf_panel', type: 'feature_occupies_surface' },
      ],
    )
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    const hit = (res.anti_pattern_violations ?? []).find(
      (v: { anti_pattern_id: string }) => v.anti_pattern_id === CONTENTION,
    )
    expect(hit).toBeDefined()
    expect(hit.configurations).toBeUndefined()
    expect(res.suppressed_union_artifacts).toBeUndefined()
  })

  it('counts what it suppressed rather than hiding it', async () => {
    // The union-only contention finding is suppressed, and the count says so.
    // Suppressing silently would trade one invisible bug for another.
    const store = await superpositionGraph()
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    expect(res.suppressed_union_artifacts).toBeGreaterThan(0)
  })
})

describe('configuration_drift through validate_graph', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-confdrift-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('reports a present_under value the axis does not declare', async () => {
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [
        { id: 'p_root', type: 'product', title: 'Wayfarer' },
        {
          id: 'ax',
          type: 'configuration_axis',
          title: 'Nav',
          properties: { values: ['legacy', 'split'] },
        },
        { id: 'sf', type: 'surface', title: 'Row', properties: { surface_kind: 'region' } },
      ],
      edges: [
        {
          id: 'e_v',
          source: 'sf',
          target: 'ax',
          type: 'surface_varies_by_configuration_axis',
          properties: { present_under: ['beta'] },
        },
      ],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()

    const res = await parse(
      validateGraph({ scope: 'configuration_drift', skip_anti_patterns: true }, makeCtx(store)),
    )
    const kinds = (res.configuration_drift ?? []).map((d: { kind: string }) => d.kind)
    expect(kinds).toContain('present_under_unknown_value')
  })

  it('emits an EMPTY array for a graph with no configuration, never an absent one', async () => {
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [{ id: 'p_root', type: 'product', title: 'Wayfarer' }],
      edges: [],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()

    const res = await parse(
      validateGraph({ scope: 'configuration_drift', skip_anti_patterns: true }, makeCtx(store)),
    )
    // Present and empty, like every sibling drift class. An array that appears
    // only when something is wrong makes "no configuration drift" and "this
    // server does not check for it" indistinguishable to a consumer.
    expect(res.configuration_drift).toEqual([])
    expect(res.summary.configuration_drift).toBe(0)
  })
})

describe('review regressions (0.30.0 verdict)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-regress-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function load(nodes: unknown[], edges: unknown[]): Promise<UPGFileStore> {
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [{ id: 'p_root', type: 'product', title: 'Wayfarer' }, ...nodes],
      edges,
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    return store
  }

  it('reports a finding that fires in a projection but NOT in the union', async () => {
    // The non-monotone case. `surface-without-job` fires when surfaces exist and
    // NO surface_serves_job edge does. The only such edge rides a surface that
    // exists solely under one value, so under the other value the edge is gone
    // and the pattern is true. In the union the edge is present and it is false.
    //
    // A reported set built by FILTERING the union can only ever remove, so this
    // finding was invisible: eleven `not_exists` patterns in the catalog are
    // non-monotone in exactly this way.
    const store = await load(
      [
        {
          id: 'ax',
          type: 'configuration_axis',
          title: 'Nav',
          properties: { values: ['a', 'b'] },
        },
        { id: 'sf_always', type: 'surface', title: 'Shell', properties: { surface_kind: 'shell' } },
        { id: 'sf_a_only', type: 'surface', title: 'A-only pane', properties: { surface_kind: 'pane' } },
        { id: 'job_1', type: 'job', title: 'Find a page again' },
      ],
      [
        { id: 'e_ax', source: 'p_root', target: 'ax', type: 'product_defines_configuration_axis' },
        {
          id: 'e_var',
          source: 'sf_a_only',
          target: 'ax',
          type: 'surface_varies_by_configuration_axis',
          properties: { present_under: ['a'] },
        },
        { id: 'e_job', source: 'sf_a_only', target: 'job_1', type: 'surface_serves_job' },
      ],
    )
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    const hit = (res.anti_pattern_violations ?? []).find(
      (v: { anti_pattern_id: string }) => v.anti_pattern_id === 'surface-without-job',
    )
    expect(hit, 'a projection-only finding must be reported, not dropped').toBeDefined()
    // It holds under b and not under a, so it reports qualified.
    expect(hit.configurations).toEqual([{ axis: 'ax', value: 'b' }])
  })

  it('gates valid on configuration_drift errors', async () => {
    // A graph whose own drift message says a projection cannot be trusted must
    // not return valid:true to a CI gate.
    const store = await load(
      [
        { id: 'ax', type: 'configuration_axis', title: 'Nav', properties: { values: ['a', 'b'] } },
        { id: 'sf', type: 'surface', title: 'Row', properties: { surface_kind: 'region' } },
      ],
      [
        {
          id: 'e_var',
          source: 'sf',
          target: 'ax',
          type: 'surface_varies_by_configuration_axis',
          properties: { present_under: ['nonexistent'] },
        },
      ],
    )
    const res = await parse(validateGraph({ skip_anti_patterns: true }, makeCtx(store)))
    expect(res.summary.configuration_drift).toBeGreaterThan(0)
    expect(res.valid).toBe(false)
    expect(res.structurally_valid).toBe(false)
  })

  it('refuses a configuration that cannot take effect', async () => {
    const store = await load(
      [{ id: 'ax', type: 'configuration_axis', title: 'Nav', properties: { values: ['a', 'b'] } }],
      [],
    )
    const r = (await Promise.resolve(
      validateGraph({ configuration: { ax: 'a' }, skip_anti_patterns: true }, makeCtx(store)),
    )) as { isError?: boolean; content: Array<{ text: string }> }
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('skip_anti_patterns')
  })

  it('echoes the configuration it applied', async () => {
    const store = await load(
      [
        { id: 'ax', type: 'configuration_axis', title: 'Nav', properties: { values: ['a', 'b'] } },
        { id: 'sf', type: 'surface', title: 'Row', properties: { surface_kind: 'region' } },
      ],
      [],
    )
    const res = await parse(validateGraph({ configuration: { ax: 'a' }, skip_drift: true }, makeCtx(store)))
    expect(res.applied_configuration).toEqual({ ax: 'a' })
  })
})
