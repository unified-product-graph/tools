/**
 * Workspace and portfolio tools: multi-product discovery, switching, init,
 * cross-product edges. Handlers touch the filesystem (cwd, .upg folder,
 * .mcp.json) and the workspace lib alongside the in-memory store.
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { edgeId } from '@unified-product-graph/sdk'
import type { UPGCrossEdge, UPGCrossEdgeType } from '@unified-product-graph/core'
import { UPG_CROSS_EDGE_TYPES } from '@unified-product-graph/core'
import { UPGPortfolioStore } from '@unified-product-graph/sdk'
import {
  resolvePortfolioPath,
  openPortfolioStoreIfExists,
  registerProductOnPortfolio,
  findProductFileById,
} from '@unified-product-graph/sdk'
import {
  createProduct,
  initWorkspace,
  InvalidProductNameError,
  InvalidProductStageError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotInitialisedError,
} from '@unified-product-graph/sdk'

/**
 * Find all `.upg` files in the current directory and its immediate
 * subdirectories. Skips dotfiles other than `.upg/`.
 *
 * @returns JSON: `{ products: Array<{ file, title, stage, nodes, edges }> }`.
 * @atomicity atomic (read-only)
 * @see switch_product
 * @see get_workspace_info
 */
export const listLocalProducts: ToolHandler = (_args, _ctx): ToolResult => {
  const cwd = process.cwd()
  const products: {
    file: string
    title: string
    stage: string
    nodes: number
    edges: number
  }[] = []

  const candidates: string[] = []
  const topEntries = fs.readdirSync(cwd, { withFileTypes: true })
  for (const entry of topEntries) {
    if (entry.isFile() && entry.name.endsWith('.upg')) {
      candidates.push(path.join(cwd, entry.name))
    } else if (entry.isDirectory() && (entry.name === '.upg' || !entry.name.startsWith('.'))) {
      try {
        const subEntries = fs.readdirSync(
          path.join(cwd, entry.name),
          { withFileTypes: true },
        )
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.upg')) {
            candidates.push(path.join(cwd, entry.name, sub.name))
          }
        }
      } catch {
        // permission error or similar; skip
      }
    }
  }

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const doc = JSON.parse(raw)
      products.push({
        file: path.relative(cwd, filePath),
        title: doc.product?.title ?? '(untitled)',
        stage: doc.product?.stage ?? 'unknown',
        nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
        edges: Array.isArray(doc.edges) ? doc.edges.length : 0,
      })
    } catch {
      // malformed JSON; skip
    }
  }

  return text(JSON.stringify({ products }, null, 2))
}

/**
 * Switch to a different `.upg` file without restarting the server. In
 * workspace mode, accepts a bare filename (e.g. `client-project` or
 * `client-project.upg`) and resolves against `.upg/`.
 *
 * @returns JSON: `{ message, file, product: { title, stage }, entities }`.
 * @throws Returns a textError when the file cannot be resolved or the load
 *   fails (file watcher / parse error).
 * @atomicity non-atomic. Flushes the current store, stops watching, and
 *   loads the new file as separate filesystem operations.
 * @warning Mutates server-side workspace state. After an MCP reconnect the
 *   server reverts to the workspace default. Call `get_workspace_info`
 *   before any read/mutation to confirm the active product.
 * @see get_workspace_info
 * @see list_local_products
 * @see init_workspace
 */
