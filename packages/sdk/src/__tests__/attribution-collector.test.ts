/**
 * Attribution collector: the mirror side of the entity-filter contract (0.29.0).
 *
 * `collectAntiPatternInputs` writes `nodesByEntityFilter` and
 * `nodesByEdgeCountSpec`; the evaluator reads them back through the SAME key
 * functions. Nothing throws if the two sides disagree: the lookup just misses,
 * the match list reads as empty, and a violation silently loses its node ids
 * while every count stays correct. So the keys are asserted here against the
 * literal strings the spec-side tests assert, and the ids against a real store.
 *
 * Fixture names are invented, per the standing anonymity rule.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { UPGFileStore } from '../index.js'
import {
  collectAntiPatternInputs,
  isPropertyPresent,
  isStringPropertyPresent,
} from '../lib/anti-pattern-inputs.js'

const tmpFiles: string[] = []
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true })
})

type NodeSpec = Record<string, unknown>

async function loadStore(nodes: NodeSpec[], edges: NodeSpec[] = []): Promise<UPGFileStore> {
  const doc = {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.29.0',
      product: { id: 'p_test', title: 'Wayfarer' },
      counts: { nodes: nodes.length, edges: edges.length },
      provenance: {
        tool: 'vitest',
        tool_version: '0.0.0',
        exported_at: '2026-08-15T00:00:00.000Z',
      },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'Wayfarer', stage: 'growth' },
    nodes: [{ id: 'p_test', type: 'product', title: 'Wayfarer' }, ...nodes],
    edges,
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upg-attr-')), 'graph.upg')
  tmpFiles.push(file)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  return store
}

describe('presence predicates are two named contracts, not one fuzzy rule', () => {
  it('the broad predicate counts zero and false as present', () => {
    // The per-node reading. `capacity: 0` is a reserved place and
    // `mutates_content: false` is a real answer; reading either as an omission
    // would misjudge the very surfaces the numeric check form exists for.
    expect(isPropertyPresent(0)).toBe(true)
    expect(isPropertyPresent(false)).toBe(true)
    expect(isPropertyPresent('rule text')).toBe(true)
    expect(isPropertyPresent(undefined)).toBe(false)
    expect(isPropertyPresent(null)).toBe(false)
    expect(isPropertyPresent('')).toBe(false)
  })

  it('the string predicate does not, because it must agree with a string-only index', () => {
    // Narrower BY CONSTRUCTION. The aggregate presence indexes hold string
    // values only, so an attribution predicate that must line up with the count
    // that fired a violation has to apply the same restriction. If these two
    // ever agreed on 0 and false, one of them would be wrong.
    expect(isStringPropertyPresent(0)).toBe(false)
    expect(isStringPropertyPresent(false)).toBe(false)
    expect(isStringPropertyPresent('rule text')).toBe(true)
    expect(isStringPropertyPresent('')).toBe(false)
  })
})

describe('nodesByEntityFilter: the four live catalog filters', () => {
  it('attributes the status form', async () => {
    const store = await loadStore([
      { id: 'h_1', type: 'hypothesis', title: 'H1', status: 'drafted' },
      { id: 'h_2', type: 'hypothesis', title: 'H2', status: 'drafted' },
      { id: 'h_3', type: 'hypothesis', title: 'H3', status: 'validated' },
    ])
    const inputs = collectAntiPatternInputs(store)
    expect(inputs.nodesByEntityFilter?.['hypothesis|status=drafted']).toEqual(['h_1', 'h_2'])
  })

  it('attributes the value form', async () => {
    const store = await loadStore([
      { id: 'm_1', type: 'metric', title: 'Weekly actives', properties: { designation: 'north_star' } },
      { id: 'm_2', type: 'metric', title: 'Signups', properties: { designation: 'input' } },
      { id: 'm_3', type: 'metric', title: 'Unlabelled' },
    ])
    const inputs = collectAntiPatternInputs(store)
    expect(inputs.nodesByEntityFilter?.['metric|designation=north_star']).toEqual(['m_1'])
  })

  it('attributes both arbitration_state admissions separately', async () => {
    const store = await loadStore([
      { id: 'sf_1', type: 'surface', title: 'A', properties: { arbitration_state: 'none' } },
      { id: 'sf_2', type: 'surface', title: 'B', properties: { arbitration_state: 'safe_by_coincidence' } },
      { id: 'sf_3', type: 'surface', title: 'C', properties: { arbitration_state: 'enforced_documented' } },
    ])
    const inputs = collectAntiPatternInputs(store)
    expect(inputs.nodesByEntityFilter?.['surface|arbitration_state=none']).toEqual(['sf_1'])
    expect(inputs.nodesByEntityFilter?.['surface|arbitration_state=safe_by_coincidence']).toEqual([
      'sf_2',
    ])
  })

  it('seeds every declared filter, so an honest zero is an empty array and never a missing key', () => {
    // A missing key is indistinguishable from a stale collector. Seeding is
    // what lets a reader tell "nothing matched" from "nothing was computed".
    return loadStore([]).then((store) => {
      const inputs = collectAntiPatternInputs(store)
      for (const key of [
        'hypothesis|status=drafted',
        'metric|designation=north_star',
        'surface|arbitration_state=none',
        'surface|arbitration_state=safe_by_coincidence',
      ]) {
        expect(inputs.nodesByEntityFilter?.[key], `${key} must be seeded`).toEqual([])
      }
    })
  })
})

describe('nodesByEdgeCountSpec: occupancy against capacity, on a real store', () => {
  const SPEC_KEY =
    'surface|feature_occupies_surface|inbound|capacity|1|gt|arbitration_rule=absent|composition_mode=chained'

  async function surfaceStore() {
    return loadStore(
      [
        // Over capacity, no rule: contended.
        { id: 'sf_panel', type: 'surface', title: 'Detail panel', properties: { capacity: 1 } },
        // Unbounded with several occupants: contended (absent capacity reads as 1).
        { id: 'sf_banner', type: 'surface', title: 'Banner stack' },
        // At capacity: partitioned, not contended.
        { id: 'sf_header', type: 'surface', title: 'Field header', properties: { capacity: 4 } },
        // Over capacity but documented: the clean exit.
        {
          id: 'sf_inspector',
          type: 'surface',
          title: 'Inspector',
          properties: { capacity: 1, arbitration_rule: 'Most recent wins' },
        },
        // Over capacity but chained: exempt.
        {
          id: 'sf_slot',
          type: 'surface',
          title: 'Decoration slot',
          properties: { composition_mode: 'chained' },
        },
        ...Array.from({ length: 12 }, (_, n) => ({
          id: `feat_${n}`,
          type: 'feature',
          title: `Feature ${n}`,
        })),
      ],
      [
        // 3 occupants on the capacity-1 panel
        ...[0, 1, 2].map((n) => ({ id: `e_p${n}`, source: `feat_${n}`, target: 'sf_panel', type: 'feature_occupies_surface' })),
        // 2 on the unbounded banner
        ...[3, 4].map((n) => ({ id: `e_b${n}`, source: `feat_${n}`, target: 'sf_banner', type: 'feature_occupies_surface' })),
        // 4 on the capacity-4 header
        ...[5, 6, 7, 8].map((n) => ({ id: `e_h${n}`, source: `feat_${n}`, target: 'sf_header', type: 'feature_occupies_surface' })),
        // 2 on the documented inspector
        ...[9, 10].map((n) => ({ id: `e_i${n}`, source: `feat_${n}`, target: 'sf_inspector', type: 'feature_occupies_surface' })),
        // 2 on the chained slot
        ...[0, 11].map((n) => ({ id: `e_s${n}`, source: `feat_${n}`, target: 'sf_slot', type: 'feature_occupies_surface' })),
      ],
    )
  }

  it('names exactly the contended surfaces', async () => {
    const store = await surfaceStore()
    const inputs = collectAntiPatternInputs(store)
    // Sorted on both sides deliberately: this layer emits document order, and
    // ordering is not part of its contract. The evaluator sorts when it builds
    // `target_node_ids`, which is where a stable public order is owed.
    expect([...(inputs.nodesByEdgeCountSpec?.[SPEC_KEY] ?? [])].sort()).toEqual([
      'sf_banner',
      'sf_panel',
    ])
  })

  it('excludes the at-capacity surface, the documented one, and the chained one for three different reasons', async () => {
    const store = await surfaceStore()
    const matched = collectAntiPatternInputs(store).nodesByEdgeCountSpec?.[SPEC_KEY] ?? []
    expect(matched, 'at capacity: partitioned, not contended').not.toContain('sf_header')
    expect(matched, 'carries a rule: the question is answered').not.toContain('sf_inspector')
    expect(matched, 'chained: occupants wrap rather than compete').not.toContain('sf_slot')
  })

  it('treats capacity 0 as a real cap rather than an absent one', async () => {
    // The broad presence predicate and the numeric read have to agree that a
    // declared zero is a value. A reserved surface holding one occupant is over
    // its stated capacity of nothing.
    const store = await loadStore(
      [
        { id: 'sf_reserved', type: 'surface', title: 'Reserved', properties: { capacity: 0 } },
        { id: 'feat_x', type: 'feature', title: 'X' },
      ],
      [{ id: 'e_x', source: 'feat_x', target: 'sf_reserved', type: 'feature_occupies_surface' }],
    )
    const inputs = collectAntiPatternInputs(store)
    expect(inputs.nodesByEdgeCountSpec?.[SPEC_KEY]).toEqual(['sf_reserved'])
  })
})
