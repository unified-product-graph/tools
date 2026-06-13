/**
 * validate_graph surfaces value-aware property migrations (0.10.2).
 *
 * The brief's complaint was "silent breakages — invalid with no migration path
 * offered." The enum remaps (data_flow.direction etc.) already had rules under
 * 0.9.12 and the market_trend reshape lands in 0.10.2, but validate_graph's
 * property_drift only indexed lift/drop kinds (key-presence). Now it is
 * value-aware: a stale enum value or a bare number where an assessment is
 * expected shows up as property_drift pointing at migrate_properties, while a
 * correctly-shaped value is left alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
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
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>
}

const doc: UPGDocument = {
  upg_version: '0.10.2',
  exported_at: '2026-06-13T00:00:00Z',
  source: { tool: 'test' },
  product: { id: 'p_root', title: 'Root', stage: 'concept' },
  nodes: [
    { id: 'mt1', type: 'market_trend', title: 'Bare impact', properties: { impact: 4 } },
    { id: 'df1', type: 'data_flow', title: 'Stale direction', properties: { direction: 'internal' } },
    { id: 'mt2', type: 'market_trend', title: 'Correct', properties: { impact: { value: 4, label: 'High', scale_id: 'impact_5' } } },
  ],
  edges: [],
} as unknown as UPGDocument

describe('validate_graph value-aware property migration drift (0.10.2)', () => {
  let cwd: string
  let originalCwd: string
  let store: UPGFileStore

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'upg-mpd-'))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'root.upg'), JSON.stringify(doc, null, 2))
    process.chdir(cwd)
    store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'root.upg'))
    store.stopWatching()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    store.stopWatching()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('flags a bare-number assessment (reshape) and a stale enum value (remap), but not a correct value', async () => {
    const body = await parse(validateGraph({ scope: 'property_drift' }, makeCtx(store)))
    const drift = (body.property_drift as Array<{ id: string; property: string; via: string }>) ?? []

    const impactStale = drift.find((d) => d.id === 'mt1' && d.property === 'impact')
    expect(impactStale, 'bare-number market_trend.impact should be migratable').toBeTruthy()
    expect(impactStale!.via).toContain('0.10.2')

    const directionStale = drift.find((d) => d.id === 'df1' && d.property === 'direction')
    expect(directionStale, 'stale data_flow.direction enum should be migratable').toBeTruthy()
    expect(directionStale!.via).toContain('0.9.12')

    // The already-correct market_trend assessment must NOT be flagged.
    expect(drift.find((d) => d.id === 'mt2')).toBeUndefined()
  })
})
