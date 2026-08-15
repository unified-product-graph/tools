/**
 * The `configuration` read parameter and the configuration diff (0.30.0).
 *
 * ZERO NEW TOOLS. The design weighed a `diff_configuration` tool against
 * reusing what exists and chose reuse: `query` already diffs against a previous
 * result id, so two calls that differ only by `configuration` ARE the
 * configuration diff. The only thing missing was edge deltas, without which the
 * diff answers "which surfaces exist differently" but not the case the field
 * report opened with, an occupant that MOVES between rows while every node
 * involved persists.
 *
 * Fixture names are invented, per the standing anonymity rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { query } from '../tools/nodes.js'
import { getTree } from '../tools/tree.js'
import { rejectUnsupportedConfiguration, CONFIGURATION_AWARE_TOOLS } from '../lib/tool-registry.js'
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
  const r = (await Promise.resolve(result)) as {
    isError?: boolean
    content: Array<{ text: string }>
  }
  const raw = r.content[0]?.text ?? ''
  // Error results are plain prose, not JSON, so the body is best-effort. The
  // refusal tests assert on `isError` and the message rather than a shape.
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  return { isError: r.isError, body, raw }
}

describe('the configuration read parameter', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-confread-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)

    // A shell holding one row under each configuration, and an occupant that
    // MOVES between them. Every node exists in both; only the edges differ.
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [
        { id: 'p_root', type: 'product', title: 'Wayfarer' },
        {
          id: 'ax_nav',
          type: 'configuration_axis',
          title: 'Navigation layout',
          properties: { values: ['legacy', 'split'], default_value: 'legacy' },
        },
        { id: 'sf_shell', type: 'surface', title: 'Shell', properties: { surface_kind: 'shell' } },
        { id: 'sf_row_one', type: 'surface', title: 'Primary row', properties: { surface_kind: 'region' } },
        { id: 'sf_row_two', type: 'surface', title: 'Secondary row', properties: { surface_kind: 'region' } },
        { id: 'sf_occupant', type: 'surface', title: 'Filter chip', properties: { surface_kind: 'slot' } },
      ],
      edges: [
        { id: 'e_ax', source: 'p_root', target: 'ax_nav', type: 'product_defines_configuration_axis' },
        { id: 'e_s1', source: 'sf_shell', target: 'sf_row_one', type: 'surface_contains_surface' },
        {
          id: 'e_s2',
          source: 'sf_shell',
          target: 'sf_row_two',
          type: 'surface_contains_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['split'] } },
        },
        // The occupant moves: row one under legacy, row two under split.
        {
          id: 'e_occ_legacy',
          source: 'sf_row_one',
          target: 'sf_occupant',
          type: 'surface_contains_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['legacy'] } },
        },
        {
          id: 'e_occ_split',
          source: 'sf_row_two',
          target: 'sf_occupant',
          type: 'surface_contains_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['split'] } },
        },
      ],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('drops a surface absent under the chosen value', async () => {
    // sf_row_two is reachable only through an edge qualified to `split`.
    const legacy = await parse(
      query({ from_id: 'sf_shell', traverse: ['surface_contains_surface'], depth: 3, configuration: { ax_nav: 'legacy' } }, ctx),
    )
    expect(legacy.raw).not.toContain('sf_row_two')

    const split = await parse(
      query({ from_id: 'sf_shell', traverse: ['surface_contains_surface'], depth: 3, configuration: { ax_nav: 'split' } }, ctx),
    )
    expect(split.raw).toContain('sf_row_two')
  })

  it('reads the union when no configuration is given', async () => {
    const union = await parse(
      query({ from_id: 'sf_shell', traverse: ['surface_contains_surface'], depth: 3 }, ctx),
    )
    expect(union.raw).toContain('sf_row_one')
    expect(union.raw).toContain('sf_row_two')
  })

  it('accepts an axis by title when it is unambiguous', async () => {
    // An agent that has just read a graph knows the axis by name. Forcing an id
    // lookup for a two-axis product is friction with no safety benefit.
    const byTitle = await parse(
      query({ from_id: 'sf_shell', traverse: ['surface_contains_surface'], depth: 3, configuration: { 'Navigation layout': 'legacy' } }, ctx),
    )
    expect(byTitle.isError).toBeFalsy()
    expect(byTitle.raw).not.toContain('sf_row_two')
  })

  it('refuses an unknown axis rather than silently returning the union', async () => {
    // The worst outcome would be a typo that reads as "no configuration": the
    // caller believes they see one member of the family and are looking at all
    // of them superposed.
    const r = await parse(query({ from_id: 'sf_shell', configuration: { ax_typo: 'legacy' } }, ctx))
    expect(r.isError).toBe(true)
    expect(r.raw).toContain('Unknown configuration axis')
  })

  it('refuses a value the axis does not declare', async () => {
    const r = await parse(query({ from_id: 'sf_shell', configuration: { ax_nav: 'beta' } }, ctx))
    expect(r.isError).toBe(true)
    expect(r.raw).toContain('does not declare the value')
  })

  it('applies to get_tree as well', async () => {
    const legacy = await parse(getTree({ pattern: 'design_system', configuration: { ax_nav: 'legacy' } }, ctx))
    expect(legacy.isError).toBeFalsy()
    const split = await parse(getTree({ pattern: 'design_system', configuration: { ax_nav: 'split' } }, ctx))
    expect(split.isError).toBeFalsy()
  })
})

describe('two queries that differ only by configuration are the diff', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-confdiff-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
    const doc = {
      upg_version: '0.30.0',
      exported_at: '2026-08-15T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes: [
        { id: 'p_root', type: 'product', title: 'Wayfarer' },
        {
          id: 'ax_nav',
          type: 'configuration_axis',
          title: 'Navigation layout',
          properties: { values: ['legacy', 'split'] },
        },
        { id: 'sf_shell', type: 'surface', title: 'Shell', properties: { surface_kind: 'shell' } },
        { id: 'sf_row_one', type: 'surface', title: 'Primary row', properties: { surface_kind: 'region' } },
        { id: 'sf_occupant', type: 'surface', title: 'Filter chip', properties: { surface_kind: 'slot' } },
      ],
      edges: [
        { id: 'e_s1', source: 'sf_shell', target: 'sf_row_one', type: 'surface_contains_surface' },
        {
          id: 'e_occ_direct',
          source: 'sf_shell',
          target: 'sf_occupant',
          type: 'surface_contains_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['split'] } },
        },
        {
          id: 'e_occ_nested',
          source: 'sf_row_one',
          target: 'sf_occupant',
          type: 'surface_contains_surface',
          properties: { active_when: { axis: 'ax_nav', values: ['legacy'] } },
        },
      ],
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('does not report edges as removed when the caller merely excluded them', async () => {
    // `edge_include: []` means "do not send me edges", not "the edges are
    // gone". Reading the empty array as a deletion reported every edge in the
    // previous result as removed: a diff inventing a deletion out of a display
    // preference.
    const first = await parse(
      query(
        {
          from_id: 'sf_shell',
          traverse: ['surface_contains_surface'],
          depth: 3,
          edge_include: ['id', 'type', 'source', 'target'],
          configuration: { ax_nav: 'legacy' },
        },
        ctx,
      ),
    )
    const resultId = first.body._result_id as string

    const second = await parse(
      query(
        {
          from_id: 'sf_shell',
          traverse: ['surface_contains_surface'],
          depth: 3,
          edge_include: [],
          configuration: { ax_nav: 'legacy' },
          diff_from: resultId,
        },
        ctx,
      ),
    )
    const diff = second.body.diff as Record<string, unknown>
    expect(diff).toBeDefined()
    expect(diff.edges_removed_count).toBeUndefined()
    expect(diff.edges_removed).toBeUndefined()
  })

  it('reports the edge that moved, which node deltas alone cannot show', async () => {
    // Every node exists in both configurations, so a node-only diff is empty
    // and says nothing happened. The whole difference lives in the edges: this
    // is the reported case where an occupant changes parent under a flag.
    const first = await parse(
      query(
        {
          from_id: 'sf_shell',
          traverse: ['surface_contains_surface'],
          depth: 3,
          edge_include: ['id', 'type', 'source', 'target'],
          configuration: { ax_nav: 'legacy' },
        },
        ctx,
      ),
    )
    const resultId = first.body._result_id as string
    expect(resultId).toBeTruthy()

    const second = await parse(
      query(
        {
          from_id: 'sf_shell',
          traverse: ['surface_contains_surface'],
          depth: 3,
          edge_include: ['id', 'type', 'source', 'target'],
          configuration: { ax_nav: 'split' },
          diff_from: resultId,
        },
        ctx,
      ),
    )

    const diff = second.body.diff as Record<string, unknown>
    expect(diff).toBeDefined()
    // No node appeared or vanished.
    expect(diff.added_count).toBe(0)
    expect(diff.removed_count).toBe(0)
    // But the containment edge moved, and the diff says so.
    expect(diff.edges_added_count).toBe(1)
    expect(diff.edges_removed_count).toBe(1)
  })
})

describe('configuration is refused where it is not implemented', () => {
  it('names the tools that do support it rather than ignoring the argument', () => {
    // A dropped argument is the worst outcome available: the caller believes
    // they are reading one member of the family while reading all of them
    // superposed. Enforced at dispatch, so it covers tools added later too.
    const err = rejectUnsupportedConfiguration('list_nodes', { configuration: { ax: 'a' } })
    expect(err).toBeDefined()
    expect(err).toContain('list_nodes')
    for (const t of CONFIGURATION_AWARE_TOOLS) expect(err).toContain(t)
  })

  it('passes the three tools that do implement it', () => {
    for (const name of CONFIGURATION_AWARE_TOOLS) {
      expect(rejectUnsupportedConfiguration(name, { configuration: { ax: 'a' } })).toBeUndefined()
    }
  })

  it('says nothing when no configuration was passed', () => {
    expect(rejectUnsupportedConfiguration('list_nodes', {})).toBeUndefined()
    expect(rejectUnsupportedConfiguration('list_nodes', { configuration: undefined })).toBeUndefined()
  })
})
