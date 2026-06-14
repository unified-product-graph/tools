/**
 * `upg portfolio` command group: cross-product / portfolio operations.
 *
 * Default portfolio document: `.upg/portfolio.upg` (resolved from cwd).
 * All subcommands accept `--file <path>` to override the portfolio document.
 *
 * Subcommands:
 *   list                          list portfolios (list_portfolios)
 *   attach <product> <portfolio>  add product to portfolio (attach_product_to_portfolio)
 *   detach <product> <portfolio>  remove product from portfolio (detach_product_from_portfolio)
 *   health                        multi-product digest (portfolio_digest)
 *   query --from <type>           BFS across products (portfolio_query)
 *   check                         validate + anti-pattern report (portfolio_validate)
 *   edges                         list cross-product edges (list_portfolio_cross_edges)
 *   connect <src> <tgt> --type    create cross-product edge (create_cross_product_edge)
 *   disconnect <id>               delete cross-product edge (delete_cross_product_edge)
 *   migrate                       migrate inline edges to portfolio doc (migrate_cross_edges)
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { Command } from 'commander'
import chalk from 'chalk'
import {
  UPGPortfolioStore,
  UPGFileStore,
  openPortfolioStoreIfExists,
  resolvePortfolioPath,
  attachProductToPortfolio,
  detachProductFromPortfolio,
  deleteCrossProductEdge,
  computeGraphDigest,
  edgeId,
  buildPortfolioNodeIndex,
} from '@unified-product-graph/sdk'
import { UPG_CROSS_EDGE_TYPES, REGISTRY_PRODUCT_ID, validateEdgeProperties, friendlyToAssessment, type UPGCrossEdgeType, type UPGEdgeType } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, success, fail, label } from '../lib/formatter.js'
import { die, runtimeError, usageError, violation } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the portfolio document path, optionally overriding with --file. */
function resolvePortfolioFile(explicitFile?: string): string | null {
  if (explicitFile) return path.resolve(explicitFile)
  return resolvePortfolioPath(process.cwd())
}

/** Enumerate workspace products: files with a product header. */
interface ScopedProduct {
  id: string | null
  title: string
  file: string
  absPath: string
}

function listWorkspaceProducts(cwd: string): ScopedProduct[] {
  const upgDir = path.join(cwd, '.upg')
  const all: ScopedProduct[] = []
  const scanDir = (dir: string) => {
    let entries: string[] = []
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const f of entries) {
      if (!f.endsWith('.upg') || f === 'portfolio.upg') continue
      const absPath = path.join(dir, f)
      try {
        const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
          product?: { id?: string; title?: string }
        }
        if (!doc.product) continue
        all.push({
          id: doc.product.id ?? null,
          title: doc.product.title ?? '(untitled)',
          file: path.relative(cwd, absPath),
          absPath,
        })
      } catch { /* skip malformed */ }
    }
  }
  scanDir(cwd)
  if (fs.existsSync(upgDir)) scanDir(upgDir)
  return all
}

/** Filter products by scope (id / file / basename). */
function applyScope(
  all: ScopedProduct[],
  scope: string[] | undefined,
): { products: ScopedProduct[]; unmatched: string[] } {
  if (!scope || scope.length === 0) return { products: all, unmatched: [] }
  const matches = (p: ScopedProduct, want: string) =>
    p.id === want ||
    p.file === want ||
    path.basename(p.file) === want ||
    path.basename(p.file, '.upg') === want
  const products = all.filter((p) => scope.some((w) => matches(p, w)))
  const unmatched = scope.filter((w) => !all.some((p) => matches(p, w)))
  return { products, unmatched }
}

/**
 * Classification distribution (0.10.6, brief D): per registry axis, the count of
 * members per value, computed from the portfolio's classify cross edges. Mirrors
 * the MCP `portfolio_digest` classification block. Returns undefined when no
 * classify edges (or no usable portfolio) exist.
 */
async function buildClassificationDistribution(cwd: string): Promise<Record<string, unknown> | undefined> {
  let pfStore
  try {
    pfStore = await openPortfolioStoreIfExists(cwd)
  } catch {
    return undefined
  }
  if (!pfStore) return undefined
  const classifyEdges = pfStore.getAllCrossEdges().filter((e) => e.type.endsWith('_classified_as_classification_value'))
  if (classifyEdges.length === 0) return undefined

  const valueToAxis = new Map<string, string>()
  for (const e of pfStore.listRegistryEdges('classification_axis_includes_classification_value')) {
    valueToAxis.set(e.target, e.source)
  }
  const label = (bareId: string): string => pfStore!.getRegistryNode(bareId)?.title ?? bareId
  const UNAXED = '__unaxed__'
  const axes = new Map<string, Map<string, number>>()
  for (const e of classifyEdges) {
    const valueBare = e.target.startsWith(`${REGISTRY_PRODUCT_ID}/`)
      ? e.target.slice(REGISTRY_PRODUCT_ID.length + 1)
      : e.target
    const axisBare = valueToAxis.get(valueBare) ?? UNAXED
    const byValue = axes.get(axisBare) ?? new Map<string, number>()
    byValue.set(valueBare, (byValue.get(valueBare) ?? 0) + 1)
    axes.set(axisBare, byValue)
  }
  const axisList = [...axes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([axisBare, byValue]) => {
      const values = [...byValue.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([valueBare, count]) => ({ value: valueBare, label: label(valueBare), count }))
      const total = values.reduce((s, v) => s + v.count, 0)
      return axisBare === UNAXED
        ? { axis: null, label: 'unaxed', values, total }
        : { axis: axisBare, label: label(axisBare), values, total }
    })
  return { total_classified_edges: classifyEdges.length, axes: axisList }
}

// ── portfolio list ────────────────────────────────────────────────────────────

