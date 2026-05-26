/**
 * Smoke test against a real `.upg` graph.
 *
 * Runs `validate_graph` and `get_anti_pattern_violations_for` end-to-end
 * to confirm the tool returns the new shape and that anti-pattern
 * evaluation surfaces fires on a real graph.
 *
 * The test isn't pinned to a specific count of fires — only to "the
 * wiring works." Set `UPG_SMOKE_FIXTURE` to point at any `.upg` file;
 * the test skips gracefully if no fixture is available.
 */

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { validateGraph, getAntiPatternViolationsFor } from '../tools/validation.js'

// Smoke test against a real .upg graph. Set `UPG_SMOKE_FIXTURE` to point at
// any .upg file; defaults to a monorepo-local sample if present.
const SMOKE_FIXTURE = process.env.UPG_SMOKE_FIXTURE
  ?? resolve(__dirname, '../../../../.upg/entopo.upg')

describe('Smoke test against a real .upg graph', () => {
  if (!existsSync(SMOKE_FIXTURE)) {
    it.skip('no smoke fixture available — skipping', () => {})
    return
  }

  it('validate_graph runs and returns new envelope with anti-pattern fields', async () => {
    const store = new UPGFileStore()
    await store.load(SMOKE_FIXTURE)
    store.stopWatching()
    const ctx: ToolContext = {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
    const result = await validateGraph({}, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)

    // New shape — `valid`, anti_pattern_violations, summary counts.
    expect(typeof body.valid).toBe('boolean')
    expect(Array.isArray(body.anti_pattern_violations)).toBe(true)
    expect(typeof body.summary.anti_pattern_violations_high).toBe('number')
    expect(typeof body.summary.anti_pattern_violations_medium).toBe('number')
    expect(typeof body.summary.anti_pattern_violations_low).toBe('number')

    // Existing shape preserved — schema drift fields still present.
    expect(typeof body.summary.entity_drift).toBe('number')
    expect(typeof body.summary.edge_drift).toBe('number')

    // Surface what fired — useful for visual confirmation in CI logs.
    const fires = body.anti_pattern_violations.map(
      (v: { anti_pattern_id: string; severity: string }) =>
        `${v.severity}: ${v.anti_pattern_id}`,
    )
    console.log(
      `[smoke] graph @ ${SMOKE_FIXTURE}\n` +
        `  total_nodes=${body.summary.total_nodes ?? '?'}, total_edges=${body.summary.total_edges ?? '?'}\n` +
        `  valid=${body.valid}, fires=${body.anti_pattern_violations.length} ` +
        `(high=${body.summary.anti_pattern_violations_high}, ` +
        `medium=${body.summary.anti_pattern_violations_medium}, ` +
        `low=${body.summary.anti_pattern_violations_low})\n` +
        `  patterns:\n  - ${fires.length ? fires.join('\n  - ') : '(none fired)'}`,
    )
  })

  it('severity filter narrows the result set', async () => {
    const store = new UPGFileStore()
    await store.load(SMOKE_FIXTURE)
    store.stopWatching()
    const ctx: ToolContext = {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
    const result = await validateGraph({ severity: 'high' }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    for (const v of body.anti_pattern_violations) {
      expect(v.severity).toBe('high')
    }
  })

  it('get_anti_pattern_violations_for returns a typed envelope for a real entity', async () => {
    const store = new UPGFileStore()
    await store.load(SMOKE_FIXTURE)
    store.stopWatching()
    const ctx: ToolContext = {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
    const firstNode = store.getAllNodes()[0]
    if (!firstNode) {
      // Empty graph — skip.
      return
    }
    const result = await getAntiPatternViolationsFor({ entity_id: firstNode.id }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.entity_id).toBe(firstNode.id)
    expect(body.type).toBe(firstNode.type)
    expect(Array.isArray(body.violations)).toBe(true)
  })

  it('get_anti_pattern_violations_for errors on unknown id', async () => {
    const store = new UPGFileStore()
    await store.load(SMOKE_FIXTURE)
    store.stopWatching()
    const ctx: ToolContext = {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
    const result = await getAntiPatternViolationsFor({ entity_id: 'definitely-not-a-real-id' }, ctx)
    expect(result.isError).toBe(true)
  })
})
