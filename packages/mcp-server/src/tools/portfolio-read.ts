/**
 * Cross-product read layer (batch-3 #13).
 *
 * Every other content read (`query`, `get_graph_digest`, `list_nodes`, …)
 * operates only on the single ACTIVE product, and answering a portfolio-level
 * question ("show every product's strategy", "which products have no persona")
 * meant serially `switch_product`-ing through each graph — O(n) calls, and
 * un-parallelisable because `switch_product` mutates shared active-product
 * state.
 *
 * `portfolio_query` and `portfolio_digest` read ACROSS products in one call.
 * The active product is read from the live in-memory store (so unflushed edits
 * are reflected); every other product is loaded into a transient read-only
 * store (`UPGFileStore.loadReadOnly` — no watcher, no lock, discarded after the
 * read) so the active product is never disturbed. Both are read-only; the
 * cross-product WRITE counterpart is tracked as batch-4.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import {
  UPGFileStore,
  computeGraphDigest,
  openPortfolioStoreIfExists,
  assembleLandscape,
  assembleCompetitorProfile,
  assembleComparison,
  aggregateEdgeProperties,
  findSingleSelectOverlaps,
  buildPortfolioNodeIndex,
  buildValueAxisMap,
  type UPGPortfolioStore,
  type PortfolioNodeRef,
} from '@unified-product-graph/sdk'
import { REGISTRY_PRODUCT_ID, UPG_CROSS_EDGE_TYPES, validateEdgeProperties } from '@unified-product-graph/core'
import { preflightPayload } from '../lib/payload-guard.js'
import { traverseGraph, type GraphReader, type TraverseParams } from '../lib/graph-traverse.js'
import { findWorkspaceUpgFiles } from './workspace.js'
import { validateGraph } from './validation.js'
import { buildProductKindMap } from '../lib/portfolio-kind.js'

/** A workspace product resolved to its on-disk file + header identity. */
interface ScopedProduct {
  id: string | null
  title: string
  /** Workspace-relative path, as `list_local_products` reports. */
  file: string
  /** Absolute path on disk. */
  absPath: string
}

/**
 * Enumerate workspace products (root + immediate subdirs, including `.upg/`),
 * skipping the portfolio document and any non-product `.upg`. When `scope` is
 * provided, keep only products whose id, relative file, or basename matches an
 * entry. Returns the matched products plus any scope entries that matched
 * nothing (so the caller can report them).
 */
export function resolveScopedProducts(
  cwd: string,
  scope: string[] | undefined,
): { products: ScopedProduct[]; unmatched: string[] } {
  const all: ScopedProduct[] = []
  for (const absPath of findWorkspaceUpgFiles(cwd)) {
    try {
      const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
        product?: { id?: string; title?: string }
      }
      // portfolio.upg and other non-product docs carry no `product` header.
      if (!doc.product) continue
      all.push({
        id: doc.product.id ?? null,
        title: doc.product.title ?? '(untitled)',
        file: path.relative(cwd, absPath),
        absPath,
      })
    } catch {
      // malformed JSON — skip (surfaced per-product if it was explicitly scoped)
    }
  }

  if (!scope || scope.length === 0) {
    return { products: all, unmatched: [] }
  }

  const matches = (p: ScopedProduct, want: string): boolean =>
    p.id === want ||
    p.file === want ||
    path.basename(p.file) === want ||
    path.basename(p.file, '.upg') === want

  const products = all.filter((p) => scope.some((want) => matches(p, want)))
  const unmatched = scope.filter((want) => !all.some((p) => matches(p, want)))
  return { products, unmatched }
}

/**
 * Build a {@link GraphReader} for a product. The active product reads from the
 * live store (`ctx.store`) so unflushed in-memory edits are visible; every
 * other product is loaded read-only into a transient store. Throws if the file
 * cannot be loaded (caller tags the product with the error and continues).
 */
async function readerFor(
  product: ScopedProduct,
  activeStore: UPGFileStore,
): Promise<{ reader: GraphReader; store: UPGFileStore; active: boolean }> {
  const activePath = activeStore.getFilePath()
  if (activePath && path.resolve(activePath) === path.resolve(product.absPath)) {
    return { reader: activeStore, store: activeStore, active: true }
  }
  const store = new UPGFileStore()
  await store.loadReadOnly(product.absPath)
  return { reader: store, store, active: false }
}

/**
 * Cross-edge traversal extension (0.10.6, query-path brief B).
 *
 * The per-product BFS in `traverseGraph` stops at product boundaries: cross-
 * product edges live in `portfolio.upg`, not in any single product's reader, so
 * a `traverse: ["competitor_classified_as_classification_value"]` returned
 * `total_edges: 0`. This builds a one-hop expansion off the portfolio's cross
 * edges, keyed by qualified source (`{product_id}/{node_id}`), restricted to the
 * cross-edge types the caller explicitly named in `traverse[]`. The registry (or
 * other-product) target is resolved to a terminal node so the matrix
 * ("which competitors are value X?") is returned, with each cross edge's
 * `properties` (confidence / assessed_on / ...) intact.
 */
interface CrossExpansion {
  /** qualified source id (`{product_id}/{node_id}`) -> outgoing cross edges of the requested types */
  bySource: Map<string, Array<{ id: string; type: string; source: string; target: string; properties?: Record<string, unknown> }>>
  /** Project a cross-edge target id into a terminal node (resolves registry canonicals). */
  resolveTarget: (target: string) => Record<string, unknown>
}

/** Which `traverse[]` entries are positive cross-edge types (negations and within-graph types excluded). */
function requestedCrossTypes(traverse: string[] | undefined): string[] {
  if (!traverse) return []
  const cross = new Set(UPG_CROSS_EDGE_TYPES as readonly string[])
  return [...new Set(traverse.filter((t) => !t.startsWith('!') && cross.has(t)))]
}

function buildCrossExpansion(
  portfolioStore: UPGPortfolioStore,
  crossTypes: string[],
  includeFields: Set<string>,
): CrossExpansion {
  const wanted = new Set(crossTypes)
  const bySource = new Map<string, Array<{ id: string; type: string; source: string; target: string; properties?: Record<string, unknown> }>>()
  for (const e of portfolioStore.getAllCrossEdges()) {
    if (!wanted.has(e.type)) continue
    const props = (e as { properties?: Record<string, unknown> }).properties
    const arr = bySource.get(e.source) ?? []
    arr.push({ id: e.id, type: e.type, source: e.source, target: e.target, ...(props ? { properties: props } : {}) })
    bySource.set(e.source, arr)
  }
  const resolveTarget = (target: string): Record<string, unknown> => {
    if (target.startsWith(`${REGISTRY_PRODUCT_ID}/`)) {
      const bareId = target.slice(REGISTRY_PRODUCT_ID.length + 1)
      const canonical = portfolioStore.getRegistryNode(bareId)
      if (canonical) {
        const node: Record<string, unknown> = { id: target, type: canonical.type }
        if (includeFields.has('title')) node.title = canonical.title
        if (includeFields.has('status') && canonical.status) node.status = canonical.status
        return node
      }
    }
    // Non-registry (or unresolved) target: surface the qualified id as the node.
    return { id: target }
  }
  return { bySource, resolveTarget }
}