export const switchProduct: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const fileArg = args.file as string
  let resolved = path.resolve(fileArg)

  if (!fs.existsSync(resolved)) {
    const cwd = process.cwd()
    const workspaceCandidates = [
      path.join(cwd, '.upg', fileArg),
      path.join(cwd, '.upg', fileArg + '.upg'),
    ]
    const found = workspaceCandidates.find((c) => fs.existsSync(c))
    if (found) {
      resolved = found
    } else {
      return textError(
        `File not found: ${resolved} (also checked .upg/${fileArg} and .upg/${fileArg}.upg)`,
      )
    }
  }

  try {
    await store.flush()
    store.stopWatching()
    await store.load(resolved)

    const product = store.getProduct()
    const nodes = store.getAllNodes()
    return text(
      JSON.stringify(
        {
          message: `Switched to ${product.title}`,
          file: resolved,
          product: { title: product.title, stage: product.stage },
          entities: nodes.length,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    return textError(`Failed to switch: ${(err as Error).message}`)
  }
}

/**
 * Get information about the current UPG workspace: which product is loaded,
 * what other products are available, and which mode (`workspace` or
 * `single-file`) is active.
 *
 * @returns JSON: `{ mode, workspace_path?, current_product?, current_file?,
 *   products }`. The shape depends on whether `.upg/workspace.json` exists.
 * @atomicity atomic (read-only)
 * @see init_workspace
 */
export const getWorkspaceInfo: ToolHandler = async (_args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const cwd = process.cwd()
  const workspacePath = path.join(cwd, '.upg', 'workspace.json')
  const currentFile = store.getFilePath()

  try {
    const raw = await fsp.readFile(workspacePath, 'utf-8')
    const workspace = JSON.parse(raw)
    const currentBasename = path.basename(currentFile)

    const products = (
      workspace.products as Array<{
        file: string
        title: string
      }>
    ).map((p) => ({
      file: p.file,
      title: p.title,
      active: p.file === currentBasename,
    }))

    return text(
      JSON.stringify(
        {
          mode: 'workspace',
          workspace_path: '.upg/',
          current_product: currentBasename,
          products,
        },
        null,
        2,
      ),
    )
  } catch {
    const product = store.getProduct()
    return text(
      JSON.stringify(
        {
          mode: 'single-file',
          current_file: path.relative(cwd, currentFile) || path.basename(currentFile),
          products: [
            {
              file:
                path.relative(cwd, currentFile) ||
                path.basename(currentFile),
              title: product.title,
              active: true,
            },
          ],
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Initialize a UPG workspace: creates the `.upg/` folder and moves the
 * current `.upg` file into it. Enables multi-product management. Pair with
 * `create_product` and `switch_product` for portfolio flows.
 *
 * @returns JSON: `{ message, ...result }`. `result` carries the workspace
 *   path and the moved file's new location.
 * @throws Returns a textError when the workspace already exists
 *   (`WorkspaceAlreadyExistsError`) or another filesystem error occurs.
 * @atomicity non-atomic. The operation creates a directory and (optionally)
 *   moves a file as separate filesystem mutations.
 * @warning One-time setup operation. Idempotent failure on retry: if the
 *   workspace already exists, raises `WorkspaceAlreadyExistsError`. Pair
 *   with `get_workspace_info` to check state before re-running.
 * @see create_product
 * @see switch_product
 * @see get_workspace_info
 */
export const initWorkspaceTool: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  try {
    const result = await initWorkspace({
      cwd: process.cwd(),
      store,
      moveExisting: (args.move_existing as boolean) ?? true,
    })
    return text(
      JSON.stringify({ message: 'Workspace initialized', ...result }, null, 2),
    )
  } catch (err) {
    if (err instanceof WorkspaceAlreadyExistsError) {
      return textError(err.message)
    }
    return textError(
      `init_workspace failed: ${(err as Error).message}`,
    )
  }
}

/**
 * Create a new sibling `.upg` product in the current workspace. Mints a
 * canonical product id, writes the file, stamps integrity, registers in
 * `workspace.json`. When `portfolio_id` is supplied, also creates a
 * `portfolio_contains_product` edge in the current graph.
 *
 * @returns JSON: `{ message, ...result }`. `result` carries `id`, `title`,
 *   `slug`, `file_path`, and the optional portfolio edge.
 * @throws Returns a textError when the workspace is uninitialised
 *   (`WorkspaceNotInitialisedError`) or the name is invalid
 *   (`InvalidProductNameError`).
 * @atomicity non-atomic. File write + workspace.json patch + optional
 *   portfolio edge are separate mutations.
 * @see init_workspace
 */
export const createProductTool: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  try {
    const result = await createProduct({
      cwd: process.cwd(),
      store,
      name: args.name as string,
      slug: args.slug as string | undefined,
      description: args.description as string | undefined,
      stage: args.stage as never,
      portfolio_id: args.portfolio_id as string | undefined,
    })
    return text(
      JSON.stringify({ message: `Created product: ${result.title}`, ...result }, null, 2),
    )
  } catch (err) {
    if (
      err instanceof WorkspaceNotInitialisedError ||
      err instanceof InvalidProductNameError ||
      // non-canonical stage value rejected on write.
      err instanceof InvalidProductStageError
    ) {
      return textError(err.message)
    }
    return textError(`create_product failed: ${(err as Error).message}`)
  }
}

/**
 * List all portfolio entities from the portfolio document
 * (`.upg/portfolio.upg`). Portfolios represent the strategic axis (where we
 * invest) and live at the portfolio scope alongside product areas and the
 * organisation.
 *
 * Returns an empty list when no portfolio document exists yet.
 *
 * @returns JSON: `{ portfolios: Array<{ id, title, description?,
 *   parent_portfolio_id?, hierarchy_model?, products? }>, total }`.
 * @atomicity atomic (read-only)
 * @see create_cross_product_edge
 * @see get_organization
 */
export const listPortfolios: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
  if (!portfolioStore) {
    return text(JSON.stringify({ portfolios: [], total: 0 }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  const portfolios = doc?.portfolios ?? []
  const result = portfolios.map((pf) => {
    const row: Record<string, unknown> = { id: pf.id, title: pf.title }
    if (pf.description) row.description = pf.description
    if (pf.parent_portfolio_id !== undefined) row.parent_portfolio_id = pf.parent_portfolio_id
    if (pf.hierarchy_model) row.hierarchy_model = pf.hierarchy_model
    if (pf.products) row.products = pf.products
    return row
  })
  return text(JSON.stringify({ portfolios: result, total: result.length }, null, 2))
}

/**
 * Get the organisation that owns the current workspace's portfolio. Reads
 * `portfolio.upg.organization` (a singleton in the portfolio document).
 *
 * @returns JSON: `{ organization: UPGOrganization | null, portfolio_file? }`.
 *   Returns `{ organization: null }` when no portfolio document exists yet.
 * @atomicity atomic (read-only)
 * @see list_portfolios
 */
export const getOrganization: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return text(JSON.stringify({ organization: null }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  const portfolioPath = portfolioStore.getFilePath()
  return text(
    JSON.stringify(
      {
        organization: doc?.organization ?? null,
        ...(portfolioPath
          ? { portfolio_file: path.relative(cwd, portfolioPath) }
          : {}),
      },
      null,
      2,
    ),
  )
}

/**
 * Create a cross-product relationship between two entities in different
 * products within a portfolio. Writes to the portfolio document
 * (`.upg/portfolio.upg`) using qualified IDs (`{product_id}/{node_id}`),
 * not to the source product's `edges[]`.
 *
 * The portfolio document is created at `.upg/portfolio.upg` if it does not
 * exist yet. A workspace (`.upg/` directory with `workspace.json`) is
 * required (use `init_workspace` first).
 *
 * Parameters:
 * - `source_id`: Qualified source node ID, e.g. `{product_id}/{node_id}`.
 *   If a bare node ID is provided, `source_product_id` must also be supplied.
 * - `target_id`: Qualified target node ID. Same convention as `source_id`.
 * - `type`: Cross-product relationship type (see enum below).
 * - `source_product_id`: Product ID owning the source node. Used to qualify
 *   bare `source_id` if not already qualified.
 * - `target_product_id`: Product ID owning the target node. Used to qualify
 *   bare `target_id` if not already qualified.
 *
 * @returns JSON: `{ edge, portfolio_file }`.
 * @throws Returns a textError when parameters are missing or invalid, or
 *   when the workspace is not initialised.
 * @atomicity non-atomic. Portfolio file create (if new) + edge append are
 *   separate filesystem operations.
 * @see list_portfolios
 * @see list_portfolio_cross_edges
 * @see migrate_cross_edges
 */
export const createCrossProductEdge: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const sourceIdArg = args.source_id as string | undefined
  const targetIdArg = args.target_id as string | undefined
  const edgeTypeArg = args.type as string | undefined
  const sourceProductId = args.source_product_id as string | undefined
  const targetProductId = args.target_product_id as string | undefined

  if (!sourceIdArg) return textError('Missing required parameter: source_id')
  if (!targetIdArg) return textError('Missing required parameter: target_id')
  if (!edgeTypeArg) return textError('Missing required parameter: type')

  if (!UPG_CROSS_EDGE_TYPES.includes(edgeTypeArg as UPGCrossEdgeType)) {
    return textError(
      `Invalid cross-product edge type: ${edgeTypeArg}. ` +
      `Valid types: ${UPG_CROSS_EDGE_TYPES.join(', ')}`,
    )
  }

  // Qualify IDs; accept both bare IDs (with product context) and
  // pre-qualified `{product_id}/{node_id}` strings.
  let qualifiedSource: string
  if (sourceIdArg.includes('/')) {
    qualifiedSource = sourceIdArg
  } else if (sourceProductId) {
    qualifiedSource = `${sourceProductId}/${sourceIdArg}`
  } else {
    return textError(
      `source_id "${sourceIdArg}" is a bare node ID. ` +
      `Supply source_product_id to qualify it, or pass a qualified ID ({product_id}/{node_id}).`,
    )
  }

  let qualifiedTarget: string
  if (targetIdArg.includes('/')) {
    qualifiedTarget = targetIdArg
  } else if (targetProductId) {
    qualifiedTarget = `${targetProductId}/${targetIdArg}`
  } else {
    return textError(
      `target_id "${targetIdArg}" is a bare node ID. ` +
      `Supply target_product_id to qualify it, or pass a qualified ID ({product_id}/{node_id}).`,
    )
  }

  // Resolve portfolio path; requires a workspace
  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) {
    return textError(
      'No workspace found. Run `init_workspace` first to enable portfolio cross-product edges.',
    )
  }

  // Strict-by-default: refuse if no portfolio document exists yet. Cross-
  // product edges express portfolio-level decisions ("Product A shares
  // persona with Product B"). They should require a portfolio that
  // semantically contains both products. F7 (2026-05-20).
  const autoCreatePortfolio = (args.auto_create_portfolio as boolean | undefined) ?? false
  const portfolioExisted = fs.existsSync(portfolioPath)
  if (!portfolioExisted && !autoCreatePortfolio) {
    return textError(
      `No portfolio document found at .upg/portfolio.upg. ` +
      `Cross-product edges express portfolio-level relationships and should be anchored to a portfolio that contains both products. ` +
      `Either: (1) create a portfolio node first (\`create_node({type: "portfolio", title: "..."})\`) and link the products under it, ` +
      `or (2) pass \`auto_create_portfolio: true\` to create an empty portfolio document on the fly (legacy behaviour).`,
    )
  }

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  const derivedSourceProductId = sourceProductId ?? qualifiedSource.split('/')[0]
  const derivedTargetProductId = targetProductId ?? qualifiedTarget.split('/')[0]

  const newEdge: UPGCrossEdge = {
    id: edgeId(),
    source: qualifiedSource,
    target: qualifiedTarget,
    type: edgeTypeArg as UPGCrossEdgeType,
    source_product_id: derivedSourceProductId,
    target_product_id: derivedTargetProductId,
  }

  // Auto-register both products on portfolio.upg.products[]. Cross-
  // edges referring to products that aren't listed are still valid but harder
  // to follow; the registry gives a stable lookup table for tooling.
  const registeredProducts: Array<{ id: string; file_path?: string; title?: string }> = []
  const portfolioDoc = portfolioStore.getDocument()
  if (portfolioDoc) {
    for (const productId of [derivedSourceProductId, derivedTargetProductId]) {
      const lookup = findProductFileById(cwd, productId)
      const wasNew = registerProductOnPortfolio(portfolioDoc, {
        id: productId,
        ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}),
      })
      if (wasNew) {
        registeredProducts.push({
          id: productId,
          ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}),
        })
      }
    }
    if (registeredProducts.length > 0) portfolioStore.markDirty()
  }

  try {
    portfolioStore.addCrossEdge(newEdge)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write cross-product edge: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        edge: newEdge,
        portfolio_file: path.relative(cwd, portfolioPath),
        ...(registeredProducts.length > 0
          ? { registered_products: registeredProducts }
          : {}),
      },
      null,
      2,
    ),
  )
}

