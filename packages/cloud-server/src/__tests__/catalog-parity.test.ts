/**
 * Catalog-parity gate (UPG 0.19.0 tool consolidation) — CLOUD mirror.
 * PHASE-AWARE, async. See the local test for the full rationale.
 */

import { describe, it, expect } from 'vitest'
import {
  loadRetiredTools,
  retiredToolNames,
  CATALOG_LIST_KINDS,
  CATALOG_GET_KINDS,
} from '@unified-product-graph/mcp-tooling'
import { getToolHandler, TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import type { CloudContext } from '../lib/server-context.js'

const contract = loadRetiredTools()
const ctx = {} as CloudContext
const REGISTERED = new Set(TOOL_DEFINITIONS.map((d) => d.name))
const RETIRED_PRESENT = REGISTERED.has('list_playbooks')

interface Called {
  isError: boolean
  text: string
  body: unknown
}

async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const handler = getToolHandler(name)
  if (!handler) throw new Error(`No handler registered for tool: ${name}`)
  const result = await handler(args, ctx)
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

const routed = (c: Called): boolean => !/Unknown catalog kind/.test(c.text)

const ID_FALLBACKS = ['id', 'name', 'type', 'entity_type', 'key', 'domain_id', 'edge_type']
const GET_KIND_TO_LIST_KIND: Record<string, string> = {
  entity_meta: 'entity_types', edge_type: 'edge_types', region: 'regions',
  domain_guide: 'domains', domain_ring: 'domain_rings', framework: 'frameworks',
  lens: 'lenses', lifecycle: 'lifecycles', playbook: 'playbooks', scale: 'scales',
  anti_pattern: 'anti_patterns', tree_pattern: 'tree_patterns', type_label: 'type_labels',
  template: 'templates', approach: 'approaches',
}

async function representativeIds(getKind: string, idParam: string): Promise<string[]> {
  const listed = (await call('list_catalog', { kind: GET_KIND_TO_LIST_KIND[getKind] })).body as Record<string, unknown>
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

describe('catalog-parity (cloud): completeness / bijection', () => {
  it('retires exactly 48 tools', () => {
    expect(retiredToolNames(contract)).toHaveLength(48)
  })
  it('list kinds bijection === CATALOG_LIST_KINDS', () => {
    expect(new Set(Object.values(contract.list).map((e) => e.kind))).toEqual(new Set<string>(CATALOG_LIST_KINDS))
  })
  it('get kinds bijection === CATALOG_GET_KINDS', () => {
    expect(new Set(Object.values(contract.get).map((e) => e.kind))).toEqual(new Set<string>(CATALOG_GET_KINDS))
  })
  it('both facets registered', () => {
    expect(REGISTERED.has('list_catalog')).toBe(true)
    expect(REGISTERED.has('get_catalog_entry')).toBe(true)
  })
})

describe(`catalog-parity (cloud): removal state (${RETIRED_PRESENT ? 'PHASE 1' : 'PHASE 2'})`, () => {
  if (RETIRED_PRESENT) {
    it('Phase 1: retired list/get/fold tools still registered', () => {
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

describe('catalog-parity (cloud): list_catalog covers every kind', () => {
  for (const [name, entry] of Object.entries(contract.list)) {
    it(`${name} → list_catalog({ kind: '${entry.kind}' })`, async () => {
      const newCall = await call('list_catalog', { kind: entry.kind })
      if (RETIRED_PRESENT) expectParity(await call(name, {}), newCall, name)
      else expect(routed(newCall), `${entry.kind} must route`).toBe(true)
    })
  }
})

describe('catalog-parity (cloud): filter passthrough', () => {
  it('benchmarks benchmark_kind resolves each catalog', async () => {
    for (const bk of ['count', 'relationship', 'ratio', 'domain_activation']) {
      const newCall = await call('list_catalog', { kind: 'benchmarks', benchmark_kind: bk })
      if (RETIRED_PRESENT) expectParity(await call('list_benchmarks', { kind: bk }), newCall, `benchmarks(${bk})`)
      else expect(newCall.isError, `benchmarks(${bk})`).toBe(false)
    }
  })
  it('playbooks region filter resolves', async () => {
    const newCall = await call('list_catalog', { kind: 'playbooks', region: 'users_needs' })
    if (RETIRED_PRESENT) expectParity(await call('list_playbooks', { region: 'users_needs' }), newCall, 'playbooks(region)')
    else expect(newCall.isError).toBe(false)
  })
})

describe('catalog-parity (cloud): get_catalog_entry covers every kind', () => {
  for (const [name, entry] of Object.entries(contract.get)) {
    it(`${name} → get_catalog_entry({ kind: '${entry.kind}', id })`, async () => {
      const ids = await representativeIds(entry.kind, entry.id_param)
      expect(ids.length, `no ids for ${entry.kind}`).toBeGreaterThan(0)
      for (const id of ids) {
        const newCall = await call('get_catalog_entry', { kind: entry.kind, id })
        if (RETIRED_PRESENT) expectParity(await call(name, { [entry.id_param]: id }), newCall, `${name}(${id})`)
        else expect(routed(newCall), `${entry.kind}(${id}) must route`).toBe(true)
      }
      const badId = '__definitely_not_a_real_id__'
      const badNew = await call('get_catalog_entry', { kind: entry.kind, id: badId })
      if (RETIRED_PRESENT) expectParity(await call(name, { [entry.id_param]: badId }), badNew, `${name}(bad)`)
      else expect(routed(badNew), `${entry.kind}(bad id) must route`).toBe(true)
    })
  }
})

describe('catalog-parity (cloud): folds into get_entity_schema', () => {
  const TYPES = ['persona', 'hypothesis', 'opportunity', 'metric']

  it('valid_children fold', async () => {
    for (const t of TYPES) {
      const schema = (await call('get_entity_schema', { type: t, include: ['valid_children'] })).body as Record<string, unknown>
      if (RETIRED_PRESENT) {
        const old = (await call('get_valid_children', { parent_type: t })).body as Record<string, unknown>
        expect(schema.valid_children, `valid_children ${t}`).toEqual(old.valid_children)
      } else {
        expect(Array.isArray(schema.valid_children), `valid_children ${t}`).toBe(true)
      }
    }
  })

  it('resolve_edge fold', async () => {
    const pairs: [string, string][] = [['persona', 'job'], ['product', 'feature']]
    for (const [src, tgt] of pairs) {
      const schema = (await call('get_entity_schema', { type: src, resolve_edge_to: tgt })).body as Record<string, unknown>
      const re = schema.resolve_edge as Record<string, unknown>
      expect(re, `resolve_edge ${src}->${tgt}`).toBeTruthy()
      if (RETIRED_PRESENT) {
        expect(re).toEqual((await call('resolve_edge_for_pair', { source_type: src, target_type: tgt })).body)
      } else {
        expect(re.source_type).toBe(src)
        expect('edge_type' in re).toBe(true)
      }
    }
  })
})

describe('catalog-parity (cloud): get_spec_version changelog fold', () => {
  it('default has no changelog; changelog:true adds an array', async () => {
    const base = (await call('get_spec_version', {})).body as Record<string, unknown>
    expect(base).not.toHaveProperty('changelog')
    const withLog = (await call('get_spec_version', { changelog: true })).body as Record<string, unknown>
    expect(Array.isArray(withLog.changelog)).toBe(true)
  })
})
