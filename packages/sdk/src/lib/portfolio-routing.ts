/**
 * Portfolio routing helpers.
 *
 * Portfolio-scoped entity types (`portfolio`, `organization`, `product_area`)
 * belong in `.upg/portfolio.upg` rather than the active product's `nodes[]`.
 * These helpers centralise:
 *   - resolving the portfolio path for the current workspace
 *   - loading-or-initialising the portfolio store
 *   - appending entities to the right portfolio array (or setting the
 *     singleton `organization`)
 *   - reading portfolio-scoped entities back out in a shape compatible with
 *     `list_portfolios` / `list_product_areas`
 *
 * The set of portfolio-scoped types is intentionally narrow and documented as
 * `PORTFOLIO_SCOPED_TYPES`. Adding a new type means:
 *   1. extending `UPGPortfolioDocument` in `@unified-product-graph/core`
 *   2. extending this set
 *   3. extending the write-routing switch in `writePortfolioScopedNode`
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { nodeId } from './id.js'
import { UPGPortfolioStore } from '../store.js'
import type {
  UPGPortfolioDocument,
  UPGPortfolio,
  UPGProductArea,
  UPGOrganization,
  UPGCrossEdge,
} from '@unified-product-graph/core'
import { UPG_PORTFOLIO_KINDS } from '@unified-product-graph/core'

/** Entity types that live in `.upg/portfolio.upg` instead of a product graph. */
export const PORTFOLIO_SCOPED_TYPES: ReadonlySet<string> = new Set([
  'portfolio',
  'organization',
  'product_area',
])

/** Default portfolio filename within a `.upg/` workspace. */
export const PORTFOLIO_FILENAME = 'portfolio.upg'

/** True when the entity type belongs in the portfolio document. */
export function isPortfolioScopedType(type: string): boolean {
  return PORTFOLIO_SCOPED_TYPES.has(type)
}

/**
 * Resolve the portfolio file path for the current workspace.
 * Returns null if the cwd has no `.upg/` directory.
 */
export function resolvePortfolioPath(cwd: string): string | null {
  const upgDir = path.join(cwd, '.upg')
  if (!fs.existsSync(upgDir)) return null
  return path.join(upgDir, PORTFOLIO_FILENAME)
}

/**
 * Resolve the portfolio file path, creating the `.upg/` directory if it does
 * not exist. Used by write paths that need to mint a portfolio document on
 * demand (e.g. first portfolio entity in a workspace that has product files but
 * never had a portfolio doc).
 */
export function resolveOrCreatePortfolioPath(cwd: string): string {
  const upgDir = path.join(cwd, '.upg')
  if (!fs.existsSync(upgDir)) {
    fs.mkdirSync(upgDir, { recursive: true })
  }
  return path.join(upgDir, PORTFOLIO_FILENAME)
}

/**
 * Open (or initialise) the portfolio store at the given path. Caller is
 * responsible for `flush()`-ing the store when the mutation is committed.
 */
export async function openPortfolioStore(
  portfolioPath: string,
): Promise<UPGPortfolioStore> {
  const store = new UPGPortfolioStore()
  await store.loadOrInit(portfolioPath)
  return store
}

// ── Write routing ────────────────────────────────────────────────────────────

export interface WritePortfolioNodeArgs {
  /** Entity type; must satisfy `isPortfolioScopedType`. */
  type: string
  /** Title for the new entity (or the organisation). */
  title: string
  description?: string
  /** Free-form properties; subset is hoisted onto the typed shape per type. */
  properties?: Record<string, unknown>
  /** When type === 'organization', allow overwriting an existing org. */
  overwrite_organization?: boolean
}

export interface WritePortfolioNodeResult {
  /** Persisted entity shape (the typed record actually written). */
  entity: UPGPortfolio | UPGProductArea | UPGOrganization
  /** Where in the portfolio document the entity was written. */
  written_to: 'portfolios' | 'product_areas' | 'organization'
  /** Absolute portfolio file path. */
  portfolio_file: string
  /** Optional warning (e.g. organization overwrite happened). */
  warning?: string
}

export class PortfolioRoutingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortfolioRoutingError'
  }
}

/**
 * Append (or set, for `organization`) a portfolio-scoped entity into the
 * portfolio document. Creates `.upg/portfolio.upg` on demand.
 *
 * For `organization`: refuses to overwrite an existing org unless
 * `overwrite_organization: true` is supplied. The auto-generated org from
 * `loadOrInit` is treated as a placeholder (org id starting with `org_` and
 * title "Portfolio") and may be replaced silently.
 */
