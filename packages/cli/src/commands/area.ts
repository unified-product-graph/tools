/**
 * `upg area` command group: product areas within a portfolio graph.
 *
 * Portfolio-scoped: reads and writes `.upg/portfolio.upg` (via the SDK
 * portfolio-routing helpers), not the active product file. --file is accepted
 * on graph-scoped subcommands (`tree`, `show`) that need to load a product graph
 * to render a node subgraph.
 *
 * Subcommands:
 *   list                           list all product areas
 *   create <title>                 create a new product area
 *   update <id>                    edit area title / description / priority / owner
 *   delete <id>                    delete an area from the portfolio
 *   show <id>                      show area context (.upg-area.json walk)
 *   tree <id>                      area-scoped subgraph (BFS via product graph)
 *   assign <product> <area>        add a product to an area
 *   move <product> <area>          move a product to a different area
 *   remove <product> <area>        remove a product from an area
 *   link-audience <area> <id>      create an area audience edge to a registry persona/segment
 */

import { Command } from 'commander'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import {
  openPortfolioStoreIfExists,
  writePortfolioScopedNode,
  assignProductToArea,
  moveProductToArea,
  removeProductFromArea,
  deleteArea,
  updateProductArea,
  PortfolioRoutingError,
  edgeId,
} from '@unified-product-graph/sdk'
import type { UPGCrossEdge } from '@unified-product-graph/sdk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, renderTree, success, label } from '../lib/formatter.js'
import { die, runtimeError } from '../lib/errors.js'
import type { UPGBaseNode } from '@unified-product-graph/core'
import chalk from 'chalk'

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the portfolio cwd: walk up from the process cwd looking for a .upg
 * directory. Falls back to process.cwd() when none is found.
 */
async function resolvePortfolioCwd(): Promise<string> {
  let dir = process.cwd()
  const { root } = path.parse(dir)
  while (dir !== root) {
    try {
      await fsp.access(path.join(dir, '.upg'))
      return dir
    } catch { /* walk up */ }
    dir = path.dirname(dir)
  }
  return process.cwd()
}

// ── `upg area list` ───────────────────────────────────────────────────────────

const listSub = new Command('list')
  .description('List all product areas in the portfolio.')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const portfolioStore = await openPortfolioStoreIfExists(cwd)
      if (!portfolioStore) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ areas: [], total: 0 }, null, 2) + '\n')
        } else {
          process.stderr.write(upgHeader('Areas') + '\n')
          console.log('  No portfolio document found. Run `upg area create <title>` to create one.')
        }
        return
      }
      const doc = portfolioStore.getDocument()
      const areas = doc?.product_areas ?? []
      const result = areas.map((area) => {
        const row: Record<string, unknown> = { id: area.id, title: area.title }
        if (area.description) row.description = area.description
        if (area.parent_area_id !== undefined) row.parent_area_id = area.parent_area_id
        if (area.strategic_priority) row.strategic_priority = area.strategic_priority
        if (area.owner) row.owner = area.owner
        if (area.products) row.products = area.products
        return row
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify({ areas: result, total: result.length }, null, 2) + '\n')
        return
      }
      process.stderr.write(upgHeader('Areas') + '\n')
      if (result.length === 0) {
        console.log('  No product areas yet. Run `upg area create <title>` to create one.')
        return
      }
      for (const a of result) {
        const priority = a.strategic_priority ? chalk.dim(` [${a.strategic_priority}]`) : ''
        const owner = a.owner ? chalk.dim(` owned by ${a.owner}`) : ''
        const parent = a.parent_area_id ? chalk.dim(` parent: ${a.parent_area_id}`) : ''
        const products = Array.isArray(a.products) && a.products.length > 0
          ? chalk.dim(` (${a.products.length} product${a.products.length === 1 ? '' : 's'})`)
          : ''
        console.log(`  ${chalk.blueBright(String(a.id))}  ${chalk.white(String(a.title))}${priority}${owner}${parent}${products}`)
      }
      process.stderr.write(`\n  ${result.length} area${result.length === 1 ? '' : 's'}\n`)
    } catch (err) {
      die(err)
    }
  })

// ── `upg area create <title>` ─────────────────────────────────────────────────

