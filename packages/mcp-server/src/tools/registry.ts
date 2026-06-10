/**
 * Canonical shared-entity registry tools (canonical-registry initiative,
 * Phase 2). A portfolio defines a shared entity (persona / metric / competitor
 * / ...) ONCE in the `registry` section of `.upg/portfolio.upg`; each product's
 * local copy links to it via an `instance_of` cross-edge whose target is
 * `registry/{node_id}`.
 *
 * Three local tools:
 *   - define_canonical_entity — write a canonical node into the registry.
 *   - register_instance       — link a product node to a canonical (instance_of).
 *   - list_registry           — read the registry, optionally with its instances.
 *
 * Local-only: the registry lives in the `.upg`-file portfolio document, a
 * workspace concept with no single-product cloud analogue.
 */

import * as path from 'node:path'
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import {
  UPGFileStore,
  edgeId,
  resolvePortfolioPath,
  openPortfolioStoreIfExists,
  findProductFileById,
} from '@unified-product-graph/sdk'
import { UPGPortfolioStore } from '@unified-product-graph/sdk'
import {
  UPG_TYPES_SET,
  REGISTRY_PRODUCT_ID,
  generateSlug,
  type UPGBaseNode,
  type UPGCrossEdge,
} from '@unified-product-graph/core'

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

/** The active product's id, or undefined when no product is loaded. Defensive: a
 * fresh workspace may have no active product. */
function activeProductId(store: UPGFileStore): string | undefined {
  try {
    return store.getDocument()?.product?.id
  } catch {
    return undefined
  }
}

/**
 * Define a canonical shared entity in the portfolio registry. The registry is
 * the single authoritative definition that product instances link to via
 * `register_instance`. A canonical entity is a normal node (no special type);
 * it simply lives in the `registry` section of `.upg/portfolio.upg`.
 *
 * Parameters:
 * - `type` (required): a canonical UPG entity type (e.g. `persona`, `metric`,
 *   `competitor`, `market_segment`). Must be an active (non-deprecated) type.
 * - `title` (required): the canonical name.
 * - `description`, `properties`, `tags`: optional, stored as-is.
 * - `canonical_id`: optional explicit id; otherwise derived from type + title
 *   (e.g. `persona_developer`). Must be unique within the registry.
 *
 * Creates the portfolio document if it does not exist (the registry is a
 * portfolio-tier concept). Requires a workspace (`init_workspace`).
 *
 * @returns JSON: `{ canonical, qualified_id, portfolio_file }`.
 * @atomicity non-atomic. Portfolio file create (if new) + registry append.
 * @see register_instance
 * @see list_registry
 */
export const defineCanonicalEntity: ToolHandler = async (args): Promise<ToolResult> => {
  const type = args.type as string | undefined
  const title = args.title as string | undefined
  if (!type) return textError('Missing required parameter: type')
  if (!title) return textError('Missing required parameter: title')
  if (!UPG_TYPES_SET.has(type)) {
    return textError(
      `Invalid entity type: "${type}". A canonical entity must be an active UPG type ` +
      `(e.g. persona, metric, competitor, market_segment). See list_entity_types.`,
    )
  }

  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) {
    return textError('No workspace found. Run `init_workspace` first to host a portfolio registry.')
  }

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  const taken = new Set(portfolioStore.listRegistryNodes().map((n) => n.id))
  const explicitId = (args.canonical_id as string | undefined)?.trim()
  if (explicitId && taken.has(explicitId)) {
    return textError(`Registry already has a canonical entity with id "${explicitId}".`)
  }
  const id = explicitId || deriveCanonicalId(type, title, taken)

  const node: UPGBaseNode = { id, type: type as UPGBaseNode['type'], title }
  if (args.description) node.description = args.description as string
  if (Array.isArray(args.tags)) node.tags = args.tags as string[]
  if (args.properties && typeof args.properties === 'object') {
    node.properties = args.properties as Record<string, unknown>
  }

  try {
    portfolioStore.addRegistryNode(node)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write canonical entity: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        canonical: node,
        qualified_id: `${REGISTRY_PRODUCT_ID}/${id}`,
        portfolio_file: path.relative(cwd, portfolioPath),
      },
      null,
      2,
    ),
  )
}