export async function writePortfolioScopedNode(
  cwd: string,
  args: WritePortfolioNodeArgs,
): Promise<WritePortfolioNodeResult> {
  if (!isPortfolioScopedType(args.type)) {
    throw new PortfolioRoutingError(
      `writePortfolioScopedNode called with non-portfolio type "${args.type}". ` +
        `Valid types: ${[...PORTFOLIO_SCOPED_TYPES].join(', ')}.`,
    )
  }

  const portfolioPath = resolveOrCreatePortfolioPath(cwd)
  const store = await openPortfolioStore(portfolioPath)
  const doc = store.getDocument()
  if (!doc) {
    throw new PortfolioRoutingError(
      `Failed to initialise portfolio document at ${portfolioPath}`,
    )
  }

  let result: WritePortfolioNodeResult
  switch (args.type) {
    case 'portfolio':
      result = appendPortfolio(doc, args, portfolioPath)
      break
    case 'product_area':
      result = appendProductArea(doc, args, portfolioPath)
      break
    case 'organization':
      result = setOrganization(doc, args, portfolioPath)
      break
    default:
      // Unreachable thanks to the guard above, but keeps the type checker
      // honest if PORTFOLIO_SCOPED_TYPES grows out of sync.
      throw new PortfolioRoutingError(`Unhandled portfolio-scoped type: ${args.type}`)
  }

  // Mark dirty (the typed mutations above bypass the store's scheduleSave) and
  // flush synchronously so the caller can return a stable response shape.
  // `setDirty` is not exposed on UPGPortfolioStore; we work around by hand-
  // writing through the store's existing API. The simplest cross-cutting hook
  // is `addCrossEdge`-style: it sets `dirty = true` internally. Since we
  // mutated `doc` in place via getDocument(), call a no-op flush primitive.
  //
  // Implementation choice: expose a `markDirty()` on UPGPortfolioStore so
  // callers can opt-in to a flush without going through a typed mutation
  // method. See `store.ts`.
  store.markDirty()
  await store.flush()

  return result
}

function appendPortfolio(
  doc: UPGPortfolioDocument,
  args: WritePortfolioNodeArgs,
  portfolioPath: string,
): WritePortfolioNodeResult {
  const props = args.properties ?? {}
  const entity: UPGPortfolio = {
    id: nodeId(),
    title: args.title,
  }
  if (args.description) entity.description = args.description
  let warning: string | undefined
  if (typeof props.parent_portfolio_id === 'string' || props.parent_portfolio_id === null) {
    entity.parent_portfolio_id = props.parent_portfolio_id as string | null
    if (
      typeof props.parent_portfolio_id === 'string' &&
      !doc.portfolios.some((p) => p.id === props.parent_portfolio_id)
    ) {
      warning = `parent_portfolio_id "${props.parent_portfolio_id}" does not match an existing portfolio; stored as a forward reference.`
    }
  }
  if (
    props.hierarchy_model === 'flat' ||
    props.hierarchy_model === 'nested' ||
    props.hierarchy_model === 'matrix'
  ) {
    entity.hierarchy_model = props.hierarchy_model
  }
  if (typeof props.kind === 'string' && (UPG_PORTFOLIO_KINDS as readonly string[]).includes(props.kind)) {
    entity.kind = props.kind as (typeof UPG_PORTFOLIO_KINDS)[number]
  }
  if (Array.isArray(props.products)) {
    entity.products = props.products.filter((p): p is string => typeof p === 'string')
  }
  doc.portfolios.push(entity)
  return { entity, written_to: 'portfolios', portfolio_file: portfolioPath, ...(warning ? { warning } : {}) }
}

function appendProductArea(
  doc: UPGPortfolioDocument,
  args: WritePortfolioNodeArgs,
  portfolioPath: string,
): WritePortfolioNodeResult {
  const props = args.properties ?? {}
  const entity: UPGProductArea = {
    id: nodeId(),
    title: args.title,
  }
  if (args.description) entity.description = args.description
  if (typeof props.parent_area_id === 'string' || props.parent_area_id === null) {
    entity.parent_area_id = props.parent_area_id as string | null
  }
  // Canonical Priority scale. Coerce legacy 'critical' → 'urgent' (the
  // closest canonical level) so older data and callers degrade gracefully rather
  // than being silently dropped.
  const sp = props.strategic_priority === 'critical' ? 'urgent' : props.strategic_priority
  if (sp === 'urgent' || sp === 'high' || sp === 'medium' || sp === 'low' || sp === 'none') {
    entity.strategic_priority = sp
  }
  if (typeof props.owner === 'string') entity.owner = props.owner
  if (Array.isArray(props.products)) {
    entity.products = props.products.filter((p): p is string => typeof p === 'string')
  }
  doc.product_areas.push(entity)
  return { entity, written_to: 'product_areas', portfolio_file: portfolioPath }
}

