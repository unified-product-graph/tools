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
} from '@unified-product-graph/core'

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
  if (typeof props.parent_portfolio_id === 'string' || props.parent_portfolio_id === null) {
    entity.parent_portfolio_id = props.parent_portfolio_id as string | null
  }
  if (
    props.hierarchy_model === 'flat' ||
    props.hierarchy_model === 'nested' ||
    props.hierarchy_model === 'matrix'
  ) {
    entity.hierarchy_model = props.hierarchy_model
  }
  if (Array.isArray(props.products)) {
    entity.products = props.products.filter((p): p is string => typeof p === 'string')
  }
  doc.portfolios.push(entity)
  return { entity, written_to: 'portfolios', portfolio_file: portfolioPath }
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
  if (
    props.strategic_priority === 'critical' ||
    props.strategic_priority === 'high' ||
    props.strategic_priority === 'medium' ||
    props.strategic_priority === 'low'
  ) {
    entity.strategic_priority = props.strategic_priority
  }
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
  products.push(entry)
  //: flag the store dirty so the in-memory append survives flush().
  store?.markDirty()
  return true
}

/**
 * Best-effort lookup of a product's `.upg` file and title given its product
 * id. Walks the workspace `.upg/` directory looking for a file whose
 * `product.id` matches. Returns null when not found or when the workspace
 * lookup fails.
 */
export function findProductFileById(
  cwd: string,
  productId: string,
): { file_path: string; title: string } | null {
  const upgDir = path.join(cwd, '.upg')
  if (!fs.existsSync(upgDir)) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(upgDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.upg')) continue
    // Skip the portfolio file itself.
    if (entry.name === PORTFOLIO_FILENAME) continue
    const filePath = path.join(upgDir, entry.name)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const doc = JSON.parse(raw) as { product?: { id?: string; title?: string } }
      if (doc.product?.id === productId) {
        return {
          file_path: path.relative(cwd, filePath),
          title: doc.product.title ?? entry.name,
        }
      }
    } catch {
      // skip unreadable/malformed file
    }
  }
  return null
}