const createSub = new Command('create')
  .argument('<title>', 'Area title')
  .description('Create a new product area in the portfolio.')
  .option('--description <text>', 'Description')
  .option('--priority <level>', 'Strategic priority: urgent, high, medium, low, none')
  .option('--owner <name>', 'Owner name or team')
  .option('--parent <area-id>', 'Parent area id (nests this area under another)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (title, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const properties: Record<string, unknown> = {}
      if (opts.priority) properties.strategic_priority = opts.priority
      if (opts.parent) properties.parent_area_id = opts.parent
      if (opts.owner) properties.owner = opts.owner
      const result = await writePortfolioScopedNode(cwd, {
        type: 'product_area',
        title,
        description: opts.description as string | undefined,
        properties,
      })
      if (opts.json) {
        const payload: Record<string, unknown> = {
          node: result.entity,
          portfolio_file: result.portfolio_file,
          written_to: result.written_to,
        }
        if (result.warning) payload.warning = result.warning
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
        return
      }
      console.log(success(`Created area: ${chalk.bold(title)} (${(result.entity as { id: string }).id})`))
      if (result.warning) process.stderr.write(chalk.yellow(`  Warning: ${result.warning}\n`))
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area update <id>` ────────────────────────────────────────────────────

const updateSub = new Command('update')
  .argument('<id>', 'Area id')
  .description('Edit an area: title, description, priority, owner, or re-parent.')
  .option('--title <text>', 'New title')
  .option('--description <text>', 'New description')
  .option('--priority <level>', 'Strategic priority: urgent, high, medium, low, none')
  .option('--owner <name>', 'New owner name or team')
  .option('--parent <area-id>', 'Re-parent under this area id')
  .option('--unparent', 'Make this area top-level (remove parent)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      if (!opts.title && !opts.description && !opts.priority && !opts.owner && !opts.parent && !opts.unparent) {
        die(runtimeError('Nothing to update: pass at least one of --title, --description, --priority, --owner, --parent, --unparent'))
      }
      if (opts.parent && opts.unparent) {
        die(runtimeError('Pass either --parent or --unparent, not both.'))
      }
      const cwd = await resolvePortfolioCwd()
      const updateArgs: {
        title?: string
        description?: string
        strategic_priority?: string
        owner?: string
        parent_area_id?: string | null
      } = {}
      if (opts.title) updateArgs.title = opts.title as string
      if (opts.description) updateArgs.description = opts.description as string
      if (opts.priority) updateArgs.strategic_priority = opts.priority as string
      if (opts.owner) updateArgs.owner = opts.owner as string
      if (opts.unparent) updateArgs.parent_area_id = null
      else if (opts.parent) updateArgs.parent_area_id = opts.parent as string
      const result = await updateProductArea(cwd, id, updateArgs)
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          message: `Updated area (${result.updated.join(', ')})`,
          area: result.area,
          updated: result.updated,
        }, null, 2) + '\n')
        return
      }
      console.log(success(`Updated area ${chalk.bold(id)}: ${result.updated.join(', ')}`))
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area delete <id>` ────────────────────────────────────────────────────

const deleteSub = new Command('delete')
  .argument('<id>', 'Area id')
  .description('Delete a product area from the portfolio.')
  .option('--force', 'Delete even if the area still has products')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const result = await deleteArea(cwd, id, { force: opts.force as boolean | undefined })
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          message: `Deleted area ${id}`,
          ...result,
        }, null, 2) + '\n')
        return
      }
      console.log(success(`Deleted area ${chalk.bold(id)}`))
      if (result.unnested_children && result.unnested_children.length > 0) {
        console.log(label(`  Un-nested child areas: ${result.unnested_children.join(', ')}`))
      }
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area show <id>` ──────────────────────────────────────────────────────

const showSub = new Command('show')
  .argument('<id>', 'Area id to look up in the portfolio')
  .description('Show area details from the portfolio.')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const portfolioStore = await openPortfolioStoreIfExists(cwd)
      if (!portfolioStore) {
        die(runtimeError('No portfolio document found. Run `upg area create <title>` to create one.'))
      }
      const doc = portfolioStore!.getDocument()
      const area = doc?.product_areas?.find((a) => a.id === id)
      if (!area) {
        die(runtimeError(`Area "${id}" not found in portfolio. List areas with \`upg area list\`.`))
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(area, null, 2) + '\n')
        return
      }
      process.stderr.write(upgHeader(`Area: ${area!.title}`) + '\n')
      console.log(`  ${label('id')}                ${chalk.bold(area!.id)}`)
      console.log(`  ${label('title')}             ${area!.title}`)
      if (area!.description) console.log(`  ${label('description')}       ${area!.description}`)
      if (area!.strategic_priority) console.log(`  ${label('priority')}          ${area!.strategic_priority}`)
      if (area!.owner) console.log(`  ${label('owner')}             ${area!.owner}`)
      if (area!.parent_area_id) console.log(`  ${label('parent_area_id')}    ${area!.parent_area_id}`)
      const products = area!.products ?? []
      console.log(`  ${label('products')}          ${products.length === 0 ? '(none)' : products.join(', ')}`)
    } catch (err) {
      die(err)
    }
  })