function setOrganization(
  doc: UPGPortfolioDocument,
  args: WritePortfolioNodeArgs,
  portfolioPath: string,
): WritePortfolioNodeResult {
  const props = args.properties ?? {}
  const existing = doc.organization
  const isPlaceholder = isPlaceholderOrganization(existing)

  if (existing && !isPlaceholder && !args.overwrite_organization) {
    throw new PortfolioRoutingError(
      `Portfolio already has an organization (id: "${existing.id}", title: ` +
        `"${existing.title}"). A portfolio holds exactly one organization. ` +
        `Pass overwrite_organization: true to replace it (e.g. ` +
        `create_node({type: "organization", title: "...", overwrite_organization: true})), ` +
        `or call update_node on the existing organization id.`,
    )
  }

  const entity: UPGOrganization = {
    id: `org_${createHash('sha256').update(args.title).digest('hex').slice(0, 8)}`,
    title: args.title,
  }
  if (args.description) entity.description = args.description
  if (typeof props.logo_url === 'string') entity.logo_url = props.logo_url
  if (typeof props.industry === 'string') entity.industry = props.industry

  const warning = !isPlaceholder && args.overwrite_organization
    ? `Replaced existing organization "${existing.title}" (id: ${existing.id}) with "${entity.title}" (id: ${entity.id}).`
    : undefined

  doc.organization = entity
  return {
    entity,
    written_to: 'organization',
    portfolio_file: portfolioPath,
    ...(warning ? { warning } : {}),
  }
}

/**
 * The portfolio store auto-creates a placeholder organization on `loadOrInit`
 * (title "Portfolio", id derived from that title). Treat those records as
 * blank slate; they were never authored by a caller.
 */
function isPlaceholderOrganization(
  org: UPGOrganization | undefined | null,
): boolean {
  if (!org) return true
  if (org.title !== 'Portfolio') return false
  const placeholderId = `org_${createHash('sha256').update('Portfolio').digest('hex').slice(0, 8)}`
  return org.id === placeholderId
}

// ── Read routing ─────────────────────────────────────────────────────────────

/**
 * Open the portfolio store if one exists. Returns null when there is no
 * workspace and no portfolio document on disk; callers use this to render an
 * empty list instead of erroring.
 */
export async function openPortfolioStoreIfExists(
  cwd: string,
): Promise<UPGPortfolioStore | null> {
  const portfolioPath = resolvePortfolioPath(cwd)
  if (!portfolioPath) return null
  if (!fs.existsSync(portfolioPath)) return null
  const store = new UPGPortfolioStore()
  await store.loadOrInit(portfolioPath)
  return store
}

// ── Cross-product edge product registration ──────────────────────────────────

/**
 * A lightweight product reference recorded on the portfolio document. The full
 * UPG spec (`UPGPortfolioDocument.products`) types this slot as
 * `UPGProduct & { nodes; edges }`, but the MCP model keeps each product in its
 * own `.upg` file. The reference shape below carries just enough to look the
 * product up later (id + file_path) plus a denormalised title for human-
 * readable listings.
 *
 * If/when the spec adds an explicit `UPGProductReference` type, this shape
 * should migrate to it. The fields are intentionally additive; every field
 * other than `id` is optional so the record stays forward-compatible.
 */
export interface PortfolioProductReference {
  id: string
  /** Workspace-relative path to the product's `.upg` file, when known. */
  file_path?: string
  /** Display title; denormalised from the product's own `product.title`. */
  title?: string
  /**
   * Workspace member kind (0.10.0, #45), cached from the product graph's
   * `$upg.member_kind`. `watched` / `org_rollup` members are registered for
   * reference but excluded from `counts.products`. Absent = `product`.
   */
  member_kind?: 'product' | 'org_rollup' | 'watched' | 'operating_function'
}

