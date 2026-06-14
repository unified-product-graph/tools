/**
 * Portfolio classification-landscape assembly (0.10.7). The portfolio-grain
 * complement to `tree-assemble.ts`: where `assembleTree` walks a SINGLE product's
 * within-graph edges, this walks the portfolio's CROSS edges into the shared
 * registry — the `*_classified_as_classification_value` matrix the competitive
 * tier produces — and returns the two shapes a human or downstream (Entopo)
 * actually consumes:
 *
 *  - `landscape`: a classification axis -> its values -> the nodes classified at
 *    each value, every leaf carrying the edge's `confidence` / `assessed_on`.
 *    Anchorable at one axis, one value, or the whole portfolio.
 *  - `competitor_profile`: one classified node (a competitor) -> its position on
 *    every axis it has been graded against, each position carrying confidence.
 *
 * Why a separate module, not a `get_tree` pattern: `assembleTree` is contractually
 * "active product only" and its drift-guard requires every slot resolve to a
 * within-product `UPG_EDGE_CATALOG` edge. The landscape's edges are cross-product
 * edges stored in `portfolio.upg`, and its nodes span the registry plus every
 * product. It is a different grain, so it lives beside `portfolio_digest` /
 * `portfolio_query`, not inside `get_tree`.
 *
 * AXIS RESOLUTION is deliberately tolerant. The canonical link from a value to
 * its axis is a `classification_axis_includes_classification_value` registry edge;
 * graphs that predate that wiring instead tag the value `axis:<slug>`. This
 * resolver tries the registry edge first, then the tag, and buckets anything it
 * cannot resolve under `unaxed` rather than guessing from id shape. A landscape
 * therefore renders truthfully on a partially-wired graph: resolved axes group
 * their values; unresolved values are surfaced, not hidden, so the gap in the
 * graph is visible instead of silently absorbed.
 *
 * Pure functions over a `UPGPortfolioDocument`; no I/O. Lives in the SDK so the
 * local server, the digest, and any future consumer assemble identical shapes
 * from one source. (Portfolio reads have no cloud analogue — the cloud server is
 * single-product-per-request — so there is no cloud counterpart, by design.)
 *
 * https://unifiedproductgraph.org | MIT
 */
import { REGISTRY_PRODUCT_ID } from '@unified-product-graph/core'
import type {
  UPGBaseNode,
  UPGCrossEdge,
  UPGEdge,
  UPGPortfolioDocument,
} from '@unified-product-graph/core'

/** Edge-type suffix shared by every classification cross edge (competitor + node forms). */
const CLASSIFY_SUFFIX = '_classified_as_classification_value'
/** Registry-internal edge that canonically links an axis to one of its values. */
const AXIS_INCLUDES = 'classification_axis_includes_classification_value'

/** A node resolved to a title + provenance, addressed by its qualified id. */
export interface PortfolioNodeRef {
  /** Qualified id: `{product_id}/{node_id}` or `registry/{id}`. */
  id: string
  /** The bare node id (qualified id minus the product/registry prefix). */
  bare_id: string
  type: string
  title: string
  status?: string
  /** Owning product id, or `registry` for a canonical node. */
  product_id: string
  /** Owning product title (absent for registry nodes). */
  product_title?: string
}

/** A value's resolved axis (bare id + display label), and how it was resolved. */
export interface ValueAxis {
  /** Bare axis id (e.g. `classification_axis_ai_maturity`), or a synthetic `axis:<slug>`. */
  axis: string
  label: string
  /** Which mechanism resolved the link: a registry edge, an `axis:` tag, or none. */
  via: 'registry_edge' | 'axis_tag'
}

/**
 * Index every resolvable node in the portfolio by its qualified id, so a
 * cross-edge endpoint (`p_…/n_…` or `registry/…`) resolves to a title in O(1).
 * The qualified id is the key the cross-edge `source` / `target` already use.
 *
 * Three sources, in precedence order (later wins on the rare collision):
 *  1. Registry canonicals (`registry/{id}`) — always present in the doc.
 *  2. Embedded product nodes — present only when the portfolio inlines them; a
 *     workspace portfolio carries product STUBS (a `file_path`, no `nodes`), in
 *     which case this source is empty.
 *  3. `instance_of` cross-edges — every product-local node registered to a
 *     canonical resolves to that canonical's title/type WITHOUT loading the
 *     product file. This is what lets a competitive landscape print "Directus"
 *     for `p_…/n_…` from the portfolio document alone.
 *
 * `extra` lets a caller with filesystem access (the local MCP handler) inject
 * file-loaded product-local refs for nodes that are NOT registry instances
 * (e.g. a `node_classified_as_classification_value` over a product feature);
 * those win, since a file-loaded title is the node's own, not its canonical's.
 */
