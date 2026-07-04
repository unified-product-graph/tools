/**
 * Catalog-parity gate (UPG 0.19.0 tool consolidation).
 *
 * PHASE-AWARE. Driven off `retired-tools.json`.
 *
 * - While the retired spec-introspection tools are STILL REGISTERED (Phase 1,
 *   additive), this proves — for every one of the 48 — that its output is
 *   reachable and byte-EQUAL through the faceted surface (the strongest proof,
 *   new vs old with both present).
 * - After removal (Phase 2), the retired tools are gone, so the deep-equal
 *   branch cannot run; the gate instead proves removal is COMPLETE (none of the
 *   48 remain registered) and every kind is still FUNCTIONAL through the facets
 *   (+ folds + changelog). Completeness/bijection holds in both phases.
 *
 * The byte-equal proof is captured whenever both surfaces coexist; the team's
 * invariant is "green with old present, THEN remove", so the deep-equal record
 * lives in the Phase-1 build + git history.
 */

import { describe, it, expect } from 'vitest'
import {
  loadRetiredTools,
  retiredToolNames,
  CATALOG_LIST_KINDS,
  CATALOG_GET_KINDS,
} from '@unified-product-graph/mcp-tooling'
import { getToolHandler, TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import type { ToolContext } from '../lib/server-context.js'

const contract = loadRetiredTools()
const ctx = {} as ToolContext
const REGISTERED = new Set(TOOL_DEFINITIONS.map((d) => d.name))
const RETIRED_PRESENT = REGISTERED.has('list_playbooks')

interface Called {
  isError: boolean
  text: string
  body: unknown
}

function call(name: string, args: Record<string, unknown>): Called {
  const handler = getToolHandler(name)
  if (!handler) throw new Error(`No handler registered for tool: ${name}`)
  const result = handler(args, ctx)
  if (result instanceof Promise) throw new Error(`${name} handler is async; gate expects sync spec tools`)
  const text = result.content[0].text
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { isError: result.isError === true, text, body }
}

function expectParity(oldCall: Called, newCall: Called, label: string): void {
  expect(newCall.isError, `${label}: isError flag differs`).toBe(oldCall.isError)
  expect(newCall.body, `${label}: payload differs`).toEqual(oldCall.body)
}

// A facet call "routed" to a real handler iff it is NOT the facet's own
// unknown-kind rejection. Downstream missing-arg / not-found responses (which
// vary per delegated handler) still count as routed — the kind is wired.
const routed = (c: Called): boolean => !/Unknown catalog kind/.test(c.text)

const ID_FALLBACKS = ['id', 'name', 'type', 'entity_type', 'key', 'domain_id', 'edge_type']
const GET_KIND_TO_LIST_KIND: Record<string, string> = {
  entity_meta: 'entity_types', edge_type: 'edge_types', region: 'regions',
  domain_guide: 'domains', domain_ring: 'domain_rings', framework: 'frameworks',
  lens: 'lenses', lifecycle: 'lifecycles', playbook: 'playbooks', scale: 'scales',
  anti_pattern: 'anti_patterns', tree_pattern: 'tree_patterns', type_label: 'type_labels',
  template: 'templates', approach: 'approaches',
}

function representativeIds(getKind: string, idParam: string): string[] {
  const listed = call('list_catalog', { kind: GET_KIND_TO_LIST_KIND[getKind] }).body as Record<string, unknown>
  const arr = Object.values(listed).find((v) => Array.isArray(v)) as unknown[] | undefined
  if (!arr || arr.length === 0) return []
  const fields = [idParam, ...ID_FALLBACKS]
  const ids: string[] = []
  for (const el of arr) {
    if (el && typeof el === 'object') {
      const rec = el as Record<string, unknown>
      const field = fields.find((f) => typeof rec[f] === 'string')
      if (field) ids.push(rec[field] as string)
    }
  }
  return [...new Set([ids[0], ids[ids.length - 1]].filter((x): x is string => Boolean(x)))]
}

describe('catalog-parity: completeness / bijection (both phases)', () => {
  it('contract retires exactly 48 tools (25 list + 15 get + 3 fold + 5 prompt)', () => {
    expect(Object.keys(contract.list)).toHaveLength(25)
    expect(Object.keys(contract.get)).toHaveLength(15)
    expect(Object.keys(contract.fold)).toHaveLength(3)
    expect(Object.keys(contract.prompt)).toHaveLength(5)
    expect(retiredToolNames(contract)).toHaveLength(48)
  })

  it('list kinds bijection === CATALOG_LIST_KINDS', () => {
    expect(new Set(Object.values(contract.list).map((e) => e.kind))).toEqual(new Set<string>(CATALOG_LIST_KINDS))
  })

  it('get kinds bijection === CATALOG_GET_KINDS', () => {
    expect(new Set(Object.values(contract.get).map((e) => e.kind))).toEqual(new Set<string>(CATALOG_GET_KINDS))
  })

  it('both facets are registered', () => {
    expect(REGISTERED.has('list_catalog')).toBe(true)
    expect(REGISTERED.has('get_catalog_entry')).toBe(true)
  })
})

describe(`catalog-parity: removal state (${RETIRED_PRESENT ? 'PHASE 1 additive' : 'PHASE 2 removed'})`, () => {
  if (RETIRED_PRESENT) {
    it('Phase 1: every retired list/get/fold tool is still registered', () => {
      for (const name of [...Object.keys(contract.list), ...Object.keys(contract.get), ...Object.keys(contract.fold)]) {
        expect(REGISTERED.has(name), `${name} present`).toBe(true)
      }
    })
  } else {
    it('Phase 2: NONE of the 48 retired tools remain registered', () => {
      for (const name of retiredToolNames(contract)) {
        expect(REGISTERED.has(name), `${name} must be removed`).toBe(false)
      }
    })
  }
})

describe('catalog-parity: list_catalog covers every kind', () => {
  for (const [name, entry] of Object.entries(contract.list)) {
    it(`${name} → list_catalog({ kind: '${entry.kind}' })`, () => {
      const newCall = call('list_catalog', { kind: entry.kind })
      if (RETIRED_PRESENT) expectParity(call(name, {}), newCall, name)
      else expect(routed(newCall), `${entry.kind} must route`).toBe(true)
    })
  }
})

describe('catalog-parity: filter passthrough', () => {
  it('benchmarks benchmark_kind resolves each catalog', () => {
    for (const bk of ['count', 'relationship', 'ratio', 'domain_activation']) {
      const newCall = call('list_catalog', { kind: 'benchmarks', benchmark_kind: bk })
      if (RETIRED_PRESENT) expectParity(call('list_benchmarks', { kind: bk }), newCall, `benchmarks(${bk})`)
      else expect(newCall.isError, `benchmarks(${bk})`).toBe(false)
    }
  })

  it('playbooks region filter resolves', () => {
    const newCall = call('list_catalog', { kind: 'playbooks', region: 'users_needs' })
    if (RETIRED_PRESENT) expectParity(call('list_playbooks', { region: 'users_needs' }), newCall, 'playbooks(region)')
    else expect(newCall.isError).toBe(false)
  })

  it('status_values routes with an entity_type', () => {
    const newCall = call('list_catalog', { kind: 'status_values', entity_type: 'hypothesis' })
    if (RETIRED_PRESENT) expectParity(call('list_status_values', { entity_type: 'hypothesis' }), newCall, 'status_values(entity_type)')
    else expect(newCall.isError, 'status_values(entity_type)').toBe(false)
  })
})

describe('catalog-parity: get_catalog_entry covers every kind', () => {
  for (const [name, entry] of Object.entries(contract.get)) {
    it(`${name} → get_catalog_entry({ kind: '${entry.kind}', id })`, () => {
      const ids = representativeIds(entry.kind, entry.id_param)
      expect(ids.length, `no ids for ${entry.kind}`).toBeGreaterThan(0)
      for (const id of ids) {
        const newCall = call('get_catalog_entry', { kind: entry.kind, id })
        if (RETIRED_PRESENT) expectParity(call(name, { [entry.id_param]: id }), newCall, `${name}(${id})`)
        else expect(routed(newCall), `${entry.kind}(${id}) must route`).toBe(true)
      }
      const badId = '__definitely_not_a_real_id__'
      const badNew = call('get_catalog_entry', { kind: entry.kind, id: badId })
      if (RETIRED_PRESENT) expectParity(call(name, { [entry.id_param]: badId }), badNew, `${name}(bad)`)
      else expect(routed(badNew), `${entry.kind}(bad id) must route`).toBe(true)
    })
  }
})

describe('catalog-parity: folds into get_entity_schema', () => {
  const TYPES = ['persona', 'hypothesis', 'opportunity', 'metric']

  it('valid_children fold', () => {
    for (const t of TYPES) {
      const schema = call('get_entity_schema', { type: t, include: ['valid_children'] }).body as Record<string, unknown>
      if (RETIRED_PRESENT) {
        const old = call('get_valid_children', { parent_type: t }).body as Record<string, unknown>
        expect(schema.valid_children, `valid_children ${t}`).toEqual(old.valid_children)
      } else {
        expect(Array.isArray(schema.valid_children), `valid_children ${t} present`).toBe(true)
      }
    }
  })

  it('region fold', () => {
    for (const t of TYPES) {
      const schema = call('get_entity_schema', { type: t, include: ['region'] }).body as Record<string, unknown>
      expect('region' in schema, `region fold present for ${t}`).toBe(true)
      if (RETIRED_PRESENT) {
        const oldCall = call('get_region_for_entity_type', { entity_type: t })
        if (oldCall.isError) expect(schema.region).toBeNull()
        else expect(schema.region).toEqual(oldCall.body)
      }
    }
  })

  it('resolve_edge fold', () => {
    const pairs: [string, string][] = [['persona', 'job'], ['product', 'feature'], ['persona', 'metric']]
    for (const [src, tgt] of pairs) {
      const schema = call('get_entity_schema', { type: src, resolve_edge_to: tgt }).body as Record<string, unknown>
      const re = schema.resolve_edge as Record<string, unknown>
      expect(re, `resolve_edge ${src}->${tgt}`).toBeTruthy()
      if (RETIRED_PRESENT) {
        expect(re).toEqual(call('resolve_edge_for_pair', { source_type: src, target_type: tgt }).body)
      } else {
        expect(re.source_type).toBe(src)
        expect(re.target_type).toBe(tgt)
        expect('edge_type' in re).toBe(true)
      }
    }
  })
})

describe('catalog-parity: get_spec_version changelog fold', () => {
  it('default has no changelog; changelog:true adds an array', () => {
    const base = call('get_spec_version', {}).body as Record<string, unknown>
    expect(base).not.toHaveProperty('changelog')
    const withLog = call('get_spec_version', { changelog: true }).body as Record<string, unknown>
    expect(Array.isArray(withLog.changelog)).toBe(true)
  })
})
