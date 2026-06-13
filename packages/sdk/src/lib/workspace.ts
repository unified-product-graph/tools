/**
 * Workspace bootstrap. Holds the core logic for `init_workspace`.
 *
 * Extracted from server.ts so the bug-prone fs choreography can be unit-tested
 * against real tmp directories without booting the MCP transport.
 *
 * Two bugs this module guards against:
 * 1. `readdir` returning the `.upg` workspace directory itself as an entry
 *    that "ends with .upg". The old code tried to rename `.upg → .upg/.upg`
 *    and crashed with EINVAL.
 * 2. A user who already organised their `.upg` files inside `.upg/` re-running
 *    `init_workspace` from the project root. The old code found nothing at
 *    root and registered an empty product list. The new code discovers
 *    pre-existing siblings and registers them non-destructively.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { UPGFileStore } from '../store.js'
import type { UPGDocument, UPGProductStage, UPGBaseNode } from '@unified-product-graph/core'
import {
  generateSlug,
  resolveSlugCollision,
  UPG_VERSION,
  validateProductStageStrict,
  serializeCanonical,
} from '@unified-product-graph/core'
import { edgeId, productId } from './id.js'
import {
  openPortfolioStoreIfExists,
  registerProductOnPortfolio,
  addProductToArea,
  addProductToPortfolio,
} from './portfolio-routing.js'

export interface WorkspaceProduct {
  file: string
  title: string
  /**
   * Workspace member kind (0.10.0, #45), cached from the graph's
   * `$upg.member_kind` for fast enumeration. `product` (default / absent),
   * `org_rollup` (company umbrella), or `watched` (monitored intelligence graph).
   */
  member_kind?: 'product' | 'org_rollup' | 'watched'
}

export interface InitWorkspaceArgs {
  cwd: string
  store: UPGFileStore
  moveExisting?: boolean
}

export interface InitWorkspaceResult {
  workspace_path: string
  default_product: string
  products: WorkspaceProduct[]
  current_product: { title: string; entities: number }
}

export class WorkspaceAlreadyExistsError extends Error {
  constructor() {
    super('Workspace already exists. Use get_workspace_info to see current state.')
    this.name = 'WorkspaceAlreadyExistsError'
  }
}

export class WorkspaceNotInitialisedError extends Error {
  constructor() {
    super(
      'Workspace not initialised. Run `init_workspace` first to enable multi-product management.',
    )
    this.name = 'WorkspaceNotInitialisedError'
  }
}

export class InvalidProductNameError extends Error {
  constructor(reason: string) {
    super(`Invalid product name: ${reason}`)
    this.name = 'InvalidProductNameError'
  }
}

/**
 * Thrown when a `create_product` / product-stage write attempts to
 * persist a non-canonical UPGProductStage value. Surfaces the canonical set
 * + any documented coercion target in the error message so the caller can
 * fix the input.
 */
export class InvalidProductStageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProductStageError'
  }
}

async function readProductTitle(filePath: string, fallback: string): Promise<string> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    const doc = JSON.parse(raw)
    if (doc.product?.title && typeof doc.product.title === 'string') {
      return doc.product.title
    }
  } catch {
    // Malformed file or unreadable; fall back to filename
  }
  return fallback
}