export function buildPortfolioNodeIndex(
  doc: UPGPortfolioDocument,
  extra?: Iterable<PortfolioNodeRef>,
): Map<string, PortfolioNodeRef> {
  const index = new Map<string, PortfolioNodeRef>()
  const registryById = new Map<string, UPGBaseNode>()
  for (const n of doc.registry?.nodes ?? []) {
    registryById.set(n.id, n)
    const id = `${REGISTRY_PRODUCT_ID}/${n.id}`
    index.set(id, { id, bare_id: n.id, type: n.type, title: n.title, status: n.status, product_id: REGISTRY_PRODUCT_ID })
  }
  for (const p of doc.products ?? []) {
    const pid = p.id
    if (!pid) continue
    for (const n of p.nodes ?? []) {
      const id = `${pid}/${n.id}`
      index.set(id, { id, bare_id: n.id, type: n.type, title: n.title, status: n.status, product_id: pid, product_title: p.title })
    }
  }
  // instance_of: resolve a product-local node to its registry canonical's title.
  for (const e of doc.cross_edges ?? []) {
    if (e.type !== 'instance_of') continue
    if (index.has(e.source)) continue // an embedded/extra node title is more specific
    const canonical = registryById.get(bareOf(e.target))
    if (!canonical) continue
    const slash = e.source.indexOf('/')
    index.set(e.source, {
      id: e.source,
      bare_id: bareOf(e.source),
      type: canonical.type,
      title: canonical.title,
      status: canonical.status,
      product_id: e.source_product_id ?? (slash === -1 ? REGISTRY_PRODUCT_ID : e.source.slice(0, slash)),
    })
  }
  for (const ref of extra ?? []) index.set(ref.id, ref)
  return index
}

/** Strip the `registry/` (or `{pid}/`) prefix from a qualified id; identity if unqualified. */
function bareOf(qualifiedId: string): string {
  const slash = qualifiedId.indexOf('/')
  return slash === -1 ? qualifiedId : qualifiedId.slice(slash + 1)
}

/** Humanise a slug (`ai_maturity` -> `Ai maturity`) for a synthetic axis label of last resort. */
function humanise(slug: string): string {
  const s = slug.replace(/_/g, ' ').trim()
  return s.length === 0 ? slug : s[0].toUpperCase() + s.slice(1)
}

/**
 * Map each `classification_value` (bare id) to its axis. Registry edge first
 * (`classification_axis_includes_classification_value`, source=axis), then an
 * `axis:<slug>` tag on the value node, resolving the slug against a real axis
 * node (`classification_axis_<slug>`, or any axis whose id ends with the slug)
 * and falling back to a synthetic `axis:<slug>` when no axis node exists. Values
 * with neither signal are absent from the map (the caller buckets them as
 * `unaxed`).
 */
export function buildValueAxisMap(doc: UPGPortfolioDocument): Map<string, ValueAxis> {
  const out = new Map<string, ValueAxis>()
  const registryNodes = doc.registry?.nodes ?? []
  const axisTitle = new Map<string, string>()
  for (const n of registryNodes) {
    if (n.type === 'classification_axis') axisTitle.set(n.id, n.title)
  }

  // 1. Canonical: registry axis -> value edges.
  for (const e of (doc.registry?.edges ?? []) as UPGEdge[]) {
    if (e.type !== AXIS_INCLUDES) continue
    const axisId = bareOf(e.source)
    const valueId = bareOf(e.target)
    out.set(valueId, { axis: axisId, label: axisTitle.get(axisId) ?? humanise(axisId), via: 'registry_edge' })
  }

  // 2. Fallback: `axis:<slug>` tag on the value node (only where not already resolved).
  const axisIds = [...axisTitle.keys()]
  for (const n of registryNodes) {
    if (n.type !== 'classification_value' || out.has(n.id)) continue
    const tag = (n.tags ?? []).find((t) => t.startsWith('axis:'))
    if (!tag) continue
    const slug = tag.slice('axis:'.length)
    const matchId =
      (axisTitle.has(`classification_axis_${slug}`) && `classification_axis_${slug}`) ||
      axisIds.find((id) => id === slug || id.endsWith(`_${slug}`)) ||
      null
    out.set(
      n.id,
      matchId
        ? { axis: matchId, label: axisTitle.get(matchId) ?? humanise(slug), via: 'axis_tag' }
        : { axis: `axis:${slug}`, label: humanise(slug), via: 'axis_tag' },
    )
  }
  return out
}