/**
 * Ensure that a product is registered on `portfolio.upg.products[]`. No-op when
 * an entry with the same `id` already exists.
 *
 * (S-01): this MUTATES `doc.products` in place. Because `store.flush()`
 * is a no-op unless the store is dirty, the documented "register then flush
 * once" pattern previously DROPPED the append silently (the in-memory mutation
 * was never flagged dirty). Pass the owning `store` and this flags it dirty for
 * you — mirroring `writePortfolioScopedNode`, which flags dirty internally.
 *
 * If you can't pass the store, call `store.markDirty()` yourself BEFORE
 * `flush()`. The 2-arg form is retained for back-compat but is the footgun;
 * prefer the 3-arg form.
 *
 * @returns true when a new entry was appended, false when already present.
 */
export function registerProductOnPortfolio(
  doc: UPGPortfolioDocument,
  ref: PortfolioProductReference,
  store?: { markDirty: () => void },
): boolean {
  if (!ref.id) return false
  // The spec types `products` as `Array<UPGProduct & { nodes; edges }>` but at
  // the MCP layer the products[] slot is used as a lightweight reference index
  // (id + file_path + title). Cast through `unknown` to avoid TS friction at
  // the boundary; runtime shape is preserved.
  const products = doc.products as unknown as PortfolioProductReference[]
  if (products.some((p) => p.id === ref.id)) return false
  const entry: PortfolioProductReference = { id: ref.id }
  if (ref.file_path) entry.file_path = ref.file_path
  if (ref.title) entry.title = ref.title
  if (ref.member_kind === 'org_rollup' || ref.member_kind === 'watched' || ref.member_kind === 'operating_function') entry.member_kind = ref.member_kind
  products.push(entry)
  //: flag the store dirty so the in-memory append survives flush().
  store?.markDirty()
  return true
}

/**
 * Update an EXISTING portfolio registry entry's `member_kind` (spec #44, UPG
 * 0.10.1). Unlike `registerProductOnPortfolio` (which only adds), this upserts
 * the kind on a product already in `products[]`, so a re-kind keeps
 * `$upg.counts.products` (derived from product-kind members on flush) and the
 * anti-pattern `watched`-scoping (`buildProductKindMap`) in sync with the
 * graph's own `$upg.member_kind`. Sets `watched` / `org_rollup`; clears the
 * field for `product` (the absent default). Returns true when the entry was
 * found and changed; the caller flushes.
 */
export function setProductMemberKindOnPortfolio(
  doc: UPGPortfolioDocument,
  productId: string,
  kind: 'product' | 'org_rollup' | 'watched' | 'operating_function',
  store?: { markDirty: () => void },
): boolean {
  if (!productId) return false
  const products = doc.products as unknown as PortfolioProductReference[]
  const entry = products.find((p) => p.id === productId)
  if (!entry) return false
  const current =
    entry.member_kind === 'org_rollup' || entry.member_kind === 'watched' || entry.member_kind === 'operating_function'
      ? entry.member_kind
      : 'product'
  if (current === kind) return false
  if (kind === 'product') delete entry.member_kind
  else entry.member_kind = kind
  store?.markDirty()
  return true
}

/**
 * Update an EXISTING portfolio registry entry's cached `title` (0.17.0). The
 * `products[].title` slot is denormalised from the product graph's own
 * `product.title`; renaming a product via `update_product({title})` must
 * reconcile this cache so portfolio reads (`portfolio_census` / `portfolio_digest`
 * / `findProductFileById`) show the current name rather than the title cached at
 * create time. Returns true when the entry was found and the title changed; the
 * caller flushes.
 */
export function setProductTitleOnPortfolio(
  doc: UPGPortfolioDocument,
  productId: string,
  title: string,
  store?: { markDirty: () => void },
): boolean {
  if (!productId) return false
  const products = doc.products as unknown as PortfolioProductReference[]
  const entry = products.find((p) => p.id === productId)
  if (!entry) return false
  if (entry.title === title) return false
  entry.title = title
  store?.markDirty()
  return true
}

/**
 * Update an EXISTING portfolio registry entry's cached `file_path` (0.17.2). The
 * `products[].file_path` slot is workspace-relative and points at the product's
 * `.upg` file; renaming the file via `update_product({rename_file})` must
 * reconcile it so portfolio reads and `findProductFileById` resolve the new path
 * rather than a path that no longer exists. Returns true when the entry was found
 * and the path changed; the caller flushes.
 */
export function setProductFilePathOnPortfolio(
  doc: UPGPortfolioDocument,
  productId: string,
  filePath: string,
  store?: { markDirty: () => void },
): boolean {
  if (!productId) return false
  const products = doc.products as unknown as PortfolioProductReference[]
  const entry = products.find((p) => p.id === productId)
  if (!entry) return false
  if (entry.file_path === filePath) return false
  entry.file_path = filePath
  store?.markDirty()
  return true
}

