/**
 * Cross-product structure clone (batch-4 #17).
 *
 * Bringing many products to the same structural spine meant re-authoring a
 * near-identical skeleton each time — only the *content* differs, the *shape*
 * (typed nodes + canonical edges + hierarchy) is identical. `clone_structure`
 * stamps the SHAPE of one product (the exemplar) into another: same entity
 * types, same edges, placeholder titles ready to rename/fill. No content
 * (descriptions, properties, real titles, statuses) crosses over.
 *
 * Source is always read-only (`loadReadOnly`, the 0.9.1 read infra). The write
 * target (`into`) defaults to the ACTIVE product (the lock-protected store);
 * naming a non-active product writes there directly with NO `switch_product`
 * (the cross-product write deferred from batch-3), via a transient writable
 * load + flush. If `into` resolves to the active product, the write routes
 * through the live store so the file is never opened twice.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import {
  UPGFileStore,
  createNode as createNodeLib,
  createEdge as createEdgeLib,
} from '@unified-product-graph/sdk'
import { getRegionForEntityType, UPG_REGIONS, UPG_TYPE_NAMES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { findWorkspaceUpgFiles } from './workspace.js'

/** A workspace product resolved to its on-disk file + header identity. */
interface ResolvedProduct {
  id: string | null
  title: string
  file: string
  absPath: string
}

/** Enumerate workspace products (skipping the portfolio doc + non-product .upg). */
function listProducts(cwd: string): ResolvedProduct[] {
  const out: ResolvedProduct[] = []
  for (const absPath of findWorkspaceUpgFiles(cwd)) {
    try {
      const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as { product?: { id?: string; title?: string } }
      if (!doc.product) continue
      out.push({
        id: doc.product.id ?? null,
        title: doc.product.title ?? '(untitled)',
        file: path.relative(cwd, absPath),
        absPath,
      })
    } catch {
      // malformed JSON — skip
    }
  }
  return out
}

function matchProduct(p: ResolvedProduct, want: string): boolean {
  return (
    p.id === want ||
    p.file === want ||
    path.basename(p.file) === want ||
    path.basename(p.file, '.upg') === want
  )
}

/**
 * Resolve a region request list to a set of region ids. Each entry matches a
 * region by id or (case-insensitive) label. Returns the matched id set plus any
 * entries that matched nothing.
 */
function resolveRegionScope(regions: string[]): { ids: Set<string>; unmatched: string[] } {
  const ids = new Set<string>()
  const unmatched: string[] = []
  for (const want of regions) {
    const w = want.toLowerCase()
    const hit = UPG_REGIONS.find(
      (r) => r.id === want || r.id.toLowerCase() === w || (r.label && r.label.toLowerCase() === w),
    )
    if (hit) ids.add(hit.id)
    else unmatched.push(want)
  }
  return { ids, unmatched }
}

interface CloneNodeSpec {
  sourceId: string
  type: string
  title: string
}

/**
 * Plan the clone: the source nodes (region-filtered) to twin, their placeholder
 * titles, and the edges to recreate (both endpoints in-scope). Pure; no writes.
 */
function planClone(
  source: UPGFileStore,
  regionIds: Set<string> | null,
): { nodes: CloneNodeSpec[]; edges: UPGEdge[]; byType: Record<string, number>; excludedUnregioned: number } {
  const allNodes = source.getAllNodes()
  const inScope = new Map<string, UPGBaseNode>()
  let excludedUnregioned = 0

  for (const n of allNodes) {
    if (regionIds) {
      const region = getRegionForEntityType(n.type as string)
      if (!region) { excludedUnregioned++; continue }
      if (!regionIds.has(region.id)) continue
    }
    inScope.set(n.id, n)
  }

  // Stable order: by type (for readable placeholder numbering), then by the
  // node's existing order in the file.
  const ordered = [...inScope.values()]
  const perTypeCount: Record<string, number> = {}
  const perTypeIndex: Record<string, number> = {}
  for (const n of ordered) perTypeCount[n.type] = (perTypeCount[n.type] ?? 0) + 1

  const nodes: CloneNodeSpec[] = ordered.map((n) => {
    const idx = (perTypeIndex[n.type] = (perTypeIndex[n.type] ?? 0) + 1)
    const label = UPG_TYPE_NAMES[n.type as string] ?? (n.type as string)
    // Number only when the type repeats, so a singleton reads "TODO: Persona".
    const title = perTypeCount[n.type] > 1 ? `TODO: ${label} ${idx}` : `TODO: ${label}`
    return { sourceId: n.id, type: n.type as string, title }
  })

  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

  // Edges whose BOTH endpoints are in scope. Self-product edges only (the source
  // store holds one product; cross-product edges live in portfolio.upg).
  const edges = source
    .getAllEdges()
    .filter((e) => inScope.has(e.source) && inScope.has(e.target))

  return { nodes, edges, byType, excludedUnregioned }
}

