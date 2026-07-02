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
import type { UPGCrossEdge, UPGCrossEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { UPG_CROSS_EDGE_TYPES, REGISTRY_PRODUCT_ID, edgeCarriesProperties, validateEdgeProperties, friendlyToAssessment } from '@unified-product-graph/core'
import { UPGPortfolioStore, UPGFileStore } from '@unified-product-graph/sdk'
import { buildPortfolioNodeIndex } from '@unified-product-graph/sdk'
import { preflightPayload } from '../lib/payload-guard.js'
import {
  resolvePortfolioPath,
  openPortfolioStoreIfExists,
  registerProductOnPortfolio,
  findProductFileById,
  attachProductToPortfolio,
  detachProductFromPortfolio,
  deleteCrossProductEdge,
  batchDeleteCrossProductEdges,
} from '@unified-product-graph/sdk'
import {
  createProduct,
  updateProduct,
  initWorkspace,
  InvalidProductNameError,
  InvalidProductStageError,
  InvalidMemberKindError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotInitialisedError,
} from '@unified-product-graph/sdk'
import { coerceProductStage } from '@unified-product-graph/core'
import { createEdge } from './edges.js'

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
  const seen = new Set<string>()
  const add = (abs: string) => {
    const resolved = path.resolve(abs)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      candidates.push(resolved)
    }
  }

  // (a) Filesystem scan: root + immediate subdirs (the historical behaviour).
  let topEntries: fs.Dirent[]
  try {
    topEntries = fs.readdirSync(cwd, { withFileTypes: true })
  } catch {
    return candidates
  }
  for (const entry of topEntries) {
    if (entry.isFile() && entry.name.endsWith('.upg')) {
      add(path.join(cwd, entry.name))
    } else if (entry.isDirectory() && (entry.name === '.upg' || !entry.name.startsWith('.'))) {
      try {
        const subEntries = fs.readdirSync(path.join(cwd, entry.name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.upg')) {
            add(path.join(cwd, entry.name, sub.name))
          }
        }
      } catch {
        // permission error or similar; skip
      }
    }
  }

  // (b) Registry-driven discovery (#44): honour any workspace.json-registered
  // subpath at any depth, so a graph in `competitors/<slug>/` is discoverable
  // even though the filesystem scan above only reaches one level. The registry
  // is the source of truth; the scan is the convenience fallback. Tolerant:
  // a missing/malformed workspace.json leaves the scan results untouched.
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(cwd, '.upg', 'workspace.json'), 'utf-8')) as {
      products?: Array<{ file?: unknown }>
    }
    for (const p of ws.products ?? []) {
      if (typeof p.file !== 'string') continue
      const abs = path.resolve(cwd, '.upg', p.file)
      if (fs.existsSync(abs)) add(abs)
    }
  } catch {
    // no workspace.json or malformed — the filesystem scan stands alone
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
    member_kind: string
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
        member_kind: (doc.$upg?.member_kind as string | undefined) ?? 'product',
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

  // Two phases with distinct error scoping (0.17.6). Before, a single try/catch
  // wrapped both the pre-switch flush of the ACTIVE product and the load of the
  // TARGET, so a flush CONFLICT (the active file was edited in another session)
  // surfaced as "Failed to switch" for every target — implying the requested
  // product failed to load, when it was never touched, and leaving the caller
  // with no in-band fix (restart-only). Separate them.
  const activeFile = store.getFilePath()
  const activeRel = path.relative(cwd, activeFile) || path.basename(activeFile)

  // Phase 1 — persist the active product before switching away. `flush()` is
  // dirty-guarded (a clean store is a no-op), so this writes only when there are
  // unsaved changes. A CONFLICT here is about the ACTIVE file, not the target.
  try {
    await store.flush()
  } catch (err) {
    return textError(
      `Cannot switch away from the active product (${activeRel}): saving its unsaved changes failed.\n` +
        `${(err as Error).message}\n` +
        `The requested product "${fileArg}" was NOT loaded and the active product is unchanged. ` +
        `To recover in-band, run reload_product({ discard_local: true }) — it discards the stale local ` +
        `state and re-reads ${activeRel} from disk — then retry switch_product.`,
    )
  }

  // Phase 2 — load the target. A failure here is a load/parse problem with the
  // REQUESTED file; the active product's watcher has already been stopped.
  try {
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
    return textError(
      `Failed to load the requested product "${fileArg}" (${resolved}): ${(err as Error).message}. ` +
        `The previous product (${activeRel}) is no longer watched — call get_workspace_info to confirm the ` +
        `active product, or reload_product to restore it.`,
    )
  }
}

/**
 * Re-read the active product from disk, discarding any unsaved in-memory
 * changes. The in-band escape from a wedged save-conflict (0.17.6): when the
 * active product's flush conflicts with an external edit, every write —
 * including `switch_product`, which flushes the active product first — keeps
 * throwing `CONFLICT`, and the stale snapshot persists with no way out short of
 * restarting the server. Reloading from disk drops the stale snapshot so the
 * next flush cannot conflict.
 *
 * `discard_local` (default false) is a safety gate: when the active product has
 * unsaved changes, it must be `true` to proceed, so a reload never silently
 * destroys unpersisted work. With no unsaved changes the reload always runs (a
 * safe refresh). This is LOCAL-only — cloud sessions have no on-disk file to
 * re-read.
 *
 * @returns JSON: `{ message, file, product: { title, stage }, entities,
 *   discarded_local_changes }`.
 * @throws textError when unsaved changes exist and `discard_local` is not true.
 * @atomicity non-atomic. Stops the watcher, re-reads the file, re-arms the watcher.
 * @see switch_product
 * @see get_workspace_info
 */
