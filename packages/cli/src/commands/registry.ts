/**
 * Registry command group: canonical shared-entity registry.
 *
 * Operates on the portfolio document (`.upg/portfolio.upg`). Pass --file
 * to target a specific portfolio file; otherwise the portfolio is resolved
 * from the current working directory via resolvePortfolioPath.
 *
 * Subcommands:
 *   define <type> <title>         - add a canonical entity (define_canonical_entity)
 *   update <id>                   - patch a canonical entity in place (update_canonical_entity)
 *   register <product> <node-id>  - create instance_of edge (register_instance)
 *   promote <product> <node-id>   - promote a product node to canonical (promote_to_canonical)
 *   list [type]                   - list registry nodes (list_registry)
 *   connect <src> <tgt>           - add a registry-internal edge (create_registry_edge)
 *   org [id]                      - show or set the portfolio organisation
 */

import * as path from 'node:path'
import { Command } from 'commander'
import {
  UPGPortfolioStore,
  resolvePortfolioPath,
  openPortfolioStoreIfExists,
  edgeId,
} from '@unified-product-graph/sdk'
import {
  UPG_TYPES_SET,
  UPG_EDGE_CATALOG,
  REGISTRY_PRODUCT_ID,
  generateSlug,
  type UPGBaseNode,
  type UPGCrossEdge,
  type UPGEdge,
} from '@unified-product-graph/core'
import { die, runtimeError, violation, usageError } from '../lib/errors.js'
import { upgHeader, label, success } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import chalk from 'chalk'

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the portfolio store from an explicit --file or by walking cwd.
 * Creates the portfolio document if it does not exist yet (mirrors the MCP).
 */
async function openOrInitPortfolio(explicitFile?: string): Promise<{ store: UPGPortfolioStore; portfolioPath: string }> {
  const cwd = process.cwd()
  let portfolioPath: string
  if (explicitFile) {
    portfolioPath = path.resolve(explicitFile)
  } else {
    const resolved = resolvePortfolioPath(cwd)
    if (!resolved) {
      throw runtimeError(
        'No .upg workspace found. Run `upg init` first, or pass --file <portfolio.upg>.',
      )
    }
    portfolioPath = resolved
  }
  const store = new UPGPortfolioStore()
  await store.loadOrInit(portfolioPath)
  return { store, portfolioPath }
}

/**
 * Open an existing portfolio store (read-only path). Returns null when the
 * portfolio does not exist yet (no registry to read).
 */
async function openPortfolioReadOnly(
  cwd: string,
  explicitFile?: string,
): Promise<UPGPortfolioStore | null> {
  if (explicitFile) {
    const portfolioPath = path.resolve(explicitFile)
    const store = new UPGPortfolioStore()
    try {
      await store.loadOrInit(portfolioPath)
      return store
    } catch {
      return null
    }
  }
  return openPortfolioStoreIfExists(cwd)
}