/**
 * Classification distribution (0.10.6, query-path brief D): the "positioning
 * view" as a one-call projection. Walks the portfolio's
 * `*_classified_as_classification_value` cross edges, groups each by the
 * registry axis its target value belongs to (via the registry-internal
 * `classification_axis_includes_classification_value` edges), and counts members
 * per value. Returns `undefined` when no classification edges exist, so
 * portfolios without the tier keep their existing digest output.
 */
function buildClassificationDistribution(portfolioStore: UPGPortfolioStore): Record<string, unknown> | undefined {
  const classifyEdges = portfolioStore
    .getAllCrossEdges()
    .filter((e) => e.type.endsWith('_classified_as_classification_value'))
  if (classifyEdges.length === 0) return undefined

  const doc = portfolioStore.getDocument()
  // Shared axis resolution: a `classification_axis_includes_classification_value`
  // registry edge first, then an `axis:<slug>` tag on the value node. A graph
  // wired either way (or partly each) resolves; the old registry-edge-only path
  // reported every value as unaxed on the common tag-only graph.
  const valueAxis = doc ? buildValueAxisMap(doc) : new Map()
  const label = (bareId: string): string => portfolioStore.getRegistryNode(bareId)?.title ?? bareId

  // axis bare id -> (value bare id -> count); '__unaxed__' collects unresolved values.
  const UNAXED = '__unaxed__'
  const axes = new Map<string, Map<string, number>>()
  for (const e of classifyEdges) {
    const valueBare = e.target.startsWith(`${REGISTRY_PRODUCT_ID}/`)
      ? e.target.slice(REGISTRY_PRODUCT_ID.length + 1)
      : e.target
    const axisBare = valueAxis.get(valueBare)?.axis ?? UNAXED
    const byValue = axes.get(axisBare) ?? new Map<string, number>()
    byValue.set(valueBare, (byValue.get(valueBare) ?? 0) + 1)
    axes.set(axisBare, byValue)
  }

  const axisLabel = (axisBare: string): string => valueAxisLabelFor(valueAxis, axisBare) ?? label(axisBare)
  const axisList = [...axes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([axisBare, byValue]) => {
      const values = [...byValue.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([valueBare, count]) => ({ value: valueBare, label: label(valueBare), count }))
      const total = values.reduce((s, v) => s + v.count, 0)
      return axisBare === UNAXED
        ? { axis: null, label: 'unaxed', values, total }
        : { axis: axisBare, label: axisLabel(axisBare), values, total }
    })

  return {
    total_classified_edges: classifyEdges.length,
    axes: axisList,
    // Discoverability: point an agent that has never seen this graph at the tool
    // that renders the full nested view, so the landscape is reachable, not just
    // present (read-path brief, ask #4).
    render_with: 'get_portfolio_tree',
    note: `This portfolio has a classification landscape across ${axisList.filter((a) => a.axis !== null).length} axes. Render it with get_portfolio_tree({ shape: "landscape" }) (anchor at an axis or value for members), or a competitor's position with get_portfolio_tree({ shape: "competitor_profile", from_id }).`,
  }
}

/** Display label for an axis bare id, recovered from any value that resolved to it. */
function valueAxisLabelFor(
  valueAxis: Map<string, { axis: string; label: string }>,
  axisBare: string,
): string | undefined {
  for (const v of valueAxis.values()) if (v.axis === axisBare) return v.label
  return undefined
}

/**
 * `portfolio_query`: run the single-product `query` traversal across every
 * product in scope, tagging each subgraph with its source `product_id`. Same
 * traversal semantics as `query` (BFS over typed edges with field projection),
 * but spanning products in one call.
 *
 * @returns JSON: `{ products: Array<{ product_id, file, title, total_nodes,
 *   total_edges, nodes, edges, truncated? }>, products_searched,
 *   products_with_matches, empty_products, unmatched_scope? }`. Products that
 *   matched zero nodes are summarised in `empty_products`, not expanded, to
 *   keep the payload lean. `from_id` only matches in its owning product; the
 *   rest report empty.
 * @atomicity atomic (read-only). Never mutates active-product state.
 * @see query
 * @see portfolio_digest
 * @see list_local_products
 */
export const portfolioQuery: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const from = args.from as string | undefined
  const fromId = args.from_id as string | undefined
  if (!from && !fromId) {
    return textError('Provide either "from" (entity type) or "from_id" (node ID)')
  }

  const scope = args.scope as string[] | undefined
  const cwd = process.cwd()
  const { products, unmatched } = resolveScopedProducts(cwd, scope)
  if (products.length === 0) {
    return text(
      JSON.stringify(
        {
          products: [],
          products_searched: 0,
          products_with_matches: 0,
          empty_products: [],
          ...(unmatched.length > 0 ? { unmatched_scope: unmatched } : {}),
          note:
            scope && scope.length > 0
              ? 'No workspace products matched the requested scope.'
              : 'No products found in the workspace. Run from a directory with a .upg/ workspace.',
        },
        null,
        2,
      ),
    )
  }

  // Per-product cap defaults lower than single-product `query` (200) because a
  // portfolio sweep aggregates across many graphs; max still 1000 per product.
  const perProductLimit = Math.min(Math.max((args.limit as number) ?? 100, 1), 1000)
  const params: TraverseParams = {
    from,
    from_id: fromId,
    traverse: args.traverse as string[] | undefined,
    depth: args.depth as number | undefined,
    limit: perProductLimit,
    include: args.include as string[] | undefined,
    edge_include: args.edge_include as string[] | undefined,
    property_include: args.property_include as string[] | undefined,
  }

  // Cross-edge traversal (0.10.6, brief B): when a cross-edge type is named in
  // `traverse[]`, load the portfolio once and expand matched nodes one hop out
  // over the portfolio's cross edges to their registry / other-product targets.
  // Off by default (no cross types named) so existing within-graph queries are
  // byte-identical.
  const crossTypes = requestedCrossTypes(params.traverse)
  const includeFields = new Set(params.include ?? ['title', 'status', 'type'])
  includeFields.add('id'); includeFields.add('type')
  const emitEdges = !(params.edge_include !== undefined && params.edge_include.length === 0)
  let expansion: CrossExpansion | null = null
  if (crossTypes.length > 0) {
    // Best-effort: a missing or legacy/malformed portfolio doc just means no
    // cross-edge expansion (the within-graph traversal is unaffected).
    try {
      const portfolioStore = await openPortfolioStoreIfExists(cwd)
      if (portfolioStore) expansion = buildCrossExpansion(portfolioStore, crossTypes, includeFields)
    } catch {
      /* no usable portfolio document: skip cross-edge expansion */
    }
  }

  const matched: Array<Record<string, unknown>> = []
  const emptyProducts: string[] = []
  const errored: Array<{ product_id: string | null; file: string; error: string }> = []
  let totalNodes = 0
  let totalEdges = 0

  for (const product of products) {
    let reader: GraphReader
    try {
      ;({ reader } = await readerFor(product, store))
    } catch (err) {
      errored.push({ product_id: product.id, file: product.file, error: (err as Error).message })
      continue
    }

    const outcome = traverseGraph(reader, params)
    if (!outcome.ok) {
      // The only loop-time error is `from_id` not present in THIS product; node
      // ids are product-local, so that is "no match here", not a failure.
      emptyProducts.push(product.id ?? product.file)
      continue
    }
    const r = outcome.result
    if (r.total_nodes === 0) {
      emptyProducts.push(product.id ?? product.file)
      continue
    }

    const nodes = [...r.nodes]
    const edges = [...r.edges]
    // Expand cross edges off the within-product nodes (qualified by product id).
    if (expansion && product.id) {
      const seenTargets = new Set<string>(nodes.map((n) => String((n as { id?: unknown }).id)))
      for (const n of r.nodes) {
        const bareId = String((n as { id?: unknown }).id)
        const qualified = `${product.id}/${bareId}`
        for (const ce of expansion.bySource.get(qualified) ?? []) {
          if (emitEdges) {
            edges.push({
              id: ce.id,
              type: ce.type,
              source: ce.source,
              target: ce.target,
              ...(ce.properties ? { properties: ce.properties } : {}),
            })
          }
          if (!seenTargets.has(ce.target)) {
            seenTargets.add(ce.target)
            nodes.push(expansion.resolveTarget(ce.target))
          }
        }
      }
    }

    totalNodes += nodes.length
    totalEdges += edges.length
    matched.push({
      product_id: product.id,
      file: product.file,
      title: product.title,
      total_nodes: nodes.length,
      total_edges: edges.length,
      nodes,
      edges,
      ...(r.truncated ? { truncated: true, truncated_at_depth: r.truncated_at_depth } : {}),
    })
  }

  // Aggregate payload guard: a wide sweep can exceed the transport budget.
  const guard = preflightPayload({
    toolName: 'portfolio_query',
    nodeCount: totalNodes,
    edgeCount: totalEdges,
    compactEdges: true,
    argsHint: `from=${from ?? fromId}, products=${matched.length}, limit=${perProductLimit}`,
  })
  if (guard.kind === 'refuse') return guard.result

  const response: Record<string, unknown> = {
    products: matched,
    products_searched: products.length,
    products_with_matches: matched.length,
    total_nodes: totalNodes,
    total_edges: totalEdges,
    empty_products: emptyProducts,
  }
  if (errored.length > 0) response.errored_products = errored
  if (unmatched.length > 0) response.unmatched_scope = unmatched
  if (guard.kind === 'warn') Object.assign(response, guard.fields)
  return text(JSON.stringify(response, null, 2))
}