export async function initWorkspace({
  cwd,
  store,
  moveExisting = true,
}: InitWorkspaceArgs): Promise<InitWorkspaceResult> {
  const resolvedCwd = path.resolve(cwd)
  const upgDir = path.resolve(resolvedCwd, '.upg')

  // Bail if the workspace is already initialised
  try {
    await fsp.access(path.join(upgDir, 'workspace.json'))
    throw new WorkspaceAlreadyExistsError()
  } catch (err) {
    if (err instanceof WorkspaceAlreadyExistsError) throw err
    // ENOENT: good, no workspace yet
  }

  await fsp.mkdir(upgDir, { recursive: true })

  // Root-level .upg files that may need moving. Use withFileTypes to filter
  // out the `.upg` directory entry itself; `'.upg'.endsWith('.upg')` would
  // otherwise match it and trigger a rename of the directory into itself.
  const rootEntries = await fsp.readdir(resolvedCwd, { withFileTypes: true })
  const rootUpgFiles = rootEntries
    .filter((e) => e.isFile() && e.name.endsWith('.upg'))
    .map((e) => e.name)
    .sort()

  // Pre-existing .upg files already living inside .upg/; they are products
  // even if the user never moved them. Register without re-moving.
  let preExistingFiles: string[] = []
  try {
    const upgDirEntries = await fsp.readdir(upgDir, { withFileTypes: true })
    preExistingFiles = upgDirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.upg'))
      .map((e) => e.name)
      .sort()
  } catch {
    // Directory was just created or unreadable; treat as empty
  }

  const products: WorkspaceProduct[] = []
  const seen = new Set<string>()

  for (const file of preExistingFiles) {
    const filePath = path.join(upgDir, file)
    const title = await readProductTitle(filePath, path.basename(file, '.upg'))
    products.push({ file, title })
    seen.add(file)
  }

  if (moveExisting) {
    for (const file of rootUpgFiles) {
      const srcPath = path.resolve(resolvedCwd, file)
      const destPath = path.resolve(upgDir, file)

      // Already inside the workspace dir (covers symlink edge cases where
      // resolvedCwd and upgDir share a prefix in unexpected ways).
      if (srcPath === destPath || path.dirname(srcPath) === upgDir) {
        if (!seen.has(file)) {
          const title = await readProductTitle(srcPath, path.basename(file, '.upg'))
          products.push({ file, title })
          seen.add(file)
        }
        continue
      }

      const title = await readProductTitle(srcPath, path.basename(file, '.upg'))

      // If the destination already exists (user dropped the same file in
      // both root and .upg/), keep the existing one and leave the root copy
      // alone; non-destructive by default.
      let destExists = false
      try {
        await fsp.access(destPath)
        destExists = true
      } catch {
        // dest absent; safe to move
      }

      if (!destExists) {
        await fsp.rename(srcPath, destPath)
      }
      if (!seen.has(file)) {
        products.push({ file, title })
        seen.add(file)
      }
    }
  }

  // If still nothing registered, seed with the currently-loaded store file.
  if (products.length === 0) {
    const currentFile = store.getFilePath()
    const basename = path.basename(currentFile)
    const destPath = path.resolve(upgDir, basename)
    try {
      await fsp.access(destPath)
    } catch {
      await fsp.copyFile(currentFile, destPath)
    }
    const product = store.getProduct()
    products.push({ file: basename, title: product.title })
  }

  const defaultProduct = products[0].file

  await fsp.writeFile(
    path.join(upgDir, 'workspace.json'),
    JSON.stringify({ version: '1.0', default_product: defaultProduct, products }, null, 2) + '\n',
    'utf-8',
  )

  // Reload store with the workspace's default product
  const newFilePath = path.join(upgDir, defaultProduct)
  await store.flush()
  store.stopWatching()
  await store.load(newFilePath)

  const product = store.getProduct()
  return {
    workspace_path: '.upg/',
    default_product: defaultProduct,
    products,
    current_product: { title: product.title, entities: store.getAllNodes().length },
  }
}

// ─── create_product ────────────────────────────────────────────────

