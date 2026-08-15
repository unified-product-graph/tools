/**
 * Capacity-aware contention + node-level attribution (0.29.0, feedback af9ae4c2).
 *
 * The end-to-end acceptance fixture for the release: a real store, real
 * surfaces carrying real capacities, driven through `validate_graph` and
 * `get_anti_pattern_violations_for`. The spec-package tests pin the same rules
 * against synthetic `AntiPatternInputs`; these prove the whole path, including
 * the collector arithmetic that turns nodes and edges into those inputs.
 *
 * Two things are being proved:
 *
 *  1. A surface whose occupancy is at or below its stated `capacity` is
 *     PARTITIONED, not contended, and no longer fires. Three of the reporter's
 *     ten flagged surfaces were this, and all three were wrong.
 *  2. A violation names the offending nodes, so a correctly-modelled surface
 *     stops answering for its neighbours. Before this, attribution was
 *     type-keyed: fourteen correctly-declared chained slots kept an entire
 *     surface roster lit, and no amount of correct modelling could clear it.
 *
 * Fixture names are invented (a fictional project-tracking product). The
 * reported case is real; the product behind it is not named anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { validateGraph, getAntiPatternViolationsFor } from '../tools/validation.js'
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
  return JSON.parse(r.content[0]?.text ?? '{}')
}

type Vio = {
  anti_pattern_id: string
  target_entities: string[]
  target_node_ids?: string[]
}

const CONTENTION = 'contended-surface-without-arbitration'

type SurfaceSpec = {
  id: string
  title: string
  occupants: number
  capacity?: number
  arbitration_rule?: string
  composition_mode?: string
}

describe('capacity-aware contention and node attribution (0.29.0)', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-contention-'))
    mkdirSync(join(cwd, '.upg'))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function loadGraph(surfaces: SurfaceSpec[]): Promise<UPGFileStore> {
    const nodes: Array<Record<string, unknown>> = [
      { id: 'p_root', type: 'product', title: 'Wayfarer', stage: 'growth' },
    ]
    const edges: Array<Record<string, unknown>> = []
    let featureSeq = 0

    for (const s of surfaces) {
      const properties: Record<string, unknown> = { surface_kind: 'region' }
      if (s.capacity !== undefined) properties.capacity = s.capacity
      if (s.arbitration_rule !== undefined) properties.arbitration_rule = s.arbitration_rule
      if (s.composition_mode !== undefined) properties.composition_mode = s.composition_mode
      nodes.push({ id: s.id, type: 'surface', title: s.title, properties })

      for (let n = 0; n < s.occupants; n++) {
        const fid = `feat_${featureSeq++}`
        nodes.push({ id: fid, type: 'feature', title: `Feature ${fid}` })
        edges.push({
          id: `e_${fid}_${s.id}`,
          source: fid,
          target: s.id,
          type: 'feature_occupies_surface',
        })
      }
    }

    const doc = {
      upg_version: '0.29.0',
      exported_at: '2026-08-14T00:00:00Z',
      source: { tool: 'test' },
      product: { id: 'p_root', title: 'Wayfarer', stage: 'growth' },
      nodes,
      edges,
    }
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
    return store
  }

  async function contention(store: UPGFileStore): Promise<Vio | undefined> {
    const res = await parse(validateGraph({ skip_drift: true }, makeCtx(store)))
    return (res.anti_pattern_violations as Vio[] | undefined)?.find(
      (v) => v.anti_pattern_id === CONTENTION,
    )
  }

  // ── the three reported false positives ────────────────────────────────────
  it('clears a surface holding exactly its stated capacity', async () => {
    // The field header row: capacity 4, four occupants positioned side by side
    // by runtime width measurement. All four fit, by design. Before 0.29.0 this
    // fired purely for having more than one occupant and no rule.
    const store = await loadGraph([
      { id: 'sf_field_header', title: 'Field header row', occupants: 4, capacity: 4 },
    ])
    expect(await contention(store)).toBeUndefined()
  })

  it('clears a surface holding fewer occupants than its capacity', async () => {
    // The rich-text toolbar: capacity 4, two occupants. Half empty.
    const store = await loadGraph([
      { id: 'sf_toolbar', title: 'Editor toolbar', occupants: 2, capacity: 4 },
    ])
    expect(await contention(store)).toBeUndefined()
  })

  // ── the true positives, which must all survive ────────────────────────────
  it('fires on a capacity-1 slot holding three occupants', async () => {
    // The case the entity was proposed for: opening one silently evicts
    // whatever was open, and nothing records which one wins.
    const store = await loadGraph([
      { id: 'sf_detail_panel', title: 'Detail panel', occupants: 3, capacity: 1 },
    ])
    const v = await contention(store)
    expect(v).toBeDefined()
    expect(v?.target_node_ids).toEqual(['sf_detail_panel'])
  })

  it('fires on an unbounded surface with several occupants: absent capacity is not an exemption', async () => {
    // Absence means unbounded, and the tempting reading is "no limit, so never
    // flag". The opposite holds: a surface that states no limit has stated no
    // answer. Four of the reporter's seven true positives were unbounded.
    const store = await loadGraph([
      { id: 'sf_banner_stack', title: 'Banner stack', occupants: 7 },
    ])
    const v = await contention(store)
    expect(v).toBeDefined()
    expect(v?.target_node_ids).toEqual(['sf_banner_stack'])
  })

  it('does not fire on an unbounded surface with a single occupant', async () => {
    // One occupant cannot be contended with anything. The absent-capacity
    // default of 1 has to leave this alone or it would flag every slot.
    const store = await loadGraph([
      { id: 'sf_status_line', title: 'Status line', occupants: 1 },
    ])
    expect(await contention(store)).toBeUndefined()
  })

  // ── the mixed graph: the reported shape in miniature ──────────────────────
  it('names only the contended surfaces in a graph that mixes both', async () => {
    const store = await loadGraph([
      // Contended: over capacity, or unbounded with several occupants.
      { id: 'sf_detail_panel', title: 'Detail panel', occupants: 3, capacity: 1 },
      { id: 'sf_banner_stack', title: 'Banner stack', occupants: 7 },
      // Partitioned: everyone fits.
      { id: 'sf_field_header', title: 'Field header row', occupants: 4, capacity: 4 },
      { id: 'sf_toolbar', title: 'Editor toolbar', occupants: 2, capacity: 4 },
      { id: 'sf_navbar_row', title: 'Navbar row', occupants: 2, capacity: 3 },
      // Documented: a real rule, which was always the clean exit.
      {
        id: 'sf_inspector',
        title: 'Inspector',
        occupants: 3,
        capacity: 1,
        arbitration_rule: 'Most recently selected node wins; a pinned inspector outranks selection.',
      },
      // Chained: occupants wrap one another, exempt since 0.28.0.
      { id: 'sf_middleware_slot', title: 'Row decoration slot', occupants: 5, composition_mode: 'chained' },
    ])

    const v = await contention(store)
    expect(v).toBeDefined()
    expect(v?.target_node_ids).toEqual(['sf_banner_stack', 'sf_detail_panel'])
  })

  // ── attribution: the half that made correct modelling unrewarding ─────────
  it('a correctly modelled surface no longer answers for its neighbours', async () => {
    const store = await loadGraph([
      { id: 'sf_detail_panel', title: 'Detail panel', occupants: 3, capacity: 1 },
      { id: 'sf_field_header', title: 'Field header row', occupants: 4, capacity: 4 },
      { id: 'sf_middleware_slot', title: 'Row decoration slot', occupants: 5, composition_mode: 'chained' },
    ])

    // The offender is named, and says so.
    const offender = await parse(
      getAntiPatternViolationsFor({ entity_id: 'sf_detail_panel' }, makeCtx(store)),
    )
    const offenderHit = (offender.violations as Array<{ anti_pattern_id: string; matched_by: string }>)
      .find((x) => x.anti_pattern_id === CONTENTION)
    expect(offenderHit).toBeDefined()
    expect(offenderHit?.matched_by).toBe('id')

    // The partitioned surface and the chained slot are NOT implicated, which is
    // the whole point: under type-keyed attribution both came back lit purely
    // for being surfaces in a graph that had a contended one somewhere.
    for (const clean of ['sf_field_header', 'sf_middleware_slot']) {
      const res = await parse(getAntiPatternViolationsFor({ entity_id: clean }, makeCtx(store)))
      const ids = (res.violations as Array<{ anti_pattern_id: string }>).map((x) => x.anti_pattern_id)
      expect(ids, `${clean} must not be implicated`).not.toContain(CONTENTION)
    }
  })

  it('a FEATURE occupying a contended surface still resolves the violation', async () => {
    // The reachability half of the contract, and the regression a naive
    // id-only match introduces. Contention attribution can only ever name
    // SURFACES, but `feature` is in target_entities because the condition
    // references it, so a feature matched before ids existed. Ids must add
    // precision for the types they cover and change nothing for the types they
    // do not: no entity may become unreachable because some OTHER type got
    // named precisely.
    const store = await loadGraph([
      { id: 'sf_detail_panel', title: 'Detail panel', occupants: 3, capacity: 1 },
    ])
    // feat_0 is one of the three occupants minted for that surface.
    const res = await parse(getAntiPatternViolationsFor({ entity_id: 'feat_0' }, makeCtx(store)))
    const hit = (res.violations as Array<{ anti_pattern_id: string; matched_by: string }>)
      .find((x) => x.anti_pattern_id === CONTENTION)
    expect(hit, 'a feature occupying a contended surface must stay reachable').toBeDefined()
    // It matched through the type half, which is the honest label: the detector
    // never claimed anything about this feature specifically.
    expect(hit?.matched_by).toBe('type')
  })

  it('type-matched violations still resolve, and label themselves as approximations', async () => {
    // Attribution is not universal and must not pretend to be. `surface-without-job`
    // is an aggregate detector: it knows the graph has no surface_serves_job edge
    // anywhere, not which surface is at fault. It must still match, and must say
    // it matched by type so a caller can weigh it accordingly.
    const store = await loadGraph([
      { id: 'sf_field_header', title: 'Field header row', occupants: 4, capacity: 4 },
    ])
    const res = await parse(
      getAntiPatternViolationsFor({ entity_id: 'sf_field_header' }, makeCtx(store)),
    )
    const byType = (res.violations as Array<{ anti_pattern_id: string; matched_by: string }>)
      .find((x) => x.anti_pattern_id === 'surface-without-job')
    expect(byType).toBeDefined()
    expect(byType?.matched_by).toBe('type')
  })
})