const listSub = new Command('list')
  .description('List portfolios in the portfolio document.')
  .option('--file <path>', 'Path to portfolio.upg (default: .upg/portfolio.upg)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
      const doc = portfolioStore?.getDocument()
      const portfolios = doc?.portfolios ?? []
      const result = portfolios.map((pf) => {
        const row: Record<string, unknown> = { id: pf.id, title: pf.title }
        if (pf.description) row.description = pf.description
        if (pf.parent_portfolio_id !== undefined) row.parent_portfolio_id = pf.parent_portfolio_id
        if (pf.hierarchy_model) row.hierarchy_model = pf.hierarchy_model
        if (pf.products) row.products = pf.products
        return row
      })

      if (opts.json) {
        console.log(JSON.stringify({ portfolios: result, total: result.length }, null, 2))
        return
      }

      console.log(upgHeader('Portfolio'))
      if (result.length === 0) {
        console.log('  No portfolios. Create one with `upg create portfolio "<title>"`.\n')
        return
      }
      for (const pf of result) {
        const pcount = Array.isArray(pf.products)
          ? ` ${chalk.dim(`(${(pf.products as string[]).length} products)`)}`
          : ''
        console.log(`  ${chalk.bold.white(sanitizeForTerminal(pf.title as string))}${pcount}`)
        console.log(`  ${chalk.dim('id:')} ${sanitizeForTerminal(pf.id as string)}`)
        if (pf.description) {
          console.log(`  ${chalk.dim(sanitizeForTerminal(pf.description as string))}`)
        }
        console.log()
      }
      console.log(`  ${label(`${result.length} portfolio(s)`)}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── portfolio attach ──────────────────────────────────────────────────────────

const attachSub = new Command('attach')
  .description('Add a product to a portfolio (attach_product_to_portfolio).')
  .arguments('<product> <portfolio>')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product: string, portfolio: string, opts) => {
    try {
      const result = await attachProductToPortfolio(process.cwd(), {
        product_id: product,
        portfolio_id: portfolio,
      })
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2))
        return
      }
      const containerTitle = sanitizeForTerminal(result.container_title ?? portfolio)
      const productLabel = sanitizeForTerminal(product)
      if (result.already_member) {
        console.log(`\n  ${chalk.dim(`Product "${productLabel}" is already a member of "${containerTitle}"`)}\n`)
      } else {
        console.log(`\n  ${success(`Attached "${productLabel}" to portfolio "${containerTitle}"`)}\n`)
      }
    } catch (err) {
      die(runtimeError((err as Error).message))
    }
  })

// ── portfolio detach ──────────────────────────────────────────────────────────

const detachSub = new Command('detach')
  .description('Remove a product from a portfolio (detach_product_from_portfolio).')
  .arguments('<product> <portfolio>')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product: string, portfolio: string, opts) => {
    try {
      const result = await detachProductFromPortfolio(process.cwd(), {
        product_id: product,
        portfolio_id: portfolio,
      })
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2))
        return
      }
      const containerTitle = sanitizeForTerminal(result.container_title ?? portfolio)
      const productLabel = sanitizeForTerminal(product)
      if (!result.removed) {
        console.log(`\n  ${chalk.dim(`Product "${productLabel}" was not a member of "${containerTitle}"`)}\n`)
      } else {
        console.log(`\n  ${success(`Detached "${productLabel}" from portfolio "${containerTitle}"`)}\n`)
      }
    } catch (err) {
      die(runtimeError((err as Error).message))
    }
  })

// ── portfolio health ──────────────────────────────────────────────────────────

const healthSub = new Command('health')
  .description('Multi-product digest: counts and health per product (portfolio_digest).')
  .option('--scope <ids...>', 'Restrict to specific product ids, files, or basenames')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      const { products, unmatched } = applyScope(listWorkspaceProducts(cwd), opts.scope as string[] | undefined)

      if (products.length === 0) {
        const note = opts.scope ? 'No workspace products matched the requested scope.' : 'No products found in the workspace.'
        if (opts.json) {
          console.log(JSON.stringify({
            products: [],
            rollup: { products: 0, total_nodes: 0, total_edges: 0, by_stage: {} },
            note,
          }, null, 2))
          return
        }
        console.log(upgHeader('Portfolio Health'))
        console.log(`  ${note}\n`)
        return
      }

      const summaries: Array<Record<string, unknown>> = []
      const byStage: Record<string, number> = {}
      let totalNodes = 0
      let totalEdges = 0

      for (const product of products) {
        try {
          const s = new UPGFileStore()
          await s.loadReadOnly(product.absPath)
          const digest = computeGraphDigest(s)
          const stage = digest.product.stage || 'unset'
          byStage[stage] = (byStage[stage] ?? 0) + 1
          totalNodes += digest.counts.total_nodes
          totalEdges += digest.counts.total_edges
          const topTypes = Object.entries(digest.counts.by_type)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([type, count]) => ({ type, count }))
          const covSummary = (digest.coverage as Record<string, { overall_pct?: number } | unknown>)
          const overallPct = (covSummary['stage_summary'] as { overall_pct?: number } | undefined)?.overall_pct ?? null
          summaries.push({
            product_id: product.id,
            file: product.file,
            title: digest.product.title,
            stage: digest.product.stage || null,
            total_nodes: digest.counts.total_nodes,
            total_edges: digest.counts.total_edges,
            health: digest.health,
            coverage_pct: overallPct,
            top_types: topTypes,
          })
        } catch (err) {
          summaries.push({
            product_id: product.id,
            file: product.file,
            title: product.title,
            error: (err as Error).message,
          })
        }
      }

      const rollup = {
        products: summaries.length,
        total_nodes: totalNodes,
        total_edges: totalEdges,
        by_stage: byStage,
      }

      if (opts.json) {
        const out: Record<string, unknown> = { products: summaries, rollup }
        const classification = await buildClassificationDistribution(cwd)
        if (classification) out.classification = classification
        if (unmatched.length > 0) out.unmatched_scope = unmatched
        console.log(JSON.stringify(out, null, 2))
        return
      }

      console.log(upgHeader('Portfolio Health'))
      for (const s of summaries) {
        const title = sanitizeForTerminal(String(s.title ?? s.product_id ?? s.file))
        const stage = s.stage ? chalk.dim(` [${sanitizeForTerminal(String(s.stage))}]`) : ''
        if (s.error) {
          console.log(`  ${fail(title)}${stage}  ${chalk.dim(String(s.error))}`)
          continue
        }
        const h = s.health as { orphan_rate?: number; validation_rate?: number } | undefined
        const coverage = typeof s.coverage_pct === 'number' ? Math.round(s.coverage_pct) : null
        const orphanRate = typeof h?.orphan_rate === 'number' ? Math.round(h.orphan_rate * 100) : null
        console.log(`  ${chalk.bold.white(title)}${stage}`)
        console.log(
          `    ${label('nodes')} ${chalk.bold(String(s.total_nodes))}` +
          `  ${label('edges')} ${chalk.bold(String(s.total_edges))}` +
          `  ${label('coverage')} ${coverage !== null ? `${coverage}%` : chalk.dim('n/a')}` +
          `  ${label('orphans')} ${orphanRate !== null ? `${orphanRate}%` : chalk.dim('n/a')}`,
        )
        console.log()
      }
      const stageEntries = Object.entries(byStage).map(([s, n]) => `${s}:${n}`).join('  ')
      console.log(`  ${label('Rollup')}  ${summaries.length} products  ${totalNodes} nodes  ${totalEdges} edges`)
      if (stageEntries) console.log(`  ${label('By stage')}  ${stageEntries}`)
      if (unmatched.length > 0) {
        console.log(`\n  ${fail(`Unmatched scope: ${unmatched.join(', ')}`)}\n`)
      } else {
        console.log()
      }
    } catch (err) {
      die(err)
    }
  })

// ── portfolio query ───────────────────────────────────────────────────────────

const querySub = new Command('query')
  .description('BFS traversal across all workspace products (portfolio_query).')
  .requiredOption('--from <type>', 'Starting entity type (BFS anchor)')
  .option('--traverse <edges...>', 'Edge types to traverse')
  .option('--depth <n>', 'BFS depth (default 2)', parseInt)
  .option('--limit <n>', 'Max nodes per product (default 100)', parseInt)
  .option('--scope <ids...>', 'Restrict to specific product ids, files, or basenames')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      const from: string = opts.from
      const traverse = opts.traverse as string[] | undefined
      const depth = typeof opts.depth === 'number' ? opts.depth : 2
      const perProductLimit = typeof opts.limit === 'number' ? Math.min(Math.max(opts.limit, 1), 1000) : 100

      const { products, unmatched } = applyScope(listWorkspaceProducts(cwd), opts.scope as string[] | undefined)

      if (products.length === 0) {
        const note = opts.scope ? 'No workspace products matched the requested scope.' : 'No products found in the workspace.'
        if (opts.json) {
          console.log(JSON.stringify({
            products: [],
            products_searched: 0,
            products_with_matches: 0,
            empty_products: [],
            note,
          }, null, 2))
          return
        }
        console.log(upgHeader('Portfolio Query'))
        console.log(`  ${note}\n`)
        return
      }

      // Cross-edge traversal (0.10.6, brief B): when a cross-edge type is named
      // in --traverse, load the portfolio once and expand matched nodes one hop
      // out over the portfolio's cross edges to their registry / other-product
      // targets (the per-product BFS otherwise stops at product boundaries).
      const crossWanted = new Set(
        (traverse ?? []).filter((t) => (UPG_CROSS_EDGE_TYPES as readonly string[]).includes(t)),
      )
      let crossBySource: Map<string, Array<{ id: string; source: string; target: string; type: string; properties?: Record<string, unknown> }>> | null = null
      let resolveCrossTarget: ((target: string) => { id: string; type?: string; title?: string }) | null = null
      if (crossWanted.size > 0) {
        try {
          const pfStore = await openPortfolioStoreIfExists(cwd)
          if (pfStore) {
            crossBySource = new Map()
            for (const e of pfStore.getAllCrossEdges()) {
              if (!crossWanted.has(e.type)) continue
              const props = (e as { properties?: Record<string, unknown> }).properties
              const arr = crossBySource.get(e.source) ?? []
              arr.push({ id: e.id, source: e.source, target: e.target, type: e.type, ...(props ? { properties: props } : {}) })
              crossBySource.set(e.source, arr)
            }
            resolveCrossTarget = (target: string) => {
              if (target.startsWith(`${REGISTRY_PRODUCT_ID}/`)) {
                const canonical = pfStore.getRegistryNode(target.slice(REGISTRY_PRODUCT_ID.length + 1))
                if (canonical) return { id: target, type: canonical.type, title: canonical.title }
              }
              return { id: target }
            }
          }
        } catch {
          /* no usable portfolio document: skip cross-edge expansion */
        }
      }

      const matched: Array<Record<string, unknown>> = []
      const emptyProducts: string[] = []
      let totalNodes = 0
      let totalEdges = 0

      for (const product of products) {
        try {
          const s = new UPGFileStore()
          await s.loadReadOnly(product.absPath)
          const allNodes = s.getDocument().nodes ?? []
          const allEdges = s.getDocument().edges ?? []
          const roots = allNodes.filter((n) => n.type === from)
          if (roots.length === 0) {
            emptyProducts.push(product.id ?? product.file)
            continue
          }

          // Build adjacency map for BFS
          const edgesBySource = new Map<string, typeof allEdges>()
          for (const e of allEdges) {
            if (traverse && traverse.length > 0 && !traverse.includes(e.type)) continue
            const arr = edgesBySource.get(e.source) ?? []
            arr.push(e)
            edgesBySource.set(e.source, arr)
          }

          const visited = new Set<string>()
          const queue: Array<{ id: string; d: number }> = roots.map((r) => ({ id: r.id, d: 0 }))
          const resultNodes: Array<{ id: string; type: string; title: string; status?: string }> = []
          const resultEdges: Array<{ id: string; source: string; target: string; type: string; properties?: Record<string, unknown> }> = []

          while (queue.length > 0 && resultNodes.length < perProductLimit) {
            const item = queue.shift()!
            if (visited.has(item.id)) continue
            visited.add(item.id)
            const node = allNodes.find((n) => n.id === item.id)
            if (!node) continue
            resultNodes.push({
              id: node.id,
              type: node.type,
              title: node.title,
              ...(node.status ? { status: node.status } : {}),
            })
            if (item.d < depth) {
              for (const e of edgesBySource.get(item.id) ?? []) {
                resultEdges.push({ id: e.id, source: e.source, target: e.target, type: e.type })
                if (!visited.has(e.target)) queue.push({ id: e.target, d: item.d + 1 })
              }
            }
          }

          // Cross-edge expansion: follow the portfolio's cross edges one hop out
          // from each matched node (qualified by product id) to its target.
          if (crossBySource && resolveCrossTarget && product.id) {
            const seen = new Set<string>(resultNodes.map((n) => n.id))
            for (const n of [...resultNodes]) {
              const qualified = `${product.id}/${n.id}`
              for (const ce of crossBySource.get(qualified) ?? []) {
                resultEdges.push({ id: ce.id, source: ce.source, target: ce.target, type: ce.type, ...(ce.properties ? { properties: ce.properties } : {}) })
                if (!seen.has(ce.target)) {
                  seen.add(ce.target)
                  const t = resolveCrossTarget(ce.target)
                  resultNodes.push({ id: t.id, type: t.type ?? 'unknown', title: t.title ?? t.id })
                }
              }
            }
          }

          totalNodes += resultNodes.length
          totalEdges += resultEdges.length
          matched.push({
            product_id: product.id,
            file: product.file,
            title: product.title,
            total_nodes: resultNodes.length,
            total_edges: resultEdges.length,
            nodes: resultNodes,
            edges: resultEdges,
          })
        } catch {
          emptyProducts.push(product.id ?? product.file)
        }
      }

      const response: Record<string, unknown> = {
        products: matched,
        products_searched: products.length,
        products_with_matches: matched.length,
        total_nodes: totalNodes,
        total_edges: totalEdges,
        empty_products: emptyProducts,
      }
      if (unmatched.length > 0) response.unmatched_scope = unmatched

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2))
        return
      }

      console.log(upgHeader('Portfolio Query'))
      console.log(
        `  ${label('from')} ${chalk.bold(sanitizeForTerminal(from))}` +
        `  ${label('depth')} ${depth}` +
        `  ${label('products')} ${products.length}`,
      )
      console.log()

      if (matched.length === 0) {
        console.log(`  No matches for type "${sanitizeForTerminal(from)}" across ${products.length} product(s).\n`)
        return
      }

      for (const m of matched) {
        const title = sanitizeForTerminal(String(m.title ?? m.product_id ?? m.file))
        console.log(`  ${chalk.bold.white(title)}  ${chalk.dim(sanitizeForTerminal(String(m.file)))}`)
        const nodes = m.nodes as Array<{ type: string; title: string }>
        for (const n of nodes) {
          console.log(`    ${chalk.gray(sanitizeForTerminal(n.type))}  ${chalk.white(sanitizeForTerminal(n.title))}`)
        }
        console.log()
      }
      console.log(`  ${label(`${matched.length}/${products.length} products matched, ${totalNodes} nodes total`)}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── portfolio check ───────────────────────────────────────────────────────────

const checkSub = new Command('check')
  .description('Validate all workspace products + portfolio anti-patterns (portfolio_validate).')
  .option('--scope <ids...>', 'Restrict to specific product ids, files, or basenames')
  .option('--severity <sev>', 'Filter anti-patterns: high, medium, or low')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      const { products, unmatched } = applyScope(listWorkspaceProducts(cwd), opts.scope as string[] | undefined)

      if (products.length === 0) {
        const note = opts.scope ? 'No workspace products matched the requested scope.' : 'No products found in the workspace.'
        const out = {
          products: [],
          rollup: {
            products: 0, valid: 0, invalid: 0, structurally_valid: 0,
            anti_pattern_violations: { high: 0, medium: 0, low: 0 },
            all_valid: false,
          },
          note,
        }
        if (opts.json) { console.log(JSON.stringify(out, null, 2)); return }
        console.log(upgHeader('Portfolio Check'))
        console.log(`  ${note}\n`)
        return
      }

      const summaries: Array<Record<string, unknown>> = []
      let validCount = 0
      let structurallyValidCount = 0
      let totalHigh = 0
      let totalMedium = 0
      let totalLow = 0

      for (const product of products) {
        try {
          const s = new UPGFileStore()
          await s.loadReadOnly(product.absPath)
          const digest = computeGraphDigest(s)

          // Anti-pattern violations are surfaced via the digest when the SDK includes them.
          // Cast defensively; MCP server computes them via validateGraph handler separately.
          type DigestWithAP = typeof digest & {
            anti_pattern_violations?: Array<{ anti_pattern_id: string; severity: string; name: string }>
          }
          const apAll = (digest as DigestWithAP).anti_pattern_violations ?? []
          const apFiltered = opts.severity
            ? apAll.filter((v) => v.severity === opts.severity)
            : apAll

          const high = apFiltered.filter((v) => v.severity === 'high').length
          const medium = apFiltered.filter((v) => v.severity === 'medium').length
          const low = apFiltered.filter((v) => v.severity === 'low').length
          totalHigh += high
          totalMedium += medium
          totalLow += low
          const valid = high === 0
          if (valid) validCount++
          structurallyValidCount++

          const entry: Record<string, unknown> = {
            product_id: product.id,
            file: product.file,
            title: digest.product.title,
            valid,
            structurally_valid: true,
            anti_patterns: { high, medium, low },
          }
          if (apFiltered.length > 0) {
            entry.top_violations = apFiltered.slice(0, 5).map((v) => ({
              anti_pattern_id: v.anti_pattern_id,
              severity: v.severity,
              name: v.name,
            }))
          }
          summaries.push(entry)
        } catch (err) {
          summaries.push({
            product_id: product.id,
            file: product.file,
            title: product.title,
            error: (err as Error).message,
          })
        }
      }

      const rollup = {
        products: summaries.length,
        valid: validCount,
        invalid: summaries.length - validCount,
        structurally_valid: structurallyValidCount,
        anti_pattern_violations: { high: totalHigh, medium: totalMedium, low: totalLow },
        all_valid: summaries.length > 0 && validCount === summaries.length,
      }

      if (opts.json) {
        const out: Record<string, unknown> = { products: summaries, rollup }
        if (unmatched.length > 0) out.unmatched_scope = unmatched
        console.log(JSON.stringify(out, null, 2))
        return
      }

      console.log(upgHeader('Portfolio Check'))
      for (const s of summaries) {
        const title = sanitizeForTerminal(String(s.title ?? s.product_id ?? s.file))
        if (s.error) {
          console.log(`  ${fail(title)}  ${chalk.dim(String(s.error))}`)
          continue
        }
        const ap = s.anti_patterns as { high: number; medium: number; low: number } | undefined
        const indicator = s.valid ? success(title) : fail(title)
        const apSummary = ap ? chalk.dim(` h:${ap.high} m:${ap.medium} l:${ap.low}`) : ''
        console.log(`  ${indicator}${apSummary}`)
        const violations = s.top_violations as Array<{ anti_pattern_id: string; severity: string }> | undefined
        if (violations && violations.length > 0) {
          for (const v of violations) {
            const sev =
              v.severity === 'high' ? chalk.red(v.severity) :
              v.severity === 'medium' ? chalk.yellow(v.severity) :
              chalk.dim(v.severity)
            console.log(`    ${sev}  ${chalk.dim(sanitizeForTerminal(v.anti_pattern_id))}`)
          }
        }
      }
      console.log()
      const verdict = rollup.all_valid
        ? success(`All ${rollup.products} products valid`)
        : fail(`${rollup.invalid}/${rollup.products} products have issues`)
      console.log(
        `  ${verdict}  ` +
        `${chalk.dim(`high:${totalHigh} medium:${totalMedium} low:${totalLow}`)}`,
      )
      if (unmatched.length > 0) {
        console.log(`\n  ${fail(`Unmatched scope: ${unmatched.join(', ')}`)}\n`)
      } else {
        console.log()
      }
    } catch (err) {
      die(err)
    }
  })