/**
 * Best-effort lookup of a product's `.upg` file and title given its product id.
 *
 * Resolves against the workspace registry, NOT just the `.upg/` root: candidate
 * files are the flat `.upg/*.upg` scan PLUS every subpath registered in
 * `.upg/workspace.json` (a product created with `dir:` lives in a subfolder,
 * e.g. `.upg/web-ecosystem/<slug>.upg`, and is invisible to a root-only scan).
 * workspace.json is the source of truth for placement; the flat scan is the
 * convenience fallback. This keeps every product resolver that calls it
 * (attach/detach/assign/move + the registry tools) consistent with
 * `list_local_products` / `findWorkspaceUpgFiles`. Returns null when no
 * candidate's `product.id` matches.
 */
export function findProductFileById(
  cwd: string,
  productId: string,
): { file_path: string; title: string } | null {
  const upgDir = path.join(cwd, '.upg')
  if (!fs.existsSync(upgDir)) return null

  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (abs: string) => {
    const resolved = path.resolve(abs)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      candidates.push(resolved)
    }
  }

  // (a) Flat `.upg/*.upg` scan (the historical behaviour).
  try {
    for (const entry of fs.readdirSync(upgDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.upg')) continue
      if (entry.name === PORTFOLIO_FILENAME) continue
      add(path.join(upgDir, entry.name))
    }
  } catch {
    return null
  }

  // (b) workspace.json-registered subpaths (resolved relative to `.upg/`, at any
  // depth). Tolerant: a missing/malformed workspace.json leaves the scan alone.
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(upgDir, 'workspace.json'), 'utf-8')) as {
      products?: Array<{ file?: unknown }>
    }
    for (const p of ws.products ?? []) {
      if (typeof p.file !== 'string') continue
      const abs = path.resolve(upgDir, p.file)
      if (fs.existsSync(abs)) add(abs)
    }
  } catch {
    // no workspace.json / malformed — the flat scan stands alone
  }

  for (const filePath of candidates) {
    try {
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { product?: { id?: string; title?: string } }
      if (doc.product?.id === productId) {
        return {
          file_path: path.relative(cwd, filePath),
          title: doc.product.title ?? path.basename(filePath),
        }
      }
    } catch {
      // skip unreadable/malformed file
    }
  }
  return null
}

// ── Product → container membership ( §A) ──────────────────────────────

export interface ProductMembershipResult {
  product_id: string
  container_id: string
  container_kind: 'product_area' | 'portfolio'
  container_title?: string
  /** True when the product was already a member (no-op append). */
  already_member: boolean
  /** True when the product was newly added to portfolio.upg.products[]. */
  registered: boolean
}

/**
 * Add a product id to a `product_area`'s `products[]` (dedup). Doc-level, no I/O —
 * the caller owns flushing. Returns `found: false` when no area matches.
 */
export function addProductToArea(
  doc: UPGPortfolioDocument,
  areaId: string,
  productId: string,
): { found: boolean; title?: string; already: boolean } {
  const area = doc.product_areas.find((a) => a.id === areaId)
  if (!area) return { found: false, already: false }
  const members = area.products ?? []
  const already = members.includes(productId)
  if (!already) area.products = [...members, productId]
  return { found: true, title: area.title, already }
}

/**
 * Add a product id to a `portfolio`'s `products[]` (dedup). Doc-level, no I/O.
 * Returns `found: false` when no portfolio matches.
 */
export function addProductToPortfolio(
  doc: UPGPortfolioDocument,
  portfolioId: string,
  productId: string,
): { found: boolean; title?: string; already: boolean } {
  const portfolio = doc.portfolios.find((p) => p.id === portfolioId)
  if (!portfolio) return { found: false, already: false }
  const members = portfolio.products ?? []
  const already = members.includes(productId)
  if (!already) portfolio.products = [...members, productId]
  return { found: true, title: portfolio.title, already }
}