/** One classified-node leaf under a value: the node + the edge's assessment. */
export interface LandscapeMember {
  id: string
  type: string
  title: string
  product_id?: string
  product_title?: string
  /** `confidence` from the classification edge (label is the human-facing grade). */
  confidence?: unknown
  /** `assessed_on` date from the classification edge. */
  assessed_on?: unknown
  /** Selected node properties (when `include_properties` is passed). */
  properties?: Record<string, unknown>
}

/** A value node and the members classified at it. */
export interface LandscapeValue {
  value: string
  label: string
  total: number
  members: LandscapeMember[]
}

/** An axis node and its values. */
export interface LandscapeAxis {
  /** Bare axis id, a synthetic `axis:<slug>`, or `null` for the unaxed bucket. */
  axis: string | null
  label: string
  total: number
  values: LandscapeValue[]
}

export interface LandscapeResult {
  shape: 'landscape'
  /** The anchored node, when `from_id` named one (axis or value); else null (whole portfolio). */
  anchor: { id: string; type: string; title: string } | null
  axes: LandscapeAxis[]
  stats: { axes: number; values: number; members: number; members_included: boolean; total_edges: number; unaxed_values: number }
  /** Present when no classification edges exist, so the caller can explain the empty result. */
  note?: string
}

/** Options shared by the landscape / profile assemblers. */
export interface PortfolioTreeOptions {
  /** Anchor node (qualified or bare): a classification axis or value (landscape), or a classified node (profile). */
  from_id?: string
  /** Node property keys to inline on each leaf, in addition to the edge's confidence/assessed_on. */
  include_properties?: string[]
  /**
   * A pre-built node index (from {@link buildPortfolioNodeIndex}, optionally
   * enriched with file-loaded product titles). When omitted, the assembler
   * builds one from `doc` alone (registry + instance_of resolution).
   */
  node_index?: Map<string, PortfolioNodeRef>
  /**
   * Whether to inline the classified members under each value (landscape only).
   * Defaults to TRUE when anchored at a single axis or value (the detail view),
   * FALSE for the whole portfolio (the overview: per-value counts only, so the
   * default whole-portfolio call stays under the transport cap). Pass `true`
   * explicitly to force full members on the whole portfolio.
   */
  include_members?: boolean
}

/** Classification cross edges (both competitor and node forms), with assessment intact. */
function classifyEdges(doc: UPGPortfolioDocument): UPGCrossEdge[] {
  return (doc.cross_edges ?? []).filter((e) => e.type.endsWith(CLASSIFY_SUFFIX))
}

/** Project a node ref + classification edge into a leaf member. */
function memberOf(
  ref: PortfolioNodeRef | undefined,
  qualifiedId: string,
  edge: UPGCrossEdge,
  index: Map<string, PortfolioNodeRef>,
  includeProps: string[] | undefined,
): LandscapeMember {
  const r = ref ?? index.get(qualifiedId)
  const props = (edge.properties ?? {}) as Record<string, unknown>
  const m: LandscapeMember = {
    id: qualifiedId,
    type: r?.type ?? 'unknown',
    title: r?.title ?? bareOf(qualifiedId),
  }
  if (r?.product_id && r.product_id !== REGISTRY_PRODUCT_ID) {
    m.product_id = r.product_id
    if (r.product_title) m.product_title = r.product_title
  }
  if ('confidence' in props) m.confidence = props.confidence
  if ('assessed_on' in props) m.assessed_on = props.assessed_on
  if (includeProps && includeProps.length > 0 && props) {
    const picked: Record<string, unknown> = {}
    for (const k of includeProps) if (k in props) picked[k] = props[k]
    if (Object.keys(picked).length > 0) m.properties = picked
  }
  return m
}

