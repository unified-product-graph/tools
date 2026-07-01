/**
 * Portfolio STRUCTURE assembly (0.17.3). The org-chart complement to
 * `portfolio-landscape.ts`: where the landscape walks the classification CROSS
 * edges into the shared registry, this renders the portfolio's OWN document
 * fields — organisation, product areas, portfolios, and the products that belong
 * to them — as a nested tree. No graph traversal, no registry, no cross-edges:
 * a pure walk of `organization` / `product_areas` / `portfolios` / `products`.
 *
 *   organization
 *   ├── product_area            (top-level: no parent_area_id)
 *   │   ├── product_area        (sub-area via parent_area_id)
 *   │   └── product             (member via area.products[])
 *   └── portfolio               (top-level: no parent_portfolio_id)
 *       ├── portfolio           (sub-portfolio via parent_portfolio_id)
 *       └── product             (member via portfolio.products[])
 *
 * Areas and portfolios are two independent groupings of the same products (the
 * ownership axis and the strategic axis), so a product can appear under both —
 * the tree shows each membership rather than forcing a single home. Malformed
 * parent references (a cycle, or a parent id that does not exist) are surfaced at
 * the top level rather than dropped, so the gap in the document is visible.
 *
 * Pure functions over a `UPGPortfolioDocument`; no I/O. Lives in the SDK so the
 * local server and any future consumer assemble an identical shape from one
 * source. (Portfolio reads have no cloud analogue — the cloud server is
 * single-product-per-request — so there is no cloud counterpart, by design.)
 *
 * https://unifiedproductgraph.org | MIT
 */
import type { UPGPortfolioDocument, UPGPortfolioKind } from '@unified-product-graph/core'

/** One node in the structure tree: the org root, an area, a portfolio, or a product leaf. */
export interface StructureNode {
  /** The entity id (area / portfolio / product / organisation id). */
  id: string
  /** Human-readable title, resolved from the document (product id as a last resort). */
  title: string
  /** Which kind of document entity this node is. */
  kind: 'organization' | 'product_area' | 'portfolio' | 'product'
  /** Area only: the area's strategic priority, when set. */
  strategic_priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  /** Area only: the person or team that owns the area, when set. */
  owner?: string
  /** Portfolio only: the investment posture, when set. */
  portfolio_kind?: UPGPortfolioKind
  /** Product only: the product's lifecycle stage, when known. */
  stage?: string
  /** Product only: true when the product id is referenced but not registered in `products[]`. */
  unregistered?: true
  /** Child nodes (sub-areas / sub-portfolios / member products). Absent for a leaf. */
  children?: StructureNode[]
}

/** Counts describing the assembled structure. */
export interface StructureStats {
  areas: number
  portfolios: number
  /** Distinct products registered in the portfolio document (`products[]`). */
  products: number
  /** Registered products referenced by no area and no portfolio. */
  unassigned_products: number
}

/** The `shape: "structure"` result: the org tree plus counts. */
export interface PortfolioStructure {
  shape: 'structure'
  root: StructureNode
  stats: StructureStats
  note?: string
}

/** Resolve a product id to a `product` leaf, falling back to the id when unregistered. */
function productLeaf(
  productId: string,
  registered: Map<string, { title: string; stage?: string }>,
): StructureNode {
  const hit = registered.get(productId)
  if (hit) {
    return { id: productId, title: hit.title, kind: 'product', ...(hit.stage ? { stage: hit.stage } : {}) }
  }
  return { id: productId, title: productId, kind: 'product', unregistered: true }
}

/**
 * Assemble the portfolio's organisational structure from document fields. Pure;
 * reads only `organization`, `product_areas`, `portfolios`, and `products`.
 */