async function attachProductToContainer(
  cwd: string,
  productId: string,
  containerId: string,
  kind: 'product_area' | 'portfolio',
): Promise<ProductMembershipResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) {
    throw new PortfolioRoutingError(
      `No portfolio document in this workspace. Create a ${kind === 'product_area' ? 'product area (create_area)' : 'portfolio (create_node {type:"portfolio"})'} first.`,
    )
  }
  const doc = store.getDocument()
  if (!doc) throw new PortfolioRoutingError('Portfolio document failed to load.')
  const lookup = findProductFileById(cwd, productId)
  if (!lookup) {
    throw new PortfolioRoutingError(
      `Product not found in this workspace: "${productId}". Create it with create_product, or check list_local_products.`,
    )
  }
  const add =
    kind === 'product_area'
      ? addProductToArea(doc, containerId, productId)
      : addProductToPortfolio(doc, containerId, productId)
  if (!add.found) {
    const label = kind === 'product_area' ? 'Product area' : 'Portfolio'
    const lister = kind === 'product_area' ? 'list_product_areas' : 'list_portfolios'
    throw new PortfolioRoutingError(
      `${label} not found in portfolio.upg: "${containerId}". List them with ${lister}.`,
    )
  }
  // Keep the product in the portfolio.upg registry too, so cross-surface lookups
  // resolve. registerProductOnPortfolio is a no-op when already present.
  const registered = registerProductOnPortfolio(doc, {
    id: productId,
    file_path: lookup.file_path,
    title: lookup.title,
  })
  if (!add.already || registered) {
    store.markDirty()
    await store.flush()
  }
  return {
    product_id: productId,
    container_id: containerId,
    container_kind: kind,
    container_title: add.title,
    already_member: add.already,
    registered,
  }
}

/**
 * Place a product inside a `product_area` (`area.products[]`) — resolving the area
 * against `portfolio.upg`, NOT the active product graph. Auto-registers the product
 * on the portfolio registry. Throws `PortfolioRoutingError` on a missing workspace,
 * product, or area.
 */
export function assignProductToArea(
  cwd: string,
  args: { product_id: string; area_id: string },
): Promise<ProductMembershipResult> {
  return attachProductToContainer(cwd, args.product_id, args.area_id, 'product_area')
}

/**
 * Place a product inside a `portfolio` (`portfolio.products[]`) — resolving the
 * portfolio against `portfolio.upg`. Auto-registers the product on the registry.
 * Throws `PortfolioRoutingError` on a missing workspace, product, or portfolio.
 */
export function attachProductToPortfolio(
  cwd: string,
  args: { product_id: string; portfolio_id: string },
): Promise<ProductMembershipResult> {
  return attachProductToContainer(cwd, args.product_id, args.portfolio_id, 'portfolio')
}

// ── Area editing + re-parenting ( §7) ─────────────────────────────────

/** Coerce a raw priority to the canonical scale, mapping legacy 'critical' → 'urgent'. */
function coerceStrategicPriority(
  raw: unknown,
): UPGProductArea['strategic_priority'] | undefined {
  const sp = raw === 'critical' ? 'urgent' : raw
  if (sp === 'urgent' || sp === 'high' || sp === 'medium' || sp === 'low' || sp === 'none') return sp
  return undefined
}

export interface UpdateAreaArgs {
  title?: string
  description?: string
  /** Canonical Priority; legacy 'critical' is coerced to 'urgent'. */
  strategic_priority?: string
  /** Re-parent target. `null` un-nests (makes the area top-level). Omit to leave unchanged. */
  parent_area_id?: string | null
  owner?: string
}

export interface UpdateAreaResult {
  area: UPGProductArea
  /** Names of the fields that changed. */
  updated: string[]
}

/**
 * Edit a `product_area` in `portfolio.upg` (title / description / strategic_priority /
 * owner) and/or re-parent it via `parent_area_id` (`null` un-nests). Re-parenting is
 * validated: the parent must exist, cannot be the area itself, and must not create a
 * cycle. The mirror of `updateProduct` for the organisational axis. Throws
 * `PortfolioRoutingError` on a missing workspace, unknown area/parent, or a cycle.
 */
