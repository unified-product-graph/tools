/**
 * Vistaly end-to-end import audit.
 *
 * The release gate for the Vistaly integration. It runs the FULL production
 * path (list → convert → writeToUPGFile → reload from disk) against a fixture
 * built from Vistaly's REAL API (OpenAPI spec 2025-06-21), captured in
 * ./fixtures/vistaly/SCHEMA.md.
 *
 * The adapter was originally written against a fictional API (wrong endpoints,
 * wrong field names, wrong enums). It has since been rewritten against the real
 * /beta/cards/{id}/context endpoint; this suite proves a real Vistaly discovery
 * tree now imports into a valid, reloadable .upg graph.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { VistalyAdapter } from '@unified-product-graph/adapters'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runImportE2E, stubFetch, type AdapterLike } from './helpers/import-e2e.js'

const here = path.dirname(fileURLToPath(import.meta.url))
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'vistaly', name), 'utf-8'))
}

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new VistalyAdapter() as unknown as AdapterLike
const real = fixture('card-context.real.json') // GET /beta/cards/{id}/context response

const bySource = (nodes: Array<Record<string, unknown>>, sourceId: string) =>
  nodes.find((n) => n.source_id === sourceId)

// Serve the real /beta/cards/{id}/context payload; everything else 404s, so the
// adapter must use exactly the real endpoint.
function stubRealApi() {
  return stubFetch([{ match: '/beta/cards/', json: real }])
}

async function runRealImport() {
  const restore = stubRealApi()
  try {
    return await runImportE2E({
      adapter: adapter(),
      config: { api_key: 'test-key', root_card_id: 'card_obj_smb' },
    })
  } finally {
    restore()
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Real discovery tree imports into a valid, reloadable .upg
// ───────────────────────────────────────────────────────────────────────────

describe('Vistaly e2e — real /context payload → typed discovery tree', () => {
  it('maps every real card to the correct UPG entity type', async () => {
    const out = await runRealImport()
    try {
      expect(out.items).toHaveLength(9)
      expect(out.result.nodes).toHaveLength(9)
      const typeBySource = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(typeBySource).toMatchObject({
        card_obj_smb: 'objective',
        card_out_activation: 'outcome',
        card_kpi_activation: 'metric', // kpi → metric
        card_opp_abandon: 'opportunity',
        card_sol_wizard: 'solution',
        card_exp_wizardab: 'experiment',
        card_asm_threestep: 'assumption',
        card_prb_apikeys: 'need', // problem → need
        card_prod_mobile: 'product',
      })
    } finally {
      await out.cleanup()
    }
  })

  it('normalises statuses per target lifecycle (and omits unmappable / lifecycle-free)', async () => {
    const out = await runRealImport()
    try {
      expect(bySource(out.result.nodes, 'card_out_activation')?.status).toBe('measuring') // on track
      expect(bySource(out.result.nodes, 'card_opp_abandon')?.status).toBe('validated') // now
      expect(bySource(out.result.nodes, 'card_sol_wizard')?.status).toBe('proposed') // idea
      expect(bySource(out.result.nodes, 'card_exp_wizardab')?.status).toBe('running') // running
      expect(bySource(out.result.nodes, 'card_asm_threestep')?.status).toBe('testing') // pending
      expect(bySource(out.result.nodes, 'card_prb_apikeys')?.status).toBe('raw') // identified → need.raw
      // metric is lifecycle-free; product has no status lifecycle → omitted
      expect(bySource(out.result.nodes, 'card_kpi_activation')?.status).toBeUndefined()
      expect(bySource(out.result.nodes, 'card_prod_mobile')?.status).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits the discovery-tree edges with correct types and direction', async () => {
    const out = await runRealImport()
    try {
      const sm = out.result.source_map
      const has = (type: string, sourceId: string, targetId: string) =>
        out.result.edges.some(
          (e) => e.type === type && e.source === sm[sourceId] && e.target === sm[targetId],
        )
      expect(has('objective_advances_outcome', 'card_obj_smb', 'card_out_activation')).toBe(true)
      expect(has('outcome_measured_by_metric', 'card_out_activation', 'card_kpi_activation')).toBe(true)
      // direction flips: opportunity (child) is the edge source
      expect(has('opportunity_pursues_outcome', 'card_opp_abandon', 'card_out_activation')).toBe(true)
      expect(has('product_pursues_outcome', 'card_prod_mobile', 'card_out_activation')).toBe(true)
      expect(has('opportunity_drives_solution', 'card_opp_abandon', 'card_sol_wizard')).toBe(true)
      expect(has('opportunity_addresses_need', 'card_opp_abandon', 'card_prb_apikeys')).toBe(true)
      // experiment has no canonical edge under solution → generic fallback
      expect(out.result.edges.filter((e) => e.type === 'node_informs_node')).toHaveLength(2)
      // all catalogued
      for (const e of out.result.edges) {
        expect(EDGE_TYPES.has(e.type as string), `edge "${e.type}" catalogued`).toBe(true)
      }
    } finally {
      await out.cleanup()
    }
  })

  it('PERSISTS as a valid, reloadable .upg with metric values + provenance intact', async () => {
    const out = await runRealImport()
    try {
      // Round-trips to disk and reloads with no quarantine (every type + status valid).
      expect(out.rawDoc.nodes).toHaveLength(9)
      expect(out.rawDoc.edges).toHaveLength(8)
      expect(out.reloadError).toBeNull()
      expect(out.reloadedNodes).toHaveLength(9)
      expect(out.reloadedEdges).toHaveLength(8)

      // Metric values persisted under properties (the old top-level-field bug is fixed).
      const kpi = out.rawDoc.nodes.find((n) => n.source_id === 'card_kpi_activation') as Record<string, unknown>
      expect(kpi.properties).toMatchObject({ current_value: 42, target_value: 60, unit: '%' })

      // Provenance persisted (writer now preserves canonical external_* fields).
      const opp = out.rawDoc.nodes.find((n) => n.source_id === 'card_opp_abandon') as Record<string, unknown>
      expect(opp.external_tool).toBe('vistaly')
      expect(opp.external_id).toBe('card_opp_abandon')
      expect(opp.external_ref).toContain('vistaly.com')
    } finally {
      await out.cleanup()
    }
  })

  it('warns where UPG has no direct edge (experiment routes through hypothesis)', async () => {
    const out = await runRealImport()
    try {
      const warned = (out.result.warnings ?? []).filter((w) => /No canonical UPG edge/.test(w))
      expect(warned.length).toBe(2) // solution→experiment, opportunity→assumption
    } finally {
      await out.cleanup()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. Uses the real endpoint; needs a root card id
// ───────────────────────────────────────────────────────────────────────────

describe('Vistaly e2e — enumeration contract', () => {
  it('walks GET /beta/cards/{root}/context exclusively (everything else 404s)', async () => {
    const restore = stubRealApi() // only /beta/cards/ is served
    try {
      const items = await adapter().list({ api_key: 'test-key', root_card_id: 'card_obj_smb' })
      expect(items).toHaveLength(9)
      expect(items[0]).toMatchObject({ source_type: 'card' })
    } finally {
      restore()
    }
  })

  it('requires a root_card_id (there is no list-all-cards endpoint)', async () => {
    await expect(adapter().list({ api_key: 'test-key' })).rejects.toThrow(/root_card_id/)
  })
})
