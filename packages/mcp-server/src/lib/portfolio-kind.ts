/**
 * Portfolio investment-posture classification (UPG 0.9.27, spec issue #39).
 *
 * A portfolio carries `kind: 'owned' | 'watched'` (see `UPGPortfolio`). `owned`
 * products are things we build and manage; `watched` products are an externally
 * monitored landscape (competitor intelligence graphs). Product-management
 * expectations (coverage, health, product-spine anti-patterns) are category
 * errors for a watched graph: a competitor-intelligence graph legitimately has
 * no personas, hypotheses, or roadmap, and must not be flipped invalid or drag
 * portfolio health for lacking them.
 *
 * This is a TOOLING concern, not a spec one: the `kind` field is in the spec,
 * but the read of `.upg/portfolio.upg` to classify a product lives here so the
 * pure spec evaluator stays portfolio-agnostic.
 *
 * Synchronous + fully tolerant: any missing/malformed portfolio document yields
 * an empty map (every product defaults to 'owned' — back-compat).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type ProductKind = 'owned' | 'watched'

/**
 * Map every portfolio-affiliated product id to its posture. A product is
 * `watched` iff it belongs to at least one `watched` portfolio and zero `owned`
 * portfolios (a product co-listed under an owned portfolio stays owned).
 * Products absent from the map are unaffiliated and treated as 'owned'.
 */
export function buildProductKindMap(cwd: string): Map<string, ProductKind> {
  const map = new Map<string, ProductKind>()
  let doc: {
    portfolios?: Array<{ kind?: string; products?: unknown }>
    products?: Array<{ id?: unknown; member_kind?: unknown }>
  }
  try {
    doc = JSON.parse(fs.readFileSync(path.join(cwd, '.upg', 'portfolio.upg'), 'utf-8'))
  } catch {
    return map
  }
  const seen = new Map<string, { owned: boolean; watched: boolean }>()
  for (const p of doc.portfolios ?? []) {
    if (!Array.isArray(p.products)) continue
    const isWatched = p.kind === 'watched'
    for (const pid of p.products) {
      if (typeof pid !== 'string') continue
      const rec = seen.get(pid) ?? { owned: false, watched: false }
      if (isWatched) rec.watched = true
      else rec.owned = true
      seen.set(pid, rec)
    }
  }
  // #45: a registry member tagged member_kind 'watched' is watched even without a
  // watched-portfolio membership (the file/member axis, twin of the portfolio kind).
  for (const r of doc.products ?? []) {
    if (typeof r.id !== 'string' || r.member_kind !== 'watched') continue
    const rec = seen.get(r.id) ?? { owned: false, watched: false }
    rec.watched = true
    seen.set(r.id, rec)
  }
  for (const [pid, rec] of seen) {
    map.set(pid, rec.watched && !rec.owned ? 'watched' : 'owned')
  }
  return map
}

/** Classify a single product's posture. Defaults to 'owned' (back-compat). */
export function classifyProductKind(
  cwd: string,
  productId: string | null | undefined,
): ProductKind {
  if (!productId) return 'owned'
  return buildProductKindMap(cwd).get(productId) ?? 'owned'
}