export async function updateProductArea(
  cwd: string,
  areaId: string,
  args: UpdateAreaArgs,
): Promise<UpdateAreaResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) {
    throw new PortfolioRoutingError(
      'No portfolio document in this workspace. Create a product area (create_area) first.',
    )
  }
  const doc = store.getDocument()
  if (!doc) throw new PortfolioRoutingError('Portfolio document failed to load.')
  const area = doc.product_areas.find((a) => a.id === areaId)
  if (!area) {
    throw new PortfolioRoutingError(
      `Product area not found in portfolio.upg: "${areaId}". List them with list_product_areas.`,
    )
  }

  const updated: string[] = []
  if (typeof args.title === 'string') {
    area.title = args.title
    updated.push('title')
  }
  if (typeof args.description === 'string') {
    area.description = args.description
    updated.push('description')
  }
  if (args.strategic_priority !== undefined) {
    const sp = coerceStrategicPriority(args.strategic_priority)
    if (sp === undefined) {
      throw new PortfolioRoutingError(
        `Invalid strategic_priority: "${args.strategic_priority}". Valid: urgent, high, medium, low, none.`,
      )
    }
    area.strategic_priority = sp
    updated.push('strategic_priority')
  }
  if (typeof args.owner === 'string') {
    area.owner = args.owner
    updated.push('owner')
  }
  if (args.parent_area_id !== undefined) {
    if (args.parent_area_id === null) {
      area.parent_area_id = null
    } else {
      const parentId = args.parent_area_id
      if (parentId === areaId) {
        throw new PortfolioRoutingError('A product area cannot be its own parent.')
      }
      if (!doc.product_areas.some((a) => a.id === parentId)) {
        throw new PortfolioRoutingError(
          `Parent area not found in portfolio.upg: "${parentId}". List them with list_product_areas.`,
        )
      }
      // Cycle guard: walk up from the proposed parent; reaching areaId is a cycle.
      const seen = new Set<string>()
      let cursor: string | null | undefined = parentId
      while (cursor) {
        if (cursor === areaId) {
          throw new PortfolioRoutingError(
            `Re-parenting "${areaId}" under "${parentId}" would create a cycle.`,
          )
        }
        if (seen.has(cursor)) break
        seen.add(cursor)
        cursor = doc.product_areas.find((a) => a.id === cursor)?.parent_area_id ?? null
      }
      area.parent_area_id = parentId
    }
    updated.push('parent_area_id')
  }

  if (updated.length > 0) {
    store.markDirty()
    await store.flush()
  }
  return { area, updated }
}

// ── Portfolio-tier removal / detach / delete ( §8) ────────────────────

export interface RemoveMembershipResult {
  product_id: string
  container_id: string
  container_kind: 'product_area' | 'portfolio'
  container_title?: string
  /** True when the product was a member and was removed. */
  removed: boolean
}

async function removeProductFromContainer(
  cwd: string,
  productId: string,
  containerId: string,
  kind: 'product_area' | 'portfolio',
): Promise<RemoveMembershipResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) throw new PortfolioRoutingError('No portfolio document in this workspace.')
  const doc = store.getDocument()
  if (!doc) throw new PortfolioRoutingError('Portfolio document failed to load.')
  const container =
    kind === 'product_area'
      ? doc.product_areas.find((a) => a.id === containerId)
      : doc.portfolios.find((p) => p.id === containerId)
  if (!container) {
    const label = kind === 'product_area' ? 'Product area' : 'Portfolio'
    const lister = kind === 'product_area' ? 'list_product_areas' : 'list_portfolios'
    throw new PortfolioRoutingError(
      `${label} not found in portfolio.upg: "${containerId}". List them with ${lister}.`,
    )
  }
  const members = container.products ?? []
  const removed = members.includes(productId)
  if (removed) {
    container.products = members.filter((p) => p !== productId)
    store.markDirty()
    await store.flush()
  }
  return {
    product_id: productId,
    container_id: containerId,
    container_kind: kind,
    container_title: container.title,
    removed,
  }
}

/**
 * Remove a product from a `product_area`'s `products[]` (it stays registered on the
 * portfolio and in any other container). The inverse of `assignProductToArea`.
 */
export function removeProductFromArea(
  cwd: string,
  args: { product_id: string; area_id: string },
): Promise<RemoveMembershipResult> {
  return removeProductFromContainer(cwd, args.product_id, args.area_id, 'product_area')
}

/**
 * Remove a product from a `portfolio`'s `products[]` (it stays registered and in any
 * other container). The inverse of `attachProductToPortfolio`.
 */
export function detachProductFromPortfolio(
  cwd: string,
  args: { product_id: string; portfolio_id: string },
): Promise<RemoveMembershipResult> {
  return removeProductFromContainer(cwd, args.product_id, args.portfolio_id, 'portfolio')
}

export interface DeleteAreaResult {
  area_id: string
  deleted: boolean
  /** Child areas that were un-nested (parent_area_id set to null) as a side effect. */
  unnested_children: string[]
}

/**
 * Delete a `product_area` from `portfolio.upg`. Guarded: refuses while the area still
 * has products unless `force` is set (so a mis-delete can't silently strand
 * memberships). Child areas are un-nested (their `parent_area_id` is set to null) so
 * no parent reference dangles. Throws `PortfolioRoutingError` on a missing workspace,
 * unknown area, or a non-empty area without `force`.
 */
