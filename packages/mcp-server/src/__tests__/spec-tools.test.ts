/**
 * Spec-introspection tools: (round 1) + (round 2) +
 * (round 3) + (approach verbs) + (round 5).
 *
 * Verifies that the spec tools faithfully surface the canonical
 * `@unified-product-graph/core` spec layer (playbooks, approaches,
 * domain guides, frameworks, edge catalogue, regions, lenses, type
 * labels, hierarchy, version, cross-edge types, entity meta,
 * anti-patterns, benchmarks, product stages) and behave correctly on
 * filter / lookup / pagination edge cases.: also exercises the
 * five bare-verb approach handlers (plan / inspect / prioritise / trace /
 * reflect): definition lookups at v0.3.0 returning the family-resemblance
 * envelope.
 */
import { describe, it, expect } from 'vitest'
import {
 UPG_PLAYBOOKS,
 UPG_APPROACHES,
 UPG_DOMAIN_GUIDES,
 UPG_DOMAINS,
 UPG_FRAMEWORKS,
 UPG_EDGE_CATALOG,
 UPG_REGIONS,
 UPG_LENSES,
 UPG_TYPE_LABELS,
 UPG_CROSS_EDGE_TYPES,
 UPG_VERSION,
 MARKDOWN_FORMAT_VERSION,
 UPG_VALID_CHILDREN,
 UPG_ENTITY_META,
 UPG_ENTITY_TO_DOMAIN,
 UPG_ANTI_PATTERNS,
 UPG_COUNT_BENCHMARKS,
 UPG_RELATIONSHIP_BENCHMARKS,
 UPG_RATIO_BENCHMARKS,
 UPG_DOMAIN_ACTIVATION,
 UPG_PRODUCT_STAGES,
 UPG_MIGRATIONS,
 UPG_EDGE_MIGRATIONS,
 UPG_SPLIT_MIGRATIONS,
 UPG_LIFECYCLES,
 UPG_LIFECYCLE_FREE_TYPES,
 UPG_LIFECYCLE_PLANNED_TYPES,
 UPG_SCALES,
 UPG_DOMAIN_RINGS,
 resolveContainmentEdge,
 resolveLabel,
 getVisibleTypes,
 getLens,
 UPG_FRAMEWORK_CATEGORIES,
 UPG_STRUCTURE_PATTERNS,
} from '@unified-product-graph/core'
import {
 listPlaybooks,
 getPlaybook,
 listApproaches,
 getApproach,
 plan,
 prioritise,
 trace,
 reflect,
 listDomains,
 getDomainGuide,
 listFrameworks,
 getFramework,
 listEdgeTypes,
 getEdgeType,
 listRegions,
 getRegion,
 getRegionForEntity,
 getSpecVersion,
 resolveEdgeForPair,
 listCrossEdgeTypes,
 listLenses,
 getLensTool,
 listTypeLabels,
 getTypeLabel,
 getValidChildrenTool,
 listEntityTypes,
 getEntityMeta,
 listAntiPatterns,
 getAntiPattern,
 listBenchmarks,
 listProductStages,
 listTypeMigrations,
 listEdgeMigrations,
 listSplitMigrations,
 listLifecycles,
 getLifecycle,
 listStatusValues,
 listScales,
 getScale,
 listFrameworkCategories,
 listFrameworkStructurePatterns,
 listDomainRings,
 getDomainRing,
} from '../tools/spec.js'
import type { ToolResult, ToolContext } from '../lib/server-context.js'
import {
 createSessionContext,
 createQueryCache,
 readSyncState,
 writeSyncState,
 hashFile,
 syncFilePath,
} from '../lib/server-context.js'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UPGDocument } from '@unified-product-graph/core'

function call(
 handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>,
 args: Record<string, unknown> = {},
): { ok: boolean; body: unknown; raw: ToolResult } {
 // Most spec tools ignore ctx entirely; they read from the spec catalog.
 // Sync approach verbs (plan/prioritise/trace/reflect) need a store for
 // counts/walks; the dedicated approach-execution test file exercises async
 // inspect + rich execution behavior with real fixtures. Spec-tools tests
 // assert envelope shape only.
 const ctx = makeEmptyCtx()
 const result = handler(args, ctx)
 if (result instanceof Promise) {
   throw new Error(
     'spec-tools `call` is sync; use approach-execution.test.ts for async handlers.',
   )
 }
 if (result.isError) return { ok: false, body: result.content[0].text, raw: result }
 return { ok: true, body: JSON.parse(result.content[0].text), raw: result }
}

function makeEmptyCtx(): ToolContext {
 const dir = mkdtempSync(join(tmpdir(), 'upg-spec-tools-empty-'))
 const filePath = join(dir, 'empty.upg')
 const doc: UPGDocument = {
   upg_version: '0.2',
   exported_at: new Date().toISOString(),
   source: { tool: 'test' },
   product: { id: 'p-empty', title: 'Empty test fixture', stage: 'concept' },
   nodes: [],
   edges: [],
 }
 writeFileSync(filePath, JSON.stringify(doc, null, 2))
 const store = new UPGFileStore()
 // Load synchronously is unsupported; return a synchronous shim via init.
 // For tests, the dedicated approach-execution test file uses async setup.
 ;(store as unknown as { doc: UPGDocument; nodeMap: Map<string, unknown>; edgeMap: Map<string, unknown>; edgesByNode: Map<string, Set<string>>; contentHash: string }).doc = doc
 ;(store as unknown as { nodeMap: Map<string, unknown> }).nodeMap = new Map()
 ;(store as unknown as { edgeMap: Map<string, unknown> }).edgeMap = new Map()
 ;(store as unknown as { edgesByNode: Map<string, Set<string>> }).edgesByNode = new Map()
 ;(store as unknown as { contentHash: string }).contentHash = 'empty'
 return {
   store,
   sessionContext: createSessionContext(),
   queryCache: createQueryCache(),
   sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
 }
}

// ── Playbooks ─────────────────────────────────────────────────────

