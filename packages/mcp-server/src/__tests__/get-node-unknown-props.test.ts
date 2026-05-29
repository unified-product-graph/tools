/**
 * Tests for `get_node` unknown-property warnings (F5).
 *
 * added unknown-property warnings on write paths (create_node,
 * update_node, file load). `get_node` did not surface them; a node loaded
 * from a legacy .upg file with deprecated inline properties (e.g. persona
 * `goals` / `frustrations`) would return silently clean.
 *
 * F5 wires `checkUnknownProperties` into `get_node` so the same warning shape
 * used by write paths is emitted on reads.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { getNode } from '../tools/nodes.js'
import type { UPGDocument, UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import {
 createSessionContext,
 createQueryCache,
 readSyncState,
 writeSyncState,
 hashFile,
 syncFilePath,
 type ToolContext,
} from '../lib/server-context.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(nodes: UPGBaseNode[]): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: 'p1', title: 'get_node warning fixture', stage: 'concept' },
 nodes,
 edges: [],
 }
}

async function loadStore(nodes: UPGBaseNode[]): Promise<UPGFileStore> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-get-node-warn-'))
 const filePath = join(dir, 'test.upg')
 writeFileSync(filePath, JSON.stringify(makeDoc(nodes), null, 2))
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('get_node: F5: unknown-property warnings on read', () => {
 let store: UPGFileStore
 let ctx: ToolContext

 beforeEach(async () => {
 store = await loadStore([
 {
 id: 'rt_persona_legacy',
 type: 'persona' as UPGEntityType,
 title: 'Lior, Legacy Persona',
 properties: {
 goals: ['Ship product without losing the plot', 'Stay close to the work'],
 frustrations: ['Tools that hide structure', 'Disposable AI output'],
 },
 } as UPGBaseNode,
 {
 id: 'rt_persona_chain',
 type: 'persona' as UPGEntityType,
 title: 'Mira, Chain Persona',
 description:
 'Persona authored with the canonical v0.2.7+ chain model. No inline goals/frustrations.',
 } as UPGBaseNode,
 ])
 ctx = makeCtx(store)
 })

 it('surfaces unknown_properties and warning for rt_persona_legacy (deprecated goals/frustrations)', async () => {
 const result = await getNode({ node_id: 'rt_persona_legacy' }, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)

 // Node must still be present
 expect(body.node).toBeDefined()
 expect(body.node.id).toBe('rt_persona_legacy')

 // Warning fields must be present
 expect(body.unknown_properties).toBeDefined()
 expect(Array.isArray(body.unknown_properties)).toBe(true)
 expect(body.unknown_properties).toContain('goals')
 expect(body.unknown_properties).toContain('frustrations')
 expect(body.warning).toBeDefined()
 expect(typeof body.warning).toBe('string')
 expect(body.warning).toMatch(/goals/)
 expect(body.warning).toMatch(/frustrations/)
 expect(body.warning).toMatch(/persona/)
 })

 it('does NOT include unknown_properties or warning for rt_persona_chain (canonical shape)', async () => {
 const result = await getNode({ node_id: 'rt_persona_chain' }, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)

 expect(body.node).toBeDefined()
 expect(body.node.id).toBe('rt_persona_chain')
 // No warning fields
 expect(body.unknown_properties).toBeUndefined()
 expect(body.warning).toBeUndefined()
 })

 it('returns a textError when node_id is missing', async () => {
 const result = await getNode({}, ctx)
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/Missing required parameter/)
 })

 it('returns a textError when the node does not exist', async () => {
 const result = await getNode({ node_id: 'nonexistent' }, ctx)
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/not found/)
 })
})