/**
 * `clone_structure` (Batch-4 #17): stamp the SHAPE of one product (typed nodes +
 * canonical edges + hierarchy, with `TODO:` placeholder titles) into another,
 * without re-authoring the skeleton. Content (descriptions, properties, real
 * titles, statuses) never crosses. The single biggest lever for multi-product
 * structural parity: one stamp + a content pass replaces a multi-batch rebuild.
 *
 * `from_product` is the exemplar (read-only). `into` is the write target and
 * defaults to the ACTIVE product; naming a non-active product writes there with
 * no `switch_product`. `regions` scopes the clone to entity types in those
 * super-domains. `dry_run: true` previews the plan without writing.
 *
 * @returns JSON: on `dry_run`, `{ dry_run, from, into, into_is_active,
 *   would_clone: { nodes, edges, by_type }, region_scope?, unmatched_regions?,
 *   target_existing_stubs?, sample_titles }`. On commit, `{ cloned: true, from,
 *   into, into_is_active, nodes_created, edges_created, edges_skipped?, by_type,
 *   warnings? }`.
 * @throws Returns a textError when `from_product` is missing/unresolvable, when
 *   `into` is unresolvable, when source and target are the same product, or when
 *   the source has no clonable shape under the given scope.
 * @atomicity atomic-with-rollback on commit (created twins + edges are rolled
 *   back if a hard error lands mid-clone; catalog-invalid source edges are
 *   skipped and reported, not fatal). `dry_run` never writes.
 * @see portfolio_validate
 * @see batch_create_nodes
 * @see switch_product
 */