describe('list_playbooks / get_playbook', () => {
 it('list_playbooks returns every canonical playbook by default', () => {
 const { ok, body } = call(listPlaybooks, {})
 expect(ok).toBe(true)
 const b = body as { count: number; playbooks: unknown[] }
 expect(b.count).toBe(UPG_PLAYBOOKS.length)
 expect(b.playbooks).toHaveLength(UPG_PLAYBOOKS.length)
 })

 it('list_playbooks ships 13 playbooks at v0.3.0', () => {
 const { body } = call(listPlaybooks, {})
 const b = body as { count: number }
 expect(b.count).toBe(13)
 })

 it('list_playbooks filters by region', () => {
 const { body } = call(listPlaybooks, { region: 'business_gtm_growth' })
 const b = body as { playbooks: Array<{ region: string }> }
 expect(b.playbooks.length).toBeGreaterThan(0)
 expect(b.playbooks.every((p) => p.region === 'business_gtm_growth')).toBe(true)
 //: Region 8 ships 3 playbooks (1 canonical + 2 specialised).
 expect(b.playbooks).toHaveLength(3)
 })

 it('list_playbooks filters by canonical_only (W1 invariant: exactly 11)', () => {
 const { body } = call(listPlaybooks, { canonical_only: true })
 const b = body as { count: number; playbooks: Array<{ is_canonical?: boolean }> }
 expect(b.count).toBe(UPG_REGIONS.length)
 expect(b.count).toBe(11)
 expect(b.playbooks.every((p) => p.is_canonical === true)).toBe(true)
 })

 it('list_playbooks filters by framework_id', () => {
 //: no playbook is framework-anchored anymore; anchors live on related_framework_ids.
 const { body } = call(listPlaybooks, { framework_id: 'business-model-canvas' })
 const b = body as { playbooks: Array<{ id: string; framework_id?: string }> }
 expect(b.playbooks).toHaveLength(0)
 })

 it('every canonical playbook satisfies W1 (one per region)', () => {
 for (const region of UPG_REGIONS) {
 const matches = UPG_PLAYBOOKS.filter(
 (p) => p.region === region.id && p.is_canonical === true,
 )
 expect(matches).toHaveLength(1)
 }
 })

 it('every framework_id resolves in UPG_FRAMEWORKS', () => {
 const frameworkIds = new Set(UPG_FRAMEWORKS.map((f) => f.id))
 for (const p of UPG_PLAYBOOKS) {
 if (!p.framework_id) continue
 expect(
 frameworkIds.has(p.framework_id),
 `Playbook "${p.id}" references unknown framework "${p.framework_id}"`,
 ).toBe(true)
 }
 })

 it('get_playbook returns the canonical record by id', () => {
 const sample = UPG_PLAYBOOKS[0]
 const { ok, body } = call(getPlaybook, { id: sample.id })
 expect(ok).toBe(true)
 expect((body as { id: string }).id).toBe(sample.id)
 expect((body as { creation_sequence: unknown[] }).creation_sequence).toEqual(sample.creation_sequence)
 })

 it('get_playbook errors on missing id', () => {
 expect(call(getPlaybook, {}).ok).toBe(false)
 })

 it('get_playbook errors on unknown id', () => {
 const { ok, raw } = call(getPlaybook, { id: 'playbook:does-not-exist' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown playbook id/)
 })

 it('get_playbook returns null-error when called with an approach id', () => {
 const { ok, raw } = call(getPlaybook, { id: 'approach:foo' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown playbook id/)
 })
})

// ── Approaches ────────────────────────────────────────────────────

describe('list_approaches / get_approach', () => {
 it('list_approaches returns the 5 canonical approaches', () => {
 const { ok, body } = call(listApproaches, {})
 expect(ok).toBe(true)
 const b = body as { count: number; approaches: Array<{ id: string }> }
 expect(b.count).toBe(5)
 expect(b.approaches.map((a) => a.id)).toEqual([
 'plan',
 'inspect',
 'prioritise',
 'trace',
 'reflect',
 ])
 expect(UPG_APPROACHES).toHaveLength(5)
 })

 it('list_approaches filters by framework_id (discoverability surface)', () => {
 const { ok, body } = call(listApproaches, { framework_id: 'rice-scoring' })
 expect(ok).toBe(true)
 const b = body as { count: number; approaches: Array<{ id: string }> }
 expect(b.count).toBe(1)
 expect(b.approaches[0].id).toBe('prioritise')
 })

 it('get_approach returns the canonical record by bare-verb id', () => {
 const { ok, body } = call(getApproach, { id: 'plan' })
 expect(ok).toBe(true)
 const b = body as { id: string; question_answered: string; signature_hint: string }
 expect(b.id).toBe('plan')
 expect(b.question_answered).toMatch(/build next/i)
 expect(b.signature_hint).toMatch(/coverage_score/)
 })

 it('get_approach errors on missing id', () => {
 expect(call(getApproach, {}).ok).toBe(false)
 })

 it('get_approach errors on unknown id with helpful message', () => {
 const { ok, raw } = call(getApproach, { id: 'survey' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown approach id/)
 expect(raw.content[0].text).toMatch(/plan, inspect, prioritise, trace, reflect/)
 })
})

// ── Approach verbs: envelope shape only ──────────────────────────────
// Rich execution behavior (real scores, real violations, real trails) is
// covered in `approach-execution.test.ts` which uses real graph fixtures.

describe('plan / inspect / prioritise / trace / reflect: envelope shape', () => {
 it('plan returns the family-resemblance envelope with the Plan approach', () => {
 const { ok, body } = call(plan, { region: 'users_needs' })
 expect(ok).toBe(true)
 const b = body as {
 approach_id: string
 scope: string
 generated_at: string
 approach: { id: string; label: string }
 params: { region: string }
 execution_mode: string
 }
 expect(b.approach_id).toBe('plan')
 expect(b.scope).toBe('users_needs')
 expect(b.approach.id).toBe('plan')
 expect(b.approach.label).toBe('Plan')
 expect(b.params.region).toBe('users_needs')
 expect(b.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
 expect(b.execution_mode).toBe('execution_v0_4_0')
 })

 it('plan accepts no region (whole-graph) and echoes scope null', () => {
 const { body } = call(plan, {})
 const b = body as { scope: unknown; params: { region: unknown } }
 expect(b.scope).toBeNull()
 expect(b.params.region).toBeNull()
 })

 it('prioritise requires candidates AND framework_id', () => {
 expect(call(prioritise, {}).ok).toBe(false)
 expect(call(prioritise, { candidates: ['n1'] }).ok).toBe(false)
 expect(call(prioritise, { framework_id: 'rice-scoring' }).ok).toBe(false)
 expect(
 call(prioritise, { candidates: [], framework_id: 'rice-scoring' }).ok,
 ).toBe(false)
 })

 it('prioritise returns the envelope + framework metadata when valid', () => {
 const { ok, body } = call(prioritise, {
 candidates: ['feature:a', 'feature:b'],
 framework_id: 'rice-scoring',
 })
 expect(ok).toBe(true)
 const b = body as {
 approach_id: string
 scope: string[]
 params: { candidates: string[]; framework_id: string }
 framework_resolved: { id: string; name: string } | null
 execution_mode: string
 }
 expect(b.approach_id).toBe('prioritise')
 expect(b.scope).toEqual(['feature:a', 'feature:b'])
 expect(b.framework_resolved?.id).toBe('rice-scoring')
 expect(b.execution_mode).toBe('execution_v0_4_0')
 })

 it('prioritise errors on unknown framework_id', () => {
 const { ok, raw } = call(prioritise, {
 candidates: ['n1'],
 framework_id: 'not-a-framework',
 })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown framework_id/)
 })

 it('trace requires anchor and path', () => {
 expect(call(trace, {}).ok).toBe(false)
 expect(call(trace, { anchor: 'persona:1' }).ok).toBe(false)
 expect(call(trace, { path: ['persona', 'job'] }).ok).toBe(false)
 })

 it('trace rejects edges_override of mismatched length', () => {
 const { ok, raw } = call(trace, {
 anchor: 'persona:1',
 path: ['persona', 'job', 'feature'],
 edges_override: ['persona_pursues_job'],
 })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/edges_override length/)
 })

 it('trace returns the envelope with anchor + path echoed', () => {
 const { ok, body } = call(trace, {
 anchor: 'persona:1',
 path: ['persona', 'job', 'feature'],
 })
 expect(ok).toBe(true)
 const b = body as {
 approach_id: string
 scope: string
 params: { anchor: string; path: string[]; edges_override: unknown }
 execution_mode: string
 }
 expect(b.approach_id).toBe('trace')
 expect(b.scope).toBe('persona:1')
 expect(b.params.path).toEqual(['persona', 'job', 'feature'])
 expect(b.params.edges_override).toBeNull()
 expect(b.execution_mode).toBe('execution_v0_4_0')
 })

 it('reflect accepts no mode (open reflection)', () => {
 const { ok, body } = call(reflect, {})
 expect(ok).toBe(true)
 const b = body as {
 approach_id: string
 params: { scope: unknown; mode: unknown }
 execution_mode: string
 }
 expect(b.approach_id).toBe('reflect')
 expect(b.params.mode).toBeNull()
 expect(b.execution_mode).toBe('execution_v0_4_0')
 })

 it('reflect accepts each canonical mode', () => {
 for (const mode of ['assumptions', 'alternatives', 'blind-spots', 'load-bearing']) {
 const { ok, body } = call(reflect, { mode })
 expect(ok).toBe(true)
 expect((body as { params: { mode: string } }).params.mode).toBe(mode)
 }
 })

 it('reflect rejects an invalid mode with helpful message', () => {
 const { ok, raw } = call(reflect, { mode: 'open' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Invalid mode/)
 expect(raw.content[0].text).toMatch(/assumptions, alternatives, blind-spots, load-bearing/)
 })

 it('every (sync) approach handler stamps approach_id, scope, generated_at, execution_mode', () => {
 const calls = [
 call(plan, {}),
 call(prioritise, { candidates: ['n1'], framework_id: 'rice-scoring' }),
 call(trace, { anchor: 'n1', path: ['persona'] }),
 call(reflect, {}),
 ]
 for (const c of calls) {
 expect(c.ok).toBe(true)
 const b = c.body as {
 approach_id: string
 generated_at: string
 approach: unknown
 execution_mode: string
 }
 expect(b.approach_id).toBeTypeOf('string')
 expect(b.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
 expect(b.approach).toBeDefined()
 expect(b.execution_mode).toMatch(/^execution_v0_4_0$|^definition_lookup_v0_4_0$/)
 }
 })
})

// ── Domains ─────────────────────────────────────────────────────────────────

describe('list_domains / get_domain_guide', () => {
 it('list_domains returns every canonical guide id', () => {
 const { body } = call(listDomains, {})
 const b = body as {
 count: number
 domains: Array<{ domain_id: string; anchor_entity: string }>
 }
 expect(b.count).toBe(UPG_DOMAIN_GUIDES.length)
 const ids = new Set(b.domains.map((d) => d.domain_id))
 for (const g of UPG_DOMAIN_GUIDES) expect(ids.has(g.domain_id)).toBe(true)
 })

 it('get_domain_guide returns the full guide', () => {
 const sample = UPG_DOMAIN_GUIDES.find((g) => g.domain_id === 'market_intelligence')
 expect(sample).toBeDefined()
 if (!sample) return
 const { body } = call(getDomainGuide, { domain_id: 'market_intelligence' })
 const guide = body as typeof sample
 expect(guide.domain_id).toBe('market_intelligence')
 expect(guide.anchor_entity).toBe(sample.anchor_entity)
 expect(guide.creation_sequence).toEqual(sample.creation_sequence)
 expect(guide.patterns).toEqual(sample.patterns)
 expect(guide.required_bridges).toEqual(sample.required_bridges)
 expect(guide.anti_patterns).toEqual(sample.anti_patterns)
 })

 it('get_domain_guide errors on missing or unknown domain_id', () => {
 expect(call(getDomainGuide, {}).ok).toBe(false)
 const { ok, raw } = call(getDomainGuide, { domain_id: 'not_a_domain' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown domain_id/)
 })
})

// ── Frameworks ──────────────────────────────────────────────────────────────

describe('list_frameworks / get_framework', () => {
 it('list_frameworks paginates with a default limit of 50', () => {
 const { body } = call(listFrameworks, {})
 const b = body as { total: number; count: number; next_cursor?: string }
 expect(b.total).toBe(UPG_FRAMEWORKS.length)
 expect(b.count).toBe(Math.min(50, UPG_FRAMEWORKS.length))
 if (UPG_FRAMEWORKS.length > 50) {
 expect(b.next_cursor).toBeTruthy()
 }
 })

 it('list_frameworks respects limit and clamps at 200', () => {
 const small = call(listFrameworks, { limit: 10 }).body as { count: number }
 expect(small.count).toBe(10)
 const huge = call(listFrameworks, { limit: 5000 }).body as { count: number }
 expect(huge.count).toBeLessThanOrEqual(200)
 })

 it('list_frameworks pagination walks the full set', () => {
 const seen = new Set<string>()
 let cursor: string | undefined
 let pages = 0
 do {
 const args: Record<string, unknown> = { limit: 100 }
 if (cursor) args.cursor = cursor
 const body = call(listFrameworks, args).body as {
 frameworks: Array<{ id: string }>
 next_cursor?: string
 }
 for (const f of body.frameworks) seen.add(f.id)
 cursor = body.next_cursor
 pages += 1
 if (pages > 50) throw new Error('runaway pagination')
 } while (cursor)
 expect(seen.size).toBe(UPG_FRAMEWORKS.length)
 })

 it('list_frameworks filters by category before pagination', () => {
 const { body } = call(listFrameworks, { category: 'strategy', limit: 200 })
 const b = body as { total: number; frameworks: Array<{ category: string }> }
 const expected = UPG_FRAMEWORKS.filter((f) => f.category === 'strategy')
 expect(b.total).toBe(expected.length)
 expect(b.frameworks.every((f) => f.category === 'strategy')).toBe(true)
 })

 it('get_framework returns the full record', () => {
 const sample = UPG_FRAMEWORKS[0]
 const { body } = call(getFramework, { id: sample.id })
 expect((body as { id: string }).id).toBe(sample.id)
 expect((body as { education: unknown }).education).toEqual(sample.education)
 })

 it('get_framework errors on missing or unknown id', () => {
 expect(call(getFramework, {}).ok).toBe(false)
 expect(call(getFramework, { id: 'no-such-framework' }).ok).toBe(false)
 })

 it('list_frameworks returns lightweight summaries, not full records (H1)', () => {
 const { body } = call(listFrameworks, {})
 const b = body as {
   total: number
   count: number
   next_cursor?: string
   frameworks: Array<Record<string, unknown>>
 }
 // `total` is the semantic answer to "how many frameworks exist"; `count` is
 // the page size. The catalog passed the default limit of 50 (now 53), so the
 // natural discovery call is truncated — and must say so via next_cursor.
 expect(b.total).toBe(UPG_FRAMEWORKS.length)
 expect(b.count).toBe(Math.min(50, UPG_FRAMEWORKS.length))
 expect(b.next_cursor).toBeDefined()
 const f = b.frameworks[0]
 expect(f).toHaveProperty('id')
 expect(f).toHaveProperty('name')
 expect(f).toHaveProperty('category')
 expect(f).toHaveProperty('description')
 // the heavy four-layer fields must NOT be in the list projection
 expect(f).not.toHaveProperty('data')
 expect(f).not.toHaveProperty('presentation')
 expect(f).not.toHaveProperty('education')
 // the full default list now stays well under the tool-result token cap
 expect(JSON.stringify(b).length).toBeLessThan(60_000)
 })

 it('get_framework names the catalog on an unknown id (L4)', () => {
 const r = call(getFramework, { id: 'no-such-framework' })
 expect(r.ok).toBe(false)
 expect(String(r.body)).toMatch(/rice-scoring/)
 })
})

// ── Edges ───────────────────────────────────────────────────────────────────

describe('list_status_values (#35)', () => {
 it('returns lifecycle phases as status values for a lifecycle type', () => {
 const { body } = call(listStatusValues, { entity_type: 'key_result' })
 const b = body as {
 lifecycle_free: boolean
 initial_status: string
 terminal_statuses: string[]
 values: Array<{ status: string; terminal: boolean }>
 }
 expect(b.lifecycle_free).toBe(false)
 const ids = b.values.map((v) => v.status)
 expect(ids).toContain('on_track')
 expect(ids).toContain('achieved')
 expect(b.initial_status).toBe('on_track')
 expect(b.terminal_statuses).toContain('achieved')
 })

 it('flags a lifecycle-free type with empty values', () => {
 const { body } = call(listStatusValues, { entity_type: 'persona' })
 const b = body as { lifecycle_free: boolean; values: unknown[] }
 expect(b.lifecycle_free).toBe(true)
 expect(b.values).toEqual([])
 })
})

describe('list_edge_types / get_edge_type', () => {
 it('list_edge_types returns every catalogue entry by default', () => {
 const { body } = call(listEdgeTypes, {})
 const b = body as { count: number; edges: Array<{ type: string }> }
 expect(b.count).toBe(Object.keys(UPG_EDGE_CATALOG).length)
 expect(new Set(b.edges.map((e) => e.type)).size).toBe(b.count)
 })

 it('list_edge_types filters by source_type', () => {
 const { body } = call(listEdgeTypes, { source_type: 'persona' })
 const edges = (body as { edges: Array<{ source_type: string }> }).edges
 expect(edges.length).toBeGreaterThan(0)
 expect(edges.every((e) => e.source_type === 'persona')).toBe(true)
 })

 it('list_edge_types ANDs source_type and target_type', () => {
 // Pick a real pair from the catalog.
 const [type, def] = Object.entries(UPG_EDGE_CATALOG)[0] as [
 string,
 { source_type: string; target_type: string },
 ]
 const { body } = call(listEdgeTypes, {
 source_type: def.source_type,
 target_type: def.target_type,
 })
 const edges = (body as {
 edges: Array<{ type: string; source_type: string; target_type: string }>
 }).edges
 expect(edges.some((e) => e.type === type)).toBe(true)
 expect(
 edges.every(
 (e) => e.source_type === def.source_type && e.target_type === def.target_type,
 ),
 ).toBe(true)
 })

 it('get_edge_type returns the catalogue entry by key', () => {
 const [type, def] = Object.entries(UPG_EDGE_CATALOG)[0]
 const { body } = call(getEdgeType, { type })
 expect((body as { type: string }).type).toBe(type)
 expect((body as { forward_verb: string }).forward_verb).toBe(
 (def as { forward_verb: string }).forward_verb,
 )
 })

 it('get_edge_type errors on missing or unknown type', () => {
 expect(call(getEdgeType, {}).ok).toBe(false)
 expect(call(getEdgeType, { type: 'not_an_edge' }).ok).toBe(false)
 })
})

// ── Regions ───────────────────────────────────────────────────────

describe('list_regions / get_region / get_region_for_entity_type', () => {
 it('list_regions returns all 10 canonical regions in order', () => {
 const { ok, body } = call(listRegions, {})
 expect(ok).toBe(true)
 const b = body as {
 count: number
 regions: Array<{ id: string; order: number; entity_count: number }>
 }
 expect(b.count).toBe(UPG_REGIONS.length)
 expect(b.regions).toHaveLength(UPG_REGIONS.length)
 // Order matches the canonical 1..10 sequence.
 expect(b.regions.map((r) => r.order)).toEqual(UPG_REGIONS.map((r) => r.order))
 // Compact summary entity_count matches the canonical entity list length.
 for (let i = 0; i < UPG_REGIONS.length; i++) {
 expect(b.regions[i].entity_count).toBe(UPG_REGIONS[i].entities.length)
 }
 })

 it('get_region returns the full canonical record', () => {
 const sample = UPG_REGIONS[0]
 const { body } = call(getRegion, { id: sample.id })
 const r = body as typeof sample
 expect(r.id).toBe(sample.id)
 expect(r.anchor).toEqual(sample.anchor)
 expect(r.entities).toEqual(sample.entities)
 expect(r.intra_edges).toEqual(sample.intra_edges)
 expect(r.boundary_edges).toEqual(sample.boundary_edges)
 expect(r.composes_atomic_domains).toEqual(sample.composes_atomic_domains)
 })

 it('get_region errors on missing or unknown id', () => {
 expect(call(getRegion, {}).ok).toBe(false)
 const { ok, raw } = call(getRegion, { id: 'not_a_region' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown region id/)
 })

 it('get_region_for_entity_type resolves the containing region', () => {
 // Pick a known entity type from the first region's entity list.
 const sample = UPG_REGIONS[0]
 const memberType = sample.entities[0].type
 const { body } = call(getRegionForEntity, { entity_type: memberType })
 expect((body as { id: string }).id).toBe(sample.id)
 })

 it('get_region_for_entity_type errors on unknown entity_type', () => {
 expect(call(getRegionForEntity, {}).ok).toBe(false)
 const { ok, raw } = call(getRegionForEntity, { entity_type: 'not_a_real_type' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/No region contains entity_type/)
 })
})

// ── Spec version ──────────────────────────────────────────────────

describe('get_spec_version', () => {
 it('returns the canonical version block', () => {
 const { ok, body } = call(getSpecVersion, {})
 expect(ok).toBe(true)
 const b = body as {
 upg_version: string
 markdown_format_version: string
 entity_count: number
 edge_count: number
 domain_count: number
 region_count: number
 }
 expect(b.upg_version).toBe(UPG_VERSION)
 expect(b.markdown_format_version).toBe(MARKDOWN_FORMAT_VERSION)
 expect(b.region_count).toBe(UPG_REGIONS.length)
 expect(b.edge_count).toBe(Object.keys(UPG_EDGE_CATALOG).length)
 expect(b.entity_count).toBeGreaterThan(0)
 expect(b.domain_count).toBeGreaterThan(0)
 })
})

// ── Edge resolver ─────────────────────────────────────────────────

describe('resolve_edge_for_pair', () => {
 it('resolves a known catalogued pair to its canonical edge type', () => {
 // Pick a real pair from the catalog.
 const [type, def] = Object.entries(UPG_EDGE_CATALOG)[0] as [
 string,
 { source_type: string; target_type: string },
 ]
 const { body } = call(resolveEdgeForPair, {
 source_type: def.source_type,
 target_type: def.target_type,
 })
 const b = body as { edge_type: string | null }
 // The resolver may return any edge that matches the pair (containment or
 // semantic); assert it's a valid catalog key for this pair via the helper.
 expect(b.edge_type).toBe(resolveContainmentEdge(def.source_type, def.target_type))
 // Sanity: at minimum, the catalog entry for `type` shares the pair.
 expect(typeof type).toBe('string')
 })

 it('still resolves the deliberate-only defer edges for EXPLICIT resolution (0.17.4)', () => {
 // resolve_edge_for_pair is the explicit resolution path. It MUST keep returning
 // objective_defers_feature / objective_defers_capability even though the import
 // adapters filter these out of generic-parentage inference (the spec resolver is
 // untouched; only the adapter layer skips them).
 const feat = call(resolveEdgeForPair, { source_type: 'objective', target_type: 'feature' })
 expect((feat.body as { edge_type: string | null }).edge_type).toBe('objective_defers_feature')
 const cap = call(resolveEdgeForPair, { source_type: 'objective', target_type: 'capability' })
 expect((cap.body as { edge_type: string | null }).edge_type).toBe('objective_defers_capability')
 })

 it('returns edge_type null for an uncatalogued pair', () => {
 const { body } = call(resolveEdgeForPair, {
 source_type: 'not_a_type_x',
 target_type: 'not_a_type_y',
 })
 expect((body as { edge_type: string | null }).edge_type).toBeNull()
 })

 it('errors on missing source_type or target_type', () => {
 expect(call(resolveEdgeForPair, {}).ok).toBe(false)
 expect(call(resolveEdgeForPair, { source_type: 'persona' }).ok).toBe(false)
 expect(call(resolveEdgeForPair, { target_type: 'feature' }).ok).toBe(false)
 })

 it('surfaces cross_product_scope: "curated" for a curated resolved pair (model-time visibility)', () => {
 // product_pursues_outcome is a curated cross type.
 const { body } = call(resolveEdgeForPair, { source_type: 'product', target_type: 'outcome' })
 const b = body as { edge_type: string | null; cross_product_scope?: string }
 expect(b.edge_type).toBe('product_pursues_outcome')
 expect(b.cross_product_scope).toBe('curated')
 })

 it('surfaces cross_product_scope: "provisional" for an uncurated gate-passing pair', () => {
 // capability_implemented_by_feature is not curated, but `capability` is
 // portfolio-shared, so the edge is provisional (allowed with a write-time warning).
 const { body } = call(resolveEdgeForPair, { source_type: 'capability', target_type: 'feature' })
 const b = body as { edge_type: string | null; cross_product_scope?: string }
 expect(b.edge_type).toBe('capability_implemented_by_feature')
 expect(b.cross_product_scope).toBe('provisional')
 })

 it('omits cross_product_scope for a resident resolved pair (both endpoints non-shared)', () => {
 // feature_area_contains_feature: neither endpoint is portfolio-shared → resident.
 const { body } = call(resolveEdgeForPair, { source_type: 'feature_area', target_type: 'feature' })
 const b = body as { edge_type: string | null; cross_product_scope?: string }
 expect(b.edge_type).toBe('feature_area_contains_feature')
 expect(b.cross_product_scope).toBeUndefined()
 expect(Object.prototype.hasOwnProperty.call(b, 'cross_product_scope')).toBe(false)
 })
})

// ── Cross-edge types ──────────────────────────────────────────────

describe('list_cross_edge_types', () => {
 it('returns the canonical cross-edge types', () => {
 const { ok, body } = call(listCrossEdgeTypes, {})
 expect(ok).toBe(true)
 const b = body as { count: number; types: readonly string[] }
 expect(b.count).toBe(UPG_CROSS_EDGE_TYPES.length)
 expect(b.types).toEqual(UPG_CROSS_EDGE_TYPES)
 })
})

// ── Lenses ────────────────────────────────────────────────────────

describe('list_lenses / get_lens', () => {
 it('list_lenses returns every canonical lens summary', () => {
 const { ok, body } = call(listLenses, {})
 expect(ok).toBe(true)
 const b = body as {
 count: number
 lenses: Array<{ id: string; visible_domain_count: number }>
 }
 expect(b.count).toBe(UPG_LENSES.length)
 expect(new Set(b.lenses.map((l) => l.id)).size).toBe(UPG_LENSES.length)
 })

 it('get_lens returns the full record plus resolved visible_types', () => {
 const sample = UPG_LENSES[0]
 const { ok, body } = call(getLensTool, { id: sample.id })
 expect(ok).toBe(true)
 const b = body as { id: string; visible_types: string[] }
 expect(b.id).toBe(sample.id)
 expect(b.visible_types).toEqual(getVisibleTypes(getLens(sample.id)!))
 })

 it('get_lens errors on missing or unknown id', () => {
 expect(call(getLensTool, {}).ok).toBe(false)
 const { ok, raw } = call(getLensTool, { id: 'not_a_lens' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown lens id/)
 })
})

// ── Type labels ───────────────────────────────────────────────────

describe('list_type_labels / get_type_label', () => {
 it('list_type_labels paginates with a default limit of 100', () => {
 const { body } = call(listTypeLabels, {})
 const b = body as { total: number; count: number; next_cursor?: string }
 expect(b.total).toBe(UPG_TYPE_LABELS.length)
 expect(b.count).toBe(Math.min(100, UPG_TYPE_LABELS.length))
 if (UPG_TYPE_LABELS.length > 100) expect(b.next_cursor).toBeTruthy()
 })

 it('list_type_labels pagination walks the full set', () => {
 const seen = new Set<string>()
 let cursor: string | undefined
 let pages = 0
 do {
 const args: Record<string, unknown> = { limit: 200 }
 if (cursor) args.cursor = cursor
 const body = call(listTypeLabels, args).body as {
 labels: Array<{ id: string }>
 next_cursor?: string
 }
 for (const l of body.labels) seen.add(l.id)
 cursor = body.next_cursor
 pages += 1
 if (pages > 50) throw new Error('runaway pagination')
 } while (cursor)
 expect(seen.size).toBe(UPG_TYPE_LABELS.length)
 })

 it('list_type_labels clamps limit at 500', () => {
 const huge = call(listTypeLabels, { limit: 5000 }).body as { count: number }
 expect(huge.count).toBeLessThanOrEqual(500)
 })

 it('get_type_label returns the canonical entry plus resolved label', () => {
 const sample = UPG_TYPE_LABELS[0]
 const { body } = call(getTypeLabel, { entity_type: sample.id })
 const b = body as { id: string; canonical_label: string; resolved_label: string }
 expect(b.id).toBe(sample.id)
 expect(b.canonical_label).toBe(sample.canonical_label)
 expect(b.resolved_label).toBe(resolveLabel(sample.id))
 })

 it('get_type_label resolves framework_id when provided', () => {
 // Find a label that has at least one framework_label.
 const sample = UPG_TYPE_LABELS.find(
 (l) => Object.keys(l.framework_labels).length > 0,
 )
 expect(sample).toBeDefined()
 if (!sample) return
 const fwId = Object.keys(sample.framework_labels)[0]
 const { body } = call(getTypeLabel, {
 entity_type: sample.id,
 framework_id: fwId,
 })
 expect((body as { resolved_label: string }).resolved_label).toBe(
 sample.framework_labels[fwId],
 )
 })

 it('get_type_label errors on missing or unknown entity_type', () => {
 expect(call(getTypeLabel, {}).ok).toBe(false)
 const { ok, raw } = call(getTypeLabel, { entity_type: 'not_a_type' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown entity_type/)
 })
})

// ── Hierarchy ─────────────────────────────────────────────────────

describe('get_valid_children', () => {
 it('returns the canonical valid children for a known parent type', () => {
 const parent = Object.keys(UPG_VALID_CHILDREN)[0]
 const expected = UPG_VALID_CHILDREN[parent]
 const { body } = call(getValidChildrenTool, { parent_type: parent })
 const b = body as { parent_type: string; valid_children: string[] }
 expect(b.parent_type).toBe(parent)
 expect(b.valid_children).toEqual(expected)
 })

 it('returns an empty array for unknown parent_type', () => {
 const { body } = call(getValidChildrenTool, { parent_type: 'not_a_type_zzz' })
 expect((body as { valid_children: string[] }).valid_children).toEqual([])
 })

 it('errors on missing parent_type', () => {
 expect(call(getValidChildrenTool, {}).ok).toBe(false)
 })
})

// ── Domains: extended ─────────────────────────────────────────────

describe('list_domains: with_guide_only', () => {
 it('with_guide_only: false returns every atomic domain', () => {
 const { ok, body } = call(listDomains, { with_guide_only: false })
 expect(ok).toBe(true)
 const b = body as {
 count: number
 domains: Array<{
 domain_id: string
 label: string
 description: string
 types: readonly string[]
 has_guide: boolean
 }>
 }
 expect(b.count).toBe(UPG_DOMAINS.length)
 expect(b.domains).toHaveLength(UPG_DOMAINS.length)
 // Every atomic-domain id appears.
 const ids = new Set(b.domains.map((d) => d.domain_id))
 for (const d of UPG_DOMAINS) expect(ids.has(d.id)).toBe(true)
 // has_guide is true for every domain that has a UPGDomainUsageGuide.
 const guideIds = new Set<string>(UPG_DOMAIN_GUIDES.map((g) => g.domain_id))
 for (const row of b.domains) {
 expect(row.has_guide).toBe(guideIds.has(row.domain_id))
 }
 })

 it('default behaviour preserved (with_guide_only defaults to true)', () => {
 const { body } = call(listDomains, {})
 const b = body as { count: number; domains: Array<{ domain_id: string }> }
 expect(b.count).toBe(UPG_DOMAIN_GUIDES.length)
 // Each row carries the guide-shape (no `label` / `types` keys).
 const sample = b.domains[0] as Record<string, unknown>
 expect(sample.label).toBeUndefined()
 expect(sample.types).toBeUndefined()
 })
})

// ── Entity meta + types ───────────────────────────────────────────

describe('list_entity_types / get_entity_meta', () => {
 it('list_entity_types paginates with default limit 50', () => {
 const { ok, body } = call(listEntityTypes, {})
 expect(ok).toBe(true)
 const b = body as { total: number; count: number; next_cursor?: string }
 expect(b.total).toBe(UPG_ENTITY_META.length)
 expect(b.count).toBe(Math.min(50, UPG_ENTITY_META.length))
 if (UPG_ENTITY_META.length > 50) expect(b.next_cursor).toBeTruthy()
 })

 it('list_entity_types pagination walks the full set', () => {
 const seen = new Set<string>()
 let cursor: string | undefined
 let pages = 0
 do {
 const args: Record<string, unknown> = { limit: 200 }
 if (cursor) args.cursor = cursor
 const body = call(listEntityTypes, args).body as {
 types: Array<{ name: string }>
 next_cursor?: string
 }
 for (const t of body.types) seen.add(t.name)
 cursor = body.next_cursor
 pages += 1
 if (pages > 50) throw new Error('runaway pagination')
 } while (cursor)
 expect(seen.size).toBe(UPG_ENTITY_META.length)
 })

 it('list_entity_types clamps limit at 200', () => {
 const huge = call(listEntityTypes, { limit: 5000 }).body as { count: number }
 expect(huge.count).toBeLessThanOrEqual(200)
 })

 it('list_entity_types filters by maturity', () => {
 const { body } = call(listEntityTypes, { maturity: 'deprecated', limit: 200 })
 const b = body as { total: number; types: Array<{ maturity: string }> }
 const expected = UPG_ENTITY_META.filter((m) => m.maturity === 'deprecated')
 expect(b.total).toBe(expected.length)
 expect(b.types.every((t) => t.maturity === 'deprecated')).toBe(true)
 })

 it('list_entity_types deprecated:true short-cut keeps only deprecated', () => {
 const { body } = call(listEntityTypes, { deprecated: true, limit: 200 })
 const b = body as { types: Array<{ maturity: string }> }
 expect(b.types.every((t) => t.maturity === 'deprecated')).toBe(true)
 })

 it('list_entity_types deprecated:false excludes deprecated and removed', () => {
 const { body } = call(listEntityTypes, { deprecated: false, limit: 500 })
 const b = body as { types: Array<{ maturity: string }> }
 expect(b.types.every((t) => t.maturity !== 'deprecated' && t.maturity !== 'removed')).toBe(
 true,
 )
 })

 it('list_entity_types filters by domain', () => {
 const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>
 const { body } = call(listEntityTypes, { domain: 'user', limit: 200 })
 const b = body as { types: Array<{ name: string; domain_id: string | null }> }
 expect(b.types.length).toBeGreaterThan(0)
 expect(b.types.every((t) => t.domain_id === 'user')).toBe(true)
 // Sanity-check at least one known type lives in `user`.
 expect(typeToDomain['persona']).toBe('user')
 expect(b.types.some((t) => t.name === 'persona')).toBe(true)
 })

 it('list_entity_types includes domain_id in each row', () => {
 const { body } = call(listEntityTypes, { limit: 5 })
 const b = body as { types: Array<{ name: string; domain_id: string | null }> }
 for (const t of b.types) {
 // domain_id is either a string or null, never undefined.
 expect(t.domain_id === null || typeof t.domain_id === 'string').toBe(true)
 }
 })

 it('get_entity_meta returns the canonical record + domain_id', () => {
 const { body } = call(getEntityMeta, { name: 'persona' })
 const b = body as {
 name: string
 type_id: string
 maturity: string
 domain_id: string | null
 }
 expect(b.name).toBe('persona')
 expect(b.type_id).toBe('ent_016')
 expect(b.maturity).toBe('stable')
 expect(b.domain_id).toBe('user')
 })

 it('get_entity_meta surfaces replacement for deprecated types', () => {
 const { body } = call(getEntityMeta, { name: 'pain_point' })
 const b = body as { maturity: string; replacement?: string }
 expect(b.maturity).toBe('deprecated')
 expect(b.replacement).toBe('need')
 })

 it('get_entity_meta errors on missing or unknown name', () => {
 expect(call(getEntityMeta, {}).ok).toBe(false)
 const { ok, raw } = call(getEntityMeta, { name: 'not_a_real_type' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown entity type/)
 })
})

// ── Anti-patterns ─────────────────────────────────────────────────

describe('list_anti_patterns / get_anti_pattern', () => {
 it('list_anti_patterns returns every curated entry by default', () => {
 const { ok, body } = call(listAntiPatterns, {})
 expect(ok).toBe(true)
 const b = body as { total: number; count: number; anti_patterns: Array<{ id: string }> }
 expect(b.total).toBe(UPG_ANTI_PATTERNS.length)
 expect(b.count).toBe(Math.min(50, UPG_ANTI_PATTERNS.length))
 expect(new Set(b.anti_patterns.map((p) => p.id)).size).toBe(b.count)
 })

 it('list_anti_patterns filters by severity', () => {
 const { body } = call(listAntiPatterns, { severity: 'high', limit: 200 })
 const b = body as { total: number; anti_patterns: Array<{ severity: string }> }
 const expected = UPG_ANTI_PATTERNS.filter((p) => p.severity === 'high')
 expect(b.total).toBe(expected.length)
 expect(b.anti_patterns.every((p) => p.severity === 'high')).toBe(true)
 })

 it('list_anti_patterns filters by stage', () => {
 const { body } = call(listAntiPatterns, { stage: 'launch', limit: 200 })
 const b = body as { anti_patterns: Array<{ stages: readonly string[] }> }
 expect(b.anti_patterns.every((p) => p.stages.includes('launch'))).toBe(true)
 })

 it('list_anti_patterns clamps limit at 200', () => {
 const huge = call(listAntiPatterns, { limit: 5000 }).body as { count: number }
 expect(huge.count).toBeLessThanOrEqual(200)
 })

 it('get_anti_pattern returns the full curated body', () => {
 const sample = UPG_ANTI_PATTERNS[0]
 const { body } = call(getAntiPattern, { id: sample.id })
 const b = body as typeof sample
 expect(b.id).toBe(sample.id)
 expect(b.severity).toBe(sample.severity)
 expect(b.structured_condition).toEqual(sample.structured_condition)
 expect(b.stages).toEqual(sample.stages)
 })

 it('get_anti_pattern errors on missing or unknown id', () => {
 expect(call(getAntiPattern, {}).ok).toBe(false)
 const { ok, raw } = call(getAntiPattern, { id: 'not-a-real-pattern' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown anti-pattern id/)
 })
})

// ── Benchmarks ────────────────────────────────────────────────────

describe('list_benchmarks', () => {
 it('errors when kind is missing', () => {
 expect(call(listBenchmarks, {}).ok).toBe(false)
 })

 it('errors when kind is unknown', () => {
 const { ok, raw } = call(listBenchmarks, { kind: 'not_a_kind' })
 expect(ok).toBe(false)
 expect(raw.content[0].text).toMatch(/Unknown kind/)
 })

 it('kind=count returns UPG_COUNT_BENCHMARKS', () => {
 const { ok, body } = call(listBenchmarks, { kind: 'count' })
 expect(ok).toBe(true)
 const b = body as {
 kind: string
 total: number
 count: number
 benchmarks: typeof UPG_COUNT_BENCHMARKS
 }
 expect(b.kind).toBe('count')
 expect(b.total).toBe(UPG_COUNT_BENCHMARKS.length)
 expect(b.count).toBe(UPG_COUNT_BENCHMARKS.length)
 })

 it('kind=count filters by domain', () => {
 const { body } = call(listBenchmarks, { kind: 'count', domain: 'strategy' })
 const b = body as { benchmarks: Array<{ domain: string }> }
 expect(b.benchmarks.length).toBeGreaterThan(0)
 expect(b.benchmarks.every((bm) => bm.domain === 'strategy')).toBe(true)
 })

 it('kind=count filters by stage (drops rows whose range at stage is null)', () => {
 const { body } = call(listBenchmarks, { kind: 'count', stage: 'concept' })
 const b = body as { benchmarks: Array<{ concept: { min: number; max: number } | null }> }
 expect(b.benchmarks.every((bm) => bm.concept !== null)).toBe(true)
 })

 it('kind=relationship returns UPG_RELATIONSHIP_BENCHMARKS', () => {
 const { body } = call(listBenchmarks, { kind: 'relationship' })
 const b = body as { kind: string; total: number; benchmarks: unknown[] }
 expect(b.kind).toBe('relationship')
 expect(b.total).toBe(UPG_RELATIONSHIP_BENCHMARKS.length)
 expect(b.benchmarks).toHaveLength(UPG_RELATIONSHIP_BENCHMARKS.length)
 })

 it('kind=relationship filters by stage', () => {
 const { body } = call(listBenchmarks, { kind: 'relationship', stage: 'build' })
 const b = body as { benchmarks: Array<{ stages: string[] }> }
 expect(b.benchmarks.every((bm) => bm.stages.includes('build'))).toBe(true)
 })

 it('kind=ratio returns UPG_RATIO_BENCHMARKS', () => {
 const { body } = call(listBenchmarks, { kind: 'ratio' })
 const b = body as { kind: string; total: number; benchmarks: unknown[] }
 expect(b.kind).toBe('ratio')
 expect(b.total).toBe(UPG_RATIO_BENCHMARKS.length)
 expect(b.benchmarks).toHaveLength(UPG_RATIO_BENCHMARKS.length)
 })

 it('kind=domain_activation returns UPG_DOMAIN_ACTIVATION', () => {
 const { body } = call(listBenchmarks, { kind: 'domain_activation' })
 const b = body as { kind: string; total: number; benchmarks: unknown[] }
 expect(b.kind).toBe('domain_activation')
 expect(b.total).toBe(UPG_DOMAIN_ACTIVATION.length)
 expect(b.benchmarks).toHaveLength(UPG_DOMAIN_ACTIVATION.length)
 })

 it('kind=domain_activation filters by domain', () => {
 const { body } = call(listBenchmarks, {
 kind: 'domain_activation',
 domain: 'strategy',
 })
 const b = body as { benchmarks: Array<{ domain_id: string }> }
 expect(b.benchmarks.length).toBeGreaterThan(0)
 expect(b.benchmarks.every((bm) => bm.domain_id === 'strategy')).toBe(true)
 })
})

// ── Product stages ────────────────────────────────────────────────

describe('list_product_stages', () => {
 it('returns the canonical 9-stage enum in order', () => {
 const { ok, body } = call(listProductStages, {})
 expect(ok).toBe(true)
 const b = body as { count: number; stages: readonly string[] }
 expect(b.count).toBe(UPG_PRODUCT_STAGES.length)
 expect(b.count).toBe(9)
 expect(b.stages).toEqual(UPG_PRODUCT_STAGES)
 // Order: earliest → latest.
 expect(b.stages[0]).toBe('concept')
 expect(b.stages[b.stages.length - 1]).toBe('sunset')
 })
})


// ── Spec introspection round 5 ────────────────────────────────────

// ── Migrations ──────────────────────────────────────────────────────────────

describe('list_type_migrations', () => {
 it('returns all type migrations across versions', () => {
 const { ok, body } = call(listTypeMigrations, {})
 expect(ok).toBe(true)
 const b = body as { migrations: Array<{ from: string; to: string; since: string }>; total: number }
 expect(b.total).toBeGreaterThan(0)
 expect(b.migrations).toHaveLength(b.total)
 for (const m of b.migrations) {
 expect(typeof m.from).toBe('string')
 expect(typeof m.to).toBe('string')
 expect(typeof m.since).toBe('string')
 }
 })

 it('total matches the flat expansion of UPG_MIGRATIONS', () => {
 const expectedTotal = Object.values(UPG_MIGRATIONS).reduce((acc, arr) => acc + arr.length, 0)
 const { body } = call(listTypeMigrations, {})
 const b = body as { total: number }
 expect(b.total).toBe(expectedTotal)
 })

 it('from_type filter narrows to matching entries', () => {
 const { body } = call(listTypeMigrations, { from_type: 'pain_point' })
 const b = body as { migrations: Array<{ from: string; to: string; since: string }>; total: number }
 expect(b.total).toBeGreaterThan(0)
 expect(b.migrations.every((m) => m.from === 'pain_point')).toBe(true)
 })

 it('from_type filter returns empty when type is not deprecated', () => {
 const { body } = call(listTypeMigrations, { from_type: 'persona' })
 const b = body as { total: number }
 expect(b.total).toBe(0)
 })
})

describe('list_edge_migrations', () => {
 it('returns all edge migrations across versions', () => {
 const { ok, body } = call(listEdgeMigrations, {})
 expect(ok).toBe(true)
 const b = body as { migrations: Array<{ kind: string; from: string; since: string }>; total: number }
 expect(b.total).toBeGreaterThan(0)
 expect(b.migrations).toHaveLength(b.total)
 for (const m of b.migrations) {
 expect(['rename', 'drop']).toContain(m.kind)
 expect(typeof m.from).toBe('string')
 expect(typeof m.since).toBe('string')
 }
 })

 it('total matches the flat expansion of UPG_EDGE_MIGRATIONS', () => {
 const expectedTotal = Object.values(UPG_EDGE_MIGRATIONS).reduce((acc, arr) => acc + arr.length, 0)
 const { body } = call(listEdgeMigrations, {})
 const b = body as { total: number }
 expect(b.total).toBe(expectedTotal)
 })

 it('from_edge filter narrows to matching entry', () => {
 const { body } = call(listEdgeMigrations, { from_edge: 'persona_has_jtbd' })
 const b = body as { migrations: Array<{ kind: string; from: string; to?: string }>; total: number }
 expect(b.total).toBeGreaterThan(0)
 expect(b.migrations.every((m) => m.from === 'persona_has_jtbd')).toBe(true)
 expect(b.migrations[0]?.kind).toBe('rename')
 expect(b.migrations[0]?.to).toBe('persona_pursues_job')
 })

 it('from_edge filter returns empty for unknown edge', () => {
 const { body } = call(listEdgeMigrations, { from_edge: 'totally_unknown_edge_type' })
 const b = body as { total: number }
 expect(b.total).toBe(0)
 })
})

describe('list_split_migrations', () => {
 it('returns all split migrations', () => {
 const { ok, body } = call(listSplitMigrations, {})
 expect(ok).toBe(true)
 const b = body as { splits: Array<{ from: string; since: string }>; total: number }
 const expectedTotal = Object.values(UPG_SPLIT_MIGRATIONS).reduce((acc, arr) => acc + arr.length, 0)
 expect(b.total).toBe(expectedTotal)
 expect(b.splits).toHaveLength(b.total)
 for (const s of b.splits) {
 expect(typeof s.from).toBe('string')
 expect(typeof s.since).toBe('string')
 }
 })

 it('includes the experiment split (0.2.6)', () => {
 const { body } = call(listSplitMigrations, {})
 const b = body as { splits: Array<{ from: string; since: string }> }
 const experimentSplit = b.splits.find((s) => s.from === 'experiment')
 expect(experimentSplit).toBeDefined()
 expect(experimentSplit?.since).toBe('0.2.6')
 })
})

// ── Lifecycles ──────────────────────────────────────────────────────────────

describe('list_lifecycles / get_lifecycle', () => {
 it('list_lifecycles returns all UPG_LIFECYCLES with free/planned sets', () => {
 const { ok, body } = call(listLifecycles, {})
 expect(ok).toBe(true)
 const b = body as {
 total: number
 lifecycles: Array<{ entity_type: string }>
 free_types: string[]
 planned_types: string[]
 }
 expect(b.total).toBe(UPG_LIFECYCLES.length)
 expect(b.lifecycles).toHaveLength(UPG_LIFECYCLES.length)
 expect(Array.isArray(b.free_types)).toBe(true)
 expect(Array.isArray(b.planned_types)).toBe(true)
 expect(b.free_types.length).toBe(UPG_LIFECYCLE_FREE_TYPES.size)
 expect(b.planned_types.length).toBe(UPG_LIFECYCLE_PLANNED_TYPES.size)
 })

 it('list_lifecycles entity_type filter returns at most one entry', () => {
 const { body } = call(listLifecycles, { entity_type: 'feature' })
 const b = body as { total: number; lifecycles: Array<{ entity_type: string }> }
 expect(b.total).toBe(1)
 expect(b.lifecycles[0]?.entity_type).toBe('feature')
 })

 it('list_lifecycles lifecycle_only omits free/planned lists', () => {
 // post-fix the handler omits free_types + planned_types
 // entirely (matching the wire-shape `description`). Pre-fix it
 // returned empty arrays; the keys-present-but-empty shape is what
 // this test used to assert via `.toHaveLength(0)`. Pinning the new
 // omit shape here so it can't drift back.
 const { body } = call(listLifecycles, { lifecycle_only: true })
 const b = body as Record<string, unknown>
 expect('free_types' in b).toBe(false)
 expect('planned_types' in b).toBe(false)
 expect(Array.isArray(b.lifecycles)).toBe(true)
 })

 it('list_lifecycles entity_type for unknown type returns empty list', () => {
 const { body } = call(listLifecycles, { entity_type: 'totally_unknown_type_xyz' })
 const b = body as { total: number }
 expect(b.total).toBe(0)
 })

 it('get_lifecycle returns the full lifecycle for a known type', () => {
 const { ok, body } = call(getLifecycle, { entity_type: 'feature' })
 expect(ok).toBe(true)
 const b = body as { entity_type: string; initial_phase: string; terminal_phases: string[]; phases: unknown[] }
 expect(b.entity_type).toBe('feature')
 expect(typeof b.initial_phase).toBe('string')
 expect(Array.isArray(b.terminal_phases)).toBe(true)
 expect(Array.isArray(b.phases)).toBe(true)
 expect(b.phases.length).toBeGreaterThan(0)
 })

 it('get_lifecycle returns descriptive error for a lifecycle-free type', () => {
 const { ok, body } = call(getLifecycle, { entity_type: 'persona' })
 expect(ok).toBe(false)
 const txt = body as string
 expect(txt).toContain('persona')
 expect(txt).toContain('lifecycle-free')
 })

 it('get_lifecycle returns descriptive error for unknown type', () => {
 const { ok, body } = call(getLifecycle, { entity_type: 'totally_unknown_xyz' })
 expect(ok).toBe(false)
 const txt = body as string
 expect(txt).toContain('No lifecycle defined')
 })

 it('get_lifecycle returns error when entity_type is missing', () => {
 const { ok } = call(getLifecycle, {})
 expect(ok).toBe(false)
 })
})

// ── Scales ──────────────────────────────────────────────────────────────────

describe('list_scales / get_scale', () => {
 it('list_scales returns all spec-defined scales', () => {
 const { ok, body } = call(listScales, {})
 expect(ok).toBe(true)
 const b = body as { scales: Array<{ id: string; label: string }>; total: number }
 const expectedTotal = Object.keys(UPG_SCALES).length
 expect(b.total).toBe(expectedTotal)
 expect(b.scales).toHaveLength(expectedTotal)
 for (const s of b.scales) {
 expect(typeof s.id).toBe('string')
 expect(typeof s.label).toBe('string')
 }
 })

 it('get_scale returns the full scale definition for a known id', () => {
 const { ok, body } = call(getScale, { id: 'reach_5' })
 expect(ok).toBe(true)
 const b = body as { id: string; label: string; min: number; max: number; points: unknown[] }
 expect(b.id).toBe('reach_5')
 expect(typeof b.label).toBe('string')
 expect(b.min).toBe(1)
 expect(b.max).toBe(5)
 expect(b.points.length).toBe(5)
 })

 it('get_scale returns error for unknown id', () => {
 const { ok, body } = call(getScale, { id: 'no_such_scale_xyz' })
 expect(ok).toBe(false)
 expect(body as string).toContain('Scale not found')
 })

 it('get_scale returns error when id is missing', () => {
 const { ok } = call(getScale, {})
 expect(ok).toBe(false)
 })
})

// ── Framework metadata ────────────────────────────────────────────

describe('list_framework_categories', () => {
 it('returns the canonical framework category list', () => {
 const { ok, body } = call(listFrameworkCategories, {})
 expect(ok).toBe(true)
 const b = body as { categories: string[]; total: number }
 expect(b.total).toBe(UPG_FRAMEWORK_CATEGORIES.length)
 expect(b.categories).toEqual(UPG_FRAMEWORK_CATEGORIES)
 expect(b.categories).toContain('strategy')
 expect(b.categories).toContain('prioritization')
 expect(b.categories).toContain('discovery')
 expect(b.categories).toContain('growth')
 })
})

describe('list_framework_structure_patterns', () => {
 it('returns the canonical structure pattern list', () => {
 const { ok, body } = call(listFrameworkStructurePatterns, {})
 expect(ok).toBe(true)
 const b = body as { patterns: string[]; total: number }
 expect(b.total).toBe(UPG_STRUCTURE_PATTERNS.length)
 expect(b.patterns).toEqual(UPG_STRUCTURE_PATTERNS)
 expect(b.patterns).toContain('tree')
 expect(b.patterns).toContain('matrix')
 expect(b.patterns).toContain('funnel')
 expect(b.patterns).toContain('collection')
 })
})

// ── Domain rings ──────────────────────────────────────────────────

describe('list_domain_rings / get_domain_ring', () => {
 it('list_domain_rings returns all 7 rings in canonical order', () => {
 const { ok, body } = call(listDomainRings, {})
 expect(ok).toBe(true)
 const b = body as { rings: Array<{ id: string; label: string; domain_ids: string[] }>; total: number }
 expect(b.total).toBe(7)
 expect(b.rings).toHaveLength(7)
 expect(b.rings).toEqual(UPG_DOMAIN_RINGS)
 expect(b.rings[0]?.id).toBe('nucleus')
 expect(b.rings[b.rings.length - 1]?.id).toBe('extend')
 })

 it('list_domain_rings every ring has id, label, description, domain_ids', () => {
 const { body } = call(listDomainRings, {})
 const b = body as { rings: Array<{ id: string; label: string; description: string; domain_ids: string[] }> }
 for (const r of b.rings) {
 expect(typeof r.id).toBe('string')
 expect(typeof r.label).toBe('string')
 expect(typeof r.description).toBe('string')
 expect(Array.isArray(r.domain_ids)).toBe(true)
 expect(r.domain_ids.length).toBeGreaterThan(0)
 }
 })

 it('get_domain_ring returns the full ring for a known id', () => {
 const { ok, body } = call(getDomainRing, { id: 'understand' })
 expect(ok).toBe(true)
 const b = body as { id: string; label: string; domain_ids: string[] }
 expect(b.id).toBe('understand')
 expect(b.label).toBe('Understand')
 expect(b.domain_ids).toContain('user')
 })

 it('get_domain_ring returns error for unknown id', () => {
 const { ok, body } = call(getDomainRing, { id: 'totally_unknown_ring' })
 expect(ok).toBe(false)
 expect(body as string).toContain('Domain ring not found')
 })

 it('get_domain_ring returns error when id is missing', () => {
 const { ok } = call(getDomainRing, {})
 expect(ok).toBe(false)
 })
})