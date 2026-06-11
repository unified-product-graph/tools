/**
 * `upg clone` - scaffold a subtree/structure from a template product.
 *
 * Stamps the SHAPE of one product (the exemplar) into another: same entity
 * types, same edges, placeholder titles ready to rename/fill. No content
 * (descriptions, properties, real titles, statuses) crosses over.
 *
 * Mirrors the `clone_structure` MCP handler (batch-4 #17).
 *
 * Usage:
 *   upg clone <from-product> [--into <product>] [--region <r>] [--dry-run] [--yes]
 *
 * `from-product` is resolved by product id, relative file path, or bare
 * filename (with or without .upg). `--into` defaults to the active product
 * discovered by the normal discoverUPGFile logic.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { UPGFileStore, createNode, createEdge } from '@unified-product-graph/sdk'
import { getRegionForEntityType, UPG_REGIONS, UPG_TYPE_NAMES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, success, label } from '../lib/formatter.js'
import { EXIT, die, runtimeError, usageError, violation } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'

// ── Workspace product resolution ──────────────────────────────────────────────

interface ResolvedProduct {
  id: string | null
  title: string
  absPath: string
  relFile: string
}

/**
 * Enumerate all .upg product files in the workspace (cwd root + immediate
 * subdirectories including .upg/). Skips portfolio.upg and non-product docs.
 * Mirrors the MCP server's `listProducts` helper in clone-structure.ts.
 */
function listWorkspaceProducts(cwd: string): ResolvedProduct[] {
  const out: ResolvedProduct[] = []
  const visited = new Set<string>()

  function scanDir(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.upg')) continue
      const absPath = path.join(dir, entry.name)
      if (visited.has(absPath)) continue
      visited.add(absPath)
      try {
        const doc = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as {
          product?: { id?: string; title?: string }
        }
        if (!doc.product) continue
        out.push({
          id: doc.product.id ?? null,
          title: doc.product.title ?? '(untitled)',
          absPath,
          relFile: path.relative(cwd, absPath),
        })
      } catch {
        // malformed JSON - skip
      }
    }
  }

  // Scan cwd root
  scanDir(cwd)

  // Scan immediate subdirectories (including .upg/)
  let topEntries: fs.Dirent[]
  try {
    topEntries = fs.readdirSync(cwd, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') && entry.name !== '.upg') continue
    scanDir(path.join(cwd, entry.name))
  }

  return out
}

function matchProduct(p: ResolvedProduct, want: string): boolean {
  return (
    p.id === want ||
    p.relFile === want ||
    path.basename(p.relFile) === want ||
    path.basename(p.relFile, '.upg') === want
  )
}