/**
 * `portfolio_digest`: roll up each product's counts, health, and stage-coverage
 * in one call — the multi-product `get_graph_digest`. The strategic-surface
 * read that previously required `switch_product` + `get_graph_digest` per graph.
 *
 * @returns JSON: `{ products: Array<{ product_id, file, title, stage,
 *   total_nodes, total_edges, health, coverage_pct, top_types }>, rollup:
 *   { products, total_nodes, total_edges, by_stage }, errored_products?,
 *   unmatched_scope? }`. `health`/`coverage_pct` come from `computeGraphDigest`,
 *   identical to what `get_graph_digest` reports per product.
 * @atomicity atomic (read-only). Never mutates active-product state.
 * @see get_graph_digest
 * @see portfolio_query
 */
export const portfolioDigest: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const scope = args.scope as string[] | undefined
  // Batch-4 #22: a target coverage profile, applied to every product so
  // "is this product at parity?" is a direct read across the portfolio.
  const coverageProfile = Array.isArray(args.coverage_profile)
    ? (args.coverage_profile as unknown[]).filter((r): r is string => typeof r === 'string')
    : undefined
  const cwd = process.cwd()
  const { products, unmatched } = resolveScopedProducts(cwd, scope)
  const kindMap = buildProductKindMap(cwd)

  const summaries: Array<Record<string, unknown>> = []
  const errored: Array<{ product_id: string | null; file: string; error: string }> = []
  const watchedProducts: Array<{ product_id: string | null; file: string }> = []
  const byStage: Record<string, number> = {}
  let totalNodes = 0
  let totalEdges = 0

  for (const product of products) {
    try {
      const { store: reader } = await readerFor(product, store)
      const digest = computeGraphDigest(reader, coverageProfile ? { coverageProfile } : undefined)
      const stage = digest.product.stage || 'unset'
      byStage[stage] = (byStage[stage] ?? 0) + 1
      totalNodes += digest.counts.total_nodes
      totalEdges += digest.counts.total_edges

      const topTypes = Object.entries(digest.counts.by_type)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => ({ type, count }))

      const kind = (product.id && kindMap.get(product.id)) || 'owned'
      if (kind === 'watched') watchedProducts.push({ product_id: product.id, file: product.file })
      summaries.push({
        product_id: product.id,
        file: product.file,
        kind,
        title: digest.product.title,
        stage: digest.product.stage || null,
        total_nodes: digest.counts.total_nodes,
        total_edges: digest.counts.total_edges,
        health: digest.health,
        coverage_pct: digest.coverage.stage_summary?.overall_pct ?? null,
        ...(coverageProfile ? { coverage_profile_pct: digest.coverage.profile_summary?.overall_pct ?? null } : {}),
        top_types: topTypes,
      })
    } catch (err) {
      errored.push({ product_id: product.id, file: product.file, error: (err as Error).message })
    }
  }

  const response: Record<string, unknown> = {
    products: summaries,
    rollup: {
      products: summaries.length,
      total_nodes: totalNodes,
      total_edges: totalEdges,
      by_stage: byStage,
    },
  }
  if (coverageProfile) response.coverage_profile = coverageProfile
  // Classification distribution (0.10.6, brief D): the positioning view, per axis.
  // Best-effort: a missing or legacy/malformed portfolio doc never breaks the digest.
  try {
    const portfolioStore = await openPortfolioStoreIfExists(cwd)
    if (portfolioStore) {
      const classification = buildClassificationDistribution(portfolioStore)
      if (classification) response.classification = classification
    }
  } catch {
    /* no usable portfolio document: omit the classification block */
  }
  if (errored.length > 0) response.errored_products = errored
  if (unmatched.length > 0) response.unmatched_scope = unmatched
  if (watchedProducts.length > 0) {
    response.watched_products = watchedProducts
    response.note_watched =
      'Products in a watched portfolio (kind: watched, e.g. competitor intelligence graphs) appear here for visibility, but their coverage_pct and health reflect monitoring depth, not product-management health. Exclude them when judging owned-portfolio health.'
  }
  if (products.length === 0) {
    response.note =
      scope && scope.length > 0
        ? 'No workspace products matched the requested scope.'
        : 'No products found in the workspace. Run from a directory with a .upg/ workspace.'
  }
  return text(JSON.stringify(response, null, 2))
}

/**
 * Registry drift report (canonical-registry initiative, Phase 3). Walks every
 * `instance_of` cross-edge and checks it against the canonical it points at:
 *   - `missing_canonical`: the target is not in the registry,
 *   - `dangling_instance`: the source product node no longer exists,
 *   - `type_mismatch`: instance and canonical disagree on type,
 *   - `title_divergence`: the instance was renamed off-canon (title differs).
 *
 * Returns `undefined` when the portfolio has no registry, so portfolios without
 * one keep their existing `portfolio_validate` output unchanged.
 */