export const cloneStructure: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store: activeStore } = ctx
  const fromWant = args.from_product as string | undefined
  if (!fromWant) return textError('Missing required parameter: from_product')
  const intoWant = args.into as string | undefined
  const dryRun = (args.dry_run as boolean) ?? false
  const regionsArg = Array.isArray(args.regions)
    ? (args.regions as unknown[]).filter((r): r is string => typeof r === 'string')
    : undefined

  const cwd = process.cwd()
  const products = listProducts(cwd)

  // ── Resolve source ──────────────────────────────────────────────────────
  const fromProduct = products.find((p) => matchProduct(p, fromWant))
  if (!fromProduct) {
    return textError(
      `from_product "${fromWant}" not found in the workspace. Available: ${products.map((p) => p.id ?? p.file).join(', ') || '(none)'}.`,
    )
  }

  // ── Resolve target (default = active product) ───────────────────────────
  const activePath = activeStore.getFilePath()
  let intoProduct: ResolvedProduct | undefined
  if (intoWant) {
    intoProduct = products.find((p) => matchProduct(p, intoWant))
    if (!intoProduct) {
      return textError(
        `into "${intoWant}" not found in the workspace. Available: ${products.map((p) => p.id ?? p.file).join(', ') || '(none)'}.`,
      )
    }
  } else {
    // Default: the active product.
    if (!activePath) {
      return textError('No active product to clone into. Pass `into` to name a target, or run from a loaded product.')
    }
    intoProduct =
      products.find((p) => path.resolve(p.absPath) === path.resolve(activePath)) ??
      ({
        id: (activeStore.getProduct() as { id?: string } | undefined)?.id ?? null,
        title: (activeStore.getProduct() as { title?: string } | undefined)?.title ?? '(active)',
        file: path.relative(cwd, activePath),
        absPath: activePath,
      } as ResolvedProduct)
  }

  if (path.resolve(fromProduct.absPath) === path.resolve(intoProduct.absPath)) {
    return textError('from_product and into resolve to the same product; a shape cannot be cloned into itself.')
  }

  const intoIsActive = activePath != null && path.resolve(intoProduct.absPath) === path.resolve(activePath)

  // ── Region scope ────────────────────────────────────────────────────────
  let regionIds: Set<string> | null = null
  let unmatchedRegions: string[] = []
  if (regionsArg && regionsArg.length > 0) {
    const resolved = resolveRegionScope(regionsArg)
    regionIds = resolved.ids
    unmatchedRegions = resolved.unmatched
    if (regionIds.size === 0) {
      return textError(
        `None of the requested regions matched. Unknown: [${unmatchedRegions.join(', ')}]. Valid region ids: ${UPG_REGIONS.map((r) => r.id).join(', ')}.`,
      )
    }
  }

  // ── Read source (read-only) + plan ──────────────────────────────────────
  const source = new UPGFileStore()
  try {
    await source.loadReadOnly(fromProduct.absPath)
  } catch (err) {
    return textError(`Failed to read source product "${fromProduct.id ?? fromProduct.file}": ${(err as Error).message}`)
  }

  const plan = planClone(source, regionIds)
  if (plan.nodes.length === 0) {
    return textError(
      regionIds
        ? `Source "${fromProduct.id ?? fromProduct.file}" has no nodes in the requested region scope; nothing to clone.`
        : `Source "${fromProduct.id ?? fromProduct.file}" has no nodes; nothing to clone.`,
    )
  }

  const fromLabel = fromProduct.id ?? fromProduct.file
  const intoLabel = intoProduct.id ?? intoProduct.file

  // ── Dry-run preview ─────────────────────────────────────────────────────
  if (dryRun) {
    const response: Record<string, unknown> = {
      dry_run: true,
      from: fromLabel,
      into: intoLabel,
      into_is_active: intoIsActive,
      would_clone: {
        nodes: plan.nodes.length,
        edges: plan.edges.length,
        by_type: plan.byType,
      },
      sample_titles: plan.nodes.slice(0, 8).map((n) => n.title),
    }
    if (regionIds) {
      response.region_scope = [...regionIds]
      if (plan.excludedUnregioned > 0) response.excluded_unregioned_nodes = plan.excludedUnregioned
    }
    if (unmatchedRegions.length > 0) response.unmatched_regions = unmatchedRegions
    return text(JSON.stringify(response, null, 2))
  }

  // ── Open the writer ─────────────────────────────────────────────────────
  // Active target → the live, lock-protected store. Non-active target → a
  // transient writable load we flush + dispose (the cross-product write).
  let writer: UPGFileStore
  let transient = false
  if (intoIsActive) {
    writer = activeStore
  } else {
    writer = new UPGFileStore()
    writer.setWriter('upg-mcp-server')
    try {
      await writer.load(intoProduct.absPath)
    } catch (err) {
      return textError(`Failed to open target product "${intoLabel}" for writing: ${(err as Error).message}`)
    }
    transient = true
  }

  // Double-stamp guard: count existing stubs already in the target.
  const existingStubs = writer.getAllNodes().filter((n) => (n.tags ?? []).includes('stub')).length

  // ── Commit (atomic-with-rollback) ───────────────────────────────────────
  const idMap = new Map<string, string>()
  const createdNodeIds: string[] = []
  const createdEdgeIds: string[] = []
  const skippedEdges: Array<{ type: string; reason: string }> = []

  const rollback = () => {
    for (const eid of createdEdgeIds.slice().reverse()) {
      try { writer.removeEdge(eid) } catch { /* gone */ }
    }
    for (const nid of createdNodeIds.slice().reverse()) {
      try { writer.removeNode(nid) } catch { /* gone */ }
    }
  }

  try {
    for (const spec of plan.nodes) {
      const result = createNodeLib(writer, {
        type: spec.type,
        title: spec.title,
        tags: ['stub'],
      })
      const twinId = (result.node as { id: string }).id
      idMap.set(spec.sourceId, twinId)
      createdNodeIds.push(twinId)
    }

    for (const e of plan.edges) {
      const srcTwin = idMap.get(e.source)
      const tgtTwin = idMap.get(e.target)
      if (!srcTwin || !tgtTwin) continue // endpoint out of scope; skip
      const result = createEdgeLib(writer, { source_id: srcTwin, target_id: tgtTwin, type: e.type })
      if ('error' in result) {
        // A non-canonical / drifted source edge can't be recreated; skip + report.
        skippedEdges.push({ type: e.type as string, reason: result.error })
        continue
      }
      createdEdgeIds.push((result as { edge: { id: string } }).edge.id)
    }

    await writer.flush()
  } catch (err) {
    rollback()
    if (transient) writer.stopWatching()
    return textError(`clone_structure failed mid-clone; target rolled back. ${(err as Error).message}`)
  }

  if (transient) writer.stopWatching()

  const warnings: string[] = []
  if (existingStubs > 0) {
    warnings.push(
      `Target already had ${existingStubs} stub node(s) from a prior clone; this clone added ${createdNodeIds.length} more (additive).`,
    )
  }
  if (skippedEdges.length > 0) {
    warnings.push(
      `${skippedEdges.length} source edge(s) were not canonical and were skipped (the shape's nodes are still cloned).`,
    )
  }

  const response: Record<string, unknown> = {
    cloned: true,
    from: fromLabel,
    into: intoLabel,
    into_is_active: intoIsActive,
    nodes_created: createdNodeIds.length,
    edges_created: createdEdgeIds.length,
    by_type: plan.byType,
  }
  if (skippedEdges.length > 0) response.edges_skipped = skippedEdges.length
  if (regionIds) response.region_scope = [...regionIds]
  if (unmatchedRegions.length > 0) response.unmatched_regions = unmatchedRegions
  if (warnings.length > 0) response.warnings = warnings
  return text(JSON.stringify(response, null, 2))
}