/**
 * List all cross-product edges in the portfolio document
 * (`.upg/portfolio.upg`). Returns an empty list if no portfolio exists yet.
 *
 * @returns JSON: `{ cross_edges: UPGCrossEdge[], total, portfolio_file? }`.
 * @atomicity atomic (read-only)
 * @see create_cross_product_edge
 */
export const listPortfolioCrossEdges: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) {
    return text(
      JSON.stringify({ cross_edges: [], total: 0, note: 'No workspace found.' }, null, 2),
    )
  }

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  const edges = portfolioStore.getAllCrossEdges()
  return text(
    JSON.stringify(
      {
        cross_edges: edges,
        total: edges.length,
        portfolio_file: path.relative(cwd, portfolioPath),
      },
      null,
      2,
    ),
  )
}

/**
 * Migrate inline cross-product edges from the currently-loaded product
 * document into the portfolio document (`.upg/portfolio.upg`).
 *
 * This is the Phase 2 migration tool for. Existing graphs that stored
 * cross-product edges directly in a product's `edges[]` (the old broken
 * behaviour) can be corrected without data loss.
 *
 * Operation:
 * 1. Scans the current product's `edges[]` for edges whose type is one of the
 *    six cross-product types.
 * 2. Converts them to `UPGCrossEdge` objects with qualified IDs
 *    (`{product_id}/{node_id}`).
 * 3. In dry-run mode (`dry_run: true`, the default): reports what would be
 *    migrated without writing anything.
 * 4. In live mode (`dry_run: false`): writes the edges to the portfolio
 *    document, removes them from the current product's `edges[]`, and saves
 *    both files.
 *
 * Parameters:
 * - `source_product_id` (required): The product ID that owns the current
 *   document's nodes. Used to build the qualified source IDs.
 * - `target_product_id` (optional): The product ID that owns the target nodes.
 *   If the target node is not found in the current product, this ID is used to
 *   qualify the target. Edges without a resolvable target product are skipped.
 * - `dry_run` (optional, default `true`): When true, reports without writing.
 *
 * @returns JSON: `{ migrated, skipped, dry_run, portfolio_file? }`.
 * @throws Returns a textError when `source_product_id` is missing or when the
 *   workspace is not initialised (in non-dry-run mode).
 * @atomicity non-atomic. Portfolio write + product file save are separate.
 * @warning Default is `dry_run: true`. Pass `dry_run: false` to commit. Idempotent
 *   on retry: a second `dry_run: false` after a successful migration finds zero
 *   inline cross-edges and reports `migrated: []`.
 * @see create_cross_product_edge
 * @see list_portfolio_cross_edges
 * @see list_cross_edge_types
 * @see init_workspace
 */