// ── portfolio edges ───────────────────────────────────────────────────────────

const edgesSub = new Command('edges')
  .description('List cross-product edges in the portfolio document (list_portfolio_cross_edges).')
  .option('--file <path>', 'Path to portfolio.upg (default: .upg/portfolio.upg)')
  .option('--type <type>', 'Filter by edge type')
  .option('--source-product <id>', 'Filter by source product id')
  .option('--group-by <field>', 'Group results by "source" or "target"')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      const groupBy = opts.groupBy as string | undefined
      if (groupBy !== undefined && groupBy !== 'source' && groupBy !== 'target') {
        die(usageError(`Invalid --group-by: "${sanitizeForTerminal(groupBy)}". Valid: source, target.`))
      }
      const portfolioPath = resolvePortfolioFile(opts.file)
      if (!portfolioPath) {
        if (opts.json) {
          console.log(JSON.stringify({ cross_edges: [], total: 0, note: 'No workspace found.' }, null, 2))
          return
        }
        console.log(upgHeader('Portfolio Edges'))
        console.log('  No workspace found. Run `upg init --workspace` to create one.\n')
        return
      }
      const portfolioStore = await openPortfolioStoreIfExists(cwd)
      let filtered = portfolioStore?.getAllCrossEdges() ?? []
      if (opts.type) filtered = filtered.filter((e) => e.type === opts.type)
      if (opts.sourceProduct) filtered = filtered.filter((e) => e.source_product_id === opts.sourceProduct)

      if (groupBy) {
        const groups: Record<string, typeof filtered> = {}
        for (const e of filtered) {
          const key = (groupBy === 'source' ? e.source : e.target) as string
          ;(groups[key] ??= []).push(e)
        }
        if (opts.json) {
          console.log(JSON.stringify(
            { grouped_by: groupBy, group_count: Object.keys(groups).length, total: filtered.length, groups },
            null, 2,
          ))
          return
        }
        console.log(upgHeader('Portfolio Edges'))
        const keys = Object.keys(groups)
        if (keys.length === 0) {
          console.log('  No cross-product edges. Use `upg portfolio connect` to add one.\n')
          return
        }
        for (const key of keys) {
          console.log(`  ${chalk.bold.white(sanitizeForTerminal(key))}  ${chalk.dim(`(${groups[key].length})`)}`)
          for (const e of groups[key]) {
            const other = groupBy === 'source' ? e.target : e.source
            console.log(`    ${chalk.dim(sanitizeForTerminal(e.type))}  ${chalk.white(sanitizeForTerminal(other))}`)
          }
          console.log()
        }
        console.log(`  ${label(`${filtered.length} edge(s) in ${keys.length} group(s)`)}\n`)
        return
      }

      if (opts.json) {
        console.log(JSON.stringify({ cross_edges: filtered, total: filtered.length }, null, 2))
        return
      }

      console.log(upgHeader('Portfolio Edges'))
      if (filtered.length === 0) {
        console.log('  No cross-product edges. Use `upg portfolio connect` to add one.\n')
        return
      }
      for (const e of filtered) {
        console.log(`  ${chalk.dim(sanitizeForTerminal(e.type))}`)
        console.log(`    ${chalk.dim('src')} ${chalk.white(sanitizeForTerminal(e.source))}`)
        console.log(`    ${chalk.dim('tgt')} ${chalk.white(sanitizeForTerminal(e.target))}`)
        console.log(`    ${chalk.dim('id')}  ${chalk.dim(sanitizeForTerminal(e.id))}`)
        console.log()
      }
      console.log(`  ${label(`${filtered.length} cross-product edge(s)`)}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── portfolio connect ─────────────────────────────────────────────────────────

const connectSub = new Command('connect')
  .description('Create a cross-product edge in the portfolio document (create_cross_product_edge).')
  .arguments('<src> <tgt>')
  .requiredOption('--type <type>', 'Cross-product edge type')
  .option('--file <path>', 'Path to portfolio.upg (default: .upg/portfolio.upg)')
  .option('--source-product <id>', 'Source product id (when src is a bare node id)')
  .option('--target-product <id>', 'Target product id (when tgt is a bare node id)')
  .option('--properties <json>', 'Edge property bag as JSON (only for property-carrying edge types)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (src: string, tgt: string, opts) => {
    try {
      const edgeType = opts.type as string

      if (!(UPG_CROSS_EDGE_TYPES as readonly string[]).includes(edgeType)) {
        die(usageError(
          `Invalid cross-product edge type: "${sanitizeForTerminal(edgeType)}". ` +
          `Valid types: ${UPG_CROSS_EDGE_TYPES.join(', ')}`,
        ))
      }
      if (edgeType === 'instance_of') {
        die(usageError(
          'instance_of edges are created via `register_instance` (MCP), not `upg portfolio connect`.',
        ))
      }
      if (edgeType === 'area_serves_persona' || edgeType === 'area_targets_market_segment') {
        die(usageError(
          `${edgeType} edges are created via \`link_area_to_audience\` (MCP), not \`upg portfolio connect\`.`,
        ))
      }

      const cwd = process.cwd()
      const portfolioPath = resolvePortfolioFile(opts.file)
      if (!portfolioPath) {
        die(runtimeError('No workspace found. Run `upg init --workspace` first.'))
      }

      // Qualify IDs
      let qualifiedSource: string
      if (src.includes('/')) {
        qualifiedSource = src
      } else if (opts.sourceProduct) {
        qualifiedSource = `${opts.sourceProduct}/${src}`
      } else {
        die(usageError(
          `source "${sanitizeForTerminal(src)}" is a bare node id. ` +
          `Use --source-product <id> to qualify it, or pass {product_id}/{node_id}.`,
        ))
      }

      let qualifiedTarget: string
      if (tgt.includes('/')) {
        qualifiedTarget = tgt
      } else if (opts.targetProduct) {
        qualifiedTarget = `${opts.targetProduct}/${tgt}`
      } else {
        die(usageError(
          `target "${sanitizeForTerminal(tgt)}" is a bare node id. ` +
          `Use --target-product <id> to qualify it, or pass {product_id}/{node_id}.`,
        ))
      }

      // Optional property bag (0.10.5): parse + validate against the edge type's
      // catalogue schema before persisting. No-op for edges without a
      // `property_schema`; rejects unknown keys / off-scale assessments at the
      // write surface, matching `create_cross_product_edge` (MCP).
      let properties: Record<string, unknown> | undefined
      if (opts.properties) {
        try {
          properties = JSON.parse(opts.properties) as Record<string, unknown>
        } catch (err) {
          die(usageError(`--properties is not valid JSON: ${(err as Error).message}`))
        }
        const errors = validateEdgeProperties(edgeType, properties)
        if (errors.length > 0) {
          die(usageError(`Invalid edge properties:\n  - ${errors.join('\n  - ')}`))
        }
      }

      const portfolioStore = new UPGPortfolioStore()
      await portfolioStore.loadOrInit(portfolioPath)

      const derivedSourceProduct = opts.sourceProduct ?? qualifiedSource.split('/')[0]
      const derivedTargetProduct = opts.targetProduct ?? qualifiedTarget.split('/')[0]

      const newEdge = {
        id: edgeId(),
        source: qualifiedSource,
        target: qualifiedTarget,
        type: edgeType as UPGCrossEdgeType,
        source_product_id: derivedSourceProduct,
        target_product_id: derivedTargetProduct,
        ...(properties ? { properties } : {}),
      }

      portfolioStore.addCrossEdge(newEdge)
      await portfolioStore.flush()

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          edge: newEdge,
          portfolio_file: path.relative(cwd, portfolioPath),
        }, null, 2))
        return
      }
      console.log(`\n  ${success(`Created "${sanitizeForTerminal(edgeType)}" edge`)}`)
      console.log(`  ${chalk.dim('src')} ${chalk.white(sanitizeForTerminal(qualifiedSource))}`)
      console.log(`  ${chalk.dim('tgt')} ${chalk.white(sanitizeForTerminal(qualifiedTarget))}`)
      console.log(`  ${chalk.dim('id')}  ${chalk.dim(sanitizeForTerminal(newEdge.id))}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── portfolio classify ────────────────────────────────────────────────────────

/**
 * Accepted friendly confidence words. The value/label expansion comes from the
 * single pinned source — `confidence_5.friendly_aliases` via `friendlyToAssessment`
 * (0.11.1) — so the CLI and the MCP `create_classification_edge` can never
 * disagree on what `high` means (both: value 4 / "Confident"). Before 0.11.1 a
 * local map here expanded `high → 5`, off by one from the value-4 population.
 */
const CLASSIFICATION_CONFIDENCE_SCALE = 'confidence_5'

const classifySub = new Command('classify')
  .description('Place a node in a classification cell, carrying optional confidence / provenance (create_classification_edge).')
  .arguments('<node-id> <classification-value-id>')
  .option('--confidence <level>', 'Confidence: low, medium, or high (becomes a confidence_5 assessment)')
  .option('--assessed-on <date>', 'ISO date of the assessment (default: today)')
  .option('--rationale <text>', 'Short note on why this node sits in this cell')
  .option('--evidence <ref>', 'A source URL, or a competitor_signal / evidence node id')
  .option('--node-product <id>', 'Product id owning the node (forces cross-product routing)')
  .option('--no-supersede', 'Keep a prior same-axis classification instead of retiring it (additive; default is to supersede on a single-select axis)')
  .option('--file <path>', 'Path to the active product .upg file (default: auto-discovered)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (nodeId: string, classificationValueId: string, opts) => {
    try {
      const confidenceArg = opts.confidence as string | undefined
      const confidenceAssessment =
        confidenceArg !== undefined ? friendlyToAssessment(CLASSIFICATION_CONFIDENCE_SCALE, confidenceArg) : undefined
      if (confidenceArg !== undefined && !confidenceAssessment) {
        die(usageError(`Invalid confidence: "${sanitizeForTerminal(confidenceArg)}". Valid: low, medium, high.`))
      }

      const cwd = process.cwd()

      // Source node type picks the specialised vs generic edge. Resolve it against
      // the active product store, then — for a qualified `{pid}/{nid}` source that
      // is not local — the portfolio's `instance_of` index (0.11.1), so a competitor
      // in a watched graph routes to the specialised edge and upserts the existing
      // cell instead of duplicating under the polymorphic type. Only a genuinely
      // unresolvable source falls back to the polymorphic edge.
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const bareNodeId = nodeId.includes('/') ? nodeId.split('/')[1] : nodeId
      let sourceType = store.getNode(bareNodeId)?.type
      if (sourceType !== 'competitor' && nodeId.includes('/')) {
        const pfDoc = (await openPortfolioStoreIfExists(cwd))?.getDocument()
        if (pfDoc) {
          const resolved = buildPortfolioNodeIndex(pfDoc).get(nodeId)?.type
          if (resolved) sourceType = resolved
        }
      }
      const edgeType =
        sourceType === 'competitor'
          ? 'competitor_classified_as_classification_value'
          : 'node_classified_as_classification_value'

      const properties: Record<string, unknown> = {
        ...(confidenceAssessment ? { confidence: confidenceAssessment } : {}),
        assessed_on: (opts.assessedOn as string | undefined) ?? new Date().toISOString().slice(0, 10),
        ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
        ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      }
      const propErrors = validateEdgeProperties(edgeType, properties)
      if (propErrors.length > 0) {
        store.stopWatching()
        die(usageError(`Invalid classification properties:\n  - ${propErrors.join('\n  - ')}`))
      }

      const nodeProductId = opts.nodeProduct as string | undefined
      const isCross = classificationValueId.includes('/') || !!nodeProductId

      // ── Within-graph: both node and value live in the active product. ──
      if (!isCross) {
        const value = store.getNode(classificationValueId)
        if (!value) {
          store.stopWatching()
          die(violation(
            `Classification value not found in the active product: ${sanitizeForTerminal(classificationValueId)}. ` +
            `Pass a registry value (registry/{value}) or --node-product to route cross-product.`,
          ))
        }
        const built = {
          id: edgeId(),
          source: bareNodeId,
          target: classificationValueId,
          type: edgeType as UPGEdgeType,
          properties,
        }
        const stored = store.addEdge(built) as unknown as { id: string } | undefined
        const edge = stored ?? built
        await store.flush()
        store.stopWatching()
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, edge, scope: 'within_graph' }, null, 2))
          return
        }
        console.log(`\n  ${success(`Classified "${sanitizeForTerminal(bareNodeId)}" (${edgeType})`)}`)
        console.log(`  ${chalk.dim('cell')} ${chalk.white(sanitizeForTerminal(classificationValueId))}`)
        if (confidenceArg) console.log(`  ${chalk.dim('confidence')} ${sanitizeForTerminal(confidenceArg)}`)
        console.log(`  ${chalk.dim('id')}  ${chalk.dim(sanitizeForTerminal(edge.id))}\n`)
        return
      }

      // ── Cross-product: value (and/or node) qualified across products. ──
      store.stopWatching()
      const portfolioPath = resolvePortfolioFile(undefined)
      if (!portfolioPath) {
        die(runtimeError('No workspace found. Run `upg init --workspace` first.'))
      }

      const activeProductId = store.getProduct?.()?.id
      const qualifiedSource = nodeId.includes('/')
        ? nodeId
        : `${nodeProductId ?? activeProductId}/${bareNodeId}`
      const sourceProductId = nodeProductId ?? qualifiedSource.split('/')[0]
      const targetProductId = classificationValueId.split('/')[0]

      const portfolioStore = new UPGPortfolioStore()
      await portfolioStore.loadOrInit(portfolioPath)
      const newEdge = {
        id: edgeId(),
        source: qualifiedSource,
        target: classificationValueId,
        type: edgeType as UPGCrossEdgeType,
        source_product_id: sourceProductId,
        target_product_id: targetProductId,
        properties,
      }
      // commander stores `--no-supersede` as opts.supersede === false; default true.
      const outcome = portfolioStore.addCrossEdge(newEdge, { supersede: opts.supersede !== false })
      await portfolioStore.flush()
      const superseded = outcome.superseded ?? []

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          edge: newEdge,
          scope: 'cross_product',
          ...(superseded.length > 0 ? { superseded: superseded.map((e) => ({ edge_id: e.id, target: e.target })) } : {}),
          portfolio_file: path.relative(cwd, portfolioPath),
        }, null, 2))
        return
      }
      console.log(`\n  ${success(`Classified "${sanitizeForTerminal(qualifiedSource)}" (${edgeType})`)}`)
      console.log(`  ${chalk.dim('cell')} ${chalk.white(sanitizeForTerminal(classificationValueId))}`)
      if (confidenceArg) console.log(`  ${chalk.dim('confidence')} ${sanitizeForTerminal(confidenceArg)}`)
      if (superseded.length > 0) console.log(`  ${chalk.dim('superseded')} ${chalk.white(superseded.map((e) => sanitizeForTerminal(e.target)).join(', '))}`)
      console.log(`  ${chalk.dim('id')}  ${chalk.dim(sanitizeForTerminal(newEdge.id))}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── portfolio disconnect ──────────────────────────────────────────────────────

const disconnectSub = new Command('disconnect')
  .description('Delete a cross-product edge by id (delete_cross_product_edge).')
  .arguments('<id>')
  .option('--file <path>', 'Path to portfolio.upg (default: .upg/portfolio.upg)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (edgeIdArg: string, opts) => {
    try {
      const cwd = process.cwd()
      const portfolioPath = resolvePortfolioFile(opts.file)
      if (!portfolioPath || !fs.existsSync(portfolioPath)) {
        die(runtimeError('No portfolio document found. Run `upg init --workspace` first.'))
      }
      const result = await deleteCrossProductEdge(cwd, edgeIdArg)

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2))
        return
      }
      if (!result.deleted) {
        console.log(`\n  ${chalk.dim(`No cross-product edge found with id "${sanitizeForTerminal(edgeIdArg)}"`)}\n`)
      } else {
        console.log(`\n  ${success(`Deleted cross-product edge "${sanitizeForTerminal(edgeIdArg)}"`)}\n`)
      }
    } catch (err) {
      die(err)
    }
  })

