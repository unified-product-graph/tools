/**
 * Tests for the catalog-aware `migrate_type` path (Wave 3+).
 *
 * Validates that node-type migration composes with `UPG_EDGE_MIGRATIONS`
 * (in @unified-product-graph/core@0.2.9+): renames retarget edges to canonical form,
 * flips swap source/target, drops remove edges, and unmapped legacy edges
 * surface in the response without silent substring mangling.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGEdgeType } from '@unified-product-graph/core'
import { migrateType, migrateProperties } from '../tools/nodes.js'
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
 product: { id: 'p1', title: 'Catalog-aware migrate fixture', stage: 'concept' },
 nodes,
 edges,
 }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-migrate-canonical-'))
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

const edge = (id: string, source: string, target: string, type: string): UPGEdge => ({
 id,
 source,
 target,
 type: type as UPGEdgeType,
})

describe('migrate_type: catalog-aware edge migration', () => {
 it('rewrites legacy edge keys to canonical form when guards pass', async () => {
 // Pre-v0.2.0 graph: jtbd entity + persona_has_jtbd legacy edge.
 // After migrate_type(jtbd → job), the edge should be retargeted to
 // persona_pursues_job, not the substring `persona_has_job`.
 const store = await loadStore(
 makeDoc(
 [node('p1', 'persona'), node('j1', 'jtbd', 'Build fast')],
 [edge('e1', 'p1', 'j1', 'persona_has_jtbd')],
 ),
 )
 const ctx = makeCtx(store)

 const result = await migrateType({ from_type: 'jtbd', to_type: 'job' }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(false)
 expect(body.migrated_nodes).toBe(1)
 expect(body.edge_renames).toHaveLength(1)
 expect(body.edge_renames[0]).toMatchObject({
 id: 'e1',
 from: 'persona_has_jtbd',
 to: 'persona_pursues_job',
 flipped: false,
 })
 expect(store.getNode('j1')?.type).toBe('job')
 expect(store.getEdge('e1')?.type).toBe('persona_pursues_job')
 })

 it('does NOT silently substring-substitute unmapped legacy edges', async () => {
 // pain_point → need has no entry in UPG_EDGE_MIGRATIONS for the
 // `jtbd_has_pain_point` edge, and `jtbd_has_pain_point` is not in
 // UPG_EDGE_CATALOG. Pre-v0.2.10 this would have been mangled into
 // `jtbd_has_need` (also non-canonical). Now: surfaced as unmapped.
 const store = await loadStore(
 makeDoc(
 [node('j1', 'jtbd'), node('pp1', 'pain_point')],
 [edge('e1', 'j1', 'pp1', 'jtbd_has_pain_point')],
 ),
 )
 const ctx = makeCtx(store)

 const result = await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.edge_renames).toHaveLength(0)
 expect(body.dropped_edges).toHaveLength(0)
 expect(store.getEdge('e1')?.type).toBe('jtbd_has_pain_point')
 // Surfaces the unmapped legacy edge under unmapped_legacy_edges
 expect(body.unmapped_legacy_edges).toContainEqual({
 type: 'jtbd_has_pain_point',
 count: 1,
 })
 })

 it('dry_run plans the catalog-aware migration without mutating', async () => {
 const store = await loadStore(
 makeDoc(
 [node('p1', 'persona'), node('j1', 'jtbd')],
 [edge('e1', 'p1', 'j1', 'persona_has_jtbd')],
 ),
 )
 const ctx = makeCtx(store)

 const result = await migrateType(
 { from_type: 'jtbd', to_type: 'job', dry_run: true },
 ctx,
 )
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(true)
 expect(body.edge_renames).toHaveLength(1)
 expect(body.edge_renames[0]).toMatchObject({
 from: 'persona_has_jtbd',
 to: 'persona_pursues_job',
 })
 // Graph untouched
 expect(store.getNode('j1')?.type).toBe('jtbd')
 expect(store.getEdge('e1')?.type).toBe('persona_has_jtbd')
 })

 it('preserves the migrated_nodes count when no edges need migration', async () => {
 const store = await loadStore(
 makeDoc([node('pp1', 'pain_point'), node('pp2', 'pain_point')], []),
 )
 const ctx = makeCtx(store)

 const result = await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.migrated_nodes).toBe(2)
 expect(body.migrated_edges).toBe(0)
 expect(store.getNode('pp1')?.type).toBe('need')
 expect(store.getNode('pp2')?.type).toBe('need')
 })

 it('reports edge_renames with `flipped: false` for non-flip rules', async () => {
 // persona_has_jtbd → persona_pursues_job is a plain rename (no flip).
 const store = await loadStore(
 makeDoc(
 [node('p1', 'persona'), node('j1', 'jtbd')],
 [edge('e1', 'p1', 'j1', 'persona_has_jtbd')],
 ),
 )
 const ctx = makeCtx(store)
 const result = await migrateType({ from_type: 'jtbd', to_type: 'job' }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.edge_renames[0].flipped).toBe(false)
 // source and target unchanged
 expect(store.getEdge('e1')?.source).toBe('p1')
 expect(store.getEdge('e1')?.target).toBe('j1')
 })

 it('returns the new response shape (no edge_types_renamed key)', async () => {
 // Sanity check that the legacy substring-only response shape is gone.
 const store = await loadStore(makeDoc([node('pp1', 'pain_point')], []))
 const ctx = makeCtx(store)
 const result = await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body).not.toHaveProperty('edge_types_renamed')
 expect(body).toHaveProperty('edge_renames')
 expect(body).toHaveProperty('dropped_edges')
 expect(body).toHaveProperty('unmapped_legacy_edges')
 })
})

describe('migrate_type: property migration pass', () => {
 // NOTE: The property migration pass is now a separate `migrate_properties`
 // tool (split out from migrate_type). These tests drive `migrateProperties`
 // directly to verify the property-pass response shape and behaviour. The
 // sibling `migrate-properties.test.ts` file covers the standalone tool;
 // these tests retain the cross-cutting scenarios (run after a type rename)
 // by composing migrate_type + migrate_properties where needed.
 it('lifts hypothesis_claim status to top-level after rename (§Update §1)', async () => {
 // Pre-Wave-3 hypothesis carries lifecycle phase in properties.status with
 // the legacy `untested → testing → resolved` enum. After
 // migrate_type(hypothesis → hypothesis_claim) the rename pass renames
 // the entity, then the property pass fires the type-specific
 // `lift_property_to_top_level` rule against the post-rename type and
 // remaps the value to the canonical hypothesis_claim lifecycle.
 const legacy = {
 ...node('h1', 'hypothesis', 'Pricing intuition'),
 properties: { status: 'testing' },
 }
 const store = await loadStore(makeDoc([legacy], []))
 const ctx = makeCtx(store)

 await migrateType(
 { from_type: 'hypothesis', to_type: 'hypothesis_claim' },
 ctx,
 )
 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(false)
 expect(body.lifted_properties).toEqual([
 { id: 'h1', from_property: 'status', to: 'status', value_changed: true },
 ])
 const migrated = store.getNode('h1')
 expect(migrated?.type).toBe('hypothesis_claim')
 expect(migrated?.status).toBe('active')
 expect((migrated?.properties as Record<string, unknown> | undefined)?.status).toBeUndefined()
 })

 it('drops self-referential source_id / source_type during the same pass (rule 3)', async () => {
 // The `*` wildcard rule fires on every node, so an unrelated entity
 // type carrying self-ref round-trip metadata gets cleaned up too.
 const dirty = {
 ...node('o1', 'outcome'),
 source_id: 'o1',
 source_type: 'outcome',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([dirty, node('p1', 'pain_point')], []))
 const ctx = makeCtx(store)

 await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dropped_self_referential).toEqual(
 expect.arrayContaining([
 { id: 'o1', field: 'source_id' },
 { id: 'o1', field: 'source_type' },
 ]),
 )
 const cleaned = store.getNode('o1') as unknown as Record<string, unknown> | undefined
 expect(cleaned?.source_id).toBeUndefined()
 expect(cleaned?.source_type).toBeUndefined()
 })

 it('renames pre-canonical lifecycle_status onto status with value remap (rule 2)', async () => {
 const dirty = {
 ...node('p1', 'product'),
 lifecycle_status: 'active',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([dirty, node('pp1', 'pain_point')], []))
 const ctx = makeCtx(store)

 await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 await migrateProperties({ dry_run: false }, ctx)
 const migrated = store.getNode('p1') as unknown as Record<string, unknown> | undefined
 expect(migrated?.lifecycle_status).toBeUndefined()
 expect(migrated?.status).toBe('launch')
 })

 it('dry_run reports the property plan without mutating', async () => {
 const dirty = {
 ...node('p1', 'product'),
 lifecycle_status: 'draft',
 } as unknown as UPGBaseNode
 const store = await loadStore(makeDoc([dirty, node('pp1', 'pain_point')], []))
 const ctx = makeCtx(store)

 // migrate_type runs first (no-op for property fields), then migrate_properties
 // with dry_run reports the planned property changes without committing.
 await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const result = await migrateProperties({ dry_run: true }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body.dry_run).toBe(true)
 expect(body.top_level_renames).toEqual([
 { id: 'p1', from: 'lifecycle_status', to: 'status', value_changed: true },
 ])
 // Graph untouched by the property pass
 const untouched = store.getNode('p1') as unknown as Record<string, unknown> | undefined
 expect(untouched?.lifecycle_status).toBe('draft')
 expect(untouched?.status).toBeUndefined()
 })

 it('returns the four property arrays in the response shape', async () => {
 const store = await loadStore(makeDoc([node('pp1', 'pain_point')], []))
 const ctx = makeCtx(store)
 await migrateType({ from_type: 'pain_point', to_type: 'need' }, ctx)
 const result = await migrateProperties({ dry_run: false }, ctx)
 const body = JSON.parse(result.content[0].text)

 expect(body).toHaveProperty('top_level_renames')
 expect(body).toHaveProperty('lifted_properties')
 expect(body).toHaveProperty('dropped_props')
 expect(body).toHaveProperty('dropped_self_referential')
 // Empty arrays when no rules match
 expect(body.top_level_renames).toEqual([])
 expect(body.lifted_properties).toEqual([])
 expect(body.dropped_props).toEqual([])
 expect(body.dropped_self_referential).toEqual([])
 })
})