/**
 * Assemble the classification landscape: axis -> value -> classified members,
 * each leaf carrying the classification edge's confidence/assessed_on.
 *
 * `from_id` may anchor at a classification axis (that axis's values only), a
 * classification value (that single value's members), or be omitted for the
 * whole portfolio. Values whose axis cannot be resolved are grouped under a
 * single `axis: null` ("unaxed") bucket rather than dropped.
 */
export function assembleLandscape(doc: UPGPortfolioDocument, opts: PortfolioTreeOptions = {}): LandscapeResult {
  const index = opts.node_index ?? buildPortfolioNodeIndex(doc)
  const valueAxis = buildValueAxisMap(doc)
  const edges = classifyEdges(doc)
  const includeProps = opts.include_properties

  // Resolve the anchor (axis or value), if one was named.
  let anchorRef: PortfolioNodeRef | undefined
  let anchorValueBare: string | undefined
  let anchorAxisBare: string | undefined
  if (opts.from_id) {
    anchorRef =
      index.get(opts.from_id) ?? index.get(`${REGISTRY_PRODUCT_ID}/${bareOf(opts.from_id)}`)
    const bare = bareOf(opts.from_id)
    if (anchorRef?.type === 'classification_value') anchorValueBare = anchorRef.bare_id
    else if (anchorRef?.type === 'classification_axis') anchorAxisBare = anchorRef.bare_id
    else if (bare.startsWith('classification_value_')) anchorValueBare = bare
    else if (bare.startsWith('classification_axis_')) anchorAxisBare = bare
  }
  // Inline members by default only when anchored; the whole-portfolio overview
  // is counts-only unless explicitly asked, so it stays under the transport cap.
  const anchored = Boolean(anchorValueBare || anchorAxisBare)
  const includeMembers = opts.include_members ?? anchored

  // Group members per value bare id.
  const byValue = new Map<string, { members: LandscapeMember[]; seen: Set<string> }>()
  for (const e of edges) {
    const valueBare = bareOf(e.target)
    if (anchorValueBare && valueBare !== anchorValueBare) continue
    if (anchorAxisBare && valueAxis.get(valueBare)?.axis !== anchorAxisBare) continue
    const bucket = byValue.get(valueBare) ?? { members: [], seen: new Set<string>() }
    if (!bucket.seen.has(e.source)) {
      bucket.seen.add(e.source)
      bucket.members.push(memberOf(index.get(e.source), e.source, e, index, includeProps))
    }
    byValue.set(valueBare, bucket)
  }

  const valueLabel = (bare: string): string =>
    index.get(`${REGISTRY_PRODUCT_ID}/${bare}`)?.title ?? bare

  // Bucket values under their axis (or the unaxed group).
  const UNAXED = Symbol('unaxed')
  const axisBuckets = new Map<string | typeof UNAXED, { label: string; values: LandscapeValue[] }>()
  let memberTotal = 0
  let unaxedValues = 0
  for (const [valueBare, bucket] of byValue) {
    const members = bucket.members.sort((a, b) => a.title.localeCompare(b.title))
    memberTotal += members.length
    const lv: LandscapeValue = {
      value: valueBare,
      label: valueLabel(valueBare),
      total: members.length,
      members: includeMembers ? members : [],
    }
    const ax = valueAxis.get(valueBare)
    const key = ax ? ax.axis : UNAXED
    if (!ax) unaxedValues++
    const ab = axisBuckets.get(key) ?? { label: ax ? ax.label : 'unaxed', values: [] }
    ab.values.push(lv)
    axisBuckets.set(key, ab)
  }

  const axes: LandscapeAxis[] = [...axisBuckets.entries()]
    .map(([key, ab]) => ({
      axis: key === UNAXED ? null : (key as string),
      label: ab.label,
      total: ab.values.reduce((s, v) => s + v.total, 0),
      values: ab.values.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    }))
    // Real axes first (alphabetical), unaxed last.
    .sort((a, b) => {
      if (a.axis === null) return 1
      if (b.axis === null) return -1
      return a.label.localeCompare(b.label)
    })

  const result: LandscapeResult = {
    shape: 'landscape',
    anchor: anchorRef ? { id: anchorRef.id, type: anchorRef.type, title: anchorRef.title } : null,
    axes,
    stats: {
      axes: axes.filter((a) => a.axis !== null).length,
      values: byValue.size,
      members: memberTotal,
      members_included: includeMembers,
      total_edges: edges.length,
      unaxed_values: unaxedValues,
    },
  }
  if (edges.length === 0) {
    result.note =
      'No classification edges in this portfolio. Classify nodes via create_classification_edge to populate the landscape.'
  } else if (!includeMembers) {
    result.note =
      'Overview: per-value counts only. Anchor at an axis or value with from_id, or pass include_members:true, to inline the classified nodes.'
  }
  return result
}