// ── `upg area tree <id>` ──────────────────────────────────────────────────────

const treeSub = new Command('tree')
  .argument('<id>', 'Area node id in the product graph')
  .description('Area-scoped subgraph: BFS from the area node, rendered as a tree.')
  .option('--file <path>', 'Path to .upg file')
  .option('--depth <n>', 'BFS depth (default 3, max 10)', (v) => Math.min(Math.max(parseInt(v, 10), 1), 10), 3)
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const areaNode = store.getNode(id)
      if (!areaNode) {
        store.stopWatching()
        die(runtimeError(`Area node not found: ${id}`))
      }
      if (areaNode!.type !== 'product_area') {
        store.stopWatching()
        die(runtimeError(`Node ${id} is type "${areaNode!.type}", not "product_area"`))
      }

      const maxDepth = opts.depth as number

      // BFS from areaNode, collecting reachable nodes + edges
      const visited = new Set<string>([id])
      const queue: Array<{ id: string; level: number }> = [{ id, level: 0 }]
      const nodeIds: string[] = []
      while (queue.length > 0) {
        const { id: nid, level } = queue.shift()!
        nodeIds.push(nid)
        if (level < maxDepth) {
          for (const edge of store.getEdgesForNode(nid)) {
            const neighborId = edge.source === nid ? edge.target : edge.source
            if (!visited.has(neighborId)) {
              visited.add(neighborId)
              queue.push({ id: neighborId, level: level + 1 })
            }
          }
        }
      }

      const nodeMap = new Map<string, UPGBaseNode>(
        nodeIds
          .map((nid) => store.getNode(nid))
          .filter((n): n is UPGBaseNode => n != null)
          .map((n) => [n.id, n]),
      )

      // Build children index scoped to the BFS result
      const childrenMap = new Map<string, string[]>()
      for (const nid of nodeIds) {
        const node = nodeMap.get(nid)
        if (!node) continue
        for (const edge of store.getEdgesForNode(nid)) {
          if (edge.source === nid && nodeMap.has(edge.target)) {
            const children = childrenMap.get(nid) ?? []
            children.push(edge.target)
            childrenMap.set(nid, children)
          }
        }
      }

      store.stopWatching()

      const childrenOf = (nid: string): UPGBaseNode[] =>
        (childrenMap.get(nid) ?? [])
          .map((cid) => nodeMap.get(cid))
          .filter((n): n is UPGBaseNode => n != null)

      if (opts.json) {
        interface TreeJsonNode {
          id: string; type: string; title: string; status?: string; shared?: boolean; children: TreeJsonNode[]
        }
        const expanded = new Set<string>()
        const build = (node: UPGBaseNode, depth: number): TreeJsonNode => {
          const entry: TreeJsonNode = { id: node.id, type: node.type, title: node.title, status: node.status, children: [] }
          if (expanded.has(node.id)) { entry.shared = true; return entry }
          expanded.add(node.id)
          if (depth >= maxDepth) return entry
          entry.children = childrenOf(node.id).map((c) => build(c, depth + 1))
          return entry
        }
        process.stdout.write(JSON.stringify(build(areaNode!, 0), null, 2) + '\n')
        return
      }

      process.stderr.write(upgHeader(`Area tree: ${areaNode!.title}`) + '\n')
      const root = nodeMap.get(id)!
      process.stdout.write(
        renderTree([root], childrenOf, maxDepth) + '\n',
      )
    } catch (err) {
      die(err)
    }
  })