export const migrateCrossEdges: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const sourceProductId = args.source_product_id as string | undefined
  const targetProductId = (args.target_product_id as string | undefined) ?? null
  const dryRun = (args.dry_run as boolean | undefined) ?? true

  if (!sourceProductId) {
    return textError('Missing required parameter: source_product_id')
  }

  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)

  if (!portfolioPath && !dryRun) {
    return textError(
      'No workspace found. Run `init_workspace` first to enable portfolio cross-product edge migration.',
    )
  }

  const portfolioStore = new UPGPortfolioStore()
  if (portfolioPath) {
    try {
      await portfolioStore.loadOrInit(portfolioPath)
    } catch (err) {
      return textError(`Failed to load portfolio document: ${(err as Error).message}`)
    }
  }

  // Access the live document through the store so mutations are reflected
  const doc = store.getDocument()

  const result = portfolioStore.migrateCrossEdgesFromDoc(
    doc,
    sourceProductId,
    targetProductId,
    dryRun,
  )

  if (!dryRun && result.migrated.length > 0) {
    // migrateCrossEdgesFromDoc mutates doc.edges in-place but cannot set the
    // store's dirty flag. Mark the store dirty so flush() actually writes.
    store.markDirty()
    // Flush portfolio first, then flush the product store
    if (portfolioPath) await portfolioStore.flush()
    await store.flush()
  }

  return text(
    JSON.stringify(
      {
        ...result,
        ...(portfolioPath
          ? { portfolio_file: path.relative(cwd, portfolioPath) }
          : { portfolio_file: null }),
      },
      null,
      2,
    ),
  )
}

export type { ToolContext }