async function registryDriftReport(
  cwd: string,
  activeStore: UPGFileStore,
  issueLimit: number,
): Promise<Record<string, unknown> | undefined> {
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) return undefined
  const registryNodes = portfolioStore.listRegistryNodes()
  const crossEdges = portfolioStore.getAllCrossEdges()
  const instanceEdges = crossEdges.filter((e) => e.type === 'instance_of')
  if (registryNodes.length === 0 && instanceEdges.length === 0) return undefined

  const canonicalById = new Map(registryNodes.map((n) => [n.id, n]))
  const activeId = (() => {
    try {
      return activeStore.getDocument()?.product?.id
    } catch {
      return undefined
    }
  })()

  // Cache read-only product stores by id so each referenced product loads once.
  const roCache = new Map<string, UPGFileStore | null>()
  const resolveNode = async (productId: string, nodeId: string) => {
    if (activeId && productId === activeId) return activeStore.getNode(nodeId)
    if (!roCache.has(productId)) {
      let store: UPGFileStore | null = null
      for (const absPath of findWorkspaceUpgFiles(cwd)) {
        try {
          const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as { product?: { id?: string } }
          if (doc.product?.id === productId) {
            const s = new UPGFileStore()
            await s.loadReadOnly(absPath)
            store = s
            break
          }
        } catch {
          // skip malformed
        }
      }
      roCache.set(productId, store)
    }
    return roCache.get(productId)?.getNode(nodeId)
  }

  const issues: Array<Record<string, unknown>> = []
  let okCount = 0
  let sanctioned = 0
  for (const edge of instanceEdges) {
    const prefix = `${REGISTRY_PRODUCT_ID}/`
    const canonicalId = edge.target.startsWith(prefix) ? edge.target.slice(prefix.length) : edge.target
    const canonical = canonicalById.get(canonicalId)
    if (!canonical) {
      issues.push({ kind: 'missing_canonical', edge_id: edge.id, source: edge.source, canonical: canonicalId })
      continue
    }
    const [productId, ...rest] = edge.source.split('/')
    const nodeId = rest.join('/')
    const node = await resolveNode(productId ?? '', nodeId)
    if (!node) {
      issues.push({ kind: 'dangling_instance', edge_id: edge.id, source: edge.source, canonical: canonicalId })
      continue
    }
    if (node.type !== canonical.type) {
      issues.push({
        kind: 'type_mismatch', edge_id: edge.id, source: edge.source, canonical: canonicalId,
        instance_type: node.type, canonical_type: canonical.type,
      })
      continue
    }
    if (node.title !== canonical.title) {
      // A divergence marked `alias: true` on the edge is sanctioned (an
      // intentional product-local name, e.g. "Vercel Platform / SDK" vs canonical
      // "Vercel"), so it is not drift: exclude it from issues and from `clean`,
      // counting it as accepted instead. `clean: true` then means "no UNexpected drift".
      if (edge.alias === true) {
        sanctioned++
        continue
      }
      issues.push({
        kind: 'title_divergence', edge_id: edge.id, source: edge.source, canonical: canonicalId,
        instance_title: node.title, canonical_title: canonical.title,
      })
      continue
    }
    okCount++
  }

  const byKind: Record<string, number> = {}
  for (const i of issues) byKind[i.kind as string] = (byKind[i.kind as string] ?? 0) + 1
  return {
    canonical_entities: registryNodes.length,
    instances: instanceEdges.length,
    on_canon: okCount,
    sanctioned,
    issues_total: issues.length,
    issues_by_kind: byKind,
    issues: issues.slice(0, issueLimit),
    clean: issues.length === 0,
  }
}

// Cross-edge types that count as "implementing / conforming to" a specification.
const SPEC_IMPLEMENTER_EDGES = new Set<string>([
  'product_implements_specification',
  'product_exposes_specification',
  'feature_conforms_to_specification',
  'api_contract_speaks_specification',
])
// Product-level implementations (used for the reimplementation detector — a
// feature conforming or an api_contract speaking does not count as a product
// owning a parallel implementation).
const PRODUCT_SPEC_IMPL_EDGES = new Set<string>([
  'product_implements_specification',
  'product_exposes_specification',
])
const FOUNDATIONS_CROSS_EDGES = new Set<string>([
  ...SPEC_IMPLEMENTER_EDGES,
  'product_exposes_primitive',
  'feature_manipulates_primitive',
  'primitive_stored_as_data_type',
])

/**
 * Evaluate the portfolio-scoped (`scope: 'portfolio'`) foundations anti-patterns
 * (0.9.13). These read the shared registry + cross-product edges + product-local
 * primitive nodes, context the single-graph `evaluateAntiPatterns` cannot express,
 * so they live here instead of in `validate_graph`:
 *   - specification-without-implementer: a registry specification no product /
 *     feature / api_contract implements or conforms to.
 *   - primitive-scattered-without-canonical: the same primitive title appears as a
 *     product-local node in 2+ products with no registry canonical unifying them.
 *   - product-reimplements-specification: 2+ products independently implement the
 *     same registry specification.
 * Returns undefined for portfolios with no foundations usage, so non-foundations
 * portfolios keep their existing output.
 */
async function portfolioAntiPatternReport(
  cwd: string,
  activeStore: UPGFileStore,
  limit: number,
): Promise<Record<string, unknown> | undefined> {
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) return undefined
  const registryNodes = portfolioStore.listRegistryNodes()
  const crossEdges = portfolioStore.getAllCrossEdges()
  const specs = registryNodes.filter((n) => n.type === 'specification')
  const registryPrimitiveTitles = new Set(
    registryNodes.filter((n) => n.type === 'primitive').map((n) => n.title.toLowerCase()),
  )
  const prefix = `${REGISTRY_PRODUCT_ID}/`
  const bare = (ref: string) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref)

  // Product-local primitive nodes across the workspace (active product read live,
  // others read from disk), grouped by lowercased title.
  const activeId = (() => {
    try {
      return activeStore.getDocument()?.product?.id
    } catch {
      return undefined
    }
  })()
  const primitiveProductsByTitle = new Map<string, { display: string; products: Set<string> }>()
  let localPrimitiveCount = 0
  const recordPrimitive = (title: string, productId: string) => {
    const key = title.toLowerCase()
    const entry = primitiveProductsByTitle.get(key) ?? { display: title, products: new Set<string>() }
    entry.products.add(productId)
    primitiveProductsByTitle.set(key, entry)
    localPrimitiveCount++
  }
  for (const absPath of findWorkspaceUpgFiles(cwd)) {
    try {
      const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
        product?: { id?: string }
        nodes?: Array<{ type?: string; title?: string }>
      }
      const productId = doc.product?.id
      if (!productId) continue // skip portfolio.upg / non-product docs
      const nodes =
        activeId && productId === activeId
          ? (activeStore.getDocument()?.nodes ?? [])
          : doc.nodes ?? []
      for (const node of nodes) {
        if (node.type === 'primitive' && node.title) recordPrimitive(node.title, productId)
      }
    } catch {
      // skip malformed
    }
  }

  const foundationsPresent =
    specs.length > 0 ||
    registryPrimitiveTitles.size > 0 ||
    localPrimitiveCount > 0 ||
    crossEdges.some((e) => FOUNDATIONS_CROSS_EDGES.has(e.type))
  if (!foundationsPresent) return undefined

  const violations: Array<Record<string, unknown>> = []

  // 1 · specification-without-implementer
  const unimplemented = specs
    .filter((spec) => {
      const target = `${prefix}${spec.id}`
      return !crossEdges.some((e) => SPEC_IMPLEMENTER_EDGES.has(e.type) && e.target === target)
    })
    .map((spec) => ({ specification: spec.id, title: spec.title }))
  if (unimplemented.length > 0) {
    violations.push({
      anti_pattern_id: 'specification-without-implementer',
      severity: 'medium',
      count: unimplemented.length,
      instances: unimplemented.slice(0, limit),
    })
  }

  // 2 · primitive-scattered-without-canonical
  const scattered: Array<Record<string, unknown>> = []
  for (const [key, entry] of primitiveProductsByTitle) {
    if (entry.products.size >= 2 && !registryPrimitiveTitles.has(key)) {
      scattered.push({ primitive: entry.display, products: [...entry.products].sort() })
    }
  }
  if (scattered.length > 0) {
    violations.push({
      anti_pattern_id: 'primitive-scattered-without-canonical',
      severity: 'medium',
      count: scattered.length,
      instances: scattered.slice(0, limit),
    })
  }

  // 3 · product-reimplements-specification
  const productsBySpec = new Map<string, Set<string>>()
  for (const e of crossEdges) {
    if (!PRODUCT_SPEC_IMPL_EDGES.has(e.type)) continue
    const product = e.source_product_id ?? e.source.split('/')[0]
    if (!product) continue
    const set = productsBySpec.get(e.target) ?? new Set<string>()
    set.add(product)
    productsBySpec.set(e.target, set)
  }
  const reimplemented = [...productsBySpec.entries()]
    .filter(([, products]) => products.size >= 2)
    .map(([target, products]) => ({ specification: bare(target), products: [...products].sort() }))
  if (reimplemented.length > 0) {
    violations.push({
      anti_pattern_id: 'product-reimplements-specification',
      severity: 'low',
      count: reimplemented.length,
      instances: reimplemented.slice(0, limit),
    })
  }

  const issuesTotal = violations.reduce((sum, v) => sum + (v.count as number), 0)
  return {
    evaluated: [
      'specification-without-implementer',
      'primitive-scattered-without-canonical',
      'product-reimplements-specification',
    ],
    specifications: specs.length,
    violations,
    issues_total: issuesTotal,
    clean: violations.length === 0,
  }
}