export interface CreateProductArgs {
  cwd: string
  store: UPGFileStore
  name: string
  slug?: string
  description?: string
  stage?: UPGProductStage
  /**
   * Optional portfolio id to place the new product under. As of 0.8.15 this
   * resolves against `portfolio.upg` (the product is added to that portfolio's
   * `products[]`). For back-compat a portfolio id that resolves only in the
   * active product graph still attaches via an in-graph
   * `portfolio_contains_product` edge — but that path is DEPRECATED; prefer a
   * portfolio id from portfolio.upg (see `attachProductToPortfolio`).
   */
  portfolio_id?: string
  /** Optional `product_area` id (resolved against portfolio.upg) to place the new product under. */
  area_id?: string
  /**
   * Optional subfolder under `.upg/` to write the graph into, e.g. `competitors`
   * (UPG 0.9.27, issue #44). The file lands at `.upg/<dir>/<slug>.upg` and is
   * registered in `workspace.json` with its workspace-relative subpath
   * (`competitors/<slug>.upg`). Used so a `watched` portfolio defaults its
   * intelligence graphs into `competitors/`. Absent writes flat at `.upg/<slug>.upg`
   * (back-compat). Leading slashes and `..` segments are rejected.
   */
  dir?: string
  /**
   * Optional workspace member kind (0.10.0, #45): `org_rollup` (company umbrella)
   * or `watched` (monitored intelligence graph, e.g. a competitor). Stamped into
   * the new graph's `$upg.member_kind` and cached in workspace.json + the
   * portfolio registry. Absent / `product` = an ordinary product; watched and
   * rollup members are excluded from `counts.products`.
   */
  member_kind?: 'product' | 'org_rollup' | 'watched'
}

export interface CreateProductResult {
  id: string
  file: string
  slug: string
  title: string
  workspace_path: string
  portfolio_attached: boolean
  /** True when the product was placed under a `product_area` in portfolio.upg. */
  area_attached?: boolean
  /** Non-fatal advisories (unresolved area_id, deprecated active-store attach, …). */
  warnings?: string[]
}

