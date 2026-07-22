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
import * as fs from 'node:fs'
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { findWorkspaceUpgFiles } from './workspace.js'
import {
  UPGFileStore,
  edgeId,
  resolvePortfolioPath,
  openPortfolioStoreIfExists,
} from '@unified-product-graph/sdk'
import { UPGPortfolioStore } from '@unified-product-graph/sdk'
import {
  UPG_TYPES_SET,
  UPG_EDGE_CATALOG,
  REGISTRY_PRODUCT_ID,
  generateSlug,
  type UPGBaseNode,
  type UPGCrossEdge,
  type UPGEdge,
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

/**
 * Locate a workspace product file by its `product.id`, using the same discovery
 * as `list_local_products` / the cross-product-edge writer (`findWorkspaceUpgFiles`:
 * root + immediate subdirs + `.upg/workspace.json`-registered paths at any depth).
 *
 * The SDK's `findProductFileById` only flat-scans `.upg/`, so `register_instance`
 * could not resolve a node living in a subdir- or workspace.json-registered product
 * even though `list_local_products` listed it (the cross-edge writer never tripped
 * on this because it only needs the product *id*, not the node). Matching the
 * workspace-wide discovery makes cross-product `instance_of` registration work in
 * one batch across every graph in the workspace.
 */
function findWorkspaceProductFileById(
  cwd: string,
  productId: string,
): { file_path: string; title: string } | null {
  for (const abs of findWorkspaceUpgFiles(cwd)) {
    try {
      const doc = JSON.parse(fs.readFileSync(abs, 'utf-8')) as { product?: { id?: string; title?: string } }
      if (doc.product?.id === productId) {
        return { file_path: path.relative(cwd, abs), title: doc.product.title ?? path.basename(abs) }
      }
    } catch {
      // malformed / unreadable .upg — skip
    }
  }
  return null
}

/** Resolve a source product node's `{ product_id, node_id, type, title }`. */
async function resolveSourceNode(
  cwd: string,
  activeStore: UPGFileStore,
  nodeIdArg: string,
  sourceProductIdArg: string | undefined,
): Promise<
  | { ok: true; productId: string; nodeId: string; type: string; title: string; node: UPGBaseNode }
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
    const found = findWorkspaceProductFileById(cwd, productId)
    if (!found) {
      return { ok: false, error: `Product "${productId}" not found in the workspace. Check \`list_local_products\` for the available product ids.` }
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
  return { ok: true, productId, nodeId: bareNodeId, type: node.type, title: node.title, node }
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
  const aliasArg = args.alias as boolean | undefined
  if (existing) {
    // Re-registering is a no-op for the edge, but `alias` can be toggled on an
    // existing instance_of to sanction (or un-sanction) a deliberate title divergence.
    let aliasUpdated = false
    if (aliasArg !== undefined && (existing.alias ?? false) !== aliasArg) {
      if (aliasArg) existing.alias = true
      else delete existing.alias
      portfolioStore.markDirty()
      await portfolioStore.flush()
      aliasUpdated = true
    }
    return text(
      JSON.stringify(
        {
          edge: existing,
          instance: { product_id: source.productId, node_id: source.nodeId, type: source.type, title: source.title },
          canonical: { id: canonicalId, type: canonical.type, title: canonical.title },
          portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
          already_existed: true,
          alias_updated: aliasUpdated,
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
  // `alias: true` marks a sanctioned title divergence (registry drift ignores it).
  if (aliasArg === true) edge.alias = true

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

/**
 * Edit a canonical registry entity in place (title / description / audience_role
 * / tags / properties). Properties are shallow-merged, so a partial patch keeps
 * the rest. Crucially, editing the canonical does NOT disturb any `instance_of`
 * edges pointing at it — every instance stays linked. This is the fix for a
 * canonical seeded with a typo or placeholder: correct it via the API instead of
 * hand-editing `portfolio.upg`.
 *
 * Parameters:
 * - `canonical_id` (required): the registry node id (bare or `registry/{id}`).
 * - `title`, `description`, `tags`, `properties`, `audience_role`: at least one
 *   required. `audience_role` is merged into `properties`.
 *
 * @returns JSON: `{ canonical, qualified_id, instance_count, portfolio_file }`.
 * @atomicity non-atomic. In-place registry node patch + flush.
 * @see define_canonical_entity
 */
export const updateCanonicalEntity: ToolHandler = async (args): Promise<ToolResult> => {
  const canonicalArg = args.canonical_id as string | undefined
  if (!canonicalArg) return textError('Missing required parameter: canonical_id')

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError('No portfolio document found. Define a canonical entity first with `define_canonical_entity`.')
  }

  const canonicalId = bareCanonicalId(canonicalArg)
  if (!portfolioStore.getRegistryNode(canonicalId)) {
    return textError(`Canonical entity "${canonicalId}" not found in the registry. See \`list_registry\`.`)
  }

  const patch: { title?: string; description?: string; tags?: string[]; properties?: Record<string, unknown> } = {}
  if (args.title !== undefined) patch.title = args.title as string
  if (args.description !== undefined) patch.description = args.description as string
  if (Array.isArray(args.tags)) patch.tags = args.tags as string[]
  const props: Record<string, unknown> = {}
  if (args.properties && typeof args.properties === 'object') Object.assign(props, args.properties)
  if (args.audience_role !== undefined) props.audience_role = args.audience_role
  if (Object.keys(props).length > 0) patch.properties = props
  if (Object.keys(patch).length === 0) {
    return textError('Nothing to update: pass at least one of title, description, audience_role, tags, properties.')
  }

  const updated = portfolioStore.updateRegistryNode(canonicalId, patch)
  await portfolioStore.flush()

  const target = `${REGISTRY_PRODUCT_ID}/${canonicalId}`
  const instanceCount = portfolioStore.getAllCrossEdges().filter((e) => e.type === 'instance_of' && e.target === target).length

  return text(
    JSON.stringify(
      {
        canonical: updated,
        qualified_id: target,
        instance_count: instanceCount,
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * Batch-create canonical registry entities in one atomic call (the migration
 * counterpart to `define_canonical_entity`). Validates every entity up front
 * (valid type, unique id within the batch and against the existing registry),
 * then writes all and flushes once — so a registry stand-up is a handful of
 * batches, not one call per canonical.
 *
 * Parameters:
 * - `entities` (required): array (max 50) of `{ type, title, canonical_id?,
 *   description?, tags?, properties? }` — same shape as `define_canonical_entity`.
 *
 * @returns JSON: `{ defined: [{ canonical_id, qualified_id, type, title }], count, portfolio_file }`.
 * @atomicity validate-all-then-write. A single invalid entity rejects the whole batch.
 * @see define_canonical_entity
 */
export const batchDefineCanonicalEntity: ToolHandler = async (args): Promise<ToolResult> => {
  const entities = args.entities as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(entities) || entities.length === 0) {
    return textError('Missing required parameter: entities (a non-empty array)')
  }
  if (entities.length > 50) return textError('Batch limit is 50 entities per call.')

  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) return textError('No workspace found. Run `init_workspace` first to host a portfolio registry.')

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  // Validate all up front (atomic): types valid, ids unique vs registry + within batch.
  const taken = new Set(portfolioStore.listRegistryNodes().map((n) => n.id))
  const planned: UPGBaseNode[] = []
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!
    const type = e.type as string | undefined
    const title = e.title as string | undefined
    if (!type) return textError(`entities[${i}]: missing required field: type`)
    if (!title) return textError(`entities[${i}]: missing required field: title`)
    if (!UPG_TYPES_SET.has(type)) {
      return textError(`entities[${i}]: invalid entity type "${type}". See list_entity_types.`)
    }
    const explicitId = (e.canonical_id as string | undefined)?.trim()
    if (explicitId && taken.has(explicitId)) {
      return textError(`entities[${i}]: registry already has a canonical entity with id "${explicitId}".`)
    }
    const id = explicitId || deriveCanonicalId(type, title, taken)
    taken.add(id)
    const node: UPGBaseNode = { id, type: type as UPGBaseNode['type'], title }
    if (e.description) node.description = e.description as string
    if (Array.isArray(e.tags)) node.tags = e.tags as string[]
    if (e.properties && typeof e.properties === 'object') node.properties = e.properties as Record<string, unknown>
    planned.push(node)
  }

  try {
    for (const node of planned) portfolioStore.addRegistryNode(node)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write canonical entities: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        defined: planned.map((n) => ({
          canonical_id: n.id,
          qualified_id: `${REGISTRY_PRODUCT_ID}/${n.id}`,
          type: n.type,
          title: n.title,
        })),
        count: planned.length,
        portfolio_file: path.relative(cwd, portfolioPath),
      },
      null,
      2,
    ),
  )
}

/**
 * Batch-register product instances against canonical entities in one atomic call
 * (the migration counterpart to `register_instance`). Validates every instance up
 * front (canonical exists, same-type constraint), then writes all `instance_of`
 * edges and flushes once. Per-instance idempotent: an already-linked instance is
 * reported, not duplicated. `alias` is honoured per instance.
 *
 * Parameters:
 * - `instances` (required): array (max 50) of `{ node_id, canonical_id,
 *   source_product_id?, alias? }`.
 *
 * @returns JSON: `{ results: [...], registered, already_existed, count, portfolio_file }`.
 * @atomicity validate-all-then-write. A single invalid instance rejects the whole batch.
 * @see register_instance
 */
export const batchRegisterInstance: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const instances = args.instances as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(instances) || instances.length === 0) {
    return textError('Missing required parameter: instances (a non-empty array)')
  }
  if (instances.length > 50) return textError('Batch limit is 50 instances per call.')

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError('No portfolio document found. Define a canonical entity first with `define_canonical_entity`.')
  }

  type Plan = {
    newEdge?: UPGCrossEdge
    existingRef?: UPGCrossEdge
    aliasArg?: boolean
    row: Record<string, unknown>
  }
  const plans: Plan[] = []

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!
    const nodeIdArg = inst.node_id as string | undefined
    const canonicalArg = inst.canonical_id as string | undefined
    if (!nodeIdArg) return textError(`instances[${i}]: missing required field: node_id`)
    if (!canonicalArg) return textError(`instances[${i}]: missing required field: canonical_id`)

    const canonicalId = bareCanonicalId(canonicalArg)
    const canonical = portfolioStore.getRegistryNode(canonicalId)
    if (!canonical) return textError(`instances[${i}]: canonical "${canonicalId}" not found in the registry.`)

    const source = await resolveSourceNode(cwd, ctx.store, nodeIdArg, inst.source_product_id as string | undefined)
    if (!source.ok) return textError(`instances[${i}]: ${source.error}`)
    if (source.type !== canonical.type) {
      return textError(
        `instances[${i}]: type mismatch — instance "${source.nodeId}" is a ${source.type}, ` +
        `canonical "${canonicalId}" is a ${canonical.type}.`,
      )
    }

    const qualifiedSource = `${source.productId}/${source.nodeId}`
    const qualifiedTarget = `${REGISTRY_PRODUCT_ID}/${canonicalId}`
    const aliasArg = inst.alias as boolean | undefined
    const existing = portfolioStore
      .getAllCrossEdges()
      .find((e) => e.type === 'instance_of' && e.source === qualifiedSource && e.target === qualifiedTarget)

    const baseRow = {
      source: qualifiedSource,
      target: qualifiedTarget,
      canonical_id: canonicalId,
    }
    if (existing) {
      plans.push({ existingRef: existing, aliasArg, row: { ...baseRow, already_existed: true } })
    } else {
      const newEdge: UPGCrossEdge = {
        id: edgeId(),
        source: qualifiedSource,
        target: qualifiedTarget,
        type: 'instance_of',
        source_product_id: source.productId,
        target_product_id: REGISTRY_PRODUCT_ID,
      }
      if (aliasArg === true) newEdge.alias = true
      plans.push({ newEdge, row: { ...baseRow, already_existed: false, aliased: aliasArg === true } })
    }
  }

  let registered = 0
  let alreadyExisted = 0
  try {
    for (const p of plans) {
      if (p.newEdge) {
        portfolioStore.addCrossEdge(p.newEdge)
        registered++
      } else if (p.existingRef) {
        alreadyExisted++
        if (p.aliasArg !== undefined && (p.existingRef.alias ?? false) !== p.aliasArg) {
          if (p.aliasArg) p.existingRef.alias = true
          else delete p.existingRef.alias
          portfolioStore.markDirty()
          // Signal that the idempotent re-register actually mutated the sanction,
          // so success is visible without a separate portfolio_validate (#32).
          p.row.alias_updated = true
        }
        // Always echo the resulting sanction state on an existing instance.
        p.row.aliased = p.existingRef.alias === true
      }
    }
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write instance_of edges: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        results: plans.map((p) => p.row),
        registered,
        already_existed: alreadyExisted,
        count: plans.length,
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * Promote an existing product node into the registry as its canonical — instead
 * of authoring a fresh, thinner canonical with `define_canonical_entity`. Copies
 * the source node's description / tags / properties into a new registry node, and
 * (by default) registers the source as the canonical's first instance via an
 * `instance_of` edge. Lets a team canonicalise the rich node they already curated.
 *
 * Parameters:
 * - `node_id` (required): the existing node (bare resolves against the active
 *   product or `source_product_id`; or qualified `{product_id}/{node_id}`).
 * - `source_product_id`: qualifies a bare `node_id`.
 * - `canonical_id`: optional explicit registry id (otherwise derived).
 * - `register_source`: register the source node as the first instance (default true).
 *
 * @returns JSON: `{ canonical, qualified_id, registered_source, edge?, portfolio_file }`.
 * @atomicity non-atomic. Registry node add (+ optional instance_of edge) + flush.
 * @see define_canonical_entity
 * @see register_instance
 */
export const promoteToCanonical: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const nodeIdArg = args.node_id as string | undefined
  if (!nodeIdArg) return textError('Missing required parameter: node_id (the existing node to promote)')
  const registerSource = (args.register_source as boolean | undefined) ?? true

  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) return textError('No workspace found. Run `init_workspace` first to host a portfolio registry.')

  const source = await resolveSourceNode(cwd, ctx.store, nodeIdArg, args.source_product_id as string | undefined)
  if (!source.ok) return textError(source.error)
  const srcNode = source.node

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
  const id = explicitId || deriveCanonicalId(srcNode.type, srcNode.title, taken)

  const canonical: UPGBaseNode = { id, type: srcNode.type, title: srcNode.title }
  if (srcNode.description) canonical.description = srcNode.description
  if (Array.isArray(srcNode.tags)) canonical.tags = [...srcNode.tags]
  if (srcNode.properties && typeof srcNode.properties === 'object') {
    canonical.properties = { ...(srcNode.properties as Record<string, unknown>) } as UPGBaseNode['properties']
  }

  let edge: UPGCrossEdge | undefined
  try {
    portfolioStore.addRegistryNode(canonical)
    if (registerSource) {
      edge = {
        id: edgeId(),
        source: `${source.productId}/${source.nodeId}`,
        target: `${REGISTRY_PRODUCT_ID}/${id}`,
        type: 'instance_of',
        source_product_id: source.productId,
        target_product_id: REGISTRY_PRODUCT_ID,
      }
      portfolioStore.addCrossEdge(edge)
    }
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to promote node to canonical: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        canonical,
        qualified_id: `${REGISTRY_PRODUCT_ID}/${id}`,
        registered_source: registerSource,
        edge,
        portfolio_file: path.relative(cwd, portfolioPath),
      },
      null,
      2,
    ),
  )
}

