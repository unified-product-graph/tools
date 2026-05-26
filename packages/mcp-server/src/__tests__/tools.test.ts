/**
 * Tests for pure tool functions in lib/tools.ts
 *
 * These functions take a UPGFileStore and operate on its in-memory state.
 * We build a store from a temp .upg file, populate it, and test the functions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
 createNode,
 createEdge,
 deleteNode,
 searchNodes,
 listNodes,
 computeGraphDigest,
 normalizeTags,
 moveNode,
 batchMoveNodes,
 resolveEntityType,
 UnknownEntityTypeError,
 migrateNodeType,
 batchCreateNodes,
} from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(
 nodes: UPGDocument['nodes'] = [],
 edges: UPGDocument['edges'] = [],
): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: 'p1', title: 'Test Product', stage: 'concept' },
 nodes,
 edges,
 }
}

function writeTempUPG(doc: UPGDocument): string {
 const dir = mkdtempSync(join(tmpdir(), 'upg-test-'))
 const filePath = join(dir, 'test.upg')
 writeFileSync(filePath, JSON.stringify(doc, null, 2))
 return filePath
}

async function makeStore(
 nodes: UPGDocument['nodes'] = [],
 edges: UPGDocument['edges'] = [],
): Promise<UPGFileStore> {
 const doc = makeDoc(nodes, edges)
 const filePath = writeTempUPG(doc)
 const store = new UPGFileStore()
 await store.load(filePath)
 store.stopWatching()
 return store
}

// ── normalizeTags ─────────────────────────────────────────────────────────────

describe('normalizeTags', () => {
 it('returns undefined for falsy input', () => {
 expect(normalizeTags(undefined)).toBeUndefined()
 expect(normalizeTags(null)).toBeUndefined()
 expect(normalizeTags('')).toBeUndefined()
 })

 it('passes through arrays', () => {
 expect(normalizeTags(['a', 'b'])).toEqual(['a', 'b'])
 })

 it('parses JSON string arrays', () => {
 expect(normalizeTags('["x","y"]')).toEqual(['x', 'y'])
 })

 it('wraps a plain string as single-element array', () => {
 expect(normalizeTags('solo')).toEqual(['solo'])
 })
})

// ── createNode ────────────────────────────────────────────────────────────────

describe('createNode', () => {
 let store: UPGFileStore

 beforeEach(async () => {
 store = await makeStore()
 })

 it('creates a basic node with type and title', () => {
 const result = createNode(store, { type: 'persona', title: 'Early Adopter' })
 expect(result.node.type).toBe('persona')
 expect(result.node.title).toBe('Early Adopter')
 expect(result.node.id).toMatch(/^n_/)
 expect(result.edge).toBeNull()
 })

 it('creates a node with all optional fields', () => {
 const result = createNode(store, {
 type: 'feature',
 title: 'Dark Mode',
 description: 'Support dark colour scheme',
 tags: ['ux', 'accessibility'],
 status: 'planned',
 properties: { priority: 'high' },
 })
 expect(result.node.description).toBe('Support dark colour scheme')
 expect(result.node.tags).toEqual(['ux', 'accessibility'])
 expect(result.node.status).toBe('planned')
 expect(result.node.properties).toEqual({ priority: 'high' })
 })

 it('creates a hierarchy edge when parent_id is provided', () => {
 const parent = createNode(store, { type: 'persona', title: 'Builder' })
 const child = createNode(store, {
 type: 'job',
 title: 'Ship faster',
 parent_id: parent.node.id,
 })

 expect(child.edge).not.toBeNull()
 expect(child.edge!.source).toBe(parent.node.id)
 expect(child.edge!.target).toBe(child.node.id)
 expect(child.edge!.id).toMatch(/^e_/)
 })

 it('returns warning when parent_id does not exist', () => {
 const result = createNode(store, {
 type: 'job',
 title: 'Orphan job',
 parent_id: 'n_nonexistent',
 })
 expect(result.edge).toBeNull()
 expect(result.warning).toContain('not found')
 })

 it('node is retrievable from store after creation', () => {
 const result = createNode(store, { type: 'metric', title: 'NPS' })
 const found = store.getNode(result.node.id)
 expect(found).toBeDefined()
 expect(found!.title).toBe('NPS')
 })
})

// ── createEdge ────────────────────────────────────────────────────────────────

describe('createEdge', () => {
 let store: UPGFileStore
 let nodeA: ReturnType<typeof createNode>['node']
 let nodeB: ReturnType<typeof createNode>['node']

 beforeEach(async () => {
 store = await makeStore()
 nodeA = createNode(store, { type: 'persona', title: 'Dev' }).node
 nodeB = createNode(store, { type: 'job', title: 'Debug fast' }).node
 })

 it('creates an edge between two existing nodes', () => {
 const result = createEdge(store, { source_id: nodeA.id, target_id: nodeB.id })
 expect('edge' in result).toBe(true)
 if ('edge' in result) {
 expect(result.edge.source).toBe(nodeA.id)
 expect(result.edge.target).toBe(nodeB.id)
 expect(result.edge.id).toMatch(/^e_/)
 }
 })

 it('infers edge type from source/target types when not specified', () => {
 const result = createEdge(store, { source_id: nodeA.id, target_id: nodeB.id })
 expect('edge' in result).toBe(true)
 if ('edge' in result) {
 // Should infer some edge type, not be empty
 expect(result.edge.type).toBeTruthy()
 }
 })

 it('uses explicit edge type when provided', () => {
 const result = createEdge(store, {
 source_id: nodeA.id,
 target_id: nodeB.id,
 type: 'custom_edge_type',
 })
 expect('edge' in result).toBe(true)
 if ('edge' in result) {
 expect(result.edge.type).toBe('custom_edge_type')
 }
 })

 it('returns error when source does not exist', () => {
 const result = createEdge(store, {
 source_id: 'n_nonexistent',
 target_id: nodeB.id,
 })
 expect('error' in result).toBe(true)
 })

 it('returns error when target does not exist', () => {
 const result = createEdge(store, {
 source_id: nodeA.id,
 target_id: 'n_nonexistent',
 })
 expect('error' in result).toBe(true)
 })

 it('returns error when neither target_id nor target_title provided', () => {
 const result = createEdge(store, { source_id: nodeA.id })
 expect('error' in result).toBe(true)
 })

 it('resolves target by title+type', () => {
 const result = createEdge(store, {
 source_id: nodeA.id,
 target_title: 'Debug fast',
 target_type: 'job',
 })
 expect('edge' in result).toBe(true)
 if ('edge' in result) {
 expect(result.edge.target).toBe(nodeB.id)
 }
 })
})

// ── deleteNode ────────────────────────────────────────────────────────────────

describe('deleteNode', () => {
 it('removes the node from the store', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'persona', title: 'To Delete' })

 const result = deleteNode(store, { node_id: node.id })
 expect(result.deleted_node_id).toBe(node.id)
 expect(result.deleted_node_title).toBe('To Delete')
 expect(store.getNode(node.id)).toBeUndefined()
 })

 it('removes connected edges when node is deleted', async () => {
 const store = await makeStore()
 const parent = createNode(store, { type: 'persona', title: 'Parent' })
 const child = createNode(store, {
 type: 'job',
 title: 'Child',
 parent_id: parent.node.id,
 })

 expect(child.edge).not.toBeNull()
 const edgeId = child.edge!.id

 const result = deleteNode(store, { node_id: parent.node.id })
 expect(result.deleted_edge_ids).toContain(edgeId)
 expect(store.getEdge(edgeId)).toBeUndefined()
 })

 it('throws when node does not exist', async () => {
 const store = await makeStore()
 expect(() => deleteNode(store, { node_id: 'n_nonexistent' })).toThrow(
 'Node not found',
 )
 })
})

// ── searchNodes ───────────────────────────────────────────────────────────────

describe('searchNodes', () => {
 let store: UPGFileStore

 beforeEach(async () => {
 store = await makeStore()
 createNode(store, {
 type: 'persona',
 title: 'Product Manager',
 description: 'Manages product roadmap',
 })
 createNode(store, {
 type: 'persona',
 title: 'Software Engineer',
 description: 'Builds features',
 })
 createNode(store, {
 type: 'feature',
 title: 'Roadmap View',
 description: 'Visual timeline of planned work',
 })
 })

 it('finds nodes by title substring', () => {
 const results = searchNodes(store, 'Engineer')
 expect(results).toHaveLength(1)
 expect(results[0].node.title).toBe('Software Engineer')
 expect(results[0].match_field).toBe('title')
 })

 it('finds nodes by description substring', () => {
 const results = searchNodes(store, 'roadmap')
 expect(results.length).toBeGreaterThanOrEqual(1)
 // Title match scores higher than description match
 const titles = results.map((r) => r.node.title)
 expect(titles).toContain('Roadmap View')
 })

 it('returns empty array for no matches', () => {
 const results = searchNodes(store, 'xyznonexistent')
 expect(results).toHaveLength(0)
 })

 it('respects limit parameter', () => {
 const results = searchNodes(store, 'a', { limit: 1 })
 expect(results.length).toBeLessThanOrEqual(1)
 })

 it('filters by type', () => {
 const results = searchNodes(store, 'roadmap', { type: 'persona' })
 // Only the persona with "roadmap" in description should match
 for (const r of results) {
 expect(r.node.type).toBe('persona')
 }
 })
})

// ── listNodes ─────────────────────────────────────────────────────────────────

describe('listNodes', () => {
 let store: UPGFileStore

 beforeEach(async () => {
 store = await makeStore()
 createNode(store, { type: 'persona', title: 'Alice', status: 'active' })
 createNode(store, { type: 'persona', title: 'Bob', status: 'draft' })
 createNode(store, { type: 'feature', title: 'Search', status: 'active' })
 createNode(store, { type: 'feature', title: 'Filter', status: 'active' })
 createNode(store, { type: 'metric', title: 'NPS' })
 })

 it('returns all nodes when no filters', () => {
 const result = listNodes(store)
 expect(result.total).toBe(5)
 expect(result.nodes).toHaveLength(5)
 })

 it('filters by type', () => {
 const result = listNodes(store, { type: 'persona' })
 expect(result.total).toBe(2)
 expect(result.nodes.every((n) => n.type === 'persona')).toBe(true)
 })

 it('filters by status', () => {
 const result = listNodes(store, { status: 'active' })
 expect(result.total).toBe(3)
 })

 it('filters by parent_id', () => {
 // Updated: epic → story_statement is the canonical hierarchy
 // post-split 2 (user_story deprecated → story_statement).
 const parent = createNode(store, { type: 'epic', title: 'Epic 1' })
 createNode(store, {
 type: 'story_statement',
 title: 'Story A',
 parent_id: parent.node.id,
 })
 createNode(store, {
 type: 'story_statement',
 title: 'Story B',
 parent_id: parent.node.id,
 })

 const result = listNodes(store, { parentId: parent.node.id })
 expect(result.total).toBe(2)
 })

 it('supports pagination with offset and limit', () => {
 const all = listNodes(store)
 const page = listNodes(store, { offset: 2, limit: 2 })
 expect(page.total).toBe(5) // total stays the same
 expect(page.nodes).toHaveLength(2)
 })
})

// ── computeGraphDigest ───────────────────────────────────────────────────────

describe('computeGraphDigest', () => {
 it('returns correct node/edge counts', async () => {
 const store = await makeStore()
 createNode(store, { type: 'persona', title: 'Dev' })
 createNode(store, { type: 'feature', title: 'Search' })

 const digest = computeGraphDigest(store)
 expect(digest.counts.total_nodes).toBe(2)
 expect(digest.counts.total_edges).toBe(0)
 })

 it('returns nodes_by_type breakdown', async () => {
 const store = await makeStore()
 createNode(store, { type: 'persona', title: 'A' })
 createNode(store, { type: 'persona', title: 'B' })
 createNode(store, { type: 'feature', title: 'F' })

 const digest = computeGraphDigest(store)
 expect(digest.counts.by_type['persona']).toBe(2)
 expect(digest.counts.by_type['feature']).toBe(1)
 })

 it('reports orphan count correctly', async () => {
 const store = await makeStore()
 const p = createNode(store, { type: 'persona', title: 'Connected' })
 createNode(store, { type: 'job', title: 'Linked', parent_id: p.node.id })
 createNode(store, { type: 'feature', title: 'Orphan' }) // no edges

 const digest = computeGraphDigest(store)
 // persona + job are connected via edge; feature is orphan
 expect(digest.health.orphan_count).toBe(1)
 })

 it('returns product title and stage', async () => {
 const store = await makeStore()
 const digest = computeGraphDigest(store)
 expect(digest.product.title).toBe('Test Product')
 expect(digest.product.stage).toBe('concept')
 })

 it('reports lifecycle phase counts', async () => {
 // Updated: hypothesis → hypothesis_claim (split 3),
 // experiment → experiment_plan (split 1). Both still belong to
 // the validation phase post-split.
 const store = await makeStore()
 createNode(store, { type: 'hypothesis_claim', title: 'H1' })
 createNode(store, { type: 'experiment_plan', title: 'E1' })

 const digest = computeGraphDigest(store)
 expect(digest.lifecycle.validation).toBe(2)
 })

 // ──: chain coverage uses canonical entity types ────────────────────

 it('reports persona → job chain coverage with canonical-type nodes', async () => {
 const store = await makeStore()
 const p = createNode(store, { type: 'persona', title: 'Dev' })
 createNode(store, { type: 'job', title: 'Ship faster', parent_id: p.node.id })

 const digest = computeGraphDigest(store)
 expect(digest.chains.persona_total).toBe(1)
 expect(digest.chains.persona_with_job).toBe(1)
 expect(digest.chains.job_total).toBe(1)
 })

 it('reports persona → job chain coverage when nodes still use deprecated jtbd type', async () => {
 // Regression: a graph that has not yet run migrate_type still
 // surfaces correct chain counts because canonicalType folds jtbd into job.
 const store = await makeStore()
 const p = createNode(store, { type: 'persona', title: 'Dev' })
 createNode(store, { type: 'jtbd' as never, title: 'Ship faster', parent_id: p.node.id })

 const digest = computeGraphDigest(store)
 expect(digest.chains.persona_total).toBe(1)
 expect(digest.chains.persona_with_job).toBe(1)
 expect(digest.chains.job_total).toBe(1)
 })

 it('reports job → need chain coverage with mixed canonical and deprecated types', async () => {
 // job (canonical) + jtbd (deprecated) both fold into job_total. Each has a
 // need child via persona_*_need-pattern edge.
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'Dev' })
 const j1 = createNode(store, { type: 'job', title: 'Job A', parent_id: persona.node.id })
 const j2 = createNode(store, { type: 'jtbd' as never, title: 'Job B', parent_id: persona.node.id })
 createNode(store, { type: 'need', title: 'Need A', parent_id: j1.node.id })
 createNode(store, { type: 'need', title: 'Need B', parent_id: j2.node.id })

 const digest = computeGraphDigest(store)
 expect(digest.chains.job_total).toBe(2)
 expect(digest.chains.job_with_need).toBe(2)
 })

 it('counts deprecated pain_point under canonical need in business-area coverage', async () => {
 const store = await makeStore()
 createNode(store, { type: 'pain_point' as never, title: 'Slow build' })

 const digest = computeGraphDigest(store)
 // BUSINESS_AREAS.understanding lists "need" — pain_point should resolve in.
 expect(digest.coverage.understanding.types_present).toContain('need')
 })

 // ──: canonical alias drift on chains + coverage ─────────────────
 //
 // Regression for the chain validation report (finding F3): a graph
 // with hypothesis_claim nodes was reporting `chains.hypothesis_total: 0`
 // and `coverage.discovery.types_missing: ['hypothesis', 'experiment', ...]`
 // because the digest was looking up the deprecated alias names rather than
 // canonical ones.

 it('reports hypothesis_total > 0 for canonical hypothesis_claim nodes', async () => {
 const store = await makeStore()
 const opp = createNode(store, { type: 'opportunity', title: 'Onboarding drop-off' })
 const sol = createNode(store, { type: 'solution', title: 'Wizard', parent_id: opp.node.id })
 createNode(store, { type: 'hypothesis_claim', title: 'Wizard reduces drop-off', parent_id: sol.node.id })

 const digest = computeGraphDigest(store)
 expect(digest.chains.hypothesis_total).toBe(1)
 })

 it('surfaces canonical post-split types in coverage.discovery', async () => {
 // v0.4.0 re-promoted hypothesis_claim back to canonical `hypothesis`
 // (the "claim" suffix was redundant — see UPG_MIGRATIONS['0.4.0']).
 // The digest folds hypothesis_claim → hypothesis via canonicalType, so a
 // graph that contains hypothesis_claim still surfaces under `hypothesis`.
 const store = await makeStore()
 createNode(store, { type: 'hypothesis_claim', title: 'H1' })
 createNode(store, { type: 'experiment_plan', title: 'E1' })

 const digest = computeGraphDigest(store)
 expect(digest.coverage.discovery.types_present).toContain('hypothesis')
 expect(digest.coverage.discovery.types_present).toContain('experiment_plan')
 // The deprecated names must not appear in `types_missing` lists either —
 // they are not what we expect users to create today.
 expect(digest.coverage.discovery.types_missing).not.toContain('hypothesis_claim')
 expect(digest.coverage.discovery.types_missing).not.toContain('experiment')
 })

 it('counts legacy hypothesis nodes under canonical hypothesis_claim', async () => {
 // Backwards-compat: graphs that have not yet run migrate_type still get
 // correct counts because canonicalType folds hypothesis → hypothesis_claim.
 const store = await makeStore()
 createNode(store, { type: 'hypothesis' as never, title: 'Legacy hyp' })

 const digest = computeGraphDigest(store)
 expect(digest.chains.hypothesis_total).toBe(1)
 })

 it('does not double-count when both legacy and canonical lifecycle types are present', async () => {
 // LIFECYCLE_PHASES.validation lists both `hypothesis` and `hypothesis_claim`
 // for back-compat. The lifecycle counter must dedupe via canonicalType so
 // a graph with one legacy + one canonical reports 2, not 3.
 const store = await makeStore()
 createNode(store, { type: 'hypothesis' as never, title: 'Legacy' })
 createNode(store, { type: 'hypothesis_claim', title: 'Canonical' })

 const digest = computeGraphDigest(store)
 expect(digest.lifecycle.validation).toBe(2)
 })
})

// ── slug auto-fill ──────────────────────────────────────────────────

describe('createNode slug auto-fill', () => {
 it('assigns a slug derived from the title', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'persona', title: 'Alex Senior PM' })
 expect(node.slug).toBe('alex-senior-pm')
 })

 it('resolves collisions within (type) scope', async () => {
 const store = await makeStore()
 createNode(store, { type: 'persona', title: 'Alex' })
 const { node } = createNode(store, { type: 'persona', title: 'Alex' })
 expect(node.slug).toBe('alex-2')
 })

 it('allows the same slug under a different type', async () => {
 const store = await makeStore()
 createNode(store, { type: 'persona', title: 'Atlas' })
 const { node } = createNode(store, { type: 'feature', title: 'Atlas' })
 expect(node.slug).toBe('atlas')
 })

 it('considers existing aliases for collision detection', async () => {
 const store = await makeStore()
 const { node: first } = createNode(store, { type: 'persona', title: 'Old Name' })
 // Manually patch in an alias to mirror what rotateSlug would produce
 store.updateNode(first.id, { slug: 'new-name', aliases: ['old-name'] })
 const { node: second } = createNode(store, { type: 'persona', title: 'Old Name' })
 expect(second.slug).toBe('old-name-2')
 })
})

describe('updateNode slug rotation', () => {
 it('pushes the old slug into aliases when slug changes', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'persona', title: 'Original Name' })
 expect(node.slug).toBe('original-name')

 const updated = store.updateNode(node.id, { slug: 'renamed' })
 expect(updated.slug).toBe('renamed')
 expect(updated.aliases).toEqual(['original-name'])
 })

 it('does not duplicate aliases on repeated rotation', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'persona', title: 'A' })
 store.updateNode(node.id, { slug: 'b' })
 const second = store.updateNode(node.id, { slug: 'a' }) // back to original
 expect(second.slug).toBe('a')
 // 'a' is now current; 'b' is the alias from this rotation
 expect(second.aliases).toEqual(['a', 'b'])
 })

 it('leaves aliases untouched when slug is unchanged', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'persona', title: 'X' })
 const updated = store.updateNode(node.id, { title: 'Y' })
 expect(updated.slug).toBe('x') // unchanged
 expect(updated.aliases ?? []).toEqual([])
 })
})

// ── moveNode ──────────────────────────────────────────────────────

describe('moveNode', () => {
 it('atomically swaps a node\'s parent edge under a new portfolio', async () => {
 const store = await makeStore()
 const portfolioA = createNode(store, { type: 'portfolio', title: 'A' })
 const portfolioB = createNode(store, { type: 'portfolio', title: 'B' })
 const { node: product } = createNode(store, {
 type: 'product',
 title: 'Widget',
 parent_id: portfolioA.node.id,
 })

 const result = moveNode(store, {
 node_id: product.id,
 new_parent_id: portfolioB.node.id,
 })

 expect(result.moved).toBe(true)
 if (result.moved) {
 expect(result.new_edge.source).toBe(portfolioB.node.id)
 expect(result.new_edge.target).toBe(product.id)
 expect(result.new_edge.type).toBe('portfolio_contains_product')
 expect(result.removed_edge_id).toBeTruthy()
 }
 // Old edge gone, new edge present
 const edges = store.getAllEdges().filter((e) => e.target === product.id)
 expect(edges).toHaveLength(1)
 expect(edges[0].source).toBe(portfolioB.node.id)
 })

 it('rejects moving a node onto itself', async () => {
 const store = await makeStore()
 const { node } = createNode(store, { type: 'portfolio', title: 'Solo' })
 const result = moveNode(store, { node_id: node.id, new_parent_id: node.id })
 expect(result.moved).toBe(false)
 if (!result.moved) expect(result.error).toMatch(/onto itself/)
 })

 it('rejects when new_edge_type is not in UPG_EDGE_CATALOG', async () => {
 const store = await makeStore()
 const portfolio = createNode(store, { type: 'portfolio', title: 'P' })
 const { node: product } = createNode(store, {
 type: 'product',
 title: 'W',
 parent_id: portfolio.node.id,
 })
 const result = moveNode(store, {
 node_id: product.id,
 new_parent_id: portfolio.node.id,
 new_edge_type: 'made_up_edge_type',
 })
 expect(result.moved).toBe(false)
 if (!result.moved) expect(result.error).toMatch(/UPG_EDGE_CATALOG/)
 })

 it('rejects when new_edge_type source/target constraints are violated', async () => {
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'P' })
 const portfolio = createNode(store, { type: 'portfolio', title: 'PF' })
 const { node: product } = createNode(store, {
 type: 'product',
 title: 'W',
 parent_id: portfolio.node.id,
 })
 // Try to attach product under persona via portfolio_contains_product —
 // catalog says source must be 'portfolio', not 'persona'.
 const result = moveNode(store, {
 node_id: product.id,
 new_parent_id: persona.node.id,
 new_edge_type: 'portfolio_contains_product',
 })
 expect(result.moved).toBe(false)
 if (!result.moved) expect(result.error).toMatch(/source type/)
 })

 it('disambiguates multiple hierarchy edges via old_edge_id', async () => {
 // Build a node with two hierarchy parents (graph-level legal, even if
 // unusual). Confirm moveNode refuses without old_edge_id and accepts
 // with it.
 const store = await makeStore()
 const portfolioA = createNode(store, { type: 'portfolio', title: 'A' })
 const portfolioB = createNode(store, { type: 'portfolio', title: 'B' })
 const portfolioC = createNode(store, { type: 'portfolio', title: 'C' })
 const { node: product } = createNode(store, {
 type: 'product',
 title: 'W',
 parent_id: portfolioA.node.id,
 })
 // Add a SECOND parent edge from B (manually — bypasses the
 // single-parent assumption to exercise the disambiguation path).
 createEdge(store, {
 source_id: portfolioB.node.id,
 target_id: product.id,
 type: 'portfolio_contains_product',
 })

 // Without old_edge_id → ambiguous
 const ambiguous = moveNode(store, {
 node_id: product.id,
 new_parent_id: portfolioC.node.id,
 })
 expect(ambiguous.moved).toBe(false)
 if (!ambiguous.moved) expect(ambiguous.error).toMatch(/disambiguate/)

 // With old_edge_id → explicit
 const aEdge = store.getAllEdges().find(
 (e) => e.source === portfolioA.node.id && e.target === product.id,
 )!
 const explicit = moveNode(store, {
 node_id: product.id,
 new_parent_id: portfolioC.node.id,
 old_edge_id: aEdge.id,
 })
 expect(explicit.moved).toBe(true)
 })

 it('rejects moves with no canonical edge type and no override', async () => {
 const store = await makeStore()
 // feature → persona has no edge in UPG_EDGE_CATALOG in either direction,
 // so inference rejects. (persona → product, used by the earlier version of
 // this test, now resolves to `persona_anti_fit_for_product`, which is
 // semantic — moveNode now succeeds when no hierarchy edge is mandated.)
 const feature = createNode(store, { type: 'feature', title: 'F' })
 const portfolio = createNode(store, { type: 'portfolio', title: 'PF' })
 const { node: persona } = createNode(store, {
 type: 'persona',
 title: 'P',
 })
 // Place persona under portfolio first so it has a parent, then attempt
 // a move to feature — which should reject (no canonical feature → persona
 // edge in the catalog).
 const result = moveNode(store, {
 node_id: persona.id,
 new_parent_id: feature.node.id,
 })
 // Suppress unused-portfolio lint
 void portfolio
 expect(result.moved).toBe(false)
 if (!result.moved) expect(result.error).toMatch(/canonical edge|UPG_EDGE_CATALOG/)
 })
})

describe('batchMoveNodes', () => {
 it('applies all moves atomically when every move is valid', async () => {
 const store = await makeStore()
 const a = createNode(store, { type: 'portfolio', title: 'A' })
 const b = createNode(store, { type: 'portfolio', title: 'B' })
 const p1 = createNode(store, { type: 'product', title: 'P1', parent_id: a.node.id })
 const p2 = createNode(store, { type: 'product', title: 'P2', parent_id: a.node.id })

 const outcome = batchMoveNodes(store, [
 { node_id: p1.node.id, new_parent_id: b.node.id },
 { node_id: p2.node.id, new_parent_id: b.node.id },
 ])

 expect(outcome.ok).toBe(true)
 if (outcome.ok) {
 expect(outcome.result.count).toBe(2)
 }
 const underB = store.getAllEdges().filter((e) => e.source === b.node.id)
 expect(underB).toHaveLength(2)
 })

 it('rolls back EVERYTHING when one move in the batch fails (transactional guarantee)', async () => {
 const store = await makeStore()
 const a = createNode(store, { type: 'portfolio', title: 'A' })
 const b = createNode(store, { type: 'portfolio', title: 'B' })
 const p1 = createNode(store, { type: 'product', title: 'P1', parent_id: a.node.id })

 // Snapshot edges before the batch
 const edgesBefore = store.getAllEdges().map((e) => ({ ...e }))

 const outcome = batchMoveNodes(store, [
 { node_id: p1.node.id, new_parent_id: b.node.id }, // valid
 { node_id: 'nonexistent', new_parent_id: b.node.id }, // invalid
 ])

 expect(outcome.ok).toBe(false)
 if (!outcome.ok) expect(outcome.failed_at_index).toBe(1)

 // Edge set is bit-for-bit identical to the snapshot
 const edgesAfter = store.getAllEdges()
 expect(edgesAfter).toHaveLength(edgesBefore.length)
 for (const e of edgesBefore) {
 const match = edgesAfter.find(
 (a2) => a2.source === e.source && a2.target === e.target && a2.type === e.type,
 )
 expect(match).toBeDefined()
 }
 })

 it('rejects an empty moves array', async () => {
 const store = await makeStore()
 const outcome = batchMoveNodes(store, [])
 expect(outcome.ok).toBe(false)
 })

 it('rejects more than 50 moves per batch', async () => {
 const store = await makeStore()
 const moves = Array.from({ length: 51 }, () => ({ node_id: 'x', new_parent_id: 'y' }))
 const outcome = batchMoveNodes(store, moves)
 expect(outcome.ok).toBe(false)
 if (!outcome.ok) expect(outcome.error).toMatch(/Maximum 50/)
 })
})

// ── resolveEntityType / createNode validation ─────────────────────

describe('resolveEntityType', () => {
 it('accepts a canonical type unchanged', () => {
 const result = resolveEntityType('persona')
 expect(result.canonical).toBe('persona')
 expect(result.alias).toBeUndefined()
 })

 it('aliases a deprecated synonym to its canonical replacement', () => {
 const result = resolveEntityType('jtbd')
 expect(result.canonical).toBe('job')
 expect(result.alias).toEqual({ from: 'jtbd', to: 'job' })
 })

 it('aliases pain_point → need with the alias trail', () => {
 const result = resolveEntityType('pain_point')
 expect(result.canonical).toBe('need')
 expect(result.alias).toEqual({ from: 'pain_point', to: 'need' })
 })

 it('throws UnknownEntityTypeError for genuinely unknown types', () => {
 expect(() => resolveEntityType('made_up_thing')).toThrow(UnknownEntityTypeError)
 })

 it('surfaces near-miss suggestions on unknown types', () => {
 try {
 // 'persoba' is one edit away from 'persona'
 resolveEntityType('persoba')
 throw new Error('expected throw')
 } catch (err) {
 expect(err).toBeInstanceOf(UnknownEntityTypeError)
 const e = err as UnknownEntityTypeError
 expect(e.suggestions).toContain('persona')
 expect(e.message).toMatch(/Did you mean/)
 }
 })

 it('rejects empty/non-string inputs', () => {
 expect(() => resolveEntityType('')).toThrow(UnknownEntityTypeError)
 expect(() => resolveEntityType(undefined)).toThrow(UnknownEntityTypeError)
 expect(() => resolveEntityType(123)).toThrow(UnknownEntityTypeError)
 })
})

describe('createNode entity-type validation', () => {
 it('writes a canonical type as-is with no alias warning', async () => {
 const store = await makeStore()
 const result = createNode(store, { type: 'persona', title: 'Dev' })
 expect(result.node.type).toBe('persona')
 expect(result.warning).toBeUndefined()
 })

 it('aliases a deprecated input to canonical and surfaces a warning', async () => {
 const store = await makeStore()
 const result = createNode(store, { type: 'jtbd', title: 'Ship faster' })
 expect(result.node.type).toBe('job')
 expect(result.warning).toMatch(/aliased to canonical 'job'/)
 })

 it('throws UnknownEntityTypeError for unknown types — no orphan node lands', async () => {
 const store = await makeStore()
 const before = store.getAllNodes().length
 expect(() =>
 createNode(store, { type: 'made_up_thing', title: 'Bogus' }),
 ).toThrow(UnknownEntityTypeError)
 // Critical: no orphan written
 expect(store.getAllNodes().length).toBe(before)
 })

 it('throw error message includes Levenshtein-1 suggestions', async () => {
 const store = await makeStore()
 try {
 createNode(store, { type: 'persoba', title: 'Bogus' })
 throw new Error('expected throw')
 } catch (err) {
 expect(err).toBeInstanceOf(UnknownEntityTypeError)
 expect((err as UnknownEntityTypeError).suggestions).toContain('persona')
 }
 })
})

// ── migrateNodeType ───────────────────────────────────────────────

describe('migrateNodeType', () => {
 it('changes node type and re-infers the incident edge against the catalog', async () => {
 const store = await makeStore()
 // Build: persona → job (single hop). Migrating job → need works because
 // the catalog has persona_experiences_need.
 const persona = createNode(store, { type: 'persona', title: 'Dev' })
 const job = createNode(store, {
 type: 'job',
 title: 'Ship faster',
 parent_id: persona.node.id,
 })
 expect(job.edge?.type).toBeTruthy()

 const result = migrateNodeType(store, { node_id: job.node.id, new_type: 'need' })
 expect(result.migrated).toBe(true)
 if (result.migrated) {
 expect(result.from_type).toBe('job')
 expect(result.to_type).toBe('need')
 // The persona → job edge should be rewritten to a persona → need edge.
 expect(result.edges_rewritten).toHaveLength(1)
 expect(result.edges_rewritten[0].to).toMatch(/persona.*need/)
 }
 expect(store.getNode(job.node.id)?.type).toBe('need')
 })

 it('aliases a deprecated new_type to canonical and surfaces a warning', async () => {
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'Dev' })
 const job = createNode(store, {
 type: 'job',
 title: 'Ship',
 parent_id: persona.node.id,
 })
 // jtbd → job; the node is already 'job', so this is a no-op success
 // path that returns canonical resolution + alias warning.
 const result = migrateNodeType(store, { node_id: job.node.id, new_type: 'jtbd' })
 expect(result.migrated).toBe(true)
 if (result.migrated) {
 expect(result.to_type).toBe('job')
 expect(result.warning).toMatch(/aliased to canonical 'job'/)
 }
 })

 it('rejects unknown new_type with suggestions and leaves the graph unchanged', async () => {
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'Dev' })
 const beforeType = store.getNode(persona.node.id)?.type

 const result = migrateNodeType(store, {
 node_id: persona.node.id,
 new_type: 'persoba',
 })
 expect(result.migrated).toBe(false)
 if (!result.migrated) {
 expect(result.suggestions).toContain('persona')
 }
 expect(store.getNode(persona.node.id)?.type).toBe(beforeType)
 })

 it('rejects when an incident edge cannot be re-inferred against the new type', async () => {
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'Dev' })
 const job = createNode(store, {
 type: 'job',
 title: 'Ship',
 parent_id: persona.node.id,
 })
 const edgesBefore = store.getAllEdges().map((e) => ({ ...e }))
 const beforeType = store.getNode(job.node.id)?.type

 // Migrate job → portfolio: persona → portfolio is not a canonical edge,
 // so the incident edge cannot be rewritten. The migration MUST reject
 // and leave the graph unchanged.
 const result = migrateNodeType(store, {
 node_id: job.node.id,
 new_type: 'portfolio',
 })
 expect(result.migrated).toBe(false)

 // Graph unchanged
 expect(store.getNode(job.node.id)?.type).toBe(beforeType)
 const edgesAfter = store.getAllEdges()
 expect(edgesAfter).toHaveLength(edgesBefore.length)
 for (const e of edgesBefore) {
 const match = edgesAfter.find(
 (a) => a.id === e.id && a.source === e.source && a.target === e.target && a.type === e.type,
 )
 expect(match).toBeDefined()
 }
 })

 it('is a no-op when new_type already equals current type', async () => {
 const store = await makeStore()
 const job = createNode(store, { type: 'job', title: 'Ship' })
 const result = migrateNodeType(store, { node_id: job.node.id, new_type: 'job' })
 expect(result.migrated).toBe(true)
 if (result.migrated) expect(result.edges_rewritten).toHaveLength(0)
 })

 it('rejects when the node does not exist', async () => {
 const store = await makeStore()
 const result = migrateNodeType(store, { node_id: 'nope', new_type: 'persona' })
 expect(result.migrated).toBe(false)
 })
})

// ── batchCreateNodes — atomic nodes + edges ───────────────────────

describe('batchCreateNodes', () => {
 it('creates nodes with parent_ref chains as before', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'persona', title: 'Dev' },
 { type: 'job', title: 'Ship', parent_ref: '$0' },
 ],
 })
 expect(result.ok).toBe(true)
 if (result.ok) {
 expect(result.count).toBe(2)
 expect(result.edges).toHaveLength(1) // parent_ref edge
 expect(result.edges[0].source).toBe(result.created[0].id)
 }
 })

 it('creates explicit edges using $N refs alongside nodes atomically', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'persona', title: 'Dev' },
 { type: 'job', title: 'Ship' },
 { type: 'need', title: 'Faster builds' },
 ],
 edges: [
 { from_ref: '$0', to_ref: '$1' }, // persona → job, inferred
 { from_ref: '$1', to_ref: '$2' }, // job → need, inferred
 ],
 })
 expect(result.ok).toBe(true)
 if (result.ok) {
 expect(result.count).toBe(3)
 expect(result.explicit_edges).toHaveLength(2)
 expect(result.explicit_edges![0].source).toBe(result.created[0].id)
 expect(result.explicit_edges![0].target).toBe(result.created[1].id)
 }
 })

 it('mixes $N refs and existing-node IDs in the same batch', async () => {
 const store = await makeStore()
 const persona = createNode(store, { type: 'persona', title: 'Existing Dev' })

 const result = batchCreateNodes(store, {
 nodes: [{ type: 'job', title: 'Ship' }],
 edges: [{ from_ref: persona.node.id, to_ref: '$0' }],
 })
 expect(result.ok).toBe(true)
 if (result.ok) {
 expect(result.explicit_edges).toHaveLength(1)
 expect(result.explicit_edges![0].source).toBe(persona.node.id)
 expect(result.explicit_edges![0].target).toBe(result.created[0].id)
 }
 })

 it('rejects unknown entity type — NO orphan node lands', async () => {
 const store = await makeStore()
 const before = store.getAllNodes().length
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'persona', title: 'Dev' },
 { type: 'made_up_thing', title: 'Bogus' },
 ],
 })
 expect(result.ok).toBe(false)
 expect(store.getAllNodes().length).toBe(before)
 })

 it('rejects $N ref out of range', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [{ type: 'persona', title: 'Dev' }],
 edges: [{ from_ref: '$5', to_ref: '$0' }], // $5 doesn't exist
 })
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.error).toMatch(/out of range/)
 })

 it('rejects existing-id refs that don\'t resolve in the graph', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [{ type: 'persona', title: 'Dev' }],
 edges: [{ from_ref: 'n_does_not_exist', to_ref: '$0' }],
 })
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.error).toMatch(/not found in graph/)
 })

 it('rejects edges whose explicit type is not in UPG_EDGE_CATALOG', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'persona', title: 'Dev' },
 { type: 'job', title: 'Ship' },
 ],
 edges: [{ from_ref: '$0', to_ref: '$1', type: 'totally_made_up_edge' }],
 })
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.error).toMatch(/UPG_EDGE_CATALOG/)
 })

 it('rejects edges with no canonical inference (no fabrication)', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'feature', title: 'F' },
 { type: 'persona', title: 'P' },
 ],
 // feature → persona is not a canonical edge in either direction
 edges: [{ from_ref: '$0', to_ref: '$1' }],
 })
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.error).toMatch(/no canonical edge/)
 })

 it('atomic rollback when an edge fails: NO nodes + NO edges land', async () => {
 const store = await makeStore()
 const before = {
 nodes: store.getAllNodes().length,
 edges: store.getAllEdges().length,
 }
 const result = batchCreateNodes(store, {
 nodes: [
 { type: 'persona', title: 'Dev' },
 { type: 'job', title: 'Ship' },
 ],
 edges: [
 { from_ref: '$0', to_ref: '$1' }, // valid (persona → job inferable)
 { from_ref: '$1', to_ref: '$0', type: 'made_up_edge' }, // invalid type
 ],
 })
 expect(result.ok).toBe(false)
 expect(store.getAllNodes().length).toBe(before.nodes)
 expect(store.getAllEdges().length).toBe(before.edges)
 })

 it('rejects oversize batch (combined nodes + edges > 50)', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: Array.from({ length: 30 }, (_, i) => ({ type: 'persona' as const, title: `P${i}` })),
 edges: Array.from({ length: 25 }, () => ({ from_ref: '$0', to_ref: '$1' })),
 })
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.error).toMatch(/Maximum 50/)
 })

 it('aliases deprecated types to canonical with warnings', async () => {
 const store = await makeStore()
 const result = batchCreateNodes(store, {
 nodes: [{ type: 'jtbd', title: 'Ship' }],
 })
 expect(result.ok).toBe(true)
 if (result.ok) {
 expect(result.created[0].type).toBe('job')
 expect(result.warnings?.some((w) => w.match(/aliased to canonical 'job'/))).toBe(true)
 }
 })
})