/** Build a stable, readable, type-prefixed registry node id from a title. */
function deriveCanonicalId(type: string, title: string, taken: Set<string>): string {
  const base = `${type}_${generateSlug(title).replace(/-/g, '_')}`
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/** Strip a leading `registry/` namespace from a canonical reference, if present. */
function bareCanonicalId(ref: string): string {
  const prefix = `${REGISTRY_PRODUCT_ID}/`
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

/** Portfolio-relative display path. */
function relPath(portfolioPath: string): string {
  try {
    return path.relative(process.cwd(), portfolioPath)
  } catch {
    return portfolioPath
  }
}

// ── sub-command: define ───────────────────────────────────────────────────

const defineCmd = new Command('define')
  .description('Define a canonical entity in the registry.')
  .argument('<type>', 'UPG entity type (e.g. persona, metric, competitor)')
  .argument('<title>', 'Canonical title')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--canonical-id <id>', 'Explicit registry id (default: derived from type + title)')
  .option('--description <text>', 'Optional description')
  .option('--json', 'Machine-readable JSON output')
  .action(async (type: string, title: string, opts: {
    file?: string
    canonicalId?: string
    description?: string
    json?: boolean
  }) => {
    try {
      if (!UPG_TYPES_SET.has(type)) {
        die(violation(
          `Invalid entity type: "${type}". Must be an active UPG type (e.g. persona, metric). ` +
          `Run \`upg list --type\` to browse available types.`,
        ))
      }
      if (!title.trim()) {
        die(usageError('Title is required and cannot be empty.'))
      }

      const { store, portfolioPath } = await openOrInitPortfolio(opts.file)
      const taken = new Set(store.listRegistryNodes().map((n) => n.id))

      const explicitId = opts.canonicalId?.trim()
      if (explicitId && taken.has(explicitId)) {
        die(runtimeError(`Registry already has a canonical entity with id "${explicitId}".`))
      }
      const id = explicitId ?? deriveCanonicalId(type, title.trim(), taken)

      const node: UPGBaseNode = {
        id,
        type: type as UPGBaseNode['type'],
        title: title.trim(),
      }
      if (opts.description) node.description = opts.description

      store.addRegistryNode(node)
      await store.flush()

      const qualifiedId = `${REGISTRY_PRODUCT_ID}/${id}`

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, canonical: node, qualified_id: qualifiedId, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Define'))
      console.log(success(`Defined ${sanitizeForTerminal(type)}: "${sanitizeForTerminal(node.title)}"`))
      console.log(label(`  id:       `) + chalk.white(sanitizeForTerminal(id)))
      console.log(label(`  qualified: `) + chalk.white(sanitizeForTerminal(qualifiedId)))
      console.log(label(`  file:     `) + chalk.dim(sanitizeForTerminal(relPath(portfolioPath))))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: update ───────────────────────────────────────────────────

const updateCmd = new Command('update')
  .description('Patch a canonical entity in place (title, description, tags).')
  .argument('<id>', 'Registry node id (bare or registry/<id>)')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--title <title>', 'New title')
  .option('--description <text>', 'New description')
  .option('--json', 'Machine-readable JSON output')
  .action(async (canonicalArg: string, opts: {
    file?: string
    title?: string
    description?: string
    json?: boolean
  }) => {
    try {
      const cwd = process.cwd()
      const portfolioStore = await openPortfolioReadOnly(cwd, opts.file)
      if (!portfolioStore) {
        die(runtimeError('No portfolio document found. Define a canonical entity first with `upg registry define`.'))
      }

      const canonicalId = bareCanonicalId(canonicalArg)
      if (!portfolioStore.getRegistryNode(canonicalId)) {
        die(runtimeError(`Canonical entity "${canonicalId}" not found. Run \`upg registry list\` to see available ids.`))
      }

      const patch: Parameters<typeof portfolioStore.updateRegistryNode>[1] = {}
      if (opts.title !== undefined) patch.title = opts.title
      if (opts.description !== undefined) patch.description = opts.description
      if (Object.keys(patch).length === 0) {
        die(usageError('Nothing to update: pass at least one of --title or --description.'))
      }

      const updated = portfolioStore.updateRegistryNode(canonicalId, patch)
      await portfolioStore.flush()

      const portfolioPath = portfolioStore.getFilePath() ?? ''
      const qualifiedId = `${REGISTRY_PRODUCT_ID}/${canonicalId}`

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, canonical: updated, qualified_id: qualifiedId, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Update'))
      console.log(success(`Updated "${sanitizeForTerminal(canonicalId)}"`))
      if (updated) {
        console.log(label(`  title:    `) + chalk.white(sanitizeForTerminal(updated.title)))
      }
      console.log(label(`  file:     `) + chalk.dim(sanitizeForTerminal(relPath(portfolioPath))))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: register ─────────────────────────────────────────────────

const registerCmd = new Command('register')
  .description('Register a product node as an instance of a canonical registry entity.')
  .argument('<product>', 'Product id (e.g. my_product)')
  .argument('<node-id>', 'Bare node id within the product')
  .requiredOption('--canonical <id>', 'Registry canonical id (bare or registry/<id>)')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product: string, nodeId: string, opts: {
    canonical: string
    file?: string
    json?: boolean
  }) => {
    try {
      const cwd = process.cwd()
      const portfolioStore = await openPortfolioReadOnly(cwd, opts.file)
      if (!portfolioStore) {
        die(runtimeError('No portfolio document found. Define a canonical entity first with `upg registry define`.'))
      }

      const canonicalId = bareCanonicalId(opts.canonical)
      const canonical = portfolioStore.getRegistryNode(canonicalId)
      if (!canonical) {
        die(runtimeError(
          `Canonical entity "${canonicalId}" not found. Run \`upg registry list\` to see available ids.`,
        ))
      }

      const qualifiedSource = `${product}/${nodeId}`
      const qualifiedTarget = `${REGISTRY_PRODUCT_ID}/${canonicalId}`

      // Idempotent: return existing edge without duplicating.
      const existing = portfolioStore
        .getAllCrossEdges()
        .find((e) => e.type === 'instance_of' && e.source === qualifiedSource && e.target === qualifiedTarget)

      const portfolioPath = portfolioStore.getFilePath() ?? ''

      if (existing) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, edge: existing, already_existed: true, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
          )
          return
        }
        console.log(upgHeader('Registry - Register'))
        console.log(chalk.dim(`Instance already registered: ${sanitizeForTerminal(qualifiedSource)} -> ${sanitizeForTerminal(qualifiedTarget)}`))
        console.log()
        return
      }

      const edge: UPGCrossEdge = {
        id: edgeId(),
        source: qualifiedSource,
        target: qualifiedTarget,
        type: 'instance_of',
        source_product_id: product,
        target_product_id: REGISTRY_PRODUCT_ID,
      }

      portfolioStore.addCrossEdge(edge)
      await portfolioStore.flush()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, edge, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Register'))
      console.log(success(`Registered ${sanitizeForTerminal(qualifiedSource)} as instance of ${sanitizeForTerminal(canonicalId)}`))
      console.log(label(`  edge id:  `) + chalk.dim(sanitizeForTerminal(edge.id)))
      console.log(label(`  file:     `) + chalk.dim(sanitizeForTerminal(relPath(portfolioPath))))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: promote ──────────────────────────────────────────────────

const promoteCmd = new Command('promote')
  .description('Promote a product node into the registry as its canonical.')
  .argument('<product>', 'Product id (e.g. my_product)')
  .argument('<node-id>', 'Bare node id within the product')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--canonical-id <id>', 'Explicit registry id (default: derived from type + title)')
  .option('--no-register', 'Skip auto-registering the source node as the first instance')
  .option('--json', 'Machine-readable JSON output')
  .action(async (product: string, nodeId: string, opts: {
    file?: string
    canonicalId?: string
    register?: boolean
    json?: boolean
  }) => {
    try {
      const { store, portfolioPath } = await openOrInitPortfolio(opts.file)

      // Resolve the product's .upg file to get the node type + title.
      const { loadStore } = await import('../lib/graph.js')
      const cwd = process.cwd()
      // Try to load the product file from the workspace .upg directory.
      const { findProductFileById } = await import('@unified-product-graph/sdk')
      const productRef = findProductFileById(cwd, product)
      if (!productRef) {
        die(runtimeError(`Product "${product}" not found in workspace. Check .upg/ for available product files.`))
      }
      const productFilePath = path.resolve(cwd, productRef.file_path)
      const productStore = await loadStore(productFilePath)
      const srcNode = productStore.getNode(nodeId)
      productStore.stopWatching()
      if (!srcNode) {
        die(runtimeError(`Node "${nodeId}" not found in product "${product}".`))
      }

      const taken = new Set(store.listRegistryNodes().map((n) => n.id))
      const explicitId = opts.canonicalId?.trim()
      if (explicitId && taken.has(explicitId)) {
        die(runtimeError(`Registry already has a canonical entity with id "${explicitId}".`))
      }
      const id = explicitId ?? deriveCanonicalId(srcNode.type, srcNode.title, taken)

      const canonical: UPGBaseNode = { id, type: srcNode.type, title: srcNode.title }
      if (srcNode.description) canonical.description = srcNode.description
      if (Array.isArray(srcNode.tags)) canonical.tags = [...srcNode.tags]

      const registerSource = opts.register !== false
      let edge: UPGCrossEdge | undefined
      store.addRegistryNode(canonical)
      if (registerSource) {
        edge = {
          id: edgeId(),
          source: `${product}/${nodeId}`,
          target: `${REGISTRY_PRODUCT_ID}/${id}`,
          type: 'instance_of',
          source_product_id: product,
          target_product_id: REGISTRY_PRODUCT_ID,
        }
        store.addCrossEdge(edge)
      }
      await store.flush()

      const qualifiedId = `${REGISTRY_PRODUCT_ID}/${id}`

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            canonical,
            qualified_id: qualifiedId,
            registered_source: registerSource,
            edge,
            portfolio_file: relPath(portfolioPath),
          }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Promote'))
      console.log(success(`Promoted "${sanitizeForTerminal(nodeId)}" to canonical "${sanitizeForTerminal(id)}"`))
      if (registerSource && edge) {
        console.log(chalk.dim(`  instance_of edge created: ${sanitizeForTerminal(`${product}/${nodeId}`)} -> ${sanitizeForTerminal(qualifiedId)}`))
      }
      console.log(label(`  file: `) + chalk.dim(sanitizeForTerminal(relPath(portfolioPath))))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: list ─────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List canonical entities in the registry.')
  .argument('[type]', 'Filter by entity type (e.g. persona)')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--instances', 'Include instance_of edge counts per canonical')
  .option('--json', 'Machine-readable JSON output')
  .action(async (typeFilter: string | undefined, opts: {
    file?: string
    instances?: boolean
    json?: boolean
  }) => {
    try {
      const cwd = process.cwd()
      const portfolioStore = await openPortfolioReadOnly(cwd, opts.file)

      if (!portfolioStore) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ registry: [], total: 0, by_type: {} }, null, 2) + '\n')
          return
        }
        console.log(upgHeader('Registry'))
        console.log(chalk.dim('  No portfolio document found.'))
        console.log()
        return
      }

      const nodes = portfolioStore.listRegistryNodes(typeFilter)
      const crossEdges = portfolioStore.getAllCrossEdges()
      const portfolioPath = portfolioStore.getFilePath() ?? ''

      const byType: Record<string, number> = {}
      const rows = nodes.map((n) => {
        byType[n.type] = (byType[n.type] ?? 0) + 1
        const target = `${REGISTRY_PRODUCT_ID}/${n.id}`
        const instanceCount = crossEdges.filter((e) => e.type === 'instance_of' && e.target === target).length
        const row: Record<string, unknown> = { id: n.id, type: n.type, title: n.title }
        if (n.description) row.description = n.description
        row.instance_count = instanceCount
        return row
      })

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ registry: rows, total: rows.length, by_type: byType }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry'))

      if (nodes.length === 0) {
        console.log(chalk.dim('  Registry is empty. Use `upg registry define` to add canonical entities.'))
        console.log()
        return
      }

      // Group by type for human output
      const grouped = new Map<string, typeof rows>()
      for (const row of rows) {
        const t = row.type as string
        if (!grouped.has(t)) grouped.set(t, [])
        grouped.get(t)!.push(row)
      }

      for (const [type, typeRows] of grouped) {
        console.log(chalk.bold(`  ${sanitizeForTerminal(type)} (${typeRows.length})`))
        for (const r of typeRows) {
          const instanceLabel = opts.instances ? chalk.dim(` [${r.instance_count} instance${Number(r.instance_count) === 1 ? '' : 's'}]`) : ''
          console.log(`    ${chalk.white(sanitizeForTerminal(r.id as string))}  "${sanitizeForTerminal(r.title as string)}"${instanceLabel}`)
        }
        console.log()
      }

      console.log(label(`  ${nodes.length} canonical ${nodes.length === 1 ? 'entity' : 'entities'}`))
      console.log(chalk.dim(`  file: ${sanitizeForTerminal(relPath(portfolioPath))}`))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: connect ──────────────────────────────────────────────────

const connectCmd = new Command('connect')
  .description('Create a canonical-internal edge between two registry entities.')
  .argument('<src>', 'Source registry node id (bare or registry/<id>)')
  .argument('<tgt>', 'Target registry node id (bare or registry/<id>)')
  .requiredOption('--type <edge-type>', 'Catalog edge type (e.g. specification_governed_by_organization)')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (srcArg: string, tgtArg: string, opts: {
    type: string
    file?: string
    json?: boolean
  }) => {
    try {
      const cwd = process.cwd()
      const portfolioStore = await openPortfolioReadOnly(cwd, opts.file)
      if (!portfolioStore) {
        die(runtimeError('No portfolio document found. Define the canonical entities first with `upg registry define`.'))
      }

      const edgeType = opts.type
      const def = (UPG_EDGE_CATALOG as Record<string, { source_type: string; target_type: string }>)[edgeType]
      if (!def) {
        die(violation(
          `Invalid edge type: "${edgeType}". Must be a UPG_EDGE_CATALOG type. ` +
          `Use \`upg list --type\` or see the spec for valid types.`,
        ))
      }

      const sourceId = bareCanonicalId(srcArg)
      const targetId = bareCanonicalId(tgtArg)

      const source = portfolioStore.getRegistryNode(sourceId)
      if (!source) {
        die(runtimeError(`Source "${sourceId}" not found in registry. Run \`upg registry list\` to see available ids.`))
      }
      const target = portfolioStore.getRegistryNode(targetId)
      if (!target) {
        die(runtimeError(`Target "${targetId}" not found in registry. Run \`upg registry list\` to see available ids.`))
      }

      if (source.type !== def.source_type || target.type !== def.target_type) {
        die(violation(
          `Type mismatch for "${edgeType}": expects ${def.source_type} -> ${def.target_type}, ` +
          `but got ${source.type} ("${sourceId}") -> ${target.type} ("${targetId}"). ` +
          `Use resolve_edge_for_pair to find the right edge type for this pair.`,
        ))
      }

      // Idempotent: return existing edge without duplicating.
      const existing = portfolioStore
        .listRegistryEdges()
        .find((e) => e.type === edgeType && e.source === sourceId && e.target === targetId)

      const portfolioPath = portfolioStore.getFilePath() ?? ''

      if (existing) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, edge: existing, already_existed: true, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
          )
          return
        }
        console.log(upgHeader('Registry - Connect'))
        console.log(chalk.dim(`Edge already exists: ${sanitizeForTerminal(sourceId)} -[${sanitizeForTerminal(edgeType)}]-> ${sanitizeForTerminal(targetId)}`))
        console.log()
        return
      }

      const edge: UPGEdge = {
        id: edgeId(),
        source: sourceId,
        target: targetId,
        type: edgeType as UPGEdge['type'],
      }

      portfolioStore.addRegistryEdge(edge)
      await portfolioStore.flush()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            edge,
            source: { id: sourceId, type: source.type, title: source.title },
            target: { id: targetId, type: target.type, title: target.title },
            portfolio_file: relPath(portfolioPath),
          }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Connect'))
      console.log(success(`Connected "${sanitizeForTerminal(sourceId)}" -[${sanitizeForTerminal(edgeType)}]-> "${sanitizeForTerminal(targetId)}"`))
      console.log(label(`  edge id:  `) + chalk.dim(sanitizeForTerminal(edge.id)))
      console.log(label(`  file:     `) + chalk.dim(sanitizeForTerminal(relPath(portfolioPath))))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── sub-command: org ──────────────────────────────────────────────────────

const orgCmd = new Command('org')
  .description('Show the portfolio organisation.')
  .argument('[id]', 'Organisation id (reserved for future use)')
  .option('--file <path>', 'Portfolio file path (default: .upg/portfolio.upg)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (_id: string | undefined, opts: {
    file?: string
    json?: boolean
  }) => {
    try {
      const cwd = process.cwd()
      const portfolioStore = await openPortfolioReadOnly(cwd, opts.file)

      if (!portfolioStore) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ organization: null }, null, 2) + '\n')
          return
        }
        console.log(upgHeader('Registry - Org'))
        console.log(chalk.dim('  No portfolio document found.'))
        console.log()
        return
      }

      const doc = portfolioStore.getDocument()
      const portfolioPath = portfolioStore.getFilePath() ?? ''
      const org = doc?.organization ?? null

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ organization: org, portfolio_file: relPath(portfolioPath) }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Registry - Org'))
      if (!org) {
        console.log(chalk.dim('  No organisation set in portfolio.'))
      } else {
        console.log(label('  id:    ') + chalk.white(sanitizeForTerminal(org.id)))
        console.log(label('  title: ') + chalk.white(sanitizeForTerminal(org.title)))
      }
      console.log(chalk.dim(`  file: ${sanitizeForTerminal(relPath(portfolioPath))}`))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── parent command ─────────────────────────────────────────────────────────

export const registryCommand = new Command('registry')
  .description('Canonical shared-entity registry: define, register, list, connect.')
  .addCommand(defineCmd)
  .addCommand(updateCmd)
  .addCommand(registerCmd)
  .addCommand(promoteCmd)
  .addCommand(listCmd)
  .addCommand(connectCmd)
  .addCommand(orgCmd)
  .action(() => {
    // No subcommand given: print usage summary.
    console.log(upgHeader('Registry'))
    console.log('  Subcommands:')
    console.log()
    console.log('    define <type> <title>          Add a canonical entity')
    console.log('    update <id>                    Patch a canonical entity in place')
    console.log('    register <product> <node-id>   Link a product node as an instance (--canonical <id>)')
    console.log('    promote <product> <node-id>    Promote a product node to canonical')
    console.log('    list [type]                    List registry entities')
    console.log('    connect <src> <tgt>            Create a registry-internal edge (--type <edge>)')
    console.log('    org                            Show portfolio organisation')
    console.log()
    console.log('  Global option: --file <path>  (targets a specific portfolio.upg file)')
    console.log()
  })
