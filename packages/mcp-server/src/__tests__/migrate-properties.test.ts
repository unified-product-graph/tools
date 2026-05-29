/**
 * Tests for the standalone `migrate_properties` MCP tool.
 *
 * Mirrors the catalog-aware `migrate_type` test pattern, but exercises the
 * pure property pass: no node-type rename, no edge migration. Each test
 * targets one of the four `UPG_PROPERTY_MIGRATIONS` rule kinds shipped in
 * `@unified-product-graph/core`: drop_props, rename_top_level,
 * lift_property_to_top_level, drop_when_self_referential.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import { migrateProperties } from '../tools/nodes.js'
import {
 createSessionContext,
 createQueryCache,
 readSyncState,
 writeSyncState,
 hashFile,
 syncFilePath,
 type ToolContext,
} from '../lib/server-context.js'

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: 'p1', title: 'Property migration fixture', stage: 'concept' },
 nodes,
 edges,
 }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-migrate-properties-'))
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

const node = (id: string, type: string, title = `Node ${id}`): UPGBaseNode => ({
 id,
 type: type as UPGEntityType,
 title,
})

describe('migrate_properties: pure property pass', () => {
 it('lifts pre-canonical product.properties.stage onto top-level status', async () => {
 const dirty = {
 ...node('p1', 'product'),
 properties: { stage: 'idea' },
 }
 const store = await loadStore(makeDoc([dirty], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(false)
 expect(body.lifted_properties).toEqual([
 { id: 'p1', from_property: 'stage', to: 'status', value_changed: true },
 ])
 const migrated = store.getNode('p1')
 expect(migrated?.status).toBe('concept')
 expect((migrated?.properties as Record<string, unknown> | undefined)?.stage).toBeUndefined()
 })

 it('renames pre-canonical lifecycle_status onto status with value_map remap', async () => {
 const dirty = {
 ...node('p1', 'product'),
 lifecycle_status: 'archived',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([dirty], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.top_level_renames).toEqual([
 { id: 'p1', from: 'lifecycle_status', to: 'status', value_changed: true },
 ])
 const migrated = store.getNode('p1') as unknown as Record<string, unknown> | undefined
 expect(migrated?.lifecycle_status).toBeUndefined()
 expect(migrated?.status).toBe('sunset')
 })

 it('drops self-referential source_id / source_type via the wildcard rule', async () => {
 const a = {
 ...node('o1', 'outcome'),
 source_id: 'o1',
 source_type: 'outcome',
 } as unknown as UPGBaseNode
 const b = {
 ...node('o2', 'outcome'),
 source_id: 'someone-else',
 source_type: 'outcome',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([a, b], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 // o1 is fully self-referential; both fields drop.
 // o2 has a non-self source_id (kept) and a self source_type (dropped).
 expect(body.dropped_self_referential).toEqual(
 expect.arrayContaining([
 { id: 'o1', field: 'source_id' },
 { id: 'o1', field: 'source_type' },
 { id: 'o2', field: 'source_type' },
 ]),
 )
 expect(body.dropped_self_referential).not.toContainEqual({ id: 'o2', field: 'source_id' })

 const cleaned = store.getNode('o1') as unknown as Record<string, unknown>
 expect(cleaned.source_id).toBeUndefined()
 expect(cleaned.source_type).toBeUndefined()
 const partial = store.getNode('o2') as unknown as Record<string, unknown>
 expect(partial.source_id).toBe('someone-else')
 expect(partial.source_type).toBeUndefined()
 })

 it('drops legacy metric quality props (drop_props rule)', async () => {
 const dirty = {
 ...node('m1', 'metric'),
 properties: {
 current_value: 100,
 quality_score: 4,
 proxy_reason: 'pre-v0.2.2 attribution',
 },
 }
 const store = await loadStore(makeDoc([dirty], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dropped_props).toEqual(
 expect.arrayContaining([
 { id: 'm1', key: 'quality_score' },
 { id: 'm1', key: 'proxy_reason' },
 ]),
 )
 const migrated = store.getNode('m1')
 const props = migrated?.properties as Record<string, unknown> | undefined
 expect(props?.current_value).toBe(100)
 expect(props?.quality_score).toBeUndefined()
 expect(props?.proxy_reason).toBeUndefined()
 })

 it('dry_run is the default and previews without mutating', async () => {
 const dirty = {
 ...node('p1', 'product'),
 lifecycle_status: 'draft',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([dirty], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({}, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(true)
 expect(body.top_level_renames).toEqual([
 { id: 'p1', from: 'lifecycle_status', to: 'status', value_changed: true },
 ])
 // Graph untouched
 const untouched = store.getNode('p1') as unknown as Record<string, unknown> | undefined
 expect(untouched?.lifecycle_status).toBe('draft')
 expect(untouched?.status).toBeUndefined()
 })

 it('returns four empty arrays when no rules match', async () => {
 const store = await loadStore(makeDoc([node('p1', 'persona')], []))
 const ctx = makeCtx(store)

 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.top_level_renames).toEqual([])
 expect(body.lifted_properties).toEqual([])
 expect(body.dropped_props).toEqual([])
 expect(body.dropped_self_referential).toEqual([])
 })

 it('does NOT migrate edges or rename node types', async () => {
 // Property pass is the *only* mutation; edges and types stay as-is.
 const store = await loadStore(
 makeDoc(
 [node('p1', 'persona'), node('j1', 'jtbd', 'Pre-canonical jtbd')],
 [
 {
 id: 'e1',
 source: 'p1',
 target: 'j1',
 type: 'persona_has_jtbd' as never,
 },
 ],
 ),
 )
 const ctx = makeCtx(store)

 await migrateProperties({ dry_run: false }, ctx)

 expect(store.getNode('j1')?.type).toBe('jtbd')
 expect(store.getEdge('e1')?.type).toBe('persona_has_jtbd')
 })
})