/** One axis position a competitor has been graded at. */
export interface ProfilePosition {
  /** The classification value the competitor sits at. */
  value: string
  value_label: string
  /** Bare axis id (or synthetic `axis:<slug>`), null when unresolved. */
  axis: string | null
  axis_label: string | null
  confidence?: unknown
  assessed_on?: unknown
  properties?: Record<string, unknown>
}

export interface ProfileResult {
  shape: 'competitor_profile'
  /** The profiled node, when resolvable. */
  subject: { id: string; type: string; title: string; product_id?: string } | null
  positions: ProfilePosition[]
  stats: { positions: number; axes_covered: number }
  note?: string
}

/**
 * Assemble one node's competitive profile: the classification value it sits at
 * on each axis it has been graded against, each position carrying the edge's
 * confidence/assessed_on. Mirrors {@link assembleLandscape} from the node's
 * point of view. `from_id` is required (the node to profile, qualified or bare).
 */
export function assembleCompetitorProfile(
  doc: UPGPortfolioDocument,
  opts: PortfolioTreeOptions = {},
): ProfileResult {
  const index = opts.node_index ?? buildPortfolioNodeIndex(doc)
  const valueAxis = buildValueAxisMap(doc)
  const includeProps = opts.include_properties

  if (!opts.from_id) {
    return {
      shape: 'competitor_profile',
      subject: null,
      positions: [],
      stats: { positions: 0, axes_covered: 0 },
      note: 'competitor_profile requires from_id: the qualified id of the node to profile (e.g. a competitor).',
    }
  }

  // Resolve the subject node (qualified id wins; bare falls back to registry).
  const subjectRef = index.get(opts.from_id) ?? index.get(`${REGISTRY_PRODUCT_ID}/${bareOf(opts.from_id)}`)
  // The edge source key to match: the exact qualified id, or the resolved ref's id.
  const subjectKey = subjectRef?.id ?? opts.from_id

  // Classification edges attach to the PRODUCT-LOCAL node, not the registry
  // canonical. When the subject is a canonical (a `registry/competitor_…` id, or
  // a bare id that resolved into the registry), gather every product instance
  // registered to it via `instance_of`, so profiling "Vercel" by its canonical
  // id finds the instance's positions. A subject that is itself a product node
  // matches only its own edges.
  const subjectIsCanonical = subjectKey.startsWith(`${REGISTRY_PRODUCT_ID}/`)
  const canonicalBare = subjectIsCanonical ? bareOf(subjectKey) : undefined
  const sourceKeys = new Set<string>([subjectKey])
  if (canonicalBare) {
    for (const e of doc.cross_edges ?? []) {
      if (e.type === 'instance_of' && bareOf(e.target) === canonicalBare) sourceKeys.add(e.source)
    }
  }

  const valueLabel = (bare: string): string =>
    index.get(`${REGISTRY_PRODUCT_ID}/${bare}`)?.title ?? bare

  const positions: ProfilePosition[] = []
  const axesSeen = new Set<string>()
  const seenPos = new Set<string>()
  for (const e of classifyEdges(doc)) {
    if (!sourceKeys.has(e.source)) continue
    const dedupeKey = `${bareOf(e.target)}`
    if (seenPos.has(dedupeKey)) continue
    seenPos.add(dedupeKey)
    const valueBare = bareOf(e.target)
    const ax = valueAxis.get(valueBare)
    const props = (e.properties ?? {}) as Record<string, unknown>
    const pos: ProfilePosition = {
      value: valueBare,
      value_label: valueLabel(valueBare),
      axis: ax?.axis ?? null,
      axis_label: ax?.label ?? null,
    }
    if ('confidence' in props) pos.confidence = props.confidence
    if ('assessed_on' in props) pos.assessed_on = props.assessed_on
    if (includeProps && includeProps.length > 0) {
      const picked: Record<string, unknown> = {}
      for (const k of includeProps) if (k in props) picked[k] = props[k]
      if (Object.keys(picked).length > 0) pos.properties = picked
    }
    if (ax?.axis) axesSeen.add(ax.axis)
    positions.push(pos)
  }
  positions.sort((a, b) => (a.axis_label ?? '~').localeCompare(b.axis_label ?? '~') || a.value_label.localeCompare(b.value_label))

  const result: ProfileResult = {
    shape: 'competitor_profile',
    subject: subjectRef
      ? {
          id: subjectRef.id,
          type: subjectRef.type,
          title: subjectRef.title,
          ...(subjectRef.product_id !== REGISTRY_PRODUCT_ID ? { product_id: subjectRef.product_id } : {}),
        }
      : null,
    positions,
    stats: { positions: positions.length, axes_covered: axesSeen.size },
  }
  if (positions.length === 0) {
    result.note = subjectRef
      ? `${subjectRef.title} has no classification edges. Classify it via create_classification_edge.`
      : `No node resolved for from_id "${opts.from_id}", and no classification edges reference it.`
  }
  return result
}

