/**
 * Tool registry smoke tests: locks Stage B (handler extraction).
 *
 * The registry is the single source of truth: every tool name from the
 * declarations array MUST resolve to a real handler, every handler must
 * receive a ToolContext, and a representative slice across the 7 domains
 * must round-trip end-to-end via the registry's dispatch path.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { UPG_TREE_PATTERNS } from '@unified-product-graph/core'
import {
  TOOL_DEFINITIONS,
  TOOL_REGISTRY,
  getToolHandler,
} from '../lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeDoc(overrides: Partial<UPGDocument> = {}): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes: [],
    edges: [],
    ...overrides,
  }
}

function makeNode(overrides: Partial<UPGBaseNode> = {}): UPGBaseNode {
  return {
    id: `n_${Math.random().toString(36).slice(2, 10)}`,
    type: 'persona' as UPGEntityType,
    title: 'Test Node',
    ...overrides,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-tool-registry-'))
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

describe('Tool registry: completeness', () => {
  it('every declared tool has a bound handler', () => {
    const missing: string[] = []
    for (const def of TOOL_DEFINITIONS) {
      const handler = getToolHandler(def.name)
      if (!handler) missing.push(def.name)
    }
    expect(missing).toEqual([])
  })

  it('TOOL_REGISTRY zips definition + handler one-for-one', () => {
    expect(TOOL_REGISTRY).toHaveLength(TOOL_DEFINITIONS.length)
    for (const entry of TOOL_REGISTRY) {
      expect(entry.handler).toBeTypeOf('function')
    }
  })

  it('exposes the expected 134 tools', () => {
    // 77 from v0.3.0 +
    // 11 spec-introspection round-5 tools:
    //   list_type_migrations, list_edge_migrations, list_split_migrations,
    //   list_lifecycles, get_lifecycle, list_scales, get_scale,
    //   list_framework_categories, list_framework_structure_patterns,
    //   list_domain_rings, get_domain_ring. → 88
    // + 1 anti-pattern evaluation tool:
    //   get_anti_pattern_violations_for. (validate_graph already shipped
    //   on local at v0.3.0; extends it in place rather than
    //   adding a second tool.)
    //   → 89.
    // + 1 additional tool added for v0.5.0. → 90.
    // + 1 portfolio organisation read: get_organization. → 91.
    // + migrate_status ( status migration). → 92.
    // + skill_audit ( source-vs-deployed integrity for skills). → 93.
    // + start ( zero-state on-ramp). → 94.
    // + apply_framework + score_entity (0.8.4 framework exercises). → 96.
    // + assign_product_to_area + attach_product_to_portfolio + update_product
    //   (0.8.15 workspace write surface/654). → 99.
    // + 7 portfolio edit/cleanup-tier tools (0.8.16): update_area,
    //   remove_product_from_area, delete_area, move_product_to_area,
    //   detach_product_from_portfolio, delete_cross_product_edge,
    //   batch_create_cross_product_edges. → 106.
    // + 2 cross-product read-layer tools (0.9.1 batch-3 #13): portfolio_query,
    //   portfolio_digest. → 108.
    // + portfolio_validate (0.9.3 batch-4 #19): portfolio-wide audit. → 109.
    // + clone_structure (0.9.4 batch-4 #17): cross-product shape clone. → 110.
    // + 3 registry tools (0.9.6 registry initiative Phase 2): define_canonical_entity,
    //   register_instance, list_registry. → 113.
    // + 5 batch-5 registry-lifecycle / portfolio-edge tools (0.9.8): update_canonical_entity,
    //   batch_define_canonical_entity, batch_register_instance, promote_to_canonical,
    //   link_area_to_audience. → 118.
    // + list_status_values (0.9.11 batch-6 #35): per-type status pre-flight. → 119.
    // + create_registry_edge (0.9.13 foundations follow-ups): author registry-internal
    //   edges (registry.edges), e.g. specification governed_by organization. → 120.
    // + get_tree (0.9.15): server-side canonical tree assembly (local-only). → 121.
    // + 2 tree-pattern introspection tools (0.9.20): list_tree_patterns,
    //   get_tree_pattern (the catalogue behind get_tree, made queryable). → 123.
    // + create_parity_edge (0.10.1 spec issue #38 fast-follow): typed writer for
    //   feature_rivals_competitor_feature, local-only (cross-product portfolio
    //   write, like link_area_to_audience). → 124.
    // + create_classification_edge (0.10.4): typed writer for the classification
    //   edges, local-only (same cross-product portfolio write). → 125.
    // + get_portfolio_tree (0.10.7): assembles the classification landscape /
    //   competitor profile from portfolio.upg cross-edges, local-only (portfolio
    //   read layer, no single-product cloud analogue). → 126.
    // + audit_property_coverage (0.10.8): audits portfolio cross-edges for
    //   missing required properties, local-only (portfolio read layer). → 127.
    // + diff_classification (0.11.0): reads the append-only reclassification
    //   history (signals[]) to show what moved on the landscape, local-only
    //   (portfolio read layer, no single-product cloud analogue). → 128.
    // + 2 classification-analysis read tools (0.11.2): compare_classifications
    //   (two competitors axis-by-axis, feeds the parity layer) and
    //   aggregate_edge_properties (property-layer distribution digest), both
    //   local-only (portfolio read layer). → 130.
    // + audit_axis_overlap (0.11.3): lists sources with >1 value on a single-
    //   select axis (the supersede regression guard), local-only. → 131.
    // + list_scalar_to_edge_migrations + promote_scalars_to_edges (0.12.0): the
    //   P14 scalar→edge promotion surface — list the rules, then losslessly apply
    //   them (find-or-create + link + drop). Local-only (migration layer). → 133.
    // + portfolio_census (0.12.5): the cross-product list_nodes — lists
    //   product-local nodes of one type across the workspace with a projection,
    //   edge-free so it stays under the payload cap. Local-only (portfolio read
    //   layer, no single-product cloud analogue). → 134.
    // + list_templates + get_template (0.16.x): the curated starter-template
    //   library surface — list summaries, fetch a full pattern (entities, typed
    //   edges, prompts). Read-only over @unified-product-graph/templates via the
    //   SDK; mirrored on the cloud server (static data → full parity). → 136.
    expect(TOOL_DEFINITIONS).toHaveLength(136)
  })
})

describe('Tool registry: dispatch parity', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await loadStore(
      makeDoc({
        nodes: [
          makeNode({ id: 'n1', type: 'persona', title: 'Solo Builder' }),
          makeNode({ id: 'n2', type: 'job', title: 'Ship a feature' }),
        ],
      }),
    )
    ctx = makeCtx(store)
  })

  it('list_nodes returns a JSON payload with the seeded nodes', async () => {
    const handler = getToolHandler('list_nodes')!
    const result = await handler({}, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.total).toBe(2)
    expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['n1', 'n2'])
  })

  it('get_node returns the requested node', async () => {
    const handler = getToolHandler('get_node')!
    const result = await handler({ node_id: 'n1' }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.node.title).toBe('Solo Builder')
  })

  it('get_node surfaces a textError on missing id', async () => {
    const handler = getToolHandler('get_node')!
    const result = await handler({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Missing required parameter/)
  })

  // N2 (UPG QA 0.8.7): get_node accepts `id` as an alias for `node_id`.
  it('get_node accepts the `id` alias for `node_id`', async () => {
    const handler = getToolHandler('get_node')!
    const result = await handler({ id: 'n1' }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.node.title).toBe('Solo Builder')
  })

  // N2: the missing-param error names the expected key AND its alias.
  it('get_node missing-param error names node_id and its alias', async () => {
    const handler = getToolHandler('get_node')!
    const result = await handler({}, ctx)
    expect(result.content[0].text).toMatch(/node_id/)
    expect(result.content[0].text).toMatch(/alias.*id/i)
  })

  it('get_entity_schema returns the persona schema', async () => {
    const handler = getToolHandler('get_entity_schema')!
    const result = await handler({ type: 'persona' }, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.type).toBe('persona')
    expect(Array.isArray(body.edges_out)).toBe(true)
  })

  it('get_session_context returns a fresh session', async () => {
    const handler = getToolHandler('get_session_context')!
    const result = await handler({}, ctx)
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.lens).toBe('product')
    expect(body.skills_count).toBe(0)
  })

  it('update_session_context mutates the shared context', async () => {
    const handler = getToolHandler('update_session_context')!
    await handler({ skill_invoked: 'upg-test' }, ctx)
    expect(ctx.sessionContext.skills_invoked).toHaveLength(1)
    expect(ctx.sessionContext.skills_invoked[0].skill).toBe('upg-test')
  })

  it('create_node + delete_node round-trip', async () => {
    const create = getToolHandler('create_node')!
    const created = await create({ type: 'feature', title: 'Test feature' }, ctx)
    expect(created.isError).toBeUndefined()
    const createdBody = JSON.parse(created.content[0].text)
    expect(createdBody.node.type).toBe('feature')

    const del = getToolHandler('delete_node')!
    const deleted = await del({ node_id: createdBody.node.id }, ctx)
    expect(deleted.isError).toBeUndefined()
  })

  it('get_changes reports the round-trip as one create + one delete', async () => {
    const create = getToolHandler('create_node')!
    const created = await create({ type: 'feature', title: 'Tracked feature' }, ctx)
    const createdBody = JSON.parse(created.content[0].text)
    const del = getToolHandler('delete_node')!
    await del({ node_id: createdBody.node.id }, ctx)

    const handler = getToolHandler('get_changes')!
    const result = await handler({}, ctx)
    const body = JSON.parse(result.content[0].text)
    expect(body.summary.create).toBeGreaterThanOrEqual(1)
    expect(body.summary.delete).toBeGreaterThanOrEqual(1)
  })

  it('unknown tool name returns undefined (caller surfaces textError)', () => {
    expect(getToolHandler('not_a_tool')).toBeUndefined()
  })
})

// The tree-pattern enum prose (the comma-separated id lists in the get_tree /
// get_tree_pattern descriptions the model reads) is hand-maintained and was the
// one drift seam the catalogue's structural guards did not cover: adding a
// pattern to core works at runtime (validation derives the list from the
// catalogue) while leaving these descriptions silently stale. This pins them to
// the catalogue so a forgotten id fails the build instead of shipping wrong docs.
describe('get_tree description enums stay in lockstep with UPG_TREE_PATTERNS', () => {
  const PATTERN_IDS = UPG_TREE_PATTERNS.map((p) => p.id)
  const def = (name: string) => {
    const d = TOOL_DEFINITIONS.find((t) => t.name === name)
    if (!d) throw new Error(`tool ${name} not in TOOL_DEFINITIONS`)
    return d
  }
  const listsAll = (label: string, text: string) => {
    const missing = PATTERN_IDS.filter((id) => !text.includes(id))
    expect(missing, `${label} omits pattern id(s): ${missing.join(', ')}`).toEqual([])
  }

  it('get_tree tool description + pattern arg list every catalogue pattern', () => {
    const t = def('get_tree')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = t.inputSchema.properties as any
    listsAll('get_tree.description', t.description)
    listsAll('get_tree pattern arg', props.pattern.description)
  })

  it('get_tree_pattern id arg lists every catalogue pattern', () => {
    const t = def('get_tree_pattern')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = t.inputSchema.properties as any
    listsAll('get_tree_pattern id arg', props.id.description)
  })
})