/** Resolve a source product node's `{ product_id, node_id, type, title }`. */
async function resolveSourceNode(
  cwd: string,
  activeStore: UPGFileStore,
  nodeIdArg: string,
  sourceProductIdArg: string | undefined,
): Promise<
  | { ok: true; productId: string; nodeId: string; type: string; title: string }
  | { ok: false; error: string }
> {
  let productId: string
  let bareNodeId: string
  if (nodeIdArg.includes('/')) {
    const [p, ...rest] = nodeIdArg.split('/')
    productId = p!
    bareNodeId = rest.join('/')
  } else {
    bareNodeId = nodeIdArg
    if (sourceProductIdArg) {
      productId = sourceProductIdArg
    } else {
      const activeId = activeProductId(activeStore)
      if (!activeId) {
        return {
          ok: false,
          error:
            `node_id "${nodeIdArg}" is a bare id and no active product is loaded. ` +
            `Pass a qualified id ({product_id}/{node_id}) or source_product_id.`,
        }
      }
      productId = activeId
    }
  }

  // Active product → read the live store (sees unflushed edits). Otherwise load
  // the product file read-only just to resolve the node's type + title.
  const activeId = activeProductId(activeStore)
  let node: UPGBaseNode | undefined
  if (activeId && productId === activeId) {
    node = activeStore.getNode(bareNodeId)
  } else {
    const found = findProductFileById(cwd, productId)
    if (!found) {
      return { ok: false, error: `Product "${productId}" not found in the workspace.` }
    }
    const ro = new UPGFileStore()
    try {
      await ro.loadReadOnly(path.join(cwd, found.file_path))
    } catch (err) {
      return { ok: false, error: `Failed to read product "${productId}": ${(err as Error).message}` }
    }
    node = ro.getNode(bareNodeId)
  }

  if (!node) {
    return { ok: false, error: `Node "${bareNodeId}" not found in product "${productId}".` }
  }
  return { ok: true, productId, nodeId: bareNodeId, type: node.type, title: node.title }
}

/**
 * Register a product node as an instance of a canonical registry entity by
 * creating an `instance_of` cross-edge (product entity → `registry/{id}`). This
 * is the only path that creates `instance_of` edges; it enforces the registry's
 * rules that the generic `create_cross_product_edge` cannot:
 *   - the canonical must exist in the registry,
 *   - the instance and canonical must share a type (same-type constraint).
 *
 * Parameters:
 * - `node_id` (required): the product instance. A bare id resolves against the
 *   active product (or `source_product_id`); a qualified `{product_id}/{node_id}`
 *   may target any workspace product.
 * - `canonical_id` (required): the registry node id (bare, or `registry/{id}`).
 * - `source_product_id`: qualifies a bare `node_id` when the instance is not in
 *   the active product.
 *
 * @returns JSON: `{ edge, instance, canonical, portfolio_file, already_existed? }`.
 * @atomicity non-atomic. Edge append to the portfolio document.
 * @see define_canonical_entity
 * @see list_registry
 */