export const reloadProduct: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const discardLocal = args.discard_local === true
  const cwd = process.cwd()
  const activeFile = store.getFilePath()
  const rel = path.relative(cwd, activeFile) || path.basename(activeFile)

  if (store.hasUnsavedChanges() && !discardLocal) {
    return textError(
      `The active product (${rel}) has unsaved in-memory changes; reloading from disk would discard them. ` +
        `Pass discard_local: true to discard the local state and re-read the file. This is the reliable escape ` +
        `from a save-conflict (a CONFLICT thrown by flush / switch_product) without restarting the server.`,
    )
  }

  try {
    const result = await store.reloadFromDisk()
    const product = store.getProduct()
    return text(
      JSON.stringify(
        {
          message: `Reloaded ${product.title} from disk${
            result.discardedLocalChanges ? ' (discarded unsaved local changes)' : ''
          }`,
          file: result.file,
          product: { title: product.title, stage: product.stage },
          entities: result.nodes,
          discarded_local_changes: result.discardedLocalChanges,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    return textError(`Failed to reload the active product (${rel}): ${(err as Error).message}`)
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
    // Match the active product by its workspace-relative path so subfolder
    // graphs (`competitors/<slug>.upg`) resolve, while legacy bare-filename
    // entries still match a root product (rel === basename there). (#44)
    const upgDir = path.join(cwd, '.upg')
    const currentRel = path.relative(upgDir, currentFile).split(path.sep).join('/')
    const currentBasename = path.basename(currentFile)

    const products = (
      workspace.products as Array<{
        file: string
        title: string
        member_kind?: string
      }>
    ).map((p) => ({
      file: p.file,
      title: p.title,
      ...(p.member_kind && p.member_kind !== 'product' ? { member_kind: p.member_kind } : {}),
      active: p.file === currentRel || p.file === currentBasename,
    }))

    return text(
      JSON.stringify(
        {
          mode: 'workspace',
          workspace_path: '.upg/',
          current_product: currentRel,
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
      dir: args.dir as string | undefined,
      member_kind: args.member_kind as 'product' | 'org_rollup' | 'watched' | 'operating_function' | undefined,
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
    const result = await updateProduct({
      store,
      stage: args.stage as never,
      title: args.title as string | undefined,
      description: args.description as string | undefined,
      health_status: args.health_status as string | undefined,
      url: args.url as string | undefined,
      member_kind: args.member_kind as 'product' | 'org_rollup' | 'watched' | 'operating_function' | undefined,
      rename_file: args.rename_file as boolean | undefined,
      slug: args.slug as string | undefined,
      cwd: process.cwd(),
    })
    if (result.updated.length === 0) {
      return textError(
        'Nothing to update: pass at least one of: stage, title, description, health_status, url, member_kind, rename_file, slug.',
      )
    }
    await store.flush()
    return text(
      JSON.stringify({ message: `Updated product (${result.updated.join(', ')})`, ...result }, null, 2),
    )
  } catch (err) {
    if (err instanceof InvalidProductStageError || err instanceof InvalidMemberKindError) {
      return textError(err.message)
    }
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
  if (edgeTypeArg === 'instance_of') {
    return textError(
      `instance_of edges link a product entity to a canonical registry entity and are created via ` +
      `\`register_instance\` (which enforces the same-type constraint and the registry/ target), ` +
      `not \`create_cross_product_edge\`.`,
    )
  }
  if (edgeTypeArg === 'area_serves_persona' || edgeTypeArg === 'area_targets_market_segment') {
    return textError(
      `${edgeTypeArg} edges link a product_area to a canonical registry persona/market_segment ` +
      `(carrying primary/secondary relevance) and are created via \`link_area_to_audience\`, ` +
      `not \`create_cross_product_edge\`.`,
    )
  }

  // Edge metadata is gated: only cross-edge types declared `carries_properties`
  // in the catalogue (e.g. feature_rivals_competitor_feature, carrying the parity
  // assessment parity_status / quality / is_gap / assessed_on / evidence /
  // confidence) may carry properties. (0.10.0, #38)
  const propsArg = args.properties as Record<string, unknown> | undefined
  const hasProps = !!propsArg && Object.keys(propsArg).length > 0
  if (hasProps && !edgeCarriesProperties(edgeTypeArg)) {
    return textError(
      `Cross-product edge type "${edgeTypeArg}" does not carry properties. Only types declared ` +
      `carries_properties (e.g. feature_rivals_competitor_feature) may carry edge metadata.`,
    )
  }
  // When the type declares a typed property_schema (the classification edges,
  // 0.10.4), reject unknown keys and off-scale/missing-required values. Types
  // with carries_properties but no schema (parity) keep the unvalidated bag.
  if (hasProps) {
    const propErrors = validateEdgeProperties(edgeTypeArg, propsArg)
    if (propErrors.length > 0) {
      return textError(`Invalid properties for "${edgeTypeArg}": ${propErrors.join('; ')}`)
    }
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
    ...(hasProps ? { properties: propsArg } : {}),
  }

  // Dry-run pre-flight (0.10.8): forecast create / update / unchanged WITHOUT
  // writing or registering products, so a large batch is safe to reason about
  // before it runs. Returns the would-be-stored edge.
  if (args.dry_run === true) {
    const preview = portfolioStore.previewCrossEdge(newEdge)
    return text(
      JSON.stringify(
        {
          dry_run: true,
          would: preview.would,
          edge: preview.edge,
          portfolio_file: path.relative(cwd, portfolioPath),
        },
        null,
        2,
      ),
    )
  }

  // Auto-register both products on portfolio.upg.products[]. Cross-
  // edges referring to products that aren't listed are still valid but harder
  // to follow; the registry gives a stable lookup table for tooling.
  const registeredProducts: Array<{ id: string; file_path?: string; title?: string }> = []
  const portfolioDoc = portfolioStore.getDocument()
  if (portfolioDoc) {
    for (const productId of [derivedSourceProductId, derivedTargetProductId]) {
      // The registry tier is a pseudo-product (e.g. a classification cross-edge
      // targeting `registry/{value}`); never register it as a product. (0.10.2)
      if (productId === REGISTRY_PRODUCT_ID) continue
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

  let outcome: { status: 'created' | 'updated' | 'unchanged'; edge: UPGCrossEdge; superseded?: UPGCrossEdge[] }
  try {
    outcome = portfolioStore.addCrossEdge(newEdge, { supersede: args.supersede !== false })
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write cross-product edge: ${(err as Error).message}`)
  }

  // 0.10.6 (edge-property-upsert brief #4): report the STORED edge + the write
  // status so a no-op (`unchanged`) is distinguishable from an applied write and
  // the response never echoes unapplied properties as if stored.
  return text(
    JSON.stringify(
      {
        edge: outcome.edge,
        status: outcome.status,
        applied: outcome.status !== 'unchanged',
        // 0.11.3: a same-axis move on a single-select axis retires the prior edge.
        ...(outcome.superseded && outcome.superseded.length > 0
          ? { superseded: outcome.superseded.map((e) => ({ edge_id: e.id, target: e.target })) }
          : {}),
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
 * Create a parity / rivalry edge from our `feature` to a `competitor_feature`
 * (spec issue #38, UPG 0.10.1). A typed convenience over the generic edge
 * writers for the single `feature_rivals_competitor_feature` edge type: it fixes
 * the edge type, validates the parity enums, derives `is_gap` from
 * `parity_status` when omitted, and packs the assessment (parity_status /
 * quality / is_gap / assessed_on / evidence / confidence) onto the edge as
 * metadata. The edge is authoritative; the node `parity_status` is a
 * denormalised single-rival cache (`validate_graph` warns on divergence).
 *
 * Routing mirrors the edge type's dual catalogue + cross-edge registration:
 * - WITHIN the active graph (their `competitor_feature` lives alongside our
 *   `feature`): writes a catalogue edge via `create_edge`.
 * - CROSS-product (their `competitor_feature` lives in a separate watched
 *   intelligence graph): writes a cross-edge via `create_cross_product_edge`.
 *   Cross mode is selected when `competitor_feature_id` is qualified
 *   (`{product_id}/{node_id}`) or a product id is supplied; the our-side
 *   `feature_product_id` defaults to the active product.
 *
 * Parameters:
 * - `feature_id` (required): our `feature` (the rivalry edge source).
 * - `competitor_feature_id` (required): their `competitor_feature` (target);
 *   bare for within-graph, or `{product_id}/{node_id}` for cross-product.
 * - `parity_status` (required): ahead | behind | parity | unique_to_us | unique_to_them.
 * - `quality`: better | same | worse | missing.
 * - `is_gap`: boolean (default: parity_status in behind / unique_to_them).
 * - `assessed_on`: ISO date the assessment was made.
 * - `evidence`: free text, or an evidence / competitor_signal node id.
 * - `confidence`: low | medium | high.
 * - `feature_product_id` / `competitor_product_id`: qualify bare ids in cross mode.
 * - `auto_create_portfolio`: cross mode only; create an empty portfolio doc if absent.
 *
 * @returns JSON: the created edge (within-graph `create_edge` shape, or the
 *   cross-product `{ edge, portfolio_file }` shape).
 * @atomicity inherits the delegated writer's atomicity.
 * @see create_edge
 * @see create_cross_product_edge
 * @see validate_graph
 */
export const createParityEdge: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const featureId = args.feature_id as string | undefined
  const competitorFeatureId = args.competitor_feature_id as string | undefined
  const parityStatus = args.parity_status as string | undefined
  if (!featureId) return textError('Missing required parameter: feature_id (our feature)')
  if (!competitorFeatureId) {
    return textError('Missing required parameter: competitor_feature_id (their competitor_feature)')
  }
  if (!parityStatus) return textError('Missing required parameter: parity_status')

  const PARITY = ['ahead', 'behind', 'parity', 'unique_to_us', 'unique_to_them']
  if (!PARITY.includes(parityStatus)) {
    return textError(`Invalid parity_status: ${parityStatus}. Valid: ${PARITY.join(', ')}.`)
  }
  const quality = args.quality as string | undefined
  if (quality !== undefined && !['better', 'same', 'worse', 'missing'].includes(quality)) {
    return textError(`Invalid quality: ${quality}. Valid: better, same, worse, missing.`)
  }
  const confidence = args.confidence as string | undefined
  if (confidence !== undefined && !['low', 'medium', 'high'].includes(confidence)) {
    return textError(`Invalid confidence: ${confidence}. Valid: low, medium, high.`)
  }

  // is_gap denormalises from parity_status when not given: `behind` and
  // `unique_to_them` are the gap states.
  const isGap = typeof args.is_gap === 'boolean'
    ? (args.is_gap as boolean)
    : parityStatus === 'behind' || parityStatus === 'unique_to_them'

  const properties: Record<string, unknown> = {
    parity_status: parityStatus,
    ...(quality !== undefined ? { quality } : {}),
    is_gap: isGap,
    ...(args.assessed_on !== undefined ? { assessed_on: args.assessed_on } : {}),
    ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  }

  const competitorProductId = args.competitor_product_id as string | undefined
  const featureProductId = args.feature_product_id as string | undefined
  const isCross = competitorFeatureId.includes('/') || !!competitorProductId || !!featureProductId

  if (isCross) {
    // Our feature defaults to the active product when the source isn't qualified.
    const activeProductId = ctx.store.getProduct().id
    const sourceProductId = featureProductId ?? (featureId.includes('/') ? undefined : activeProductId)
    return createCrossProductEdge(
      {
        source_id: featureId,
        target_id: competitorFeatureId,
        type: 'feature_rivals_competitor_feature',
        ...(sourceProductId ? { source_product_id: sourceProductId } : {}),
        ...(competitorProductId ? { target_product_id: competitorProductId } : {}),
        properties,
        ...(args.auto_create_portfolio !== undefined
          ? { auto_create_portfolio: args.auto_create_portfolio }
          : {}),
      },
      ctx,
    )
  }

  return createEdge(
    {
      source_id: featureId,
      target_id: competitorFeatureId,
      type: 'feature_rivals_competitor_feature',
      properties,
    },
    ctx,
  )
}

/**
 * Accepted friendly confidence words. The value/label expansion is NOT defined
 * here — it comes from the single pinned source, `confidence_5.friendly_aliases`
 * via `friendlyToAssessment` (0.11.1) — so this writer can never disagree with
 * the rest of the graph on what `high` means. (Before 0.11.1 a local map here
 * expanded `high → 5`, off by one from the value-4 population.)
 */
const CLASSIFICATION_CONFIDENCE_SCALE = 'confidence_5'

/**
 * Typed convenience writer for a classification: place a node in a classification
 * cell, carrying optional confidence / provenance (0.10.4). Mirrors
 * `create_parity_edge`: friendly args, automatic within-graph vs cross-product
 * routing, and confidence coercion so callers never hand-assemble the
 * confidence_5 assessment.
 *
 * Edge type is chosen by the source node's type: a `competitor` source writes
 * `competitor_classified_as_classification_value`; anything else writes the
 * polymorphic `node_classified_as_classification_value`. A qualified
 * `{product}/{node}` source is resolved against the owning product file and,
 * failing that, the portfolio's `instance_of` index (0.11.1) — so a competitor in
 * a watched graph routes to the specialised edge and upserts the existing cell
 * rather than duplicating it under the polymorphic type. Only a genuinely
 * unresolvable source falls back to the generic edge (valid for any source,
 * identical schema).
 *
 * Routing: a `registry/{value}` or otherwise-qualified `classification_value_id`,
 * or a supplied `node_product_id`, selects cross-product (`create_cross_product_edge`);
 * a bare local value writes a catalogue edge (`create_edge`).
 *
 * Parameters:
 * - `node_id` (required): the thing being classified (bare, or `{product}/{node}`).
 * - `classification_value_id` (required): target value (bare local, or `registry/{value}`).
 * - `node_product_id`: qualify a bare `node_id` in cross mode (defaults to active product).
 * - `confidence`: low | medium | high — expanded to a confidence_5 assessment.
 * - `assessed_on`: ISO date; defaults to today when omitted (provenance for staleness).
 * - `rationale`: short note on why this node sits in this cell.
 * - `evidence`: a source URL, or a competitor_signal / evidence node id.
 * - `auto_create_portfolio`: cross mode only; create an empty portfolio doc if absent.
 *
 * @returns JSON: the created edge (within-graph or cross-product shape).
 * @atomicity inherits the delegated writer's atomicity.
 * @see create_cross_product_edge
 * @see create_edge
 */
export const createClassificationEdge: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const nodeId = args.node_id as string | undefined
  const classificationValueId = args.classification_value_id as string | undefined
  if (!nodeId) return textError('Missing required parameter: node_id (the node being classified)')
  if (!classificationValueId) {
    return textError('Missing required parameter: classification_value_id (the target value; bare or registry/{value})')
  }

  const confidenceArg = args.confidence as string | undefined
  // Expand via the pinned scale aliases (0.11.1) so `high` is value 4 / label
  // "Confident", agreeing with the generic writers and the backfilled population.
  const confidenceAssessment =
    confidenceArg !== undefined ? friendlyToAssessment(CLASSIFICATION_CONFIDENCE_SCALE, confidenceArg) : undefined
  if (confidenceArg !== undefined && !confidenceAssessment) {
    return textError(`Invalid confidence: ${confidenceArg}. Valid: low, medium, high.`)
  }

  const nodeProductId = args.node_product_id as string | undefined

  // Pick the specialised vs generic edge from the source node's type. The source
  // may live in a non-active (e.g. watched competitor) product when it is
  // qualified `{product_id}/{node_id}` or `node_product_id` is supplied; the
  // active store can't see it. 0.10.6 (upsert brief #3): resolve the type against
  // the OWNING product so a qualified competitor source writes the specialised
  // edge instead of mis-typing as the polymorphic one (which duplicated the cell).
  const bareNodeId = nodeId.includes('/') ? nodeId.split('/')[1] : nodeId
  const activeProductId = ctx.store.getProduct().id
  const owningProductId = nodeId.includes('/') ? nodeId.split('/')[0] : (nodeProductId ?? activeProductId)
  let sourceType = ctx.store.getNode(bareNodeId)?.type
  if (owningProductId && owningProductId !== activeProductId && owningProductId !== REGISTRY_PRODUCT_ID) {
    // Cross-product source: read the owning product to learn the node's type.
    const lookup = findProductFileById(process.cwd(), owningProductId)
    if (lookup?.file_path) {
      try {
        const s = new UPGFileStore()
        await s.loadReadOnly(path.resolve(process.cwd(), lookup.file_path))
        sourceType = s.getNode(bareNodeId)?.type ?? sourceType
      } catch {
        /* unresolvable owning product: fall back to the portfolio index below */
      }
    }
  }
  // Portfolio fallback (0.11.1): a competitor in a watched/portfolio workspace is
  // often NOT a locally-resolvable product file, so the owning-product lookup
  // above leaves sourceType unresolved and the writer mis-types the edge as the
  // polymorphic `node_…` — which then duplicates the cell instead of upserting
  // (a different edge type is a different dedup key). The portfolio's
  // `instance_of` cross-edges already map `{pid}/{nid}` to its canonical type, so
  // resolve a qualified source through the node index. This is what makes a
  // qualified competitor source route to `competitor_…` and land on the existing
  // edge.
  if (sourceType !== 'competitor' && nodeId.includes('/')) {
    const pfDoc = (await openPortfolioStoreIfExists(process.cwd()))?.getDocument()
    if (pfDoc) {
      const resolved = buildPortfolioNodeIndex(pfDoc).get(nodeId)?.type
      // The portfolio index types refs' `type` loosely as string; a resolved ref
      // is a real entity type at runtime.
      if (resolved) sourceType = resolved as UPGEntityType
    }
  }
  const edgeType =
    sourceType === 'competitor'
      ? 'competitor_classified_as_classification_value'
      : 'node_classified_as_classification_value'

  const properties: Record<string, unknown> = {
    ...(confidenceAssessment ? { confidence: confidenceAssessment } : {}),
    assessed_on: (args.assessed_on as string | undefined) ?? new Date().toISOString().slice(0, 10),
    ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
    ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
  }
  const isCross = classificationValueId.includes('/') || !!nodeProductId

  if (isCross) {
    const sourceProductId = nodeProductId ?? (nodeId.includes('/') ? undefined : activeProductId)
    return createCrossProductEdge(
      {
        source_id: nodeId,
        target_id: classificationValueId,
        type: edgeType,
        ...(sourceProductId ? { source_product_id: sourceProductId } : {}),
        properties,
        ...(args.supersede !== undefined ? { supersede: args.supersede } : {}),
        ...(args.auto_create_portfolio !== undefined
          ? { auto_create_portfolio: args.auto_create_portfolio }
          : {}),
      },
      ctx,
    )
  }

  return createEdge(
    {
      source_id: nodeId,
      target_id: classificationValueId,
      type: edgeType,
      properties,
    },
    ctx,
  )
}

/**
 * Link a product area to a canonical audience (Batch-5 #29): create an
 * `area_serves_persona` (→ a registry persona) or `area_targets_market_segment`
 * (→ a registry market_segment) cross-edge, with optional `relevance`
 * (primary/secondary) and `audience_role` qualifiers. The edge type is inferred
 * from the canonical's type, so the caller just names the area and the canonical.
 * Source is the `product_area` id; target is `registry/{canonical_id}`. This is
 * the only path that creates the area↔audience edges (the generic
 * `create_cross_product_edge` rejects them). Idempotent: an existing edge is
 * updated (qualifiers) rather than duplicated.
 *
 * Parameters:
 * - `area_id` (required): the product_area (see `list_product_areas`).
 * - `canonical_id` (required): a registry persona or market_segment (bare or `registry/{id}`).
 * - `relevance`: `primary` | `secondary` (the matrix's core distinction).
 * - `audience_role`: `buyer`/`user`/`champion`/`influencer`/`partner` (persona targets only).
 *
 * @returns JSON: `{ edge, area, canonical, portfolio_file, already_existed?, updated? }`.
 * @atomicity non-atomic. Edge append to the portfolio document.
 * @see define_canonical_entity
 * @see list_product_areas
 */
export const linkAreaToAudience: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const areaId = args.area_id as string | undefined
  const canonicalArg = args.canonical_id as string | undefined
  if (!areaId) return textError('Missing required parameter: area_id')
  if (!canonicalArg) return textError('Missing required parameter: canonical_id (a registry persona or market_segment)')

  const relevance = args.relevance as string | undefined
  if (relevance !== undefined && relevance !== 'primary' && relevance !== 'secondary') {
    return textError(`Invalid relevance "${relevance}". Use "primary" or "secondary".`)
  }

  const cwd = process.cwd()
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (!portfolioStore) {
    return textError(
      'No portfolio document found. Create an area and a registry first (`create_area`, `define_canonical_entity`).',
    )
  }

  const doc = portfolioStore.getDocument()
  const area = doc?.product_areas?.find((a) => a.id === areaId)
  if (!area) {
    return textError(`Product area "${areaId}" not found in the portfolio. See \`list_product_areas\`.`)
  }

  const prefix = `${REGISTRY_PRODUCT_ID}/`
  const canonicalId = canonicalArg.startsWith(prefix) ? canonicalArg.slice(prefix.length) : canonicalArg
  const canonical = portfolioStore.getRegistryNode(canonicalId)
  if (!canonical) {
    return textError(
      `Canonical entity "${canonicalId}" not found in the registry. An area audience edge targets a ` +
      `registry persona or market_segment — define it first with \`define_canonical_entity\`.`,
    )
  }

  let edgeType: UPGCrossEdgeType
  if (canonical.type === 'persona') edgeType = 'area_serves_persona'
  else if (canonical.type === 'market_segment') edgeType = 'area_targets_market_segment'
  else {
    return textError(
      `Canonical "${canonicalId}" is a ${canonical.type}. An area audience edge targets a registry ` +
      `persona (area_serves_persona) or market_segment (area_targets_market_segment).`,
    )
  }

  const audienceRole = args.audience_role as string | undefined
  if (audienceRole !== undefined) {
    if (edgeType !== 'area_serves_persona') {
      return textError('audience_role applies only to a persona target (area_serves_persona).')
    }
    const validRoles = ['buyer', 'user', 'champion', 'influencer', 'partner']
    if (!validRoles.includes(audienceRole)) {
      return textError(`Invalid audience_role "${audienceRole}". Use one of: ${validRoles.join(', ')}.`)
    }
  }

  const target = `${REGISTRY_PRODUCT_ID}/${canonicalId}`

  // Idempotent: an existing area→canonical edge of this type is updated (its
  // qualifiers), not duplicated.
  const existing = portfolioStore
    .getAllCrossEdges()
    .find((e) => e.type === edgeType && e.source === areaId && e.target === target)
  if (existing) {
    let updated = false
    if (relevance !== undefined && existing.relevance !== relevance) {
      existing.relevance = relevance as 'primary' | 'secondary'
      updated = true
    }
    if (audienceRole !== undefined && existing.audience_role !== audienceRole) {
      existing.audience_role = audienceRole as UPGCrossEdge['audience_role']
      updated = true
    }
    if (updated) {
      portfolioStore.markDirty()
      await portfolioStore.flush()
    }
    return text(
      JSON.stringify(
        {
          edge: existing,
          area: { id: area.id, title: area.title },
          canonical: { id: canonicalId, type: canonical.type, title: canonical.title },
          already_existed: true,
          updated,
          portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
        },
        null,
        2,
      ),
    )
  }

  const edge: UPGCrossEdge = {
    id: edgeId(),
    source: areaId,
    target,
    type: edgeType,
    target_product_id: REGISTRY_PRODUCT_ID,
  }
  if (relevance !== undefined) edge.relevance = relevance as 'primary' | 'secondary'
  if (audienceRole !== undefined) edge.audience_role = audienceRole as UPGCrossEdge['audience_role']

  try {
    portfolioStore.addCrossEdge(edge)
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write area audience edge: ${(err as Error).message}`)
  }

  return text(
    JSON.stringify(
      {
        edge,
        area: { id: area.id, title: area.title },
        canonical: { id: canonicalId, type: canonical.type, title: canonical.title },
        portfolio_file: path.relative(cwd, portfolioStore.getFilePath() ?? ''),
      },
      null,
      2,
    ),
  )
}

/**
 * List cross-product edges in the portfolio document (`.upg/portfolio.upg`),
 * with optional filtering, grouping, title resolution, property projection, and
 * pagination so a large portfolio's edges read back as a focused, agent-usable
 * matrix instead of one overflowing dump (0.10.4 read-path brief C; titles +
 * projection + pagination, 0.10.7).
 *
 * Parameters:
 * - `type`: filter to one cross-edge type (e.g. `competitor_classified_as_classification_value`).
 * - `source_product_id`: filter to edges whose source is in this product.
 * - `group_by`: `source` or `target` -- group edges by that endpoint
 *   (the comparison matrix) instead of a flat list.
 * - `resolve_titles` (default true): add `source_title` / `target_title` to each
 *   edge, resolved from the registry and `instance_of` registrations, so output
 *   names entities ("Sitecore") rather than opaque ids.
 * - `property_include`: keep only these keys of each edge's `properties` (e.g.
 *   `["confidence"]`), trimming a heavy assessment payload to what is needed.
 *   Pass `[]` to drop properties entirely.
 * - `limit` / `offset`: page the FLAT list (ignored when `group_by` is set).
 *
 * For the nested axis -> value -> classified-members view of the classification
 * matrix, use `get_portfolio_tree` ({ shape: "landscape" }); this tool is the
 * raw edge reader.
 *
 * @returns JSON: flat `{ cross_edges, total, returned, offset?, has_more?,
 *   portfolio_file? }`, or when grouped `{ grouped_by, groups, total,
 *   group_count }`.
 * @atomicity atomic (read-only)
 * @see get_portfolio_tree
 * @see create_cross_product_edge
 */
export const listPortfolioCrossEdges: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
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

  const typeFilter = args.type as string | undefined
  const sourceProductFilter = args.source_product_id as string | undefined
  const groupBy = args.group_by as string | undefined
  if (groupBy !== undefined && groupBy !== 'source' && groupBy !== 'target') {
    return textError(`Invalid group_by: ${groupBy}. Valid: source, target.`)
  }
  const resolveTitles = args.resolve_titles !== false
  const propertyInclude = Array.isArray(args.property_include) ? (args.property_include as string[]) : undefined

  let edges = portfolioStore.getAllCrossEdges()
  if (typeFilter) edges = edges.filter((e) => e.type === typeFilter)
  if (sourceProductFilter) edges = edges.filter((e) => e.source_product_id === sourceProductFilter)

  // Freshness filter (0.10.8): keep edges whose `properties.assessed_on` is older
  // than a cutoff — the read path for "which cells are stale?". An edge with NO
  // assessed_on is the stalest (never assessed) and is kept. `assessed_before`
  // is an absolute ISO date; `older_than_days` is relative to now (the latter
  // wins if both are given).
  const olderThanDays = typeof args.older_than_days === 'number' ? (args.older_than_days as number) : undefined
  const assessedBefore = typeof args.assessed_before === 'string' ? (args.assessed_before as string) : undefined
  let staleCutoff: number | undefined
  if (olderThanDays !== undefined) staleCutoff = Date.now() - Math.max(0, olderThanDays) * 86_400_000
  else if (assessedBefore !== undefined) {
    const t = Date.parse(assessedBefore)
    if (Number.isNaN(t)) return textError(`Invalid assessed_before date: "${assessedBefore}". Use an ISO date (e.g. 2026-06-15).`)
    staleCutoff = t
  }
  if (staleCutoff !== undefined) {
    edges = edges.filter((e) => {
      const a = (e.properties as { assessed_on?: unknown } | undefined)?.assessed_on
      if (typeof a !== 'string') return true // never assessed = stalest
      const t = Date.parse(a)
      return Number.isNaN(t) || t < staleCutoff!
    })
  }

  const portfolio_file = path.relative(cwd, portfolioPath)

  // Title index (registry + instance_of), built once, only when needed.
  const portfolioDoc = portfolioStore.getDocument()
  const index = resolveTitles && portfolioDoc ? buildPortfolioNodeIndex(portfolioDoc) : undefined
  const titleOf = (qid: string): string | undefined => index?.get(qid)?.title

  // Project each edge: optional title decoration + property trimming.
  const project = (e: UPGCrossEdge): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...e }
    if (propertyInclude && e.properties) {
      const picked: Record<string, unknown> = {}
      for (const k of propertyInclude) if (k in e.properties) picked[k] = e.properties[k]
      out.properties = picked
    }
    if (resolveTitles) {
      const st = titleOf(e.source)
      const tt = titleOf(e.target)
      if (st) out.source_title = st
      if (tt) out.target_title = tt
    }
    return out
  }

  if (groupBy) {
    const groups: Record<string, Array<Record<string, unknown>>> = {}
    for (const e of edges) {
      const key = (groupBy === 'source' ? e.source : e.target) as string
      ;(groups[key] ??= []).push(project(e))
    }
    return text(
      JSON.stringify(
        { grouped_by: groupBy, group_count: Object.keys(groups).length, total: edges.length, groups, portfolio_file },
        null,
        2,
      ),
    )
  }

  // Flat list: paginate.
  const total = edges.length
  const offsetRaw = typeof args.offset === 'number' ? (args.offset as number) : 0
  const offset = Math.max(0, Math.floor(offsetRaw))
  const hasLimit = typeof args.limit === 'number'
  const limit = hasLimit ? Math.max(1, Math.floor(args.limit as number)) : undefined
  const page = limit !== undefined ? edges.slice(offset, offset + limit) : edges.slice(offset)
  const projected = page.map(project)

  const response: Record<string, unknown> = {
    cross_edges: projected,
    total,
    returned: projected.length,
    portfolio_file,
  }
  if (offset > 0 || limit !== undefined) {
    response.offset = offset
    response.has_more = offset + projected.length < total
  }

  // Guard: even projected, a very large flat page can exceed the transport cap.
  // These are edge rows (title-decorated when resolve_titles), not full nodes.
  const guard = preflightPayload({
    toolName: 'list_portfolio_cross_edges',
    nodeCount: 0,
    edgeCount: projected.length,
    compactEdges: !resolveTitles,
    argsHint: `total=${total}, returned=${projected.length}${limit !== undefined ? `, limit=${limit}` : ' (no limit; pass limit/offset to page)'}`,
  })
  if (guard.kind === 'refuse') return guard.result
  if (guard.kind === 'warn') Object.assign(response, guard.fields)

  return text(JSON.stringify(response, null, 2))
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
 * Delete up to 50 cross-product edges from `.upg/portfolio.upg` by id in one atomic
 * write (the inverse of `batch_create_cross_product_edges`). All ids are removed in
 * memory, then a single portfolio.upg flush persists the batch, so retiring a wave
 * of superseded edges costs one write. A missing id is `deleted: false` (not an
 * error), so the call is idempotent.
 *
 * @returns JSON: `{ message, deleted: [{ edge_id, deleted, edge? }], count, counts }`.
 * @throws textError when `edge_ids` is missing/empty/oversized or no portfolio exists.
 * @atomicity atomic (single portfolio.upg flush).
 * @see delete_cross_product_edge
 * @see batch_create_cross_product_edges
 */
export const batchDeleteCrossProductEdgesTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const edgeIdsArg = args.edge_ids as unknown
  if (!Array.isArray(edgeIdsArg) || edgeIdsArg.length === 0) {
    return textError('Missing required parameter: edge_ids (a non-empty array).')
  }
  if (edgeIdsArg.length > 50) {
    return textError(`Too many edges: ${edgeIdsArg.length}. Max 50 per batch_delete_cross_product_edges call.`)
  }
  for (let i = 0; i < edgeIdsArg.length; i++) {
    if (typeof edgeIdsArg[i] !== 'string' || !edgeIdsArg[i]) return textError(`edge_ids[${i}]: must be a non-empty string`)
  }
  try {
    const result = await batchDeleteCrossProductEdges(process.cwd(), edgeIdsArg as string[])
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
    if (edgeTypeArg === 'instance_of') {
      return textError(`edges[${i}]: instance_of edges are created via \`register_instance\` (registry same-type rules), not batch_create_cross_product_edges.`)
    }
    if (edgeTypeArg === 'area_serves_persona' || edgeTypeArg === 'area_targets_market_segment') {
      return textError(`edges[${i}]: ${edgeTypeArg} edges are created via \`link_area_to_audience\`, not batch_create_cross_product_edges.`)
    }
    let qualifiedSource: string
    if (sourceIdArg.includes('/')) qualifiedSource = sourceIdArg
    else if (sourceProductId) qualifiedSource = `${sourceProductId}/${sourceIdArg}`
    else return textError(`edges[${i}]: source_id "${sourceIdArg}" is a bare node id. Supply source_product_id or a qualified {product_id}/{node_id}.`)
    let qualifiedTarget: string
    if (targetIdArg.includes('/')) qualifiedTarget = targetIdArg
    else if (targetProductId) qualifiedTarget = `${targetProductId}/${targetIdArg}`
    else return textError(`edges[${i}]: target_id "${targetIdArg}" is a bare node id. Supply target_product_id or a qualified {product_id}/{node_id}.`)
    // Edge metadata, gated the same way the single writer gates it (0.10.4 fix:
    // the batch writer previously dropped properties silently).
    const propsArg = e.properties as Record<string, unknown> | undefined
    const hasProps = !!propsArg && Object.keys(propsArg).length > 0
    if (hasProps && !edgeCarriesProperties(edgeTypeArg)) {
      return textError(`edges[${i}]: cross-product edge type "${edgeTypeArg}" does not carry properties.`)
    }
    if (hasProps) {
      const propErrors = validateEdgeProperties(edgeTypeArg, propsArg)
      if (propErrors.length > 0) return textError(`edges[${i}]: invalid properties for "${edgeTypeArg}": ${propErrors.join('; ')}`)
    }
    prepared.push({
      id: edgeId(),
      source: qualifiedSource,
      target: qualifiedTarget,
      type: edgeTypeArg as UPGCrossEdgeType,
      source_product_id: sourceProductId ?? qualifiedSource.split('/')[0],
      target_product_id: targetProductId ?? qualifiedTarget.split('/')[0],
      ...(hasProps ? { properties: propsArg } : {}),
    })
  }

  const portfolioStore = new UPGPortfolioStore()
  try {
    await portfolioStore.loadOrInit(portfolioPath)
  } catch (err) {
    return textError(`Failed to load portfolio document: ${(err as Error).message}`)
  }

  // Dry-run pre-flight (0.10.8): forecast the whole batch (created / updated /
  // unchanged) WITHOUT writing or registering products. Each edge is previewed
  // against the persisted state, so a backfill of distinct edges reports exactly
  // what the real write will do. (In-batch duplicate (source, target, type)
  // pairs are previewed independently, not sequenced.)
  if (args.dry_run === true) {
    const previews = prepared.map((e) => portfolioStore.previewCrossEdge(e))
    const wouldCounts = { create: 0, update: 0, unchanged: 0 }
    for (const p of previews) wouldCounts[p.would]++
    return text(
      JSON.stringify(
        {
          dry_run: true,
          message: `Would apply ${wouldCounts.create + wouldCounts.update}/${previews.length} cross-product edge(s) (${wouldCounts.create} create, ${wouldCounts.update} update, ${wouldCounts.unchanged} unchanged)`,
          edges: previews.map((p) => ({ would: p.would, edge: p.edge })),
          count: previews.length,
          would_counts: wouldCounts,
          portfolio_file: path.relative(cwd, portfolioPath),
        },
        null,
        2,
      ),
    )
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
      if (pid === REGISTRY_PRODUCT_ID) continue // pseudo-product; never register (0.10.2)
      const lookup = findProductFileById(cwd, pid)
      const wasNew = registerProductOnPortfolio(portfolioDoc, {
        id: pid,
        ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}),
      })
      if (wasNew) registeredProducts.push({ id: pid, ...(lookup ? { file_path: lookup.file_path, title: lookup.title } : {}) })
    }
    if (registeredProducts.length > 0) portfolioStore.markDirty()
  }

  // 0.10.6 (edge-property-upsert brief): each add is now an upsert — an existing
  // (source, target, type) carrying new properties is updated in place rather
  // than silently no-op'd, so the 218-edge backfill lands in one batch. Report
  // the STORED edges + per-status counts so a no-op is distinguishable.
  const results: Array<{ status: 'created' | 'updated' | 'unchanged'; edge: UPGCrossEdge; superseded?: UPGCrossEdge[] }> = []
  try {
    for (const e of prepared) results.push(portfolioStore.addCrossEdge(e, { supersede: args.supersede !== false }))
    await portfolioStore.flush()
  } catch (err) {
    return textError(`Failed to write cross-product edges: ${(err as Error).message}`)
  }

  const counts = { created: 0, updated: 0, unchanged: 0 }
  for (const r of results) counts[r.status]++
  const applied = counts.created + counts.updated
  const supersededCount = results.reduce((s, r) => s + (r.superseded?.length ?? 0), 0)

  return text(
    JSON.stringify(
      {
        message: `Applied ${applied}/${results.length} cross-product edge(s) (${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged)`,
        edges: results.map((r) => ({ status: r.status, edge: r.edge, ...(r.superseded && r.superseded.length > 0 ? { superseded: r.superseded.map((e) => ({ edge_id: e.id, target: e.target })) } : {}) })),
        count: results.length,
        counts,
        ...(supersededCount > 0 ? { superseded_total: supersededCount } : {}),
        portfolio_file: path.relative(cwd, portfolioPath),
        ...(registeredProducts.length > 0 ? { registered_products: registeredProducts } : {}),
      },
      null,
      2,
    ),
  )
}

export type { ToolContext }