/** Resolve a node title from a portfolio index (helper for cross-edge title decoration). */
export function titleFromIndex(
  index: Map<string, PortfolioNodeRef>,
  qualifiedId: string,
): string | undefined {
  return index.get(qualifiedId)?.title ?? index.get(`${REGISTRY_PRODUCT_ID}/${bareOf(qualifiedId)}`)?.title
}

/* ───────────────────────── #5 compare_classifications ───────────────────────── */

/** One side's position(s) on an axis in a comparison. */
export interface ComparisonSide {
  value: string
  value_label: string
  confidence?: unknown
}

/** One axis row of a two-node classification comparison. */
export interface ComparisonAxisRow {
  /** Bare axis id (or synthetic `axis:<slug>`), null for the unaxed bucket. */
  axis: string | null
  axis_label: string | null
  a: ComparisonSide[]
  b: ComparisonSide[]
  /**
   * `agree`   — both graded, identical value set;
   * `diverge` — both graded, value sets differ;
   * `a_only`  — only A graded on this axis;
   * `b_only`  — only B graded on this axis.
   */
  status: 'agree' | 'diverge' | 'a_only' | 'b_only'
}

export interface ComparisonResult {
  shape: 'comparison'
  a: { id: string; type: string; title: string } | null
  b: { id: string; type: string; title: string } | null
  axes: ComparisonAxisRow[]
  stats: {
    shared_axes: number
    agreements: number
    divergences: number
    a_only: number
    b_only: number
  }
  note?: string
}

/** Group one node's profile positions by axis key (axis bare id, or '__unaxed__'). */
function positionsByAxis(positions: ProfilePosition[]): Map<string, ProfilePosition[]> {
  const UNAXED = '__unaxed__'
  const byAxis = new Map<string, ProfilePosition[]>()
  for (const p of positions) {
    const key = p.axis ?? UNAXED
    ;(byAxis.get(key) ?? byAxis.set(key, []).get(key)!).push(p)
  }
  return byAxis
}

/**
 * Compare two classified nodes (competitors) axis-by-axis: where they sit at the
 * same value (agree), at different values (diverge), or where only one has been
 * graded. The derivation that feeds the parity layer — `create_parity_edge` is
 * the writer, this is the reader that tells you which axes to write a parity edge
 * for. Builds each side via {@link assembleCompetitorProfile}, so axis/value/
 * confidence resolution is identical to a single-node profile, then joins on axis.
 *
 * `a` and `b` are the qualified (or bare) ids of the two nodes to compare.
 * A node graded multiple values on one axis (a multi-value categorical axis) is
 * compared as a SET: agree iff the value-id sets are equal.
 */