export async function deleteArea(
  cwd: string,
  areaId: string,
  opts?: { force?: boolean },
): Promise<DeleteAreaResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) throw new PortfolioRoutingError('No portfolio document in this workspace.')
  const doc = store.getDocument()
  if (!doc) throw new PortfolioRoutingError('Portfolio document failed to load.')
  const idx = doc.product_areas.findIndex((a) => a.id === areaId)
  if (idx === -1) {
    throw new PortfolioRoutingError(
      `Product area not found in portfolio.upg: "${areaId}". List them with list_product_areas.`,
    )
  }
  const memberCount = doc.product_areas[idx].products?.length ?? 0
  if (memberCount > 0 && !opts?.force) {
    throw new PortfolioRoutingError(
      `Product area "${areaId}" still has ${memberCount} product(s). Remove them ` +
        `(remove_product_from_area / move_product_to_area) first, or pass force: true.`,
    )
  }
  const unnestedChildren: string[] = []
  for (const a of doc.product_areas) {
    if (a.parent_area_id === areaId) {
      a.parent_area_id = null
      unnestedChildren.push(a.id)
    }
  }
  doc.product_areas.splice(idx, 1)
  store.markDirty()
  await store.flush()
  return { area_id: areaId, deleted: true, unnested_children: unnestedChildren }
}

export interface DeleteCrossEdgeResult {
  edge_id: string
  deleted: boolean
  edge?: UPGCrossEdge
}

/**
 * Delete a cross-product edge from `portfolio.upg` by id. The inverse of
 * `createCrossProductEdge`. Returns `deleted: false` (not an error) when no edge with
 * that id exists, so retries are idempotent.
 */
export async function deleteCrossProductEdge(
  cwd: string,
  edgeId: string,
): Promise<DeleteCrossEdgeResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) throw new PortfolioRoutingError('No portfolio document in this workspace.')
  const removed = store.removeCrossEdge(edgeId)
  if (removed) await store.flush()
  return { edge_id: edgeId, deleted: removed !== null, ...(removed ? { edge: removed } : {}) }
}

export interface MoveProductResult {
  product_id: string
  to_area_id: string
  to_area_title?: string
  /** Area ids the product was removed from as part of the move. */
  removed_from: string[]
  /** True when the product was newly added to the target (false if already a member). */
  added: boolean
}

/**
 * Move a product to a different `product_area`: remove it from `from_area_id` (or, when
 * omitted, from every area it currently sits in) and add it to `to_area_id` (dedup).
 * Convenience over remove + assign. Throws `PortfolioRoutingError` on a missing
 * workspace, unknown product, or unknown target area.
 */
export async function moveProductToArea(
  cwd: string,
  args: { product_id: string; to_area_id: string; from_area_id?: string },
): Promise<MoveProductResult> {
  const store = await openPortfolioStoreIfExists(cwd)
  if (!store) throw new PortfolioRoutingError('No portfolio document in this workspace.')
  const doc = store.getDocument()
  if (!doc) throw new PortfolioRoutingError('Portfolio document failed to load.')
  const toArea = doc.product_areas.find((a) => a.id === args.to_area_id)
  if (!toArea) {
    throw new PortfolioRoutingError(
      `Target product area not found in portfolio.upg: "${args.to_area_id}". List them with list_product_areas.`,
    )
  }
  const lookup = findProductFileById(cwd, args.product_id)
  if (!lookup) {
    throw new PortfolioRoutingError(
      `Product not found in this workspace: "${args.product_id}". Create it with create_product, or check list_local_products.`,
    )
  }
  const removedFrom: string[] = []
  for (const a of doc.product_areas) {
    if (a.id === args.to_area_id) continue
    if (args.from_area_id && a.id !== args.from_area_id) continue
    const members = a.products ?? []
    if (members.includes(args.product_id)) {
      a.products = members.filter((p) => p !== args.product_id)
      removedFrom.push(a.id)
    }
  }
  const add = addProductToArea(doc, args.to_area_id, args.product_id)
  registerProductOnPortfolio(doc, {
    id: args.product_id,
    file_path: lookup.file_path,
    title: lookup.title,
  })
  store.markDirty()
  await store.flush()
  return {
    product_id: args.product_id,
    to_area_id: args.to_area_id,
    to_area_title: toArea.title,
    removed_from: removedFrom,
    added: !add.already,
  }
}