export function assembleStructure(doc: UPGPortfolioDocument): PortfolioStructure {
  const areas = doc.product_areas ?? []
  const portfolios = doc.portfolios ?? []
  const products = doc.products ?? []

  const registered = new Map<string, { title: string; stage?: string }>()
  for (const p of products) registered.set(p.id, { title: p.title, ...(p.stage ? { stage: p.stage } : {}) })

  const assigned = new Set<string>()

  // ── Product areas (nested via parent_area_id) ──────────────────────────────
  const areaById = new Map(areas.map((a) => [a.id, a]))
  const areaChildren = new Map<string, typeof areas>()
  const topAreas: typeof areas = []
  for (const a of areas) {
    // A parent that is absent, null, or dangling makes this a top-level area
    // (a dangling parent is surfaced here rather than silently dropped).
    const parent = a.parent_area_id
    if (parent && areaById.has(parent)) {
      const sibs = areaChildren.get(parent) ?? []
      sibs.push(a)
      areaChildren.set(parent, sibs)
    } else {
      topAreas.push(a)
    }
  }
  const buildArea = (id: string, seen: Set<string>): StructureNode | null => {
    if (seen.has(id)) return null // cycle guard
    seen.add(id)
    const a = areaById.get(id)!
    const children: StructureNode[] = []
    for (const sub of areaChildren.get(id) ?? []) {
      const node = buildArea(sub.id, seen)
      if (node) children.push(node)
    }
    for (const pid of a.products ?? []) {
      assigned.add(pid)
      children.push(productLeaf(pid, registered))
    }
    return {
      id: a.id,
      title: a.title,
      kind: 'product_area',
      ...(a.strategic_priority ? { strategic_priority: a.strategic_priority } : {}),
      ...(a.owner ? { owner: a.owner } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  }

  // ── Portfolios (nested via parent_portfolio_id) ────────────────────────────
  const pfById = new Map(portfolios.map((p) => [p.id, p]))
  const pfChildren = new Map<string, typeof portfolios>()
  const topPfs: typeof portfolios = []
  for (const p of portfolios) {
    const parent = p.parent_portfolio_id
    if (parent && pfById.has(parent)) {
      const sibs = pfChildren.get(parent) ?? []
      sibs.push(p)
      pfChildren.set(parent, sibs)
    } else {
      topPfs.push(p)
    }
  }
  const buildPortfolio = (id: string, seen: Set<string>): StructureNode | null => {
    if (seen.has(id)) return null // cycle guard
    seen.add(id)
    const p = pfById.get(id)!
    const children: StructureNode[] = []
    for (const sub of pfChildren.get(id) ?? []) {
      const node = buildPortfolio(sub.id, seen)
      if (node) children.push(node)
    }
    for (const pid of p.products ?? []) {
      assigned.add(pid)
      children.push(productLeaf(pid, registered))
    }
    return {
      id: p.id,
      title: p.title,
      kind: 'portfolio',
      ...(p.kind ? { portfolio_kind: p.kind } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  }

  const rootChildren: StructureNode[] = []
  const areaSeen = new Set<string>()
  for (const a of topAreas) {
    const node = buildArea(a.id, areaSeen)
    if (node) rootChildren.push(node)
  }
  // Any area never reached from a top-level root is part of a parent cycle with no
  // root; promote it to a top-level root so it surfaces instead of vanishing.
  for (const a of areas) {
    if (!areaSeen.has(a.id)) {
      const node = buildArea(a.id, areaSeen)
      if (node) rootChildren.push(node)
    }
  }
  const pfSeen = new Set<string>()
  for (const p of topPfs) {
    const node = buildPortfolio(p.id, pfSeen)
    if (node) rootChildren.push(node)
  }
  for (const p of portfolios) {
    if (!pfSeen.has(p.id)) {
      const node = buildPortfolio(p.id, pfSeen)
      if (node) rootChildren.push(node)
    }
  }

  const unassigned = [...registered.keys()].filter((id) => !assigned.has(id))
  // Registered-but-unassigned products hang directly off the org, so nothing is
  // lost from the view (a product with no area and no portfolio still shows).
  for (const pid of unassigned) rootChildren.push(productLeaf(pid, registered))

  const org = doc.organization
  const root: StructureNode = {
    id: org?.id ?? 'organization',
    title: org?.title ?? 'Organisation',
    kind: 'organization',
    ...(rootChildren.length > 0 ? { children: rootChildren } : {}),
  }

  return {
    shape: 'structure',
    root,
    stats: {
      areas: areas.length,
      portfolios: portfolios.length,
      products: registered.size,
      unassigned_products: unassigned.length,
    },
    note:
      'Structural org chart from the portfolio document fields (organisation, product areas, portfolios, products). ' +
      'Areas are the ownership axis and portfolios the strategic axis, so a product can appear under both. ' +
      'For the classification landscape use get_portfolio_tree({ shape: "landscape" }); for a product spine use get_tree.',
  }
}