// ── `upg area assign <product> <area>` ────────────────────────────────────────

const assignSub = new Command('assign')
  .argument('<product>', 'Product id')
  .argument('<area>', 'Area id')
  .description('Add a product to a product area.')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product, area, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const result = await assignProductToArea(cwd, { product_id: product, area_id: area })
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return
      }
      const already = (result as unknown as Record<string, unknown>).already_member
      if (already) {
        console.log(label(`  Product ${product} is already in area ${area}.`))
      } else {
        console.log(success(`Assigned product ${chalk.bold(product)} to area ${chalk.bold(area)}.`))
      }
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area move <product> <area>` ──────────────────────────────────────────

const moveSub = new Command('move')
  .argument('<product>', 'Product id')
  .argument('<area>', 'Target area id')
  .description('Move a product to a different area (removes from current area(s)).')
  .option('--from <area-id>', 'Remove only from this source area (optional)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product, area, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const result = await moveProductToArea(cwd, {
        product_id: product,
        to_area_id: area,
        from_area_id: opts.from as string | undefined,
      })
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return
      }
      const r = result as unknown as Record<string, unknown>
      const removedFrom = Array.isArray(r.removed_from) ? (r.removed_from as string[]) : []
      console.log(success(`Moved product ${chalk.bold(product)} to area ${chalk.bold(area)}.`))
      if (removedFrom.length > 0) {
        console.log(label(`  Removed from: ${removedFrom.join(', ')}`))
      }
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area remove <product> <area>` ────────────────────────────────────────

const removeSub = new Command('remove')
  .argument('<product>', 'Product id')
  .argument('<area>', 'Area id')
  .description('Remove a product from a product area (idempotent).')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product, area, opts) => {
    try {
      const cwd = await resolvePortfolioCwd()
      const result = await removeProductFromArea(cwd, { product_id: product, area_id: area })
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return
      }
      const r = result as unknown as Record<string, unknown>
      if (r.removed === false) {
        console.log(label(`  Product ${product} was not a member of area ${area}.`))
      } else {
        console.log(success(`Removed product ${chalk.bold(product)} from area ${chalk.bold(area)}.`))
      }
    } catch (err) {
      if (err instanceof PortfolioRoutingError) die(runtimeError(err.message))
      die(err)
    }
  })

// ── `upg area link-audience <area> <canonical-id>` ────────────────────────────