/** Resolve a list of region ids/labels to their canonical ids. */
function resolveRegions(regions: string[]): { ids: Set<string>; unmatched: string[] } {
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

// ── Plan (pure, no writes) ────────────────────────────────────────────────────

interface CloneNodeSpec {
  sourceId: string
  type: string
  title: string
}

interface ClonePlan {
  nodes: CloneNodeSpec[]
  edges: UPGEdge[]
  byType: Record<string, number>
  excludedUnregioned: number
}

function planClone(source: UPGFileStore, regionIds: Set<string> | null): ClonePlan {
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

  const ordered = [...inScope.values()]
  const perTypeCount: Record<string, number> = {}
  const perTypeIndex: Record<string, number> = {}
  for (const n of ordered) perTypeCount[n.type] = (perTypeCount[n.type] ?? 0) + 1

  const nodes: CloneNodeSpec[] = ordered.map((n) => {
    const idx = (perTypeIndex[n.type] = (perTypeIndex[n.type] ?? 0) + 1)
    const label = UPG_TYPE_NAMES[n.type as string] ?? (n.type as string)
    const title = perTypeCount[n.type] > 1 ? `TODO: ${label} ${idx}` : `TODO: ${label}`
    return { sourceId: n.id, type: n.type as string, title }
  })

  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

  const edges = source
    .getAllEdges()
    .filter((e) => inScope.has(e.source) && inScope.has(e.target))

  return { nodes, edges, byType, excludedUnregioned }
}

// ── Command ───────────────────────────────────────────────────────────────────

export const cloneCommand = new Command('clone')
  .argument('<from-product>', 'Source product to clone shape from (id, filename, or relative path)')
  .description('Scaffold a subtree/structure from a template product (placeholder titles, same entity types + edges).')
  .option('--into <product>', 'Target product to clone into (default: active .upg file)')
  .option('--region <region...>', 'Scope clone to entities in these region(s) (id or label)')
  .option('--file <path>', 'Path to the target .upg file (overrides --into and discovery)')
  .option('--dry-run', 'Preview the clone plan without writing')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('--json', 'Machine-readable JSON output')
  .action(async (fromArg: string, opts: {
    into?: string
    region?: string[]
    file?: string
    dryRun?: boolean
    yes?: boolean
    json?: boolean
  }) => {
    try {
      const skipConfirm = Boolean(opts.yes)
      const dryRun = Boolean(opts.dryRun)
      const interactive = isTTY() && Boolean(process.stdin.isTTY)

      // ── Resolve source product ───────────────────────────────────────────
      const cwd = process.cwd()
      const products = listWorkspaceProducts(cwd)

      const fromProduct = products.find((p) => matchProduct(p, fromArg))
      if (!fromProduct) {
        const available = products.map((p) => p.id ?? p.relFile).join(', ') || '(none found)'
        die(runtimeError(
          `Source product "${fromArg}" not found in workspace. Available: ${available}. ` +
          `Pass a product id, filename, or relative path.`,
        ))
      }

      // ── Resolve target (active product or --into / --file) ───────────────
      const targetFilePath = opts.file
        ? path.resolve(opts.file)
        : opts.into
          ? products.find((p) => matchProduct(p, opts.into!))?.absPath
          : await discoverUPGFile(undefined)

      if (!targetFilePath) {
        if (opts.into) {
          const available = products.map((p) => p.id ?? p.relFile).join(', ') || '(none)'
          die(runtimeError(
            `Target product "${opts.into}" not found in workspace. Available: ${available}.`,
          ))
        }
        die(runtimeError('No target .upg file found. Pass --into <product> or --file <path>.'))
      }

      if (path.resolve(fromProduct.absPath) === path.resolve(targetFilePath!)) {
        die(violation(
          'Source and target resolve to the same product. A shape cannot be cloned into itself.',
        ))
      }

      // ── Region scope ─────────────────────────────────────────────────────
      let regionIds: Set<string> | null = null
      let unmatchedRegions: string[] = []
      if (opts.region && opts.region.length > 0) {
        const resolved = resolveRegions(opts.region)
        regionIds = resolved.ids
        unmatchedRegions = resolved.unmatched
        if (regionIds.size === 0) {
          die(usageError(
            `None of the requested regions matched. Unknown: [${unmatchedRegions.join(', ')}]. ` +
            `Valid region ids: ${UPG_REGIONS.map((r) => r.id).join(', ')}.`,
          ))
        }
      }

      // ── Read source (read-only) + plan ───────────────────────────────────
      const source = new UPGFileStore()
      try {
        await source.loadReadOnly(fromProduct.absPath)
      } catch (err) {
        die(runtimeError(
          `Failed to read source product "${fromProduct.id ?? fromProduct.relFile}": ${(err as Error).message}`,
        ))
      }

      const plan = planClone(source, regionIds)

      const fromLabel = fromProduct.id ?? fromProduct.relFile
      const intoProduct = products.find((p) => path.resolve(p.absPath) === path.resolve(targetFilePath!))
      const intoLabel = intoProduct?.id ?? path.relative(cwd, targetFilePath!)

      if (plan.nodes.length === 0) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({
            ok: false,
            error: regionIds
              ? `Source "${fromLabel}" has no nodes in the requested region scope.`
              : `Source "${fromLabel}" has no nodes to clone.`,
          }, null, 2) + '\n')
          process.exit(EXIT.RUNTIME)
        }
        die(runtimeError(
          regionIds
            ? `Source "${fromLabel}" has no nodes in the requested region scope; nothing to clone.`
            : `Source "${fromLabel}" has no nodes; nothing to clone.`,
        ))
      }

      // ── Dry-run ──────────────────────────────────────────────────────────
      if (dryRun) {
        const response: Record<string, unknown> = {
          dry_run: true,
          from: fromLabel,
          into: intoLabel,
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

        if (opts.json) {
          process.stdout.write(JSON.stringify(response, null, 2) + '\n')
          return
        }

        process.stderr.write(upgHeader('Clone - Dry Run') + '\n')
        process.stderr.write(label(`  from:    `) + chalk.white(sanitizeForTerminal(fromLabel)) + '\n')
        process.stderr.write(label(`  into:    `) + chalk.white(sanitizeForTerminal(intoLabel)) + '\n')
        process.stderr.write(label(`  nodes:   `) + chalk.white(String(plan.nodes.length)) + '\n')
        process.stderr.write(label(`  edges:   `) + chalk.white(String(plan.edges.length)) + '\n')
        if (regionIds) {
          process.stderr.write(label(`  regions: `) + chalk.white([...regionIds].join(', ')) + '\n')
        }
        process.stderr.write('\n')
        process.stderr.write(chalk.dim('  Sample placeholder titles:\n'))
        for (const t of plan.nodes.slice(0, 8)) {
          process.stderr.write(chalk.dim(`    ${sanitizeForTerminal(t.type.padEnd(18))} "${sanitizeForTerminal(t.title)}"\n`))
        }
        if (plan.nodes.length > 8) {
          process.stderr.write(chalk.dim(`    ... and ${plan.nodes.length - 8} more\n`))
        }
        process.stderr.write(chalk.dim('\n  Re-run without --dry-run to commit.\n'))
        process.stderr.write('\n')
        return
      }

      // ── Confirmation ─────────────────────────────────────────────────────
      if (!skipConfirm) {
        if (!interactive) {
          die(usageError(
            `Clone requires confirmation in a non-interactive shell. Re-run with --yes (-y), ` +
            `or use --dry-run to preview.`,
          ))
        }
        process.stderr.write('\n')
        process.stderr.write(label(`  from:  `) + chalk.white(sanitizeForTerminal(fromLabel)) + '\n')
        process.stderr.write(label(`  into:  `) + chalk.white(sanitizeForTerminal(intoLabel)) + '\n')
        process.stderr.write(label(`  shape: `) + chalk.white(`${plan.nodes.length} nodes, ${plan.edges.length} edges`) + '\n')
        if (regionIds) {
          process.stderr.write(label(`  scope: `) + chalk.dim([...regionIds].join(', ')) + '\n')
        }
        process.stderr.write('\n')

        const confirmed = await confirm({
          message: `Stamp ${plan.nodes.length} placeholder node(s) into "${sanitizeForTerminal(intoLabel)}"?`,
          default: false,
        })

        if (!confirmed) {
          process.stderr.write(chalk.dim('  Cancelled.\n'))
          return
        }
      }

      // ── Open the target for writing ──────────────────────────────────────
      const writer = await loadStore(targetFilePath!)

      // Double-stamp warning: count existing stubs already in target
      const existingStubs = writer.getAllNodes().filter((n) => (n.tags ?? []).includes('stub')).length

      // ── Commit (atomic-with-rollback) ────────────────────────────────────
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
          const result = createNode(writer, {
            type: spec.type,
            title: spec.title,
            tags: ['stub'],
          })
          const twinId = result.node.id
          idMap.set(spec.sourceId, twinId)
          createdNodeIds.push(twinId)
        }

        for (const e of plan.edges) {
          const srcTwin = idMap.get(e.source)
          const tgtTwin = idMap.get(e.target)
          if (!srcTwin || !tgtTwin) continue
          const result = createEdge(writer, { source_id: srcTwin, target_id: tgtTwin, type: e.type })
          if ('error' in result) {
            skippedEdges.push({ type: e.type as string, reason: result.error })
            continue
          }
          createdEdgeIds.push((result as { edge: { id: string } }).edge.id)
        }

        await writer.flush()
      } catch (err) {
        rollback()
        writer.stopWatching()
        die(runtimeError(
          `Clone failed mid-way; target rolled back. ${(err as Error).message}`,
        ))
      }

      writer.stopWatching()

      // ── Output ───────────────────────────────────────────────────────────
      const warnings: string[] = []
      if (existingStubs > 0) {
        warnings.push(
          `Target already had ${existingStubs} stub node(s) from a prior clone; ` +
          `this clone added ${createdNodeIds.length} more (additive).`,
        )
      }
      if (skippedEdges.length > 0) {
        warnings.push(
          `${skippedEdges.length} source edge(s) were not canonical and were skipped; ` +
          `the shape's nodes are still cloned.`,
        )
      }
      if (unmatchedRegions.length > 0) {
        warnings.push(`Unmatched region(s) ignored: ${unmatchedRegions.join(', ')}.`)
      }

      if (opts.json) {
        const response: Record<string, unknown> = {
          cloned: true,
          from: fromLabel,
          into: intoLabel,
          nodes_created: createdNodeIds.length,
          edges_created: createdEdgeIds.length,
          by_type: plan.byType,
        }
        if (skippedEdges.length > 0) response.edges_skipped = skippedEdges.length
        if (regionIds) response.region_scope = [...regionIds]
        if (warnings.length > 0) response.warnings = warnings
        process.stdout.write(JSON.stringify(response, null, 2) + '\n')
        process.exit(EXIT.OK)
      }

      process.stderr.write(upgHeader('Clone') + '\n')
      process.stderr.write(success(
        `Cloned shape from "${sanitizeForTerminal(fromLabel)}" into "${sanitizeForTerminal(intoLabel)}"`,
      ) + '\n')
      process.stderr.write(label(`  nodes created: `) + chalk.white(String(createdNodeIds.length)) + '\n')
      process.stderr.write(label(`  edges created: `) + chalk.white(String(createdEdgeIds.length)) + '\n')
      if (regionIds) {
        process.stderr.write(label(`  region scope:  `) + chalk.dim([...regionIds].join(', ')) + '\n')
      }
      if (warnings.length > 0) {
        process.stderr.write('\n')
        for (const w of warnings) {
          process.stderr.write(chalk.yellow(`  ! ${sanitizeForTerminal(w)}\n`))
        }
      }
      process.stderr.write(chalk.dim('\n  Titles are placeholders (TODO: <type>). Fill them with `upg update`.\n'))
      process.stderr.write('\n')
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