/**
 * `portfolio_validate` (Batch-4 #19): run `validate_graph` across every product
 * in scope in one call — the audit counterpart to `portfolio_digest`. Replaces
 * the `switch_product` + `validate_graph` round-trip per product. Each product
 * is validated by the SAME single-product `validate_graph` code path (drift +
 * anti-patterns), so the per-product verdict can never diverge; the active
 * product is read live, the rest read-only.
 *
 * @returns JSON: `{ products: Array<{ product_id, file, title, valid,
 *   structurally_valid, drift, anti_patterns: { high, medium, low },
 *   top_violations? }>, rollup: { products, valid, invalid, structurally_valid,
 *   anti_pattern_violations, all_valid }, errored_products?, unmatched_scope? }`.
 *   `severity` filters anti-patterns; `include_violations: false` drops the
 *   per-product `top_violations` list. When the portfolio has a canonical
 *   registry, a `registry_drift` block reports `instance_of` edges that point at
 *   a missing canonical, dangle, mismatch type, or were renamed off-canon
 *   (canonical-registry initiative, Phase 3). When the portfolio uses the
 *   foundations tier (a registry specification / primitive or a foundations
 *   cross-edge), a `portfolio_anti_patterns` block reports the portfolio-scoped
 *   (`scope: 'portfolio'`) anti-patterns: specification-without-implementer,
 *   primitive-scattered-without-canonical, product-reimplements-specification (0.9.13).
 * @atomicity atomic (read-only). Never mutates active-product state.
 * @see validate_graph
 * @see portfolio_digest
 * @see portfolio_query
 * @see list_registry
 */
export const portfolioValidate: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const scope = args.scope as string[] | undefined
  const severity = args.severity as string | undefined
  const includeViolations = (args.include_violations as boolean) ?? true
  const violationLimit = Math.min(Math.max((args.violation_limit as number) ?? 5, 1), 25)
  const cwd = process.cwd()
  const { products, unmatched } = resolveScopedProducts(cwd, scope)

  const summaries: Array<Record<string, unknown>> = []
  const errored: Array<{ product_id: string | null; file: string; error: string }> = []
  let validCount = 0
  let structurallyValidCount = 0
  let totalHigh = 0
  let totalMedium = 0
  let totalLow = 0

  for (const product of products) {
    let reader: UPGFileStore
    try {
      ;({ store: reader } = await readerFor(product, store))
    } catch (err) {
      errored.push({ product_id: product.id, file: product.file, error: (err as Error).message })
      continue
    }

    // Reuse the single-product validate_graph handler verbatim against this
    // product's store — identical drift + anti-pattern verdict, zero divergence.
    const perCtx: ToolContext = {
      store: reader,
      sessionContext: ctx.sessionContext,
      queryCache: ctx.queryCache,
      sync: ctx.sync,
    }
    const vArgs: Record<string, unknown> = {}
    if (severity) vArgs.severity = severity

    let body: {
      valid?: boolean
      structurally_valid?: boolean
      summary?: Record<string, number>
      anti_pattern_violations?: Array<{ anti_pattern_id: string; severity: string; name: string }>
    }
    try {
      const vResult = await validateGraph(vArgs, perCtx)
      body = JSON.parse(vResult.content[0]?.text ?? '{}')
    } catch (err) {
      errored.push({ product_id: product.id, file: product.file, error: `validate failed: ${(err as Error).message}` })
      continue
    }

    const high = body.summary?.anti_pattern_violations_high ?? 0
    const medium = body.summary?.anti_pattern_violations_medium ?? 0
    const low = body.summary?.anti_pattern_violations_low ?? 0
    totalHigh += high
    totalMedium += medium
    totalLow += low
    if (body.valid) validCount++
    if (body.structurally_valid) structurallyValidCount++

    const entry: Record<string, unknown> = {
      product_id: product.id,
      file: product.file,
      title: product.title,
      valid: body.valid ?? null,
      structurally_valid: body.structurally_valid ?? null,
      drift: {
        entity: body.summary?.entity_drift ?? 0,
        edge: body.summary?.edge_drift ?? 0,
        property: body.summary?.property_drift ?? 0,
        top_level: body.summary?.top_level_drift ?? 0,
        lifecycle: body.summary?.lifecycle_drift ?? 0,
        self_referential: body.summary?.self_referential ?? 0,
        edge_type_pair: body.summary?.edge_type_pair_drift ?? 0,
        self_loops: body.summary?.graph_topology_self_loops ?? 0,
        property_type: body.summary?.property_type_drift ?? 0,
      },
      anti_patterns: { high, medium, low },
    }
    if (includeViolations && Array.isArray(body.anti_pattern_violations) && body.anti_pattern_violations.length > 0) {
      entry.top_violations = body.anti_pattern_violations
        .slice(0, violationLimit)
        .map((v) => ({ anti_pattern_id: v.anti_pattern_id, severity: v.severity, name: v.name }))
    }
    summaries.push(entry)
  }

  const response: Record<string, unknown> = {
    products: summaries,
    rollup: {
      products: summaries.length,
      valid: validCount,
      invalid: summaries.length - validCount,
      structurally_valid: structurallyValidCount,
      anti_pattern_violations: { high: totalHigh, medium: totalMedium, low: totalLow },
      all_valid: summaries.length > 0 && validCount === summaries.length,
    },
  }
  if (errored.length > 0) response.errored_products = errored
  if (unmatched.length > 0) response.unmatched_scope = unmatched
  if (products.length === 0) {
    response.note =
      scope && scope.length > 0
        ? 'No workspace products matched the requested scope.'
        : 'No products found in the workspace. Run from a directory with a .upg/ workspace.'
  }
  // Registry drift (Phase 3): only attached when the portfolio has a registry,
  // so non-registry portfolios keep their existing output.
  try {
    const drift = await registryDriftReport(cwd, store, violationLimit)
    if (drift) response.registry_drift = drift
  } catch {
    // registry drift is advisory; never fail the whole validate on its account
  }
  // Portfolio-scoped (foundations) anti-patterns: only attached when the portfolio
  // has foundations usage (a registry specification / primitive or a foundations
  // cross-edge), so non-foundations portfolios keep their existing output.
  try {
    const portfolioAntiPatterns = await portfolioAntiPatternReport(cwd, store, violationLimit)
    if (portfolioAntiPatterns) response.portfolio_anti_patterns = portfolioAntiPatterns
  } catch {
    // advisory; never fail the whole validate on its account
  }
  return text(JSON.stringify(response, null, 2))
}

