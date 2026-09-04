/**
 * 0.40.0 — the two A4 riders: batch_create_nodes echoes what the caller wrote.
 *
 * From the same field brief as A4 itself. The reporter keyed 163 design tokens
 * by `css_variable` and had to RE-READ THE FILE to do it, because the response
 * carried only id/type/title; and a caller chaining by `ref` had no way to map
 * its own tokens onto the returned ids, because `ref_map` was emitted on
 * dry-run and on failure but not on success. Both are round trips the response
 * can remove by echoing what it already has.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createDispatcher } from '../server.js'
import {
  createSessionContext, createQueryCache, readSyncState, writeSyncState,
  hashFile, syncFilePath, type ToolContext,
} from '../lib/server-context.js'

let dir: string
let store: UPGFileStore
let dispatch: (n: string, a: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'upg-riders-'))
  const file = join(dir, 'p.upg')
  writeFileSync(file, JSON.stringify({
    upg_version: '0.8.0', exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_1', title: 'T' }, nodes: [], edges: [],
  }), 'utf-8')
  store = new UPGFileStore()
  await store.load(file)
  const ctx: ToolContext = {
    store, sessionContext: createSessionContext(), queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    serverInfo: { name: 'test', version: '0' }, getClientInfo: () => undefined,
  }
  dispatch = createDispatcher(ctx).dispatch as typeof dispatch
})

afterEach(() => { store.stopWatching(); rmSync(dir, { recursive: true, force: true }) })

describe('rider 1 — created nodes echo their properties', () => {
  it('lets a caller key results by what it wrote, with no re-read', async () => {
    // The reporter's shape: many tokens, keyed by css_variable.
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      type: 'design_token', title: `tok-${i}`,
      properties: { css_variable: `--c-${i}`, category: 'color', value: '#fff' },
    }))
    const r = await dispatch('batch_create_nodes', { nodes })
    const body = JSON.parse(r.content[0].text)
    const byVariable = new Map<string, string>(
      body.created.map((n: { id: string; properties?: Record<string, string> }) => [n.properties?.css_variable, n.id]),
    )
    expect(byVariable.size).toBe(5)
    expect(byVariable.get('--c-3')).toBeTruthy()
  })

  it('omits properties when there are none, so the common case stays small', async () => {
    const r = await dispatch('batch_create_nodes', { nodes: [{ type: 'feature', title: 'bare' }] })
    expect(JSON.parse(r.content[0].text).created[0]).not.toHaveProperty('properties')
  })
})

describe('rider 2 — ref_map is emitted on success, not only on dry-run and failure', () => {
  it('maps the caller’s own alias tokens onto created ids', async () => {
    const r = await dispatch('batch_create_nodes', {
      nodes: [
        { type: 'feature', title: 'Parent', ref: 'p' },
        { type: 'user_story', title: 'Child', parent_ref: '$0' },
      ],
    })
    const body = JSON.parse(r.content[0].text)
    expect(body.ref_map, 'ref_map missing on the success path').toBeDefined()
    const alias = body.ref_map.find((e: { token: string }) => e.token === 'p')
    expect(alias).toBeTruthy()
    expect(alias.index).toBe(0)
    // The mapping is usable: the aliased entry resolves to a created node.
    expect(body.created[alias.index].title).toBe('Parent')
  })

  it('stays absent when the caller used no refs (no new noise on the wire)', async () => {
    const r = await dispatch('batch_create_nodes', { nodes: [{ type: 'feature', title: 'solo' }] })
    expect(JSON.parse(r.content[0].text).ref_map).toBeUndefined()
  })
})
