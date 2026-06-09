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
import { UPGFileStore, computeGraphDigest } from '@unified-product-graph/sdk'
import { preflightPayload } from '../lib/payload-guard.js'
import { traverseGraph, type GraphReader, type TraverseParams } from '../lib/graph-traverse.js'
import { findWorkspaceUpgFiles } from './workspace.js'
import { validateGraph } from './validation.js'

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
function resolveScopedProducts(
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
    totalNodes += r.total_nodes
    totalEdges += r.total_edges
    matched.push({
      product_id: product.id,
      file: product.file,
      title: product.title,
      total_nodes: r.total_nodes,
      total_edges: r.total_edges,
      nodes: r.nodes,
      edges: r.edges,
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

  const summaries: Array<Record<string, unknown>> = []
  const errored: Array<{ product_id: string | null; file: string; error: string }> = []
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

      summaries.push({
        product_id: product.id,
        file: product.file,
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
  if (errored.length > 0) response.errored_products = errored
  if (unmatched.length > 0) response.unmatched_scope = unmatched
  if (products.length === 0) {
    response.note =
      scope && scope.length > 0
        ? 'No workspace products matched the requested scope.'
        : 'No products found in the workspace. Run from a directory with a .upg/ workspace.'
  }
  return text(JSON.stringify(response, null, 2))
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
 *   per-product `top_violations` list.
 * @atomicity atomic (read-only). Never mutates active-product state.
 * @see validate_graph
 * @see portfolio_digest
 * @see portfolio_query
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
  return text(JSON.stringify(response, null, 2))
}