export const registerInstance: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const nodeIdArg = args.node_id as string | undefined
  const canonicalArg = args.canonical_id as string | undefined
  if (!nodeIdArg) return textError('Missing required parameter: node_id (the product instance)')
  if (!canonicalArg) return textError('Missing required parameter: canonical_id (the registry entity)')

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError(
      'No portfolio document found. Define a canonical entity first with `define_canonical_entity`.',
    )
  }

  const canonicalId = bareCanonicalId(canonicalArg)
  const canonical = portfolioStore.getRegistryNode(canonicalId)
  if (!canonical) {
    return textError(
      `Canonical entity "${canonicalId}" not found in the registry. ` +
      `Define it first with \`define_canonical_entity\`, or check \`list_registry\`.`,
    )
  }

  const source = await resolveSourceNode(
    cwd,
    ctx.store,
    nodeIdArg,
    args.source_product_id as string | undefined,
  )
  if (!source.ok) return textError(source.error)

  // Same-type constraint: a persona instance_of a persona, a metric of a metric.
  if (source.type !== canonical.type) {
    return textError(
      `Type mismatch: instance "${source.nodeId}" is a ${source.type}, but canonical ` +
      `"${canonicalId}" is a ${canonical.type}. instance_of requires the same type on both ends.`,
    )
  }

  const qualifiedSource = `${source.productId}/${source.nodeId}`
  const qualifiedTarget = `${REGISTRY_PRODUCT_ID}/${canonicalId}`

  // Idempotent: an identical instance_of edge already present is returned, not
  // duplicated (migrations and re-runs stay clean).
  const existing = portfolioStore
    .getAllCrossEdges()
    .find(
      (e) => e.type === 'instance_of' && e.source === qualifiedSource && e.target === qualifiedTarget,
    )
  if (existing) {
    return text(
      JSON.stringify(
        {
          edge: existing,
          instance: { product_id: source.productId, node_id: source.nodeId, type: source.type, title: source.title },
          canonical: { id: canonicalId, type: canonical.type, title: canonical.title },
          portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
          already_existed: true,
        },
        null,
        2,
      ),
    )
  }

  const edge: UPGCrossEdge = {
    id: edgeId(),
    source: qualifiedSource,
    target: qualifiedTarget,
    type: 'instance_of',
    source_product_id: source.productId,
    target_product_id: REGISTRY_PRODUCT_ID,
  }

  try {
    portfolioStore.addCrossEdge(edge)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write instance_of edge: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        edge,
        instance: { product_id: source.productId, node_id: source.nodeId, type: source.type, title: source.title },
        canonical: { id: canonicalId, type: canonical.type, title: canonical.title },
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * List the canonical shared entities in the portfolio registry.
 *
 * Parameters:
 * - `type`: filter to one entity type (e.g. `persona`).
 * - `include_instances`: when true, attach each canonical's product instances
 *   (the `instance_of` edges pointing at it).
 *
 * @returns JSON: `{ registry: Array<{ id, type, title, description?,
 *   audience_role?, instance_count?, instances? }>, total, by_type }`. Returns
 *   an empty registry when none exists yet.
 * @atomicity atomic (read-only).
 * @see define_canonical_entity
 * @see register_instance
 */
export const listRegistry: ToolHandler = async (args): Promise<ToolResult> => {
  const cwd = process.cwd()
  const typeFilter = args.type as string | undefined
  const includeInstances = (args.include_instances as boolean) ?? false

  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ registry: [], total: 0, by_type: {} }, null, 2))
  }

  const nodes = portfolioStore.listRegistryNodes(typeFilter)
  const crossEdges = portfolioStore.getAllCrossEdges()

  const byType: Record<string, number> = {}
  const rows = nodes.map((n) => {
    byType[n.type] = (byType[n.type] ?? 0) + 1
    const row: Record<string, unknown> = { id: n.id, type: n.type, title: n.title }
    if (n.description) row.description = n.description
    const audienceRole = (n.properties as Record<string, unknown> | undefined)?.audience_role
    if (audienceRole) row.audience_role = audienceRole
    const target = `${REGISTRY_PRODUCT_ID}/${n.id}`
    const instances = crossEdges.filter((e) => e.type === 'instance_of' && e.target === target)
    row.instance_count = instances.length
    if (includeInstances) {
      row.instances = instances.map((e) => ({ source: e.source, product_id: e.source_product_id }))
    }
    return row
  })

  return text(
    JSON.stringify({ registry: rows, total: rows.length, by_type: byType }, null, 2),
  )
}