export function assembleComparison(
  doc: UPGPortfolioDocument,
  opts: { a?: string; b?: string; axis?: string; node_index?: Map<string, PortfolioNodeRef> } = {},
): ComparisonResult {
  const index = opts.node_index ?? buildPortfolioNodeIndex(doc)
  const empty = (which: 'a' | 'b'): ComparisonResult => ({
    shape: 'comparison',
    a: null,
    b: null,
    axes: [],
    stats: { shared_axes: 0, agreements: 0, divergences: 0, a_only: 0, b_only: 0 },
    note: `compare_classifications requires both \`a\` and \`b\`: the qualified ids of the two nodes to compare (missing: ${which}).`,
  })
  if (!opts.a) return empty('a')
  if (!opts.b) return empty('b')

  const profA = assembleCompetitorProfile(doc, { from_id: opts.a, node_index: index })
  const profB = assembleCompetitorProfile(doc, { from_id: opts.b, node_index: index })

  // Optional single-axis focus: keep only positions on the requested axis.
  const axisFilter = opts.axis ? bareOf(opts.axis) : undefined
  const keep = (p: ProfilePosition): boolean => !axisFilter || p.axis === axisFilter
  const byA = positionsByAxis(profA.positions.filter(keep))
  const byB = positionsByAxis(profB.positions.filter(keep))

  const UNAXED = '__unaxed__'
  const axisKeys = [...new Set([...byA.keys(), ...byB.keys()])]
  const sideOf = (ps: ProfilePosition[] | undefined): ComparisonSide[] =>
    (ps ?? []).map((p) => ({
      value: p.value,
      value_label: p.value_label,
      ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    }))
  const labelFor = (ps: ProfilePosition[] | undefined): { axis: string | null; axis_label: string | null } => {
    const p = (ps ?? [])[0]
    return { axis: p?.axis ?? null, axis_label: p?.axis_label ?? null }
  }
  const valueSet = (sides: ComparisonSide[]): string => [...new Set(sides.map((s) => s.value))].sort().join('|')

  let agreements = 0
  let divergences = 0
  let aOnly = 0
  let bOnly = 0
  const rows: ComparisonAxisRow[] = axisKeys.map((key) => {
    const aPs = byA.get(key)
    const bPs = byB.get(key)
    const a = sideOf(aPs)
    const b = sideOf(bPs)
    const meta = aPs ? labelFor(aPs) : labelFor(bPs)
    let status: ComparisonAxisRow['status']
    if (a.length > 0 && b.length > 0) {
      if (valueSet(a) === valueSet(b)) { status = 'agree'; agreements++ }
      else { status = 'diverge'; divergences++ }
    } else if (a.length > 0) { status = 'a_only'; aOnly++ }
    else { status = 'b_only'; bOnly++ }
    return {
      axis: key === UNAXED ? null : meta.axis,
      axis_label: key === UNAXED ? null : meta.axis_label,
      a,
      b,
      status,
    }
  })
  // Shared axes (both graded) first, ordered diverge before agree (divergences
  // are the actionable rows), then single-side rows; unaxed last.
  const order: Record<ComparisonAxisRow['status'], number> = { diverge: 0, agree: 1, a_only: 2, b_only: 3 }
  rows.sort((x, y) => {
    if (x.axis === null && y.axis !== null) return 1
    if (y.axis === null && x.axis !== null) return -1
    return order[x.status] - order[y.status] || (x.axis_label ?? '~').localeCompare(y.axis_label ?? '~')
  })

  const result: ComparisonResult = {
    shape: 'comparison',
    a: profA.subject,
    b: profB.subject,
    axes: rows,
    stats: {
      shared_axes: agreements + divergences,
      agreements,
      divergences,
      a_only: aOnly,
      b_only: bOnly,
    },
  }
  if (rows.length === 0) {
    result.note =
      profA.positions.length === 0 || profB.positions.length === 0
        ? 'At least one node has no classification edges (or none on the requested axis). Classify both via create_classification_edge to compare.'
        : 'No overlapping or distinct axes to compare.'
  }
  return result
}

/* ─────────────────────── #6 aggregate_edge_properties ─────────────────────── */

/** One bucket in a property distribution. */
export interface DistributionBucket {
  key: string
  count: number
}

/** One group's property distribution (when `group_by` is not `none`). */
export interface AggregateGroup {
  group: string
  group_label?: string
  total: number
  with_property: number
  distribution: DistributionBucket[]
}

export interface AggregateResult {
  shape: 'edge_property_aggregate'
  edge_type: string
  property: string
  group_by: 'none' | 'axis' | 'competitor' | 'value'
  total: number
  with_property: number
  without_property: number
  /** The distribution over ALL edges of the type (always present). */
  overall: DistributionBucket[]
  /** Per-group distributions, present when `group_by` is not `none`. */
  groups?: AggregateGroup[]
  note?: string
}

