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
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { UPGFileStore, computeGraphDigest } from '@unified-product-graph/sdk'
import { preflightPayload } from '../lib/payload-guard.js'
import { traverseGraph, type GraphReader, type TraverseParams } from '../lib/graph-traverse.js'
import { findWorkspaceUpgFiles } from './workspace.js'

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
      const digest = computeGraphDigest(reader)
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