/**
 * Create a canonical-internal edge between two registry entities: the authoring
 * path for `registry.edges`. Canonical entities relate to one another (a registry
 * specification governed_by a registry organization, a primitive defined_by a
 * specification, a specification extends another specification). These edges live
 * in the portfolio registry and never touch product graphs.
 *
 * Validates what the registry requires and the generic edge tools cannot:
 *   - both endpoints already exist in the registry,
 *   - the type is a real UPG_EDGE_CATALOG edge,
 *   - the catalog source_type/target_type match the two registry nodes' types
 *     (so the edge is the canonical one for the pair).
 * Idempotent: an identical edge (same source/target/type) already present is
 * returned, not duplicated.
 *
 * Parameters:
 * - `source_id` (required): registry node id (bare or `registry/{id}`).
 * - `target_id` (required): registry node id (bare or `registry/{id}`).
 * - `type` (required): a catalog edge type whose endpoints match the two nodes.
 *
 * @returns JSON: `{ edge, source, target, portfolio_file, already_existed? }`.
 * @atomicity non-atomic. Registry edge append to the portfolio document.
 * @see define_canonical_entity
 * @see list_registry
 */
export const createRegistryEdge: ToolHandler = async (args): Promise<ToolResult> => {
  const sourceArg = args.source_id as string | undefined
  const targetArg = args.target_id as string | undefined
  const type = args.type as string | undefined
  if (!sourceArg) return textError('Missing required parameter: source_id (a registry entity)')
  if (!targetArg) return textError('Missing required parameter: target_id (a registry entity)')
  if (!type) return textError('Missing required parameter: type (a catalog edge type)')

  const def = (UPG_EDGE_CATALOG as Record<string, { source_type: string; target_type: string }>)[type]
  if (!def) {
    return textError(
      `Invalid edge type: "${type}". A registry edge must be a UPG_EDGE_CATALOG type ` +
      `(see list_edge_types or resolve_edge_for_pair).`,
    )
  }

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError(
      'No portfolio document found. Define the canonical entities first with `define_canonical_entity`.',
    )
  }

  const sourceId = bareCanonicalId(sourceArg)
  const targetId = bareCanonicalId(targetArg)
  const source = portfolioStore.getRegistryNode(sourceId)
  if (!source) {
    return textError(`Source "${sourceId}" not found in the registry. See \`list_registry\`.`)
  }
  const target = portfolioStore.getRegistryNode(targetId)
  if (!target) {
    return textError(`Target "${targetId}" not found in the registry. See \`list_registry\`.`)
  }

  // Endpoint types must match the catalog edge's declared source/target types,
  // so the registry edge is the canonical relationship for the pair.
  if (source.type !== def.source_type || target.type !== def.target_type) {
    return textError(
      `Type mismatch for "${type}": expects ${def.source_type} -> ${def.target_type}, but got ` +
      `${source.type} ("${sourceId}") -> ${target.type} ("${targetId}"). ` +
      `Use \`resolve_edge_for_pair\` to find the edge for this pair.`,
    )
  }

  // Idempotent: an identical registry edge already present is returned, not duplicated.
  const existing = portfolioStore
    .listRegistryEdges()
    .find((e) => e.type === type && e.source === sourceId && e.target === targetId)
  if (existing) {
    return text(
      JSON.stringify(
        {
          edge: existing,
          source: { id: sourceId, type: source.type, title: source.title },
          target: { id: targetId, type: target.type, title: target.title },
          portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
          already_existed: true,
        },
        null,
        2,
      ),
    )
  }

  const edge: UPGEdge = {
    id: edgeId(),
    source: sourceId,
    target: targetId,
    type: type as UPGEdge['type'],
  }

  try {
    portfolioStore.addRegistryEdge(edge)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write registry edge: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        edge,
        source: { id: sourceId, type: source.type, title: source.title },
        target: { id: targetId, type: target.type, title: target.title },
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * Everything in the portfolio document that references a canonical: the
 * `instance_of` cross-edges pointing at it, any OTHER cross-edges touching its
 * qualified id (area_serves_persona, classification edges, …), and the
 * registry-internal edges naming it as an endpoint. This is the blast radius a
 * delete must guard on and a merge must repoint.
 */
function collectCanonicalReferences(
  portfolioStore: UPGPortfolioStore,
  canonicalId: string,
): { instanceEdges: UPGCrossEdge[]; otherCrossEdges: UPGCrossEdge[]; registryEdges: UPGEdge[] } {
  const qualified = `${REGISTRY_PRODUCT_ID}/${canonicalId}`
  const instanceEdges: UPGCrossEdge[] = []
  const otherCrossEdges: UPGCrossEdge[] = []
  for (const e of portfolioStore.getAllCrossEdges()) {
    if (e.source !== qualified && e.target !== qualified) continue
    if (e.type === 'instance_of') instanceEdges.push(e)
    else otherCrossEdges.push(e)
  }
  const registryEdges = portfolioStore
    .listRegistryEdges()
    .filter((e) => e.source === canonicalId || e.target === canonicalId)
  return { instanceEdges, otherCrossEdges, registryEdges }
}

/**
 * Delete a canonical entity from the portfolio registry — the missing D in the
 * registry's CRUD (feedback 01b21402). Until now a canonical could be defined,
 * updated, and promoted-to, but never retired: an obsolete or twin canonical
 * lingered forever as a 0-instance orphan in `list_registry`, because
 * `delete_node` only sees the ACTIVE product and the registry lives in
 * `.upg/portfolio.upg`, which is not a product.
 *
 * Safe by default: refuses to delete a canonical that anything still references
 * (instance_of edges, area/classification cross-edges, registry-internal edges)
 * unless `cascade: true`, which deletes those references in the same flush.
 * `dry_run: true` previews the exact blast radius without writing. For twins
 * whose instances should SURVIVE under another canonical, use
 * `merge_canonical_entities` instead — delete+cascade severs instances; merge
 * repoints them.
 *
 * Parameters:
 * - `canonical_id` (required): the registry entity id (bare, or `registry/{id}`).
 * - `cascade`: also delete every referencing edge (default false).
 * - `dry_run`: preview the blast radius; nothing is written (default false).
 *
 * @returns JSON: `{ deleted, cascaded: { instance_of, cross_edges, registry_edges },
 *   portfolio_file }` — or `{ dry_run: true, would_delete, references }`.
 * @atomicity atomic. All removals land in one portfolio flush.
 * @see merge_canonical_entities
 * @see list_registry
 */
export const deleteCanonicalEntity: ToolHandler = async (args): Promise<ToolResult> => {
  const canonicalArg = args.canonical_id as string | undefined
  if (!canonicalArg) return textError('Missing required parameter: canonical_id')
  const cascade = (args.cascade as boolean | undefined) ?? false
  const dryRun = (args.dry_run as boolean | undefined) ?? false

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError('No portfolio document found. Nothing to delete; see `list_registry`.')
  }

  const canonicalId = bareCanonicalId(canonicalArg)
  const canonical = portfolioStore.getRegistryNode(canonicalId)
  if (!canonical) {
    return textError(`Canonical entity "${canonicalId}" not found in the registry. See \`list_registry\`.`)
  }

  const refs = collectCanonicalReferences(portfolioStore, canonicalId)
  const refCount = refs.instanceEdges.length + refs.otherCrossEdges.length + refs.registryEdges.length

  if (dryRun) {
    return text(
      JSON.stringify(
        {
          dry_run: true,
          would_delete: { id: canonical.id, type: canonical.type, title: canonical.title },
          references: {
            instance_of: refs.instanceEdges.map((e) => ({ id: e.id, source: e.source })),
            cross_edges: refs.otherCrossEdges.map((e) => ({ id: e.id, type: e.type, source: e.source, target: e.target })),
            registry_edges: refs.registryEdges.map((e) => ({ id: e.id, type: e.type, source: e.source, target: e.target })),
          },
          deletable_without_cascade: refCount === 0,
        },
        null,
        2,
      ),
    )
  }

  if (refCount > 0 && !cascade) {
    return textError(
      `Canonical "${canonicalId}" is still referenced: ${refs.instanceEdges.length} instance_of edge(s), ` +
        `${refs.otherCrossEdges.length} other cross-edge(s), ${refs.registryEdges.length} registry edge(s). ` +
        `Pass cascade: true to delete the references too (severing the instances), or use ` +
        `merge_canonical_entities to repoint the instances onto a surviving canonical first. ` +
        `Preview the blast radius with dry_run: true.`,
    )
  }

  try {
    for (const e of refs.instanceEdges) portfolioStore.removeCrossEdge(e.id)
    for (const e of refs.otherCrossEdges) portfolioStore.removeCrossEdge(e.id)
    for (const e of refs.registryEdges) portfolioStore.removeRegistryEdge(e.id)
    portfolioStore.removeRegistryNode(canonicalId)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to delete canonical entity: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        deleted: { id: canonical.id, type: canonical.type, title: canonical.title },
        cascaded: {
          instance_of: refs.instanceEdges.length,
          cross_edges: refs.otherCrossEdges.length,
          registry_edges: refs.registryEdges.length,
        },
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * Merge two or more canonical registry entities into one — the fix for twin
 * canonicals (feedback 01b21402: `persona_editor` + `persona_editor_2` created
 * across two canonicalization passes, every instance double-parented under
 * both). Deleting a twin severs its instances; merging repoints them.
 *
 * In one atomic portfolio flush, for each losing canonical:
 * 1. Repoint every cross-edge endpoint `registry/{loser}` → `registry/{keep}`.
 *    A repoint that would duplicate an existing edge (same source/target/type —
 *    the double-parented instance case) drops the loser's edge instead; a
 *    sanctioned `alias` on the dropped edge is preserved on the survivor.
 * 2. Repoint registry-internal edges the same way (self-loops and duplicates drop).
 * 3. Union the loser's description / tags / properties into the keeper's GAPS —
 *    the keeper always wins where both define a value.
 * 4. Delete the loser from the registry.
 *
 * All canonicals must share one entity type. `dry_run: true` previews the full
 * plan without writing.
 *
 * Parameters:
 * - `keep` (required): the surviving canonical id (bare, or `registry/{id}`).
 * - `merge` (required): 1–20 canonical ids to fold into `keep`.
 * - `dry_run`: preview the merge plan; nothing is written (default false).
 *
 * @returns JSON: `{ kept, merged, repointed_cross_edges, dropped_duplicate_edges,
 *   repointed_registry_edges, dropped_registry_edges, properties_added,
 *   portfolio_file }` — or the same shape under `dry_run: true`.
 * @atomicity atomic. Repoints, unions, and deletions land in one portfolio flush.
 * @see delete_canonical_entity
 * @see list_registry
 */
export const mergeCanonicalEntities: ToolHandler = async (args): Promise<ToolResult> => {
  const keepArg = args.keep as string | undefined
  if (!keepArg) return textError('Missing required parameter: keep (the surviving canonical id)')
  const mergeArg = args.merge as string[] | undefined
  if (!Array.isArray(mergeArg) || mergeArg.length === 0) {
    return textError('Missing required parameter: merge (a non-empty array of canonical ids to fold into keep)')
  }
  if (mergeArg.length > 20) return textError('Merge limit is 20 canonicals per call.')
  const dryRun = (args.dry_run as boolean | undefined) ?? false

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError('No portfolio document found. Nothing to merge; see `list_registry`.')
  }

  // ── Validate all up front (atomic) ─────────────────────────────────────────
  const keepId = bareCanonicalId(keepArg)
  const keeper = portfolioStore.getRegistryNode(keepId)
  if (!keeper) return textError(`Keep canonical "${keepId}" not found in the registry. See \`list_registry\`.`)

  const loserIds: string[] = []
  for (const raw of mergeArg) {
    const id = bareCanonicalId(String(raw))
    if (id === keepId) return textError(`"${id}" cannot appear in both keep and merge.`)
    if (loserIds.includes(id)) return textError(`Duplicate id in merge list: "${id}".`)
    const node = portfolioStore.getRegistryNode(id)
    if (!node) return textError(`Merge canonical "${id}" not found in the registry. See \`list_registry\`.`)
    if (node.type !== keeper.type) {
      return textError(
        `Type mismatch: keep "${keepId}" is a ${keeper.type}, but merge candidate "${id}" is a ${node.type}. ` +
          `Merging is only defined within one entity type.`,
      )
    }
    loserIds.push(id)
  }

  // ── Plan (computed fully before any mutation) ──────────────────────────────
  const keepQualified = `${REGISTRY_PRODUCT_ID}/${keepId}`
  type CrossPlan =
    | { action: 'repoint'; edge: UPGCrossEdge; source: string; target: string }
    | { action: 'drop_duplicate'; edge: UPGCrossEdge; survivor: UPGCrossEdge }
  const crossPlans: CrossPlan[] = []
  type RegistryPlan = { action: 'repoint' | 'drop'; edge: UPGEdge; source?: string; target?: string; reason?: string }
  const registryPlans: RegistryPlan[] = []
  const propertiesAdded: Record<string, string[]> = {}
  const projectedKeeperProps: Record<string, unknown> = { ...((keeper.properties ?? {}) as Record<string, unknown>) }
  let projectedKeeperDescription = keeper.description
  const projectedKeeperTags = [...(keeper.tags ?? [])]

  // The edges that will exist after earlier plan steps apply — so a second
  // loser's repoint correctly collides with a first loser's repointed edge.
  const projected = portfolioStore.getAllCrossEdges().map((e) => ({ edge: e, source: e.source, target: e.target, dropped: false }))
  const projectedRegistry = portfolioStore.listRegistryEdges().map((e) => ({ edge: e, source: e.source, target: e.target, dropped: false }))

  for (const loserId of loserIds) {
    const loserQualified = `${REGISTRY_PRODUCT_ID}/${loserId}`

    for (const p of projected) {
      if (p.dropped) continue
      if (p.source !== loserQualified && p.target !== loserQualified) continue
      const newSource = p.source === loserQualified ? keepQualified : p.source
      const newTarget = p.target === loserQualified ? keepQualified : p.target
      const collision = projected.find(
        (q) => q !== p && !q.dropped && q.source === newSource && q.target === newTarget && q.edge.type === p.edge.type,
      )
      if (collision) {
        crossPlans.push({ action: 'drop_duplicate', edge: p.edge, survivor: collision.edge })
        p.dropped = true
      } else {
        crossPlans.push({ action: 'repoint', edge: p.edge, source: newSource, target: newTarget })
        p.source = newSource
        p.target = newTarget
      }
    }

    for (const p of projectedRegistry) {
      if (p.dropped) continue
      if (p.source !== loserId && p.target !== loserId) continue
      const newSource = p.source === loserId ? keepId : p.source
      const newTarget = p.target === loserId ? keepId : p.target
      if (newSource === newTarget) {
        registryPlans.push({ action: 'drop', edge: p.edge, reason: 'self_loop' })
        p.dropped = true
        continue
      }
      const collision = projectedRegistry.find(
        (q) => q !== p && !q.dropped && q.source === newSource && q.target === newTarget && q.edge.type === p.edge.type,
      )
      if (collision) {
        registryPlans.push({ action: 'drop', edge: p.edge, reason: 'duplicate' })
        p.dropped = true
      } else {
        registryPlans.push({ action: 'repoint', edge: p.edge, source: newSource, target: newTarget })
        p.source = newSource
        p.target = newTarget
      }
    }

    // Property/description/tags union — keeper wins, losers fill gaps only.
    // Track projected keeper state across losers so the preview matches the
    // sequential apply exactly (an earlier loser's fill closes a later one's gap).
    const loser = portfolioStore.getRegistryNode(loserId)!
    const gaps: string[] = []
    const loserProps = (loser.properties ?? {}) as Record<string, unknown>
    for (const key of Object.keys(loserProps)) {
      if (projectedKeeperProps[key] === undefined) {
        gaps.push(key)
        projectedKeeperProps[key] = loserProps[key]
      }
    }
    if (!projectedKeeperDescription && loser.description) {
      gaps.push('description')
      projectedKeeperDescription = loser.description
    }
    if (Array.isArray(loser.tags) && loser.tags.some((t) => !projectedKeeperTags.includes(t))) {
      gaps.push('tags')
      for (const t of loser.tags) if (!projectedKeeperTags.includes(t)) projectedKeeperTags.push(t)
    }
    if (gaps.length > 0) propertiesAdded[loserId] = gaps
  }

  const summary = {
    kept: { id: keeper.id, type: keeper.type, title: keeper.title },
    merged: loserIds,
    repointed_cross_edges: crossPlans.filter((p) => p.action === 'repoint').length,
    dropped_duplicate_edges: crossPlans.filter((p) => p.action === 'drop_duplicate').length,
    repointed_registry_edges: registryPlans.filter((p) => p.action === 'repoint').length,
    dropped_registry_edges: registryPlans.filter((p) => p.action === 'drop').length,
    properties_added: propertiesAdded,
  }

  if (dryRun) {
    return text(
      JSON.stringify(
        {
          dry_run: true,
          ...summary,
          plan: {
            cross_edges: crossPlans.map((p) =>
              p.action === 'repoint'
                ? { action: 'repoint', id: p.edge.id, type: p.edge.type, source: p.source, target: p.target }
                : { action: 'drop_duplicate', id: p.edge.id, type: p.edge.type, survivor: p.survivor.id },
            ),
            registry_edges: registryPlans.map((p) =>
              p.action === 'repoint'
                ? { action: 'repoint', id: p.edge.id, type: p.edge.type, source: p.source, target: p.target }
                : { action: 'drop', id: p.edge.id, type: p.edge.type, reason: p.reason },
            ),
          },
        },
        null,
        2,
      ),
    )
  }

  // ── Apply (in-place mutations + one flush) ─────────────────────────────────
  try {
    for (const p of crossPlans) {
      if (p.action === 'repoint') {
        p.edge.source = p.source
        p.edge.target = p.target
        // Repointing onto the keeper does not itself sanction a title divergence;
        // but if the loser's edge carried one, the instance's local title still
        // diverges from the KEEPER's title too or worse — keep the sanction.
      } else {
        if (p.edge.alias === true && p.survivor.alias !== true) p.survivor.alias = true
        portfolioStore.removeCrossEdge(p.edge.id)
      }
    }
    for (const p of registryPlans) {
      if (p.action === 'repoint') {
        p.edge.source = p.source!
        p.edge.target = p.target!
      } else {
        portfolioStore.removeRegistryEdge(p.edge.id)
      }
    }
    for (const loserId of loserIds) {
      const loser = portfolioStore.getRegistryNode(loserId)!
      const patch: { description?: string; tags?: string[]; properties?: Record<string, unknown> } = {}
      const keeperProps = (keeper.properties ?? {}) as Record<string, unknown>
      const fill: Record<string, unknown> = {}
      for (const [key, value] of Object.entries((loser.properties ?? {}) as Record<string, unknown>)) {
        if (keeperProps[key] === undefined) fill[key] = value
      }
      if (Object.keys(fill).length > 0) patch.properties = fill
      if (!keeper.description && loser.description) patch.description = loser.description
      if (Array.isArray(loser.tags) && loser.tags.length > 0) {
        const union = [...(keeper.tags ?? [])]
        for (const t of loser.tags) if (!union.includes(t)) union.push(t)
        if (union.length !== (keeper.tags ?? []).length) patch.tags = union
      }
      if (Object.keys(patch).length > 0) portfolioStore.updateRegistryNode(keepId, patch)
      portfolioStore.removeRegistryNode(loserId)
    }
    portfolioStore.markDirty()
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to merge canonical entities: ${(err as Error).message}`)
  }

  const target = keepQualified
  const instanceCount = portfolioStore
    .getAllCrossEdges()
    .filter((e) => e.type === 'instance_of' && e.target === target).length

  return text(
    JSON.stringify(
      {
        ...summary,
        kept: { ...summary.kept, instance_count: instanceCount },
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}