// ── portfolio migrate ─────────────────────────────────────────────────────────

const migrateSub = new Command('migrate')
  .description('Migrate inline cross-product edges from the active product into portfolio.upg (migrate_cross_edges).')
  .option('--file <path>', 'Path to the product .upg file (default: auto-discovered)')
  .option('--source-product <id>', '(required) Product id owning the source nodes')
  .option('--target-product <id>', 'Product id owning the target nodes')
  .option('--commit', 'Actually migrate; default is dry run')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const sourceProductId = opts.sourceProduct as string | undefined
      if (!sourceProductId) {
        die(usageError('--source-product <id> is required for migrate'))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const dryRun = !opts.commit
      const cwd = process.cwd()
      const portfolioPath = resolvePortfolioFile(undefined)

      if (!portfolioPath && !dryRun) {
        store.stopWatching()
        die(runtimeError('No workspace found. Run `upg init --workspace` first.'))
      }

      const portfolioStore = new UPGPortfolioStore()
      if (portfolioPath) {
        try {
          await portfolioStore.loadOrInit(portfolioPath)
        } catch (err) {
          store.stopWatching()
          die(runtimeError(`Failed to load portfolio document: ${(err as Error).message}`))
        }
      }

      const doc = store.getDocument()
      const targetProductId = (opts.targetProduct as string | undefined) ?? null
      const result = portfolioStore.migrateCrossEdgesFromDoc(doc, sourceProductId, targetProductId, dryRun)

      if (!dryRun && result.migrated.length > 0) {
        store.markDirty()
        if (portfolioPath) await portfolioStore.flush()
        await store.flush()
      }
      store.stopWatching()

      if (opts.json) {
        console.log(JSON.stringify({
          ...result,
          portfolio_file: portfolioPath ? path.relative(cwd, portfolioPath) : null,
        }, null, 2))
        return
      }

      console.log(upgHeader('Portfolio Migrate'))
      if (dryRun) console.log(chalk.dim('  Dry run (pass --commit to migrate)\n'))

      if (result.migrated.length === 0 && result.skipped.length === 0) {
        console.log('  No inline cross-product edges found.\n')
        return
      }
      if (result.migrated.length > 0) {
        console.log(`  ${success(`${result.migrated.length} edge(s) to migrate:`)}\n`)
        for (const e of result.migrated) {
          console.log(
            `    ${chalk.dim(sanitizeForTerminal(e.type))}` +
            `  ${chalk.white(sanitizeForTerminal(e.source))}` +
            ` ${chalk.dim('->')}` +
            ` ${chalk.white(sanitizeForTerminal(e.target))}`,
          )
        }
        console.log()
      }
      if (result.skipped.length > 0) {
        console.log(`  ${chalk.yellow(`${result.skipped.length} edge(s) skipped:`)}\n`)
        for (const s of result.skipped) {
          console.log(`    ${chalk.dim(sanitizeForTerminal(s.id))}  ${chalk.dim(sanitizeForTerminal(s.reason))}`)
        }
        console.log()
      }
    } catch (err) {
      die(err)
    }
  })

// ── Root command ──────────────────────────────────────────────────────────────

export const portfolioCommand = new Command('portfolio')
  .description('Cross-product and portfolio operations (portfolio.upg).')
  .addCommand(listSub)
  .addCommand(attachSub)
  .addCommand(detachSub)
  .addCommand(healthSub)
  .addCommand(querySub)
  .addCommand(checkSub)
  .addCommand(edgesSub)
  .addCommand(connectSub)
  .addCommand(classifySub)
  .addCommand(disconnectSub)
  .addCommand(migrateSub)

// Bare `upg portfolio` with no subcommand shows help.
portfolioCommand.action(() => {
  portfolioCommand.help()
})
