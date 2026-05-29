/**
 *: `get_session_context` exposes `recommendations_to_avoid` as a
 * deduped string array of every recommendation given this session.
 *
 * The point: move cross-skill dedup from prose ("pick a recommendation
 * different from previous ones") to a data field runners can filter against.
 *
 * Baseline before this test: N/A (new contract).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { getSessionContext, updateSessionContext } from '../tools/context.js'
import type { UPGDocument } from '@unified-product-graph/core'

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Session Dedup Fixture', stage: 'concept' },
    nodes: [],
    edges: [],
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-session-dedup-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function readSession(ctx: ToolContext): Record<string, unknown> {
  const result = getSessionContext({}, ctx)
  if (result instanceof Promise) throw new Error('expected a synchronous ToolResult')
  const block = result.content[0]
  if (block.type !== 'text') throw new Error('expected text block')
  return JSON.parse(block.text) as Record<string, unknown>
}

describe(': recommendations_to_avoid on get_session_context', () => {
  it('returns an empty array on a fresh session', async () => {
    const store = await loadStore(makeDoc())
    const ctx = makeCtx(store)
    const session = readSession(ctx)
    expect(session.recommendations_to_avoid).toEqual([])
  })

  it('accumulates each unique recommendation in registration order', async () => {
    const store = await loadStore(makeDoc())
    const ctx = makeCtx(store)
    updateSessionContext({ skill_invoked: 'upg', recommendation: '/upg-status' }, ctx)
    updateSessionContext({ skill_invoked: 'upg-analytics', recommendation: '/upg-connect' }, ctx)
    updateSessionContext({ skill_invoked: 'upg-gaps', recommendation: '/upg-migrate' }, ctx)
    const session = readSession(ctx)
    expect(session.recommendations_to_avoid).toEqual([
      '/upg-status',
      '/upg-connect',
      '/upg-migrate',
    ])
  })

  it('dedupes when two skills recommend the same command', async () => {
    const store = await loadStore(makeDoc())
    const ctx = makeCtx(store)
    updateSessionContext({ skill_invoked: 'upg', recommendation: '/upg-status' }, ctx)
    updateSessionContext({ skill_invoked: 'upg-gaps', recommendation: '/upg-status' }, ctx)
    updateSessionContext({ skill_invoked: 'upg-impact', recommendation: '/upg-connect' }, ctx)
    const session = readSession(ctx)
    // recommendations_given keeps both entries; recommendations_to_avoid dedupes
    expect((session.recommendations_given as unknown[]).length).toBe(3)
    expect(session.recommendations_to_avoid).toEqual(['/upg-status', '/upg-connect'])
  })

  it('survives recommendation-less skill invocations', async () => {
    const store = await loadStore(makeDoc())
    const ctx = makeCtx(store)
    updateSessionContext({ skill_invoked: 'upg-tree' }, ctx) // no recommendation
    updateSessionContext({ skill_invoked: 'upg', recommendation: '/upg-status' }, ctx)
    const session = readSession(ctx)
    expect(session.recommendations_to_avoid).toEqual(['/upg-status'])
  })
})
