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
  attachProductToPortfolio,
  detachProductFromPortfolio,
  deleteCrossProductEdge,
} from '@unified-product-graph/sdk'
import {
  createProduct,
  updateProduct,
  initWorkspace,
  InvalidProductNameError,
  InvalidProductStageError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotInitialisedError,
} from '@unified-product-graph/sdk'
import { coerceProductStage } from '@unified-product-graph/core'

/**
 * True only when `p` exists AND is a regular file. Used by `switch_product`
 * resolution so a directory whose name collides with a bare product name
 * (e.g. a `sanity/` source dir vs `.upg/sanity.upg`) never satisfies
 * resolution — the old `fs.existsSync` check matched the directory and then
 * `store.load` threw `EISDIR` (UPG batch-3 #12). Follows symlinks (a symlink
 * to a file is a file).
 */
function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Discover every `.upg` file in the workspace: the project root plus its
 * immediate subdirectories (including `.upg/`). Skips dotfiles other than
 * `.upg/`. Returns absolute paths. Shared by `list_local_products` and the
 * portfolio read layer (`portfolio_query` / `portfolio_digest`) so product
 * discovery stays consistent across them. (batch-3 #13)
 */
export function findWorkspaceUpgFiles(cwd: string): string[] {
  const candidates: string[] = []
  let topEntries: fs.Dirent[]
  try {
    topEntries = fs.readdirSync(cwd, { withFileTypes: true })
  } catch {
    return candidates
  }
  for (const entry of topEntries) {
    if (entry.isFile() && entry.name.endsWith('.upg')) {
      candidates.push(path.join(cwd, entry.name))
    } else if (entry.isDirectory() && (entry.name === '.upg' || !entry.name.startsWith('.'))) {
      try {
        const subEntries = fs.readdirSync(path.join(cwd, entry.name), { withFileTypes: true })
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
  return candidates
}

/**
 * Find all `.upg` files in the current directory and its immediate
 * subdirectories. Skips dotfiles other than `.upg/`.
 *
 * @returns JSON: `{ products: Array<{ file, title, stage, nodes, edges }> }`.
 *   `stage` is the CANONICAL UPGProductStage (legacy values like `idea` are
 *   coerced to `concept`), or `null` when unset — matching what
 *   `get_product_context` reports for the same product ( / DT-MCP-3).
 * @atomicity atomic (read-only)
 * @see switch_product
 * @see get_workspace_info
 */
export const listLocalProducts: ToolHandler = (_args, _ctx): ToolResult => {
  const cwd = process.cwd()
  const products: {
    id: string | null
    file: string
    title: string
    stage: string | null
    nodes: number
    edges: number
    areas?: string[]
    portfolios?: string[]
  }[] = []

  // Build a product-id → membership map from portfolio.upg so callers can see which
  // area/portfolio each product sits in without a second round-trip ( §11a).
  // Best-effort: absent in single-file or pre-portfolio workspaces.
  const membership = new Map<string, { areas: string[]; portfolios: string[] }>()
  try {
    const pdoc = JSON.parse(fs.readFileSync(path.join(cwd, '.upg', 'portfolio.upg'), 'utf-8')) as {
      product_areas?: Array<{ id: string; title?: string; products?: string[] }>
      portfolios?: Array<{ id: string; title?: string; products?: string[] }>
    }
    for (const area of pdoc.product_areas ?? []) {
      for (const pid of area.products ?? []) {
        const m = membership.get(pid) ?? { areas: [], portfolios: [] }
        m.areas.push(area.title ?? area.id)
        membership.set(pid, m)
      }
    }
    for (const pf of pdoc.portfolios ?? []) {
      for (const pid of pf.products ?? []) {
        const m = membership.get(pid) ?? { areas: [], portfolios: [] }
        m.portfolios.push(pf.title ?? pf.id)
        membership.set(pid, m)
      }
    }
  } catch {
    // no portfolio.upg / unreadable — products listed without membership
  }

  const candidates = findWorkspaceUpgFiles(cwd)

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const doc = JSON.parse(raw)
      // Skip non-product docs: portfolio.upg has no `product` header (it carries
      // organization / product_areas / portfolios) and is not a product. §11a.
      if (!doc.product) continue
      // Coerce the raw on-disk stage to canonical (same rule the store applies
      // at load) so this read agrees with get_product_context. Unknown / unset
      // → null (not the old "unknown" sentinel) to match the context tool.
      const coerced = coerceProductStage(doc.product?.stage)
      const pid = (doc.product?.id as string | undefined) ?? null
      const m = pid ? membership.get(pid) : undefined
      products.push({
        id: pid,
        file: path.relative(cwd, filePath),
        title: doc.product?.title ?? '(untitled)',
        stage: coerced.canonical ?? null,
        nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
        edges: Array.isArray(doc.edges) ? doc.edges.length : 0,
        ...(m && m.areas.length > 0 ? { areas: m.areas } : {}),
        ...(m && m.portfolios.length > 0 ? { portfolios: m.portfolios } : {}),
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
 * Accepts `file` (canonical) or its alias `product`.
 *
 * @returns JSON: `{ message, file, product: { title, stage }, entities }`.
 * @throws Returns a textError when neither `file` nor `product` is provided, or
 *   the file cannot be resolved, or the load fails (file watcher / parse error).
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
  // N2 (UPG QA 0.8.7): accept `product` as an alias for `file`. `file` is the
  // canonical key, but a bare product name reads naturally as `product`, and
  // that was the first guess. Validate presence BEFORE path.resolve so a missing
  // value yields a named-key error instead of leaking the internal
  // `paths[0] must be of type string` from node:path.
  const fileArg = (args.file ?? args.product) as string | undefined
  if (typeof fileArg !== 'string' || fileArg.length === 0) {
    return textError('Missing required parameter: file (alias: product). Pass a .upg path or a bare product name.')
  }

  // Resolve the target to an existing FILE. Order matters: a bare product name
  // ("sanity") must anchor to the workspace `.upg/` directory FIRST, before the
  // cwd-relative resolution — otherwise a same-named sibling in the project root
  // (e.g. a `sanity/` source directory) shadows `.upg/sanity.upg`. The old code
  // gated the `.upg/` fallback on `!fs.existsSync(resolved)`, so a bare name that
  // collided with a *directory* skipped the fallback and `store.load`-ed the
  // directory itself → `EISDIR`. We now (a) try workspace `.upg/` candidates
  // first and (b) require each candidate to be a regular file, so a directory
  // never satisfies resolution. Explicit paths (`.upg/foo.upg`, absolute) still
  // resolve via the `direct` candidates. (UPG batch-3 #12.)
  const cwd = process.cwd()
  const direct = path.resolve(fileArg)
  const candidates = [
    path.join(cwd, '.upg', fileArg),
    path.join(cwd, '.upg', `${fileArg}.upg`),
    direct,
    `${direct}.upg`,
  ]
  const resolved = candidates.find(isExistingFile)
  if (!resolved) {
    return textError(
      `File not found: ${direct} (also checked .upg/${fileArg} and .upg/${fileArg}.upg). ` +
        `Pass a .upg path or a bare product name from list_local_products.`,
    )
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
      area_id: args.area_id as string | undefined,
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
 * Update the product header (`$upg.product`): `stage` (the canonical lifecycle
 * stage `get_graph_digest` reads), `title`, `description`, `health_status`, `url`.
 * The supported way to advance a product's stage without hand-editing the
 * integrity-hashed `.upg` file. §B.
 *
 * @returns JSON: `{ product, updated: string[] }` (the fields changed).
 * @throws textError when no field is supplied, when there is no product header,
 *   or when `stage` is non-canonical (same strict validation as create_product).
 * @atomicity atomic (single flush).
 * @see create_product
 */
export const updateProductTool: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  try {
    const result = updateProduct({
      store,
      stage: args.stage as never,
      title: args.title as string | undefined,
      description: args.description as string | undefined,
      health_status: args.health_status as string | undefined,
      url: args.url as string | undefined,
    })
    if (result.updated.length === 0) {
      return textError(
        'Nothing to update: pass at least one of: stage, title, description, health_status, url.',
      )
    }
    await store.flush()
    return text(
      JSON.stringify({ message: `Updated product (${result.updated.join(', ')})`, ...result }, null, 2),
    )
  } catch (err) {
    if (err instanceof InvalidProductStageError) return textError(err.message)
    return textError(`update_product failed: ${(err as Error).message}`)
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

/**
 * Place an existing product under a portfolio (`portfolio.products[]`), resolving
 * the portfolio against `portfolio.upg` (NOT the active product graph). The
 * product is also auto-registered on the portfolio registry. §A — the
 * portfolio side of the workspace write surface.
 *
 * @returns JSON: `{ product_id, container_id, container_kind: "portfolio",
 *   container_title?, already_member, registered }`.
 * @throws textError on a missing workspace, an unknown product, or an unknown
 *   portfolio id (the message points at list_portfolios / list_local_products).
 * @atomicity atomic (single portfolio.upg flush).
 * @see assign_product_to_area
 * @see create_product
 */
export const attachProductToPortfolioTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const productId = args.product_id as string | undefined
  const portfolioId = args.portfolio_id as string | undefined
  if (!productId) return textError('Missing required parameter: product_id')
  if (!portfolioId) return textError('Missing required parameter: portfolio_id')
  try {
    const result = await attachProductToPortfolio(process.cwd(), {
      product_id: productId,
      portfolio_id: portfolioId,
    })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Remove a product from a portfolio's `products[]` (it stays registered and in any
 * other container). The inverse of `attach_product_to_portfolio`. §8.
 *
 * @returns JSON: `{ product_id, container_id, container_kind: "portfolio",
 *   container_title?, removed }`. `removed: false` (not an error) when the product was
 *   not a member, so retries are idempotent.
 * @throws textError on a missing workspace or an unknown portfolio id.
 * @atomicity atomic (single portfolio.upg flush).
 * @see attach_product_to_portfolio
 */
export const detachProductFromPortfolioTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const productId = args.product_id as string | undefined
  const portfolioId = args.portfolio_id as string | undefined
  if (!productId) return textError('Missing required parameter: product_id')
  if (!portfolioId) return textError('Missing required parameter: portfolio_id')
  try {
    const result = await detachProductFromPortfolio(process.cwd(), {
      product_id: productId,
      portfolio_id: portfolioId,
    })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Delete a cross-product edge from `.upg/portfolio.upg` by id. The inverse of
 * `create_cross_product_edge`. §8.
 *
 * @returns JSON: `{ edge_id, deleted, edge? }`. `deleted: false` (not an error) when
 *   no edge with that id exists, so retries are idempotent.
 * @throws textError on a missing workspace.
 * @atomicity atomic (single portfolio.upg flush).
 * @see create_cross_product_edge
 * @see list_portfolio_cross_edges
 */
export const deleteCrossProductEdgeTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const edgeIdArg = args.edge_id as string | undefined
  if (!edgeIdArg) return textError('Missing required parameter: edge_id')
  try {
    const result = await deleteCrossProductEdge(process.cwd(), edgeIdArg)
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Create many cross-product edges in one atomic write (mirror of `batch_create_edges`
 * for the portfolio tier). Every edge is validated and qualified BEFORE anything is
 * written: if any is invalid the whole batch is rejected and `portfolio.upg` is left
 * untouched. Referenced products are auto-registered; all edges land in one flush.
 * §10.
 *
 * Each edge: `{ source_id, target_id, type, source_product_id?, target_product_id? }`
 * (same qualification rules as `create_cross_product_edge`). Max 50 per call.
 *
 * @returns JSON: `{ message, created: UPGCrossEdge[], count, portfolio_file,
 *   registered_products? }`.
 * @throws textError when `edges` is missing/empty/oversized, when any edge is invalid,
 *   or when no portfolio document exists (pass `auto_create_portfolio: true` to mint one).
 * @atomicity atomic. All edges validated first, then a single portfolio.upg flush.
 * @see create_cross_product_edge
 * @see list_cross_edge_types
 */
export const batchCreateCrossProductEdges: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const edgesArg = args.edges as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(edgesArg) || edgesArg.length === 0) {
    return textError('Missing required parameter: edges (a non-empty array).')
  }
  if (edgesArg.length > 50) {
    return textError(`Too many edges: ${edgesArg.length}. Max 50 per batch_create_cross_product_edges call.`)
  }

  const cwd = process.cwd()
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) {
    return textError('No workspace found. Run `init_workspace` first to enable portfolio cross-product edges.')
  }
  const autoCreatePortfolio = (args.auto_create_portfolio as boolean | undefined) ?? false
  const portfolioExisted = fs.existsSync(portfolioPath)
  if (!portfolioExisted && !autoCreatePortfolio) {
    return textError(
      'No portfolio document found at .upg/portfolio.upg. Cross-product edges express portfolio-level relationships ' +
      'and should be anchored to a portfolio that contains the products. Create a portfolio first ' +
      '(`create_node({type: "portfolio", title: "..."})`), or pass `auto_create_portfolio: true`.',
    )
  }

  // Validate + qualify EVERY edge before touching the store (all-or-nothing).
  const prepared: UPGCrossEdge[] = []
  for (let i = 0; i < edgesArg.length; i++) {
    const e = edgesArg[i]
    const sourceIdArg = e.source_id as string | undefined
    const targetIdArg = e.target_id as string | undefined
    const edgeTypeArg = e.type as string | undefined
    const sourceProductId = e.source_product_id as string | undefined
    const targetProductId = e.target_product_id as string | undefined
    if (!sourceIdArg) return textError(`edges[${i}]: missing source_id`)
    if (!targetIdArg) return textError(`edges[${i}]: missing target_id`)
    if (!edgeTypeArg) return textError(`edges[${i}]: missing type`)
    if (!UPG_CROSS_EDGE_TYPES.includes(edgeTypeArg as UPGCrossEdgeType)) {
      return textError(`edges[${i}]: invalid cross-product edge type "${edgeTypeArg}". Valid types: ${UPG_CROSS_EDGE_TYPES.join(', ')}`)
    }
    let qualifiedSource: string
    if (sourceIdArg.includes('/')) qualifiedSource = sourceIdArg
    else if (sourceProductId) qualifiedSource = `${sourceProductId}/${sourceIdArg}`
    else return textError(`edges[${i}]: source_id "${sourceIdArg}" is a bare node id. Supply source_product_id or a qualified {product_id}/{node_id}.`)
    let qualifiedTarget: string
    if (targetIdArg.includes('/')) qualifiedTarget = targetIdArg
    else if (targetProductId) qualifiedTarget = `${targetProductId}/${targetIdArg}`
    else return textError(`edges[${i}]: target_id "${targetIdArg}" is a bare node id. Supply target_product_id or a qualified {product_id}/{node_id}.`)
    prepared.push({
      id: edgeId(),
      source: qualifiedSource,
      target: qualifiedTarget,
      type: edgeTypeArg as UPGCrossEdgeType,
      source_product_id: sourceProductId ?? qualifiedSource.split('/')[0],
      target_product_id: targetProductId ?? qualifiedTarget.split('/')[0],
    })
  }

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  // Auto-register every referenced product (dedup), then add all edges + one flush.
  const registeredProducts: Array<{ id: string; file_path?: string; title?: string }> = []
  const portfolioDoc = portfolioStore.getDocument()
  if (portfolioDoc) {
    const productIds = new Set<string>()
    for (const e of prepared) {
      if (e.source_product_id) productIds.add(e.source_product_id)
      if (e.target_product_id) productIds.add(e.target_product_id)
    }
    for (const pid of productIds) {
      const lookup = findProductFileById(cwd, pid)
      const wasNew = registerProductOnPortfolio(portfolioDoc, {
        id: pid,
        ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}),
      })
      if (wasNew) registeredProducts.push({ id: pid, ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}) })
    }
    if (registeredProducts.length > 0) portfolioStore.markDirty()
  }

  try {
    for (const e of prepared) portfolioStore.addCrossEdge(e)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write cross-product edges: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        message: `Created ${prepared.length} cross-product edge(s)`,
        created: prepared,
        count: prepared.length,
        portfolio_file: path.relative(cwd, portfolioPath),
        ...(registeredProducts.length > 0 ? { registered_products: registeredProducts } : {}),
      },
      null,
      2,
    ),
  )
}

export type { ToolContext }