const linkAudienceSub = new Command('link-audience')
  .argument('<area>', 'Area id')
  .argument('<canonical-id>', 'Registry persona or market_segment id (or registry/<id>)')
  .description('Create an audience edge: area_serves_persona or area_targets_market_segment.')
  .option('--relevance <level>', 'primary or secondary')
  .option('--audience-role <role>', 'buyer, user, champion, influencer, partner (persona only)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (areaId, canonicalArg, opts) => {
    try {
      const REGISTRY_PRODUCT_ID = 'registry'

      if (opts.relevance && opts.relevance !== 'primary' && opts.relevance !== 'secondary') {
        die(runtimeError(`Invalid --relevance "${opts.relevance}". Use "primary" or "secondary".`))
      }
      const validRoles = ['buyer', 'user', 'champion', 'influencer', 'partner']
      if (opts.audienceRole && !validRoles.includes(opts.audienceRole as string)) {
        die(runtimeError(`Invalid --audience-role "${opts.audienceRole}". Use one of: ${validRoles.join(', ')}.`))
      }

      const cwd = await resolvePortfolioCwd()
      const portfolioStore = await openPortfolioStoreIfExists(cwd)
      if (!portfolioStore) {
        die(runtimeError('No portfolio document found. Create an area and registry entity first.'))
      }

      const doc = portfolioStore!.getDocument()
      const area = doc?.product_areas?.find((a) => a.id === areaId)
      if (!area) {
        die(runtimeError(`Area "${areaId}" not found in portfolio. List areas with \`upg area list\`.`))
      }

      const prefix = `${REGISTRY_PRODUCT_ID}/`
      const canonicalId = canonicalArg.startsWith(prefix)
        ? canonicalArg.slice(prefix.length)
        : canonicalArg

      const canonical = portfolioStore!.getRegistryNode(canonicalId)
      if (!canonical) {
        die(runtimeError(
          `Canonical entity "${canonicalId}" not found in the registry. ` +
          `Define it first with \`define_canonical_entity\` (MCP) or ensure the registry exists.`,
        ))
      }

      type AreaEdgeType = 'area_serves_persona' | 'area_targets_market_segment'
      let edgeType: AreaEdgeType
      if (canonical!.type === 'persona') edgeType = 'area_serves_persona'
      else if (canonical!.type === 'market_segment') edgeType = 'area_targets_market_segment'
      else {
        die(runtimeError(
          `Canonical "${canonicalId}" is a ${canonical!.type}. ` +
          `An area audience edge requires a registry persona or market_segment.`,
        ))
        // unreachable, but TypeScript needs it for narrowing
        return
      }

      if (opts.audienceRole && edgeType !== 'area_serves_persona') {
        die(runtimeError('--audience-role applies only to a persona target (area_serves_persona).'))
      }

      const target = `${REGISTRY_PRODUCT_ID}/${canonicalId}`

      // Idempotent: update qualifiers on an existing edge rather than duplicating.
      const existing = portfolioStore!
        .getAllCrossEdges()
        .find((e) => e.type === edgeType && e.source === areaId && e.target === target)

      if (existing) {
        let updated = false
        if (opts.relevance && existing.relevance !== opts.relevance) {
          (existing as UPGCrossEdge).relevance = opts.relevance as 'primary' | 'secondary'
          updated = true
        }
        if (opts.audienceRole && existing.audience_role !== opts.audienceRole) {
          (existing as UPGCrossEdge).audience_role = opts.audienceRole as UPGCrossEdge['audience_role']
          updated = true
        }
        if (updated) {
          portfolioStore!.markDirty()
          await portfolioStore!.flush()
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({
            edge: existing,
            area: { id: area!.id, title: area!.title },
            canonical: { id: canonicalId, type: canonical!.type, title: canonical!.title },
            already_existed: true,
            updated,
          }, null, 2) + '\n')
          return
        }
        console.log(label(`  Edge already exists (${edgeType}).${updated ? ' Qualifiers updated.' : ''}`))
        return
      }

      const edge: UPGCrossEdge = {
        id: edgeId(),
        source: areaId,
        target,
        type: edgeType as UPGCrossEdge['type'],
        target_product_id: REGISTRY_PRODUCT_ID,
      }
      if (opts.relevance) edge.relevance = opts.relevance as 'primary' | 'secondary'
      if (opts.audienceRole) edge.audience_role = opts.audienceRole as UPGCrossEdge['audience_role']

      portfolioStore!.addCrossEdge(edge)
      await portfolioStore!.flush()

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          edge,
          area: { id: area!.id, title: area!.title },
          canonical: { id: canonicalId, type: canonical!.type, title: canonical!.title },
          portfolio_file: portfolioStore!.getFilePath() ?? '',
        }, null, 2) + '\n')
        return
      }
      console.log(success(`Linked area ${chalk.bold(areaId)} to ${canonical!.type} ${chalk.bold(canonicalId)} (${edgeType}).`))
    } catch (err) {
      die(err)
    }
  })

// ── root command ──────────────────────────────────────────────────────────────

export const areaCommand = new Command('area')
  .description('Manage product areas: list, create, update, delete, assign products, link audiences.')
  .addCommand(listSub)
  .addCommand(createSub)
  .addCommand(updateSub)
  .addCommand(deleteSub)
  .addCommand(showSub)
  .addCommand(treeSub)
  .addCommand(assignSub)
  .addCommand(moveSub)
  .addCommand(removeSub)
  .addCommand(linkAudienceSub)
  .action(() => {
    process.stderr.write(upgHeader('Area') + '\n')
    console.log('  Subcommands: list, create, update, delete, show, tree, assign, move, remove, link-audience')
    console.log()
    console.log('  Examples:')
    console.log('    upg area list')
    console.log('    upg area create "Core Platform"')
    console.log('    upg area assign my_product area_core')
    console.log()
  })