/**
 * Enrich a portfolio node index with file-loaded product titles for any
 * qualified ids in `wanted` the index could not already resolve (registry
 * canonicals and `instance_of`-registered nodes resolve from the document
 * alone). Loads each referenced product file read-only at most once. Best-effort:
 * an unloadable product simply leaves its nodes unresolved (the assembler falls
 * back to the bare id as the title).
 */
async function enrichIndexFromProducts(
  cwd: string,
  activeStore: UPGFileStore,
  index: Map<string, PortfolioNodeRef>,
  wanted: Iterable<string>,
): Promise<void> {
  // Group the still-unresolved qualified ids by product id.
  const byProduct = new Map<string, Set<string>>()
  for (const qid of wanted) {
    if (index.has(qid)) continue
    const slash = qid.indexOf('/')
    if (slash === -1) continue
    const pid = qid.slice(0, slash)
    if (pid === REGISTRY_PRODUCT_ID) continue
    ;(byProduct.get(pid) ?? byProduct.set(pid, new Set()).get(pid)!).add(qid.slice(slash + 1))
  }
  if (byProduct.size === 0) return

  const activeId = (() => {
    try {
      return activeStore.getDocument()?.product?.id
    } catch {
      return undefined
    }
  })()

  for (const [pid, nodeIds] of byProduct) {
    let store: UPGFileStore | null = null
    let title: string | undefined
    if (activeId && pid === activeId) {
      store = activeStore
      try {
        title = activeStore.getDocument()?.product?.title
      } catch {
        /* ignore */
      }
    } else {
      for (const absPath of findWorkspaceUpgFiles(cwd)) {
        try {
          const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as { product?: { id?: string; title?: string } }
          if (doc.product?.id === pid) {
            const s = new UPGFileStore()
            await s.loadReadOnly(absPath)
            store = s
            title = doc.product.title
            break
          }
        } catch {
          // skip malformed
        }
      }
    }
    if (!store) continue
    for (const nodeId of nodeIds) {
      const n = store.getNode(nodeId)
      if (!n) continue
      index.set(`${pid}/${nodeId}`, {
        id: `${pid}/${nodeId}`,
        bare_id: nodeId,
        type: n.type,
        title: n.title,
        status: n.status as string | undefined,
        product_id: pid,
        product_title: title,
      })
    }
  }
}

/**
 * `get_portfolio_tree`: assemble a portfolio-grain tree from the shared
 * classification registry and the `*_classified_as_classification_value` cross
 * edges in `.upg/portfolio.upg`. The portfolio-grain complement to `get_tree`
 * (which is product-scoped): two shapes a human or downstream actually consumes.
 *
 * - `shape: "landscape"` (default): classification axis -> its values -> the
 *   nodes classified at each value, every leaf carrying the edge's `confidence`
 *   / `assessed_on`. Anchor at one axis or value with `from_id`
 *   (`registry/classification_value_…` or `registry/classification_axis_…`), or
 *   omit it for the whole portfolio. Values whose axis is not wired (no
 *   `classification_axis_includes_classification_value` edge and no `axis:` tag)
 *   are grouped under an `axis: null` "unaxed" bucket, surfaced rather than hidden.
 * - `shape: "competitor_profile"`: one classified node (a competitor) ->
 *   its position on every axis it has been graded against, each carrying
 *   confidence. `from_id` is required (the qualified id of the node to profile).
 *
 * Node titles resolve from the document where possible (registry canonicals,
 * and product-local nodes via their `instance_of` edge), and from a read-only
 * product-file load otherwise, so output names entities ("Directus") rather than
 * opaque ids.
 *
 * Parameters:
 * - `shape`: `landscape` (default) or `competitor_profile`.
 * - `from_id`: anchor node id (qualified or bare). Optional for landscape;
 *   required for competitor_profile.
 * - `include_properties`: classification-edge property keys to inline on each
 *   leaf, in addition to the always-included `confidence` / `assessed_on`.
 * - `include_members`: landscape only. Force the classified members to inline
 *   even on the whole-portfolio overview (which is counts-only by default to
 *   stay under the transport cap). Honoured subject to the payload guard.
 *
 * @returns JSON: the landscape or profile structure (see the SDK shapes).
 * @atomicity atomic (read-only). Reads the portfolio document and, for title
 *   resolution, referenced product files read-only; never mutates active state.
 * @see portfolio_digest
 * @see list_portfolio_cross_edges
 * @see get_tree
 */
export const getPortfolioTree: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const shape = (args.shape as string | undefined) ?? 'landscape'
  if (shape !== 'landscape' && shape !== 'competitor_profile') {
    return textError(`Invalid shape: "${shape}". Valid: landscape, competitor_profile.`)
  }
  const fromId = args.from_id as string | undefined
  const includeProperties = Array.isArray(args.include_properties)
    ? (args.include_properties as string[])
    : undefined

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(
      JSON.stringify(
        { shape, note: 'No workspace portfolio document found. Run from a directory with a .upg/ workspace.' },
        null,
        2,
      ),
    )
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  // Resolve titles: registry + instance_of from the document, then enrich any
  // remaining classified-node sources from their product files.
  const index = buildPortfolioNodeIndex(doc)
  const classifySources = (doc.cross_edges ?? [])
    .filter((e) => e.type.endsWith('_classified_as_classification_value'))
    .map((e) => e.source)
  await enrichIndexFromProducts(cwd, ctx.store as UPGFileStore, index, classifySources)
  // The profile subject may itself need a file-loaded title.
  if (shape === 'competitor_profile' && fromId) await enrichIndexFromProducts(cwd, ctx.store as UPGFileStore, index, [fromId])

  const includeMembers = typeof args.include_members === 'boolean' ? (args.include_members as boolean) : undefined
  const result =
    shape === 'competitor_profile'
      ? assembleCompetitorProfile(doc, { from_id: fromId, include_properties: includeProperties, node_index: index })
      : assembleLandscape(doc, { from_id: fromId, include_properties: includeProperties, node_index: index, include_members: includeMembers })

  // Estimate from what is actually rendered: inlined members (landscape detail)
  // or positions (profile); a counts-only overview renders one row per value.
  const renderedCount =
    result.shape === 'landscape'
      ? (result.stats.members_included ? result.stats.members : result.stats.values)
      : result.stats.positions
  const guard = preflightPayload({
    toolName: 'get_portfolio_tree',
    nodeCount: 0,
    edgeCount: renderedCount,
    compactEdges: false, // leaves carry title + confidence + assessed_on
    argsHint: `shape=${shape}, from_id=${fromId ?? '(all)'}`,
  })
  if (guard.kind === 'refuse') return guard.result
  const response = result as unknown as Record<string, unknown>
  if (guard.kind === 'warn') Object.assign(response, guard.fields)
  return text(JSON.stringify(response, null, 2))
}

