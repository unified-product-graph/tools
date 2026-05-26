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
import type { UPGDocument, UPGProductStage } from '@unified-product-graph/core'
import {
  generateSlug,
  resolveSlugCollision,
  UPG_VERSION,
  validateProductStageStrict,
} from '@unified-product-graph/core'
import { edgeId, productId } from './id.js'

export interface WorkspaceProduct {
  file: string
  title: string
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
    // Malformed file or unreadable — fall back to filename
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
    // ENOENT — good, no workspace yet
  }

  await fsp.mkdir(upgDir, { recursive: true })

  // Root-level .upg files that may need moving. Use withFileTypes to filter
  // out the `.upg` directory entry itself — `'.upg'.endsWith('.upg')` would
  // otherwise match it and trigger a rename of the directory into itself.
  const rootEntries = await fsp.readdir(resolvedCwd, { withFileTypes: true })
  const rootUpgFiles = rootEntries
    .filter((e) => e.isFile() && e.name.endsWith('.upg'))
    .map((e) => e.name)
    .sort()

  // Pre-existing .upg files already living inside .upg/ — they are products
  // even if the user never moved them. Register without re-moving.
  let preExistingFiles: string[] = []
  try {
    const upgDirEntries = await fsp.readdir(upgDir, { withFileTypes: true })
    preExistingFiles = upgDirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.upg'))
      .map((e) => e.name)
      .sort()
  } catch {
    // Directory was just created or unreadable — treat as empty
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
      // alone — non-destructive by default.
      let destExists = false
      try {
        await fsp.access(destPath)
        destExists = true
      } catch {
        // dest absent — safe to move
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
   * Optional portfolio node id in the CURRENT loaded store. When provided,
   * a `product` node + `portfolio_contains_product` edge are created in the
   * current store to express the hierarchy (portfolios live in a single .upg).
   */
  portfolio_id?: string
}

export interface CreateProductResult {
  id: string
  file: string
  slug: string
  title: string
  workspace_path: string
  portfolio_attached: boolean
}

/** Compute the integrity checksum a freshly written .upg file would carry. */
function computeIntegrityChecksum(doc: UPGDocument): string {
  const sortedNodes = [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = [...doc.edges].sort((a, b) => a.id.localeCompare(b.id))
  const content = JSON.stringify({ nodes: sortedNodes, edges: sortedEdges })
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

export async function createProduct(args: CreateProductArgs): Promise<CreateProductResult> {
  const { cwd, store, name, slug: slugArg, description, stage, portfolio_id } = args
  const upgDir = path.resolve(cwd, '.upg')

  // Workspace mode required — single-file mode has no place to put the new sibling.
  try {
    await fsp.access(path.join(upgDir, 'workspace.json'))
  } catch {
    throw new WorkspaceNotInitialisedError()
  }

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
  const upgDirEntries = await fsp.readdir(upgDir, { withFileTypes: true })
  const existingSlugs = new Set(
    upgDirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.upg'))
      .map((e) => path.basename(e.name, '.upg')),
  )
  const baseSlug = slugArg && slugArg.trim().length > 0 ? generateSlug(slugArg) : generateSlug(trimmedName)
  const slug = resolveSlugCollision(baseSlug, existingSlugs)
  const filename = `${slug}.upg`
  const destPath = path.join(upgDir, filename)

  // Mint product ID via the canonical generator so it matches every other
  // server-minted ID prefix.
  const newProductId = productId()

  // Build a minimal valid UPGDocument. validateUPGDocument() at load-time will
  // confirm shape; integrity is stamped here so the new file is immediately
  // tamper-detectable.
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
    nodes: [],
    edges: [],
  }
  newDoc._integrity = {
    checksum: computeIntegrityChecksum(newDoc),
    verified_at: new Date().toISOString(),
    verified_by: 'upg-mcp-local',
  }

  // Refuse to clobber — should be impossible given collision resolution above
  // but guard anyway in case of a race against an external writer.
  try {
    await fsp.access(destPath)
    throw new Error(`File already exists at ${destPath} — slug resolution failed`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fsp.writeFile(destPath, JSON.stringify(newDoc, null, 2) + '\n', 'utf-8')

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
    { file: filename, title: trimmedName },
  ]
  await fsp.writeFile(
    workspacePath,
    JSON.stringify(workspace, null, 2) + '\n',
    'utf-8',
  )

  // Optional portfolio attachment in the CURRENT store. The portfolio lives in
  // a single .upg file; portfolio_contains_product is an in-graph hierarchy
  // edge, not a cross-product one.
  let portfolioAttached = false
  if (portfolio_id) {
    const portfolio = store.getNode(portfolio_id)
    if (portfolio && portfolio.type === 'portfolio') {
      // Mirror the new product as a node in the current store so the edge can
      // attach to a real target. The node id matches the new product's id.
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
    }
  }

  return {
    id: newProductId,
    file: filename,
    slug,
    title: trimmedName,
    workspace_path: '.upg/',
    portfolio_attached: portfolioAttached,
  }
}
