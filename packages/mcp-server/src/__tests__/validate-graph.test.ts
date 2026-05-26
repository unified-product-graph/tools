/**
 * Tests for `validate_graph` — full per-node schema-drift report.
 *
 * Pairs with the load-time drift summary (, lib/schema-drift.ts) but
 * returns per-class arrays of node IDs with suggested actions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGEdgeType } from '@unified-product-graph/core'
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

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: 'p1', title: 'validate_graph fixture', stage: 'concept' },
 nodes,
 edges,
 }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-validate-'))
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

describe('validate_graph — clean graph', () => {
 it('returns all-zero summary and empty arrays for a canonical graph', async () => {
 const store = await loadStore(
 makeDoc(
 [
 { id: 'p1', type: 'persona' as UPGEntityType, title: 'Solo Builder' } as UPGBaseNode,
 { id: 'j1', type: 'job' as UPGEntityType, title: 'Ship a product' } as UPGBaseNode,
 ],
 [{ id: 'e1', source: 'p1', target: 'j1', type: 'persona_pursues_job' as UPGEdgeType }],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({}, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.entity_drift).toBe(0)
 expect(body.summary.edge_drift).toBe(0)
 expect(body.entity_drift).toEqual([])
 expect(body.edge_drift).toEqual([])
 })
})

describe('validate_graph — entity_drift', () => {
 it('flags deprecated types with suggested rename', async () => {
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'h1',
 type: 'hypothesis_evidence' as UPGEntityType,
 title: 'Old evidence',
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'entity_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.entity_drift).toBe(1)
 expect(body.entity_drift).toHaveLength(1)
 expect(body.entity_drift[0].type).toBe('hypothesis_evidence')
 expect(body.entity_drift[0].suggested_migration.kind).toBe('rename')
 expect(body.entity_drift[0].suggested_migration.to).toBe('evidence')
 })
})

describe('validate_graph — entity_drift split suggestions', () => {
 it('populates suggested_migration.to from produces[].type, not empty []', async () => {
 // user_story is in UPG_SPLIT_MIGRATIONS['0.2.7'] only (not in UPG_MIGRATIONS),
 // so it hits the split path. Produces: ['task', 'story_statement'] (since v0.4.0,
 // when story_task was collapsed back into task — additive-vocabulary rule).
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'us1',
 type: 'user_story' as UPGEntityType,
 title: 'As a user I want X',
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'entity_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.entity_drift).toHaveLength(1)
 const entry = body.entity_drift[0]
 expect(entry.type).toBe('user_story')
 expect(entry.suggested_migration.kind).toBe('split')
 expect(Array.isArray(entry.suggested_migration.to)).toBe(true)
 expect(entry.suggested_migration.to).not.toHaveLength(0)
 expect(entry.suggested_migration.to).toContain('task')
 expect(entry.suggested_migration.to).toContain('story_statement')
 })
})

describe('validate_graph — edge_drift', () => {
 it('flags non-canonical edges with suggested rename or drop', async () => {
 const store = await loadStore(
 makeDoc(
 [
 { id: 'p1', type: 'product' as UPGEntityType, title: 'Prod' } as UPGBaseNode,
 { id: 'pe', type: 'persona' as UPGEntityType, title: 'Persona' } as UPGBaseNode,
 ],
 [
 {
 id: 'e1',
 source: 'p1',
 target: 'pe',
 type: 'product_contains_persona' as UPGEdgeType,
 },
 ],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'edge_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.edge_drift).toBe(1)
 expect(body.edge_drift).toHaveLength(1)
 expect(body.edge_drift[0].type).toBe('product_contains_persona')
 expect(['rename', 'drop', 'unknown']).toContain(body.edge_drift[0].suggested_migration.kind)
 })
})

describe('validate_graph — top_level_drift', () => {
 it('flags nodes with non-spec top-level fields', async () => {
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'p1',
 type: 'product' as UPGEntityType,
 title: 'Prod',
 lifecycle_status: 'draft',
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'top_level_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.top_level_drift).toBe(1)
 expect(body.top_level_drift).toHaveLength(1)
 expect(body.top_level_drift[0].unknown_fields).toContain('lifecycle_status')
 })
})

describe('validate_graph — self_referential', () => {
 it('flags nodes whose source_id/source_type mirror id/type', async () => {
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'p1',
 type: 'product' as UPGEntityType,
 title: 'Prod',
 source_id: 'p1',
 source_type: 'product',
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'self_referential' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.self_referential).toBe(1)
 expect(body.self_referential[0].id).toBe('p1')
 expect(body.self_referential[0].fields).toEqual(['source_id', 'source_type'])
 })
})

describe('validate_graph — scope filter', () => {
 it('returns only the requested scope arrays', async () => {
 const store = await loadStore(makeDoc([], []))
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'entity_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body).toHaveProperty('entity_drift')
 expect(body).not.toHaveProperty('edge_drift')
 expect(body).not.toHaveProperty('property_drift')
 })

 it('rejects unknown scopes', async () => {
 const store = await loadStore(makeDoc([], []))
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'whatever' }, ctx)
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/Unknown scope/)
 })
})

describe('validate_graph — doctrine fixes', () => {
 it('does not flag canonical `experiment` for split (reinstated as canonical sibling alongside experiment_plan / experiment_run)', async () => {
 // The v0.2.6 split rule for `experiment` is retained for legacy data,
 // but added `experiment` back to UPG_TYPES. Canonical types
 // must never surface as drift.
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'exp1',
 type: 'experiment' as UPGEntityType,
 title: 'Two-week capture trial',
 properties: { status: 'running' },
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'entity_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.entity_drift).toBe(0)
 expect(body.entity_drift).toEqual([])
 })

 it('flags `persona_seeks_desired_outcome` and `persona_faces_switching_cost` with canonical rename suggestions', async () => {
 const store = await loadStore(
 makeDoc(
 [
 { id: 'p1', type: 'persona' as UPGEntityType, title: 'P' } as UPGBaseNode,
 { id: 'do1', type: 'desired_outcome' as UPGEntityType, title: 'DO' } as UPGBaseNode,
 { id: 'sc1', type: 'switching_cost' as UPGEntityType, title: 'SC' } as UPGBaseNode,
 ],
 [
 { id: 'e1', source: 'p1', target: 'do1', type: 'persona_seeks_desired_outcome' as UPGEdgeType },
 { id: 'e2', source: 'p1', target: 'sc1', type: 'persona_faces_switching_cost' as UPGEdgeType },
 ],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'edge_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 const seeks = body.edge_drift.find((e: { type: string }) => e.type === 'persona_seeks_desired_outcome')
 const faces = body.edge_drift.find((e: { type: string }) => e.type === 'persona_faces_switching_cost')
 expect(seeks?.suggested_migration.kind).toBe('rename')
 expect(seeks?.suggested_migration.to).toBe('persona_aspires_to_desired_outcome')
 expect(faces?.suggested_migration.kind).toBe('rename')
 expect(faces?.suggested_migration.to).toBe('persona_incurs_switching_cost')
 })

 it('flags `product_contains_<v0.2.6+ child>` edges with drop suggestions (doctrine extended)', async () => {
 // The cleanup doctrine: product is a portfolio scope, not a typed
 // container. The original audit covered persona/insight/etc.;
 // extends to story_statement / experiment / experiment_run /
 // metric / outcome / decision (v0.2.6+ types not in the original audit).
 const store = await loadStore(
 makeDoc(
 [
 { id: 'pr1', type: 'product' as UPGEntityType, title: 'Prod' } as UPGBaseNode,
 { id: 'ss1', type: 'story_statement' as UPGEntityType, title: 'SS' } as UPGBaseNode,
 { id: 'er1', type: 'experiment_run' as UPGEntityType, title: 'ER' } as UPGBaseNode,
 { id: 'm1', type: 'metric' as UPGEntityType, title: 'M' } as UPGBaseNode,
 ],
 [
 { id: 'e1', source: 'pr1', target: 'ss1', type: 'product_contains_story_statement' as UPGEdgeType },
 { id: 'e2', source: 'pr1', target: 'er1', type: 'product_contains_experiment_run' as UPGEdgeType },
 { id: 'e3', source: 'pr1', target: 'm1', type: 'product_contains_metric' as UPGEdgeType },
 ],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'edge_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.summary.edge_drift).toBe(3)
 for (const edge of body.edge_drift) {
 expect(edge.suggested_migration.kind).toBe('drop')
 }
 })
})

describe('validate_graph — if_changed_since short-circuit', () => {
 it('returns { changed: false } when hash matches', async () => {
 const store = await loadStore(makeDoc([], []))
 const ctx = makeCtx(store)
 const first = JSON.parse((await validateGraph({}, ctx)).content[0].text)
 const second = JSON.parse(
 (await validateGraph({ if_changed_since: first._hash }, ctx)).content[0].text,
 )
 expect(second.changed).toBe(false)
 })
})

describe('validate_graph — F4: property_drift resolves deprecated type aliases', () => {
 it('surfaces property_drift entries for a `kpi` node carrying deprecated quality_* props (kpi → metric alias)', async () => {
 // The `kpi` type is a deprecated alias for `metric`. The UPG_PROPERTY_MIGRATIONS
 // `drop_props` rule is keyed on `metric`, not `kpi`. Without alias resolution the
 // drift lookup returns nothing; with F4 the canonical type is resolved first.
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'rt_metric_drift',
 type: 'kpi' as UPGEntityType,
 title: 'Time-to-first-graph (TTFG)',
 properties: {
 quality_score: 4,
 quality_actionable: true,
 quality_correlated: true,
 proxy_reason: 'TTFG is a proxy for activation quality',
 proxy_confidence: 'medium',
 current_value: 47,
 },
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'property_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)

 // At least the deprecated quality_score / proxy_reason props must fire
 const deprecatedKeys = body.property_drift.map((e: { property: string }) => e.property)
 expect(deprecatedKeys).toContain('quality_score')
 expect(deprecatedKeys).toContain('proxy_reason')
 // All entries reference the on-disk node id
 for (const entry of body.property_drift as Array<{ id: string }>) {
 expect(entry.id).toBe('rt_metric_drift')
 }
 // Summary count must be > 0
 expect(body.summary.property_drift).toBeGreaterThan(0)
 })

 it('does NOT surface property_drift for a canonical `metric` node that has already migrated its properties', async () => {
 const store = await loadStore(
 makeDoc(
 [
 {
 id: 'm1',
 type: 'metric' as UPGEntityType,
 title: 'Activation rate',
 properties: { current_value: 62, target_value: 80, designation: 'north_star' },
 } as UPGBaseNode,
 ],
 [],
 ),
 )
 const ctx = makeCtx(store)
 const result = await validateGraph({ scope: 'property_drift' }, ctx)
 const body = JSON.parse(result.content[0].text)
 expect(body.property_drift).toEqual([])
 expect(body.summary.property_drift).toBe(0)
 })
})