/**
 * `audit_property_coverage`: given a cross-edge type and the property keys that
 * should be present, return the portfolio cross-edges that LACK them (and,
 * optionally, the ones whose present values are malformed against the type's
 * property schema). The completeness check that turns "I ran the writes" into
 * "the data is actually backfilled" — without a shell pipeline over
 * `portfolio.upg` (0.10.8, read-path-tooling brief #1).
 *
 * Parameters:
 * - `edge_type` (required): the cross-edge type to audit (e.g.
 *   `competitor_classified_as_classification_value`).
 * - `required_keys` (required): the `properties` keys that should be present on
 *   every edge of that type (e.g. `["confidence", "assessed_on"]`).
 * - `source_product_id`: restrict to edges whose source is in this product.
 * - `check_values` (default true): also report edges whose PRESENT properties
 *   fail the type's property schema (e.g. a `confidence` missing its `label`,
 *   an off-scale value) under `malformed`.
 *
 * @returns JSON: `{ edge_type, required_keys, total, complete,
 *   missing: [{ edge_id, source, target, source_title?, target_title?,
 *   missing_keys }], malformed?: [...] }`.
 * @atomicity atomic (read-only). Reads the portfolio document only.
 * @see list_portfolio_cross_edges
 * @see get_portfolio_tree
 */
