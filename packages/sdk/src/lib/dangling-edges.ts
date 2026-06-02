/**
 * Classify and (optionally) repair dangling edges in a loaded UPG document.
 *
 * Three classes:
 *
 *   - **expected**: cross-product edge with `source_product_id` /
 *     `target_product_id` annotations. Resolves once the sibling product is
 *     loaded; keep these in the doc.
 *   - **suspect**: cross-product edge type (per `UPG_CROSS_EDGE_TYPES`) but
 *     no annotation. May be a stale ref; needs operator decision.
 *   - **corrupt**: non-cross-product edge with a missing endpoint. A genuine
 *     integrity break, typically the product of a botched manual edit or
 *     incomplete migration.
 *
 * A future change will move cross-product edges to `portfolio.cross_edges`
 * and eliminate `expected` entirely. Until then, this classifier is the
 * bridge: better hygiene without forcing the schema migration.
 */

import { UPG_CROSS_EDGE_TYPES, type UPGEdge } from '@unified-product-graph/core'

const CROSS_EDGE_TYPE_SET: ReadonlySet<string> = new Set(UPG_CROSS_EDGE_TYPES)

export type DanglingEdgeClass = 'expected' | 'suspect' | 'corrupt'

export interface DanglingEdgeRecord {
  id: string
  type: string
  class: DanglingEdgeClass
  source: string
  target: string
  source_product_id?: string
  target_product_id?: string
  /** Which endpoint(s) didn't resolve. */
  missing: Array<'source' | 'target'>
}

export interface DanglingEdgeReport {
  total: number
  by_class: Record<DanglingEdgeClass, number>
  edges: DanglingEdgeRecord[]
}

/**
 * Walk `edges` and pick out every edge with at least one endpoint not in
 * `nodeIds`. Pure function; does not mutate inputs. Safe to call many times.
 */
export function classifyDanglingEdges(
  edges: readonly UPGEdge[],
  nodeIds: ReadonlySet<string>,
): DanglingEdgeReport {
  const records: DanglingEdgeRecord[] = []
  const counts: Record<DanglingEdgeClass, number> = {
    expected: 0,
    suspect: 0,
    corrupt: 0,
  }

  for (const edge of edges) {
    const missing: Array<'source' | 'target'> = []
    if (!nodeIds.has(edge.source)) missing.push('source')
    if (!nodeIds.has(edge.target)) missing.push('target')
    if (missing.length === 0) continue

    const isCrossType = CROSS_EDGE_TYPE_SET.has(edge.type)
    const annotated =
      typeof (edge as { source_product_id?: string }).source_product_id === 'string' ||
      typeof (edge as { target_product_id?: string }).target_product_id === 'string'

    let cls: DanglingEdgeClass
    if (isCrossType && annotated) cls = 'expected'
    else if (isCrossType) cls = 'suspect'
    else cls = 'corrupt'

    counts[cls]++
    records.push({
      id: edge.id,
      type: edge.type,
      class: cls,
      source: edge.source,
      target: edge.target,
      source_product_id: (edge as { source_product_id?: string }).source_product_id,
      target_product_id: (edge as { target_product_id?: string }).target_product_id,
      missing,
    })
  }

  return {
    total: records.length,
    by_class: counts,
    edges: records,
  }
}

/**
 * Render the integrity report as a multi-line string.
 *
 * (S-03): by default this ALWAYS returns a string — a "no issues" line
 * on the clean case — so `renderDanglingReport(r, f).split('\n')` is safe on a
 * healthy graph (it previously returned `null`, throwing on `.split`). Pass
 * `{ quietWhenClean: true }` to get `null` on the clean case (used by the
 * loader to stay silent on stderr).
 */
export function renderDanglingReport(
  report: DanglingEdgeReport,
  filePath: string,
  options?: { quietWhenClean?: boolean },
): string | null {
  if (report.total === 0) {
    if (options?.quietWhenClean) return null
    return `.upg integrity report (${filePath}): no dangling edges.`
  }
  const lines: string[] = []
  lines.push(`.upg integrity report (${filePath}):`)
  if (report.by_class.expected > 0) {
    lines.push(`  - ${report.by_class.expected} expected dangling edges (cross-product, sibling not loaded)`)
  }
  if (report.by_class.suspect > 0) {
    lines.push(`  - ${report.by_class.suspect} suspect dangling cross-product edges:`)
    for (const e of report.edges.filter((r) => r.class === 'suspect')) {
      const which = e.missing.join('+')
      lines.push(`      ${e.id} (${e.type}) → missing ${which} (${e.source} → ${e.target})`)
    }
  }
  if (report.by_class.corrupt > 0) {
    lines.push(`  - ${report.by_class.corrupt} corrupt edges (non-cross type, broken endpoint):`)
    for (const e of report.edges.filter((r) => r.class === 'corrupt')) {
      const which = e.missing.join('+')
      lines.push(`      ${e.id} (${e.type}) → missing ${which} (${e.source} → ${e.target})`)
    }
  }
  lines.push('')
  lines.push('Run the `repair_dangling_edges` MCP tool to inspect or drop suspect/corrupt edges.')
  return lines.join('\n')
}