/** Compute the integrity checksum a freshly written .upg file would carry. */
function computeIntegrityChecksum(doc: UPGDocument): string {
  const sortedNodes = [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = [...doc.edges].sort((a, b) => a.id.localeCompare(b.id))
  const content = JSON.stringify({ nodes: sortedNodes, edges: sortedEdges })
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

export async function createProduct(args: CreateProductArgs): Promise<CreateProductResult> {
  const { cwd, store, name, slug: slugArg, description, stage, portfolio_id, area_id, dir, member_kind } = args
  const upgDir = path.resolve(cwd, '.upg')

  // Optional target subfolder (#44). Reject leading slashes and `..`/empty
  // segments so a graph can only ever land INSIDE .upg/. Absent → flat at root.
  let targetDir = upgDir
  if (dir !== undefined) {
    const cleaned = dir.trim().replace(/^[/\\]+/, '')
    if (cleaned.length === 0 || cleaned.split(/[/\\]+/).some((seg) => seg === '..' || seg === '')) {
      throw new InvalidProductNameError('dir must be a relative path inside .upg/ (no leading slash, no "..")')
    }
    targetDir = path.resolve(upgDir, cleaned)
  }

  // Workspace mode required; single-file mode has no place to put the new sibling.
  try {
    await fsp.access(path.join(upgDir, 'workspace.json'))
  } catch {
    throw new WorkspaceNotInitialisedError()
  }
  if (targetDir !== upgDir) await fsp.mkdir(targetDir, { recursive: true })

  // Validate name. Trim whitespace; reject empty / non-string.
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new InvalidProductNameError('name must be a non-empty string')
  }
  const trimmedName = name.trim()

  // Strict validation on the write path. The TypeScript signature
  // (`stage?: UPGProductStage`) is erased at the MCP boundary because args
  // arrive as plain JSON, so we must check at runtime. Reject non-canonical
  // values with a helpful error pointing to the canonical set + any
  // documented coercion target. Reads still soft-coerce (UPGFileStore.load).
  if (stage !== undefined) {
    const stageError = validateProductStageStrict(stage)
    if (stageError !== null) {
      throw new InvalidProductStageError(stageError)
    }
  }

  // Slug: prefer explicit, otherwise derive from name. Resolve collision against
  // existing workspace files (each .upg basename without extension is a slug).
  const dirEntries = await fsp.readdir(targetDir, { withFileTypes: true })
  const existingSlugs = new Set(
    dirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.upg'))
      .map((e) => path.basename(e.name, '.upg')),
  )
  const baseSlug = slugArg && slugArg.trim().length > 0 ? generateSlug(slugArg) : generateSlug(trimmedName)
  const slug = resolveSlugCollision(baseSlug, existingSlugs)
  const filename = `${slug}.upg`
  const destPath = path.join(targetDir, filename)
  // Workspace-relative, forward-slashed path for registration + the return.
  // Flat product → `slug.upg`; subfolder product → `competitors/slug.upg`. (#44)
  const workspaceFile = path.relative(upgDir, destPath).split(path.sep).join('/')

  // Mint product ID via the canonical generator so it matches every other
  // server-minted ID prefix.
  const newProductId = productId()

  // Build a minimal valid UPGDocument. validateUPGDocument() at load-time will
  // confirm shape; integrity is stamped here so the new file is immediately
  // tamper-detectable.
  // Seed a `product` node in the new graph's nodes[] (id === $upg.product.id) so
  // within-graph product_* edges (product_organises_into_feature_area, …) have an
  // anchor immediately, without a manual create_node first. Carries the stage in
  // properties.stage so node-first stage reads (get_graph_digest) agree with the
  // header. §11b.
  const productNode: UPGBaseNode = {
    id: newProductId,
    type: 'product',
    title: trimmedName,
    ...(description ? { description } : {}),
    ...(stage ? { properties: { stage } } : {}),
  }
  const newDoc: UPGDocument = {
    upg_version: UPG_VERSION,
    exported_at: new Date().toISOString(),
    source: { tool: 'upg-mcp-local' },
    product: {
      id: newProductId,
      title: trimmedName,
      ...(description ? { description } : {}),
      ...(stage ? { stage } : {}),
    },
    nodes: [productNode],
    edges: [],
    ...(member_kind === 'org_rollup' || member_kind === 'watched' ? { member_kind } : {}),
  }
  newDoc._integrity = {
    checksum: computeIntegrityChecksum(newDoc),
    verified_at: new Date().toISOString(),
    verified_by: 'upg-mcp-local',
  }

  // Refuse to clobber; should be impossible given collision resolution above
  // but guard anyway in case of a race against an external writer.
  try {
    await fsp.access(destPath)
    throw new Error(`File already exists at ${destPath}; slug resolution failed`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fsp.writeFile(destPath, serializeCanonical(newDoc), 'utf-8')

  // Append to workspace.json's products list
  const workspacePath = path.join(upgDir, 'workspace.json')
  const workspaceRaw = await fsp.readFile(workspacePath, 'utf-8')
  const workspace = JSON.parse(workspaceRaw) as {
    version: string
    default_product: string
    products: WorkspaceProduct[]
  }
  workspace.products = [
    ...workspace.products,
    { file: workspaceFile, title: trimmedName, ...(member_kind === 'org_rollup' || member_kind === 'watched' ? { member_kind } : {}) },
  ]
  await fsp.writeFile(
    workspacePath,
    JSON.stringify(workspace, null, 2) + '\n',
    'utf-8',
  )

  // Register the new product on portfolio.upg, and place it under any requested
  // area/portfolio — all resolved against portfolio.upg ( registry +
  // §A membership). Without the registry, list_local_products sees the
  // product but portfolio views and $upg.counts.products do not. The canonical
  // serialiser derives counts.products from products.length on flush, so one
  // flush keeps the registry, the count, and the membership arrays in sync.
  let portfolioAttached = false
  let areaAttached = false
  const warnings: string[] = []
  const portfolioStore = await openPortfolioStoreIfExists(cwd)
  if (portfolioStore) {
    const portfolioDoc = portfolioStore.getDocument()
    if (portfolioDoc) {
      let dirty = registerProductOnPortfolio(portfolioDoc, {
        id: newProductId,
        file_path: `.upg/${workspaceFile}`,
        title: trimmedName,
        ...(member_kind === 'org_rollup' || member_kind === 'watched' ? { member_kind } : {}),
      })
      if (area_id) {
        const a = addProductToArea(portfolioDoc, area_id, newProductId)
        if (a.found) {
          areaAttached = true
          if (!a.already) dirty = true
        } else {
          warnings.push(`area_id "${area_id}" not found in portfolio.upg — product registered but not placed in an area.`)
        }
      }
      if (portfolio_id) {
        const p = addProductToPortfolio(portfolioDoc, portfolio_id, newProductId)
        if (p.found) {
          portfolioAttached = true
          if (!p.already) dirty = true
        }
      }
      if (dirty) {
        portfolioStore.markDirty()
        await portfolioStore.flush()
      }
    }
  }

  // Back-compat (DEPRECATED, removal targeted after the 0.8.15 window): a
  // portfolio_id that resolves only in the ACTIVE product graph. Pre-0.8.15
  // createProduct mirrored a product node + portfolio_contains_product edge into
  // the active graph; that is superseded by the portfolio.upg resolution above.
  if (portfolio_id && !portfolioAttached) {
    const portfolio = store.getNode(portfolio_id)
    if (portfolio && portfolio.type === 'portfolio') {
      store.addNode({
        id: newProductId,
        type: 'product',
        title: trimmedName,
        ...(description ? { description } : {}),
      })
      store.addEdge({
        id: edgeId(),
        source: portfolio_id,
        target: newProductId,
        type: 'portfolio_contains_product',
      })
      portfolioAttached = true
      warnings.push('portfolio_id resolved in the active product graph (deprecated): attached via an in-graph edge. Prefer a portfolio id from portfolio.upg via attach_product_to_portfolio.')
    }
  }

  return {
    id: newProductId,
    file: workspaceFile,
    slug,
    title: trimmedName,
    workspace_path: '.upg/',
    portfolio_attached: portfolioAttached,
    ...(areaAttached ? { area_attached: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ─── update_product ( §B) ────────────────────────────────────

export interface UpdateProductArgs {
  store: UPGFileStore
  stage?: UPGProductStage
  title?: string
  description?: string
  health_status?: string
  url?: string
}

export interface UpdateProductResult {
  product: Record<string, unknown>
  /** Which header fields were changed. */
  updated: string[]
}

/**
 * Update the product header (`$upg.product`): the canonical home of a product's
 * lifecycle `stage` (the value `get_graph_digest` reads), plus title /
 * description / health_status / url. Strict stage validation mirrors
 * createProduct. Mutates the header in place + marks the store dirty; the caller
 * flushes. Closes the gap where the only way to set a product's stage was to
 * hand-edit the integrity-hashed file.
 */
export function updateProduct(args: UpdateProductArgs): UpdateProductResult {
  const { store, stage, title, description, health_status, url } = args
  const product = store.getProduct() as unknown as
    | (Record<string, unknown> & { stage?: string; title?: string })
    | undefined
  if (!product) throw new Error('No product header to update in this graph.')
  if (stage !== undefined) {
    const stageError = validateProductStageStrict(stage)
    if (stageError !== null) throw new InvalidProductStageError(stageError)
  }
  const updated: string[] = []
  if (stage !== undefined) {
    product.stage = stage
    updated.push('stage')
  }
  if (title !== undefined) {
    product.title = title
    updated.push('title')
  }
  if (description !== undefined) {
    product.description = description
    updated.push('description')
  }
  if (health_status !== undefined) {
    product.health_status = health_status
    updated.push('health_status')
  }
  if (url !== undefined) {
    product.url = url
    updated.push('url')
  }
  if (updated.length > 0) store.markDirty()
  return { product, updated }
}