export const auditPropertyCoverage: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const edgeType = args.edge_type as string | undefined
  if (!edgeType) return textError('Missing required parameter: edge_type.')
  if (!(UPG_CROSS_EDGE_TYPES as readonly string[]).includes(edgeType)) {
    return textError(`Unknown cross-edge type: "${edgeType}". See list_cross_edge_types.`)
  }
  const requiredKeys = Array.isArray(args.required_keys) ? (args.required_keys as string[]) : undefined
  if (!requiredKeys || requiredKeys.length === 0) {
    return textError('Missing required parameter: required_keys (a non-empty array of property keys).')
  }
  const sourceProductFilter = args.source_product_id as string | undefined
  const checkValues = args.check_values !== false

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ edge_type: edgeType, required_keys: requiredKeys, total: 0, complete: 0, missing: [], note: 'No workspace portfolio document found.' }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  let edges = portfolioStore.getAllCrossEdges().filter((e) => e.type === edgeType)
  if (sourceProductFilter) edges = edges.filter((e) => e.source_product_id === sourceProductFilter)

  const index = buildPortfolioNodeIndex(doc)
  const titleOf = (qid: string): string | undefined => index.get(qid)?.title

  const missing: Array<Record<string, unknown>> = []
  const malformed: Array<Record<string, unknown>> = []
  let complete = 0
  for (const e of edges) {
    const props = (e.properties ?? {}) as Record<string, unknown>
    const missingKeys = requiredKeys.filter((k) => !(k in props))
    const row = () => {
      const r: Record<string, unknown> = { edge_id: e.id, source: e.source, target: e.target }
      const st = titleOf(e.source)
      const tt = titleOf(e.target)
      if (st) r.source_title = st
      if (tt) r.target_title = tt
      return r
    }
    if (missingKeys.length > 0) missing.push({ ...row(), missing_keys: missingKeys })
    else complete++
    if (checkValues && Object.keys(props).length > 0) {
      const issues = validateEdgeProperties(edgeType, props)
      if (issues.length > 0) malformed.push({ ...row(), issues })
    }
  }

  const response: Record<string, unknown> = {
    edge_type: edgeType,
    required_keys: requiredKeys,
    total: edges.length,
    complete,
    missing,
  }
  if (checkValues) response.malformed = malformed

  const guard = preflightPayload({
    toolName: 'audit_property_coverage',
    nodeCount: 0,
    edgeCount: missing.length + malformed.length,
    compactEdges: false,
    argsHint: `edge_type=${edgeType}, total=${edges.length}, missing=${missing.length}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(response, guard.fields)
  return text(JSON.stringify(response, null, 2))
}

/**
 * diff_classification (UPG 0.11.0) — what moved on the competitive classification
 * landscape since a date. Reads the append-only reclassification history
 * (`signals[]`, auto-emitted at the classify-write chokepoint) and projects each
 * transition (from_value to to_value on an axis) with resolved titles. The payoff
 * of the self-updating competitive tier: pairs with the 0.10.8 freshness query
 * (which decides WHEN to re-assess) and surfaces WHAT changed.
 *
 * Portfolio-grain, local-only (CLOUD_NA) — the history lives in the portfolio
 * workspace document, which the single-product-per-request cloud has no analogue
 * for.
 *
 * @returns JSON: `{ product?, competitor?, since?, total, transitions: Array<{
 *   signal_id, competitor, competitor_title?, axis, from_value, from_title?,
 *   to_value, to_title?, observed_at, confidence?, observed_by? }> }`, newest
 *   first. Empty `transitions` when nothing moved or no history exists.
 * @atomicity atomic (read-only). Reads the portfolio document only; never mutates.
 */
export const diffClassification: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const product = args.product as string | undefined
  const competitor = args.competitor as string | undefined
  const since = args.since as string | undefined
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    return textError(`Invalid \`since\` date: "${since}". Pass an ISO date like "2026-06-01".`)
  }

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ product, since, total: 0, transitions: [], note: 'No workspace portfolio document found.' }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  let signals = portfolioStore.getReclassificationSignals({
    ...(product ? { product } : {}),
    ...(since ? { since } : {}),
  })
  if (competitor) signals = signals.filter((s) => (s.properties ?? {}).competitor === competitor)

  const index = buildPortfolioNodeIndex(doc)
  const titleOf = (qid: string): string | undefined => index.get(qid)?.title
  const valueTitle = (valueId: string): string | undefined => index.get(`${REGISTRY_PRODUCT_ID}/${valueId}`)?.title

  const transitions = signals
    .map((s) => {
      const p = (s.properties ?? {}) as Record<string, unknown>
      const comp = String(p.competitor ?? '')
      const fromValue = p.from_value as string | undefined
      const toValue = p.to_value as string | undefined
      const row: Record<string, unknown> = {
        signal_id: s.id,
        competitor: comp,
        axis: p.axis,
        from_value: fromValue,
        to_value: toValue,
        observed_at: p.observed_at,
      }
      const ct = titleOf(comp)
      if (ct) row.competitor_title = ct
      if (fromValue) { const ft = valueTitle(fromValue); if (ft) row.from_title = ft }
      if (toValue) { const tt = valueTitle(toValue); if (tt) row.to_title = tt }
      if (p.confidence !== undefined) row.confidence = p.confidence
      if (p.observed_by !== undefined) row.observed_by = p.observed_by
      return row
    })
    // Most recent move first.
    .sort((a, b) => String(b.observed_at ?? '').localeCompare(String(a.observed_at ?? '')))

  const response: Record<string, unknown> = {
    ...(product ? { product } : {}),
    ...(competitor ? { competitor } : {}),
    ...(since ? { since } : {}),
    total: transitions.length,
    transitions,
  }

  const guard = preflightPayload({
    toolName: 'diff_classification',
    nodeCount: 0,
    edgeCount: transitions.length,
    compactEdges: false,
    argsHint: `product=${product ?? 'all'}, since=${since ?? 'any'}, total=${transitions.length}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(response, guard.fields)
  return text(JSON.stringify(response, null, 2))
}

/**
 * compare_classifications (UPG 0.11.2, read-path-tooling brief #5) — compare two
 * classified nodes (competitors) axis-by-axis: where they agree (same value),
 * diverge (different values), or only one is graded. The bridge from the
 * classification layer to the parity layer: `create_parity_edge` writes a parity
 * relationship, this derives which axes one should be written for. Reuses the
 * same per-node profile assembly as `get_portfolio_tree({ shape: "competitor_profile" })`,
 * so axis/value/confidence resolution is identical, then joins the two profiles.
 *
 * Portfolio-grain, local-only (CLOUD_NA) — reads the portfolio workspace document.
 *
 * @returns JSON: `{ shape: "comparison", a, b, axes: Array<{ axis, axis_label,
 *   a: [{value, value_label, confidence?}], b: [...], status }>, stats:
 *   { shared_axes, agreements, divergences, a_only, b_only } }`. Divergences are
 *   ordered first (the actionable rows).
 * @atomicity atomic (read-only). Reads the portfolio document and, for title
 *   resolution, referenced product files read-only; never mutates active state.
 * @see get_portfolio_tree
 * @see create_parity_edge
 */
export const compareClassifications: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const a = args.a as string | undefined
  const b = args.b as string | undefined
  if (!a || !b) return textError('compare_classifications requires both `a` and `b`: the qualified ids of the two nodes to compare.')
  const axis = args.axis as string | undefined

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ shape: 'comparison', a: null, b: null, axes: [], note: 'No workspace portfolio document found.' }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  // Resolve titles for both subjects (and any classified sources they may share an
  // axis with) from their product files, mirroring get_portfolio_tree.
  const index = buildPortfolioNodeIndex(doc)
  await enrichIndexFromProducts(cwd, ctx.store as UPGFileStore, index, [a, b])

  const result = assembleComparison(doc, { a, b, axis, node_index: index }) as unknown as Record<string, unknown>

  const guard = preflightPayload({
    toolName: 'compare_classifications',
    nodeCount: 0,
    edgeCount: Array.isArray(result.axes) ? result.axes.length : 0,
    compactEdges: false,
    argsHint: `a=${a}, b=${b}, axis=${axis ?? 'all'}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(result, guard.fields)
  return text(JSON.stringify(result, null, 2))
}

/**
 * aggregate_edge_properties (UPG 0.11.2, read-path-tooling brief #6) — the digest
 * of the property layer. Aggregate the distribution of one property across every
 * portfolio cross-edge of a type, optionally grouped by a dimension. Turns the
 * by-eye "165 high / 53 medium / 0 low, mediums cluster on ext_api_sdk" count
 * over a `jq` dump into one call. `property` defaults to `confidence` (an
 * assessment object buckets by its `label`).
 *
 * Portfolio-grain, local-only (CLOUD_NA) — reads the portfolio workspace document.
 *
 * @returns JSON: `{ shape: "edge_property_aggregate", edge_type, property,
 *   group_by, total, with_property, without_property, overall: [{ key, count }],
 *   groups?: [{ group, group_label?, total, with_property, distribution }] }`.
 *   `overall` is the whole-type distribution; `groups` appears when `group_by` is
 *   not `none`.
 * @atomicity atomic (read-only). Reads the portfolio document only; never mutates.
 * @see audit_property_coverage
 * @see list_portfolio_cross_edges
 */
export const aggregateEdgePropertiesTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const edgeType = args.edge_type as string | undefined
  if (!edgeType) return textError('Missing required parameter: edge_type.')
  if (!(UPG_CROSS_EDGE_TYPES as readonly string[]).includes(edgeType)) {
    return textError(`Unknown cross-edge type: "${edgeType}". See list_cross_edge_types.`)
  }
  const groupByArg = args.group_by as string | undefined
  const validGroups = ['none', 'axis', 'competitor', 'value'] as const
  if (groupByArg !== undefined && !(validGroups as readonly string[]).includes(groupByArg)) {
    return textError(`Invalid group_by: "${groupByArg}". Valid: ${validGroups.join(', ')}.`)
  }
  const groupBy = (groupByArg as (typeof validGroups)[number] | undefined) ?? 'none'
  const property = (args.property as string | undefined) ?? 'confidence'

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ shape: 'edge_property_aggregate', edge_type: edgeType, property, group_by: groupBy, total: 0, with_property: 0, without_property: 0, overall: [], note: 'No workspace portfolio document found.' }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  const index = buildPortfolioNodeIndex(doc)
  const result = aggregateEdgeProperties(doc, { edge_type: edgeType, group_by: groupBy, property, node_index: index }) as unknown as Record<string, unknown>

  const guard = preflightPayload({
    toolName: 'aggregate_edge_properties',
    nodeCount: 0,
    edgeCount: Array.isArray(result.groups) ? result.groups.length : (Array.isArray(result.overall) ? result.overall.length : 0),
    compactEdges: false,
    argsHint: `edge_type=${edgeType}, group_by=${groupBy}, property=${property}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(result, guard.fields)
  return text(JSON.stringify(result, null, 2))
}

/**
 * audit_axis_overlap (UPG 0.11.3, brief #4) — list every classified source that
 * carries more than one value on a `single`-select classification axis. That is
 * the stale-edge symptom a reclassification leaves when the prior same-axis edge
 * is not retired; 0.11.3 makes the classify writer supersede by default, and this
 * is the regression guard + the detector for overlaps already in a graph. A clean
 * graph returns `overlaps: []`. A `multi`-select axis is exempt (it may
 * legitimately carry several values per source); unaxed values are skipped.
 *
 * Portfolio-grain, local-only (CLOUD_NA) — reads the portfolio workspace document.
 *
 * @returns JSON: `{ total, overlaps: Array<{ source, source_title?, axis,
 *   axis_label, values: [{ value, value_label, edge_id, assessed_on? }] }> }`.
 *   `total` is the number of (source, single-select axis) pairs with > 1 value.
 * @atomicity atomic (read-only). Reads the portfolio document only; never mutates.
 * @see create_classification_edge
 * @see get_portfolio_tree
 */
export const auditAxisOverlap: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ total: 0, overlaps: [], note: 'No workspace portfolio document found.' }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  if (!doc) return textError('Portfolio document failed to load.')

  const index = buildPortfolioNodeIndex(doc)
  const overlaps = findSingleSelectOverlaps(doc, { node_index: index })
  const response: Record<string, unknown> = { total: overlaps.length, overlaps }
  if (overlaps.length === 0) {
    response.note =
      'No source holds more than one value on a single-select axis. Clean: every single-select classification has one current value (supersede is working).'
  }

  const guard = preflightPayload({
    toolName: 'audit_axis_overlap',
    nodeCount: 0,
    edgeCount: overlaps.length,
    compactEdges: false,
    argsHint: `overlaps=${overlaps.length}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(response, guard.fields)
  return text(JSON.stringify(response, null, 2))
}