/** Bucket key for a property value: an assessment object reduces to its `label`. */
function bucketKeyOf(v: unknown): string {
  if (v !== null && typeof v === 'object') {
    const label = (v as { label?: unknown }).label
    if (typeof label === 'string') return label
    return JSON.stringify(v)
  }
  return String(v)
}

/** Sort a count map into descending-count buckets (ties alphabetical). */
function toBuckets(counts: Map<string, number>): DistributionBucket[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/**
 * Aggregate the distribution of one property across every portfolio cross-edge
 * of a type, optionally grouped by a dimension. The digest of the property layer
 * that turns "I counted 165 high / 53 medium by eye over the jq dump" into one
 * call. `property` defaults to `confidence`; an assessment-object property
 * (`{ value, label, scale_id }`) buckets by its `label`.
 *
 * `group_by`:
 *  - `none` (default): one overall distribution.
 *  - `axis`: group by the classification axis the target value belongs to (for
 *    `*_classified_as_classification_value` edges).
 *  - `competitor`: group by the source node (the classified entity).
 *  - `value`: group by the target value.
 */
export function aggregateEdgeProperties(
  doc: UPGPortfolioDocument,
  opts: { edge_type: string; group_by?: AggregateResult['group_by']; property?: string; node_index?: Map<string, PortfolioNodeRef> },
): AggregateResult {
  const index = opts.node_index ?? buildPortfolioNodeIndex(doc)
  const valueAxis = buildValueAxisMap(doc)
  const property = opts.property ?? 'confidence'
  const groupBy = opts.group_by ?? 'none'
  const edges = (doc.cross_edges ?? []).filter((e) => e.type === opts.edge_type)

  const overall = new Map<string, number>()
  let withProperty = 0
  // group key -> { label, total edges, with-property count, distribution }
  const groups = new Map<string, { label?: string; total: number; withProp: number; dist: Map<string, number> }>()

  const groupKeyFor = (e: UPGCrossEdge): { key: string; label?: string } => {
    if (groupBy === 'competitor') {
      const ref = index.get(e.source)
      return { key: e.source, label: ref?.title }
    }
    if (groupBy === 'value') {
      const bare = bareOf(e.target)
      return { key: bare, label: index.get(`${REGISTRY_PRODUCT_ID}/${bare}`)?.title ?? bare }
    }
    // axis
    const bare = bareOf(e.target)
    const ax = valueAxis.get(bare)
    return ax ? { key: ax.axis, label: ax.label } : { key: '__unaxed__', label: 'unaxed' }
  }

  for (const e of edges) {
    const props = (e.properties ?? {}) as Record<string, unknown>
    const has = property in props
    if (has) {
      withProperty++
      const k = bucketKeyOf(props[property])
      overall.set(k, (overall.get(k) ?? 0) + 1)
    }
    if (groupBy !== 'none') {
      const { key, label } = groupKeyFor(e)
      const g = groups.get(key) ?? { label, total: 0, withProp: 0, dist: new Map<string, number>() }
      g.total++
      if (has) {
        g.withProp++
        const k = bucketKeyOf(props[property])
        g.dist.set(k, (g.dist.get(k) ?? 0) + 1)
      }
      groups.set(key, g)
    }
  }

  const result: AggregateResult = {
    shape: 'edge_property_aggregate',
    edge_type: opts.edge_type,
    property,
    group_by: groupBy,
    total: edges.length,
    with_property: withProperty,
    without_property: edges.length - withProperty,
    overall: toBuckets(overall),
  }
  if (groupBy !== 'none') {
    result.groups = [...groups.entries()]
      .map(([group, g]) => ({
        group: group === '__unaxed__' ? 'unaxed' : group,
        ...(g.label ? { group_label: g.label } : {}),
        total: g.total,
        with_property: g.withProp,
        distribution: toBuckets(g.dist),
      }))
      // Biggest groups first; unaxed sinks to the bottom.
      .sort((x, y) => {
        if (x.group === 'unaxed' && y.group !== 'unaxed') return 1
        if (y.group === 'unaxed' && x.group !== 'unaxed') return -1
        return y.total - x.total || (x.group_label ?? x.group).localeCompare(y.group_label ?? y.group)
      })
  }
  if (edges.length === 0) {
    result.note = `No cross-edges of type "${opts.edge_type}" in this portfolio.`
  }
  return result
}
