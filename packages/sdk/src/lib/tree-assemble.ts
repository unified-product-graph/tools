/**
 * Shared server-side tree assembly for `get_tree` (0.9.16+). Walks a
 * `UPGTreePattern`'s type-driven `child_map` over a live graph and returns
 * NESTED data (not rendered text) plus structural `gaps`. Rendering stays in the
 * client.
 *
 * Type-driven, not edge-name-driven: at a node of type T, an OUTGOING edge whose
 * target is a node of a type listed in `child_map[T]` is a child, whatever the
 * edge is called. (Every canonical parent->child edge stores source=parent;
 * verified 2026-06-11.) This is why the pattern cannot drift when the edge
 * catalogue evolves, unlike the hardcoded edge chains the `/upg-show-tree` skill
 * carried.
 *
 * DAG-honest (the fix for the duplicate-explosion and the silent-drop, the same
 * failure wearing two faces): a UPG graph is a DAG, so a node can have several
 * parents. Each node's full subtree is expanded EXACTLY ONCE, under its first
 * parent in traversal order. At every other parent the node still appears, as a
 * `shared: true` reference WITHOUT its subtree re-expanded. Nothing is silently
 * dropped (a parent never looks childless when it is not), and nothing explodes
 * (a shared subtree is never re-rendered in full). Cycles terminate for free:
 * the second visit to a node is a reference, not a recursion.
 *
 * Gaps are driven by the per-child `required` flag: a node MISSING a required
 * child type is a gap; optional children are silent when absent. Uniform across
 * every pattern.
 *
 * Lives in the SDK (the graph-data layer) so every consumer assembles identical
 * trees from one source: the local file-backed server, the cloud Postgres-backed
 * server, and the CLI. The SDK `UPGFileStore` satisfies {@link GraphReader}
 * directly; the cloud handler wraps a one-shot load in an in-memory reader.
 *
 * https://unifiedproductgraph.org | MIT
 */
import type { UPGBaseNode, UPGEdge, UPGTreePattern } from '@unified-product-graph/core'

/** Minimal synchronous read surface tree assembly needs. */
export interface GraphReader {
  getNode(id: string): UPGBaseNode | undefined
  getAllNodes(): UPGBaseNode[]
  getEdgesForNode(id: string): UPGEdge[]
}

export interface TreeNode {
  id: string
  type: string
  title: string
  status?: string
  properties?: Record<string, unknown>
  /**
   * True when this node's subtree was already expanded under an earlier parent
   * (the graph is a DAG; the node has more than one parent). Its `children` are
   * intentionally empty here: render it as a reference to the canonical
   * occurrence (same `id`), not a re-expansion.
   */
  shared?: boolean
  children: TreeNode[]
}

export interface TreeGap {
  node_id: string
  type: string
  title: string
  /** The REQUIRED child types the pattern expects under this node but the graph lacks. */
  missing: string[]
}

export interface AssembleOptions {
  from_id?: string
  depth?: number
  include_properties?: string[]
  max_nodes?: number
}

export interface AssembleResult {
  pattern: string
  framework_id?: string
  anchor_type: string
  /** The type actually rooted on (may be a fallback). */
  anchor_used: string
  /** Set only when a fallback fired (anchor_used !== anchor_type). */
  anchor_resolved_from?: string
  /**
   * Whether the canonical `anchor_type` has at least one node in the graph.
   * A fallback can fire for two reasons, and this disambiguates them: the anchor
   * type is ABSENT (anchor_present=false), or it is PRESENT but a fallback root
   * surfaces more of the pattern (anchor_present=true; e.g. services that nest
   * under a bounded_context). Without this, a consumer cannot tell "no service
   * found" from "services exist but nest under the root", and a message that
   * says the former while rendering the latter contradicts itself.
   */
  anchor_present: boolean
  roots: TreeNode[]
  stats: { nodes: number; levels: number; truncated: boolean; shared_refs: number }
  gaps: TreeGap[]
}

const DEFAULT_MAX_NODES = 400

/** Build the projected node shell (no children yet). */
function shell(
  reader: GraphReader,
  id: string,
  includeProps: string[] | undefined,
): TreeNode | undefined {
  const n = reader.getNode(id)
  if (!n) return undefined
  const node: TreeNode = { id: n.id, type: n.type, title: n.title, children: [] }
  if (n.status) node.status = n.status as string
  if (includeProps && includeProps.length > 0 && n.properties) {
    const picked: Record<string, unknown> = {}
    for (const k of includeProps) {
      if (k in (n.properties as Record<string, unknown>)) picked[k] = (n.properties as Record<string, unknown>)[k]
    }
    if (Object.keys(picked).length > 0) node.properties = picked
  }
  return node
}

interface ChildRef {
  id: string
  type: string
}

/** Outgoing typed children of `node`: targets whose type is in `childTypes`. */
function childrenOf(reader: GraphReader, nodeId: string, childTypes: string[]): ChildRef[] {
  if (childTypes.length === 0) return []
  const allow = new Set(childTypes)
  const out: ChildRef[] = []
  const seen = new Set<string>()
  for (const e of reader.getEdgesForNode(nodeId)) {
    if (e.source !== nodeId) continue // follow outgoing (parent -> child) edges only
    if (seen.has(e.target)) continue
    const t = reader.getNode(e.target)
    if (t && allow.has(t.type)) {
      out.push({ id: e.target, type: t.type })
      seen.add(e.target)
    }
  }
  return out
}

/**
 * Assemble the tree forest for a pattern. Tries the anchor, then each fallback,
 * stopping at the first that yields a non-empty forest with at least one child
 * (the "wrong root, empty tree" guard) - or the last candidate regardless.
 */
export function assembleTree(
  reader: GraphReader,
  pattern: UPGTreePattern,
  opts: AssembleOptions,
): AssembleResult {
  const maxNodes = Math.min(Math.max(opts.max_nodes ?? DEFAULT_MAX_NODES, 1), 2000)
  const maxDepth = Math.min(Math.max(opts.depth ?? pattern.natural_depth, 1), 12)
  const includeProps = opts.include_properties

  type Build = { anchorType: string; roots: TreeNode[]; nodes: number; levels: number; truncated: boolean; gaps: TreeGap[]; childCount: number; sharedRefs: number }

  const buildFrom = (rootIds: string[], anchorType: string): Build => {
    // `expanded`: node ids whose subtree has been rendered under their first
    // parent. A node met again becomes a `shared` reference, not a re-expansion.
    const expanded = new Set<string>()
    const gaps: TreeGap[] = []
    let nodes = 0
    let levels = 0
    let truncated = false
    let childCount = 0
    let sharedRefs = 0

    const expand = (node: TreeNode, depth: number): void => {
      if (depth > levels) levels = depth
      const slots = pattern.child_map[node.type] ?? []
      if (slots.length === 0) return
      const childTypes = slots.map((s) => s.type)
      const requiredTypes = slots.filter((s) => s.required).map((s) => s.type)

      if (depth >= maxDepth) {
        if (childrenOf(reader, node.id, childTypes).length > 0) truncated = true
        return
      }

      const childRefs = childrenOf(reader, node.id, childTypes)

      // Gap = a required child type with no graph child of that type.
      if (requiredTypes.length > 0) {
        const presentTypes = new Set(childRefs.map((c) => c.type))
        const missing = requiredTypes.filter((t) => !presentTypes.has(t))
        if (missing.length > 0) {
          gaps.push({ node_id: node.id, type: node.type, title: node.title, missing })
        }
      }

      for (const cref of childRefs) {
        if (nodes >= maxNodes) { truncated = true; return }
        const child = shell(reader, cref.id, includeProps)
        if (!child) continue
        node.children.push(child)
        nodes++
        childCount++
        if (expanded.has(cref.id)) {
          // Already rendered under an earlier parent: reference, do not re-expand.
          child.shared = true
          sharedRefs++
        } else {
          expanded.add(cref.id)
          expand(child, depth + 1)
        }
      }
    }

    const roots: TreeNode[] = []
    for (const rid of rootIds) {
      if (expanded.has(rid)) continue
      if (nodes >= maxNodes) { truncated = true; break }
      const root = shell(reader, rid, includeProps)
      if (!root) continue
      expanded.add(rid)
      nodes++
      roots.push(root)
      expand(root, 1)
    }
    return { anchorType, roots, nodes, levels, truncated, gaps, childCount, sharedRefs }
  }

  const finalise = (b: Build, anchorType: string): AssembleResult => {
    const result: AssembleResult = {
      pattern: pattern.id,
      framework_id: pattern.framework_id,
      anchor_type: pattern.anchor_type,
      anchor_used: anchorType,
      anchor_present: reader.getAllNodes().some((n) => n.type === pattern.anchor_type),
      roots: b.roots,
      stats: { nodes: b.nodes, levels: b.levels, truncated: b.truncated, shared_refs: b.sharedRefs },
      gaps: b.gaps,
    }
    if (anchorType !== pattern.anchor_type) result.anchor_resolved_from = pattern.anchor_type
    return result
  }

  // from_id mode: root exactly at the given node.
  if (opts.from_id) {
    const n = reader.getNode(opts.from_id)
    const anchorType = n?.type ?? pattern.anchor_type
    return finalise(buildFrom([opts.from_id], anchorType), anchorType)
  }

  const candidates = [pattern.anchor_type, ...pattern.fallback_anchors]
  const idsOfType = (type: string): string[] =>
    reader.getAllNodes().filter((n) => n.type === type).map((n) => n.id)

  // Pick the anchor that surfaces the MOST of the pattern, not merely the first
  // that is non-empty. A trivial root (e.g. a vision whose only child is a
  // mission) must not shadow a fallback that holds the real cascade (Studio's
  // bets hang off the product, not the vision). The canonical anchor wins ties
  // (it leads `candidates`), so a graph wired the textbook way is unaffected.
  let chosen: Build | undefined
  let chosenAnchor = pattern.anchor_type
  for (const cand of candidates) {
    const rootIds = idsOfType(cand)
    if (rootIds.length === 0) continue // no nodes of this type: try next
    const b = buildFrom(rootIds, cand)
    if (!chosen || b.nodes > chosen.nodes) {
      chosen = b
      chosenAnchor = cand
    }
  }
  if (!chosen) {
    chosen = { anchorType: pattern.anchor_type, roots: [], nodes: 0, levels: 0, truncated: false, gaps: [], childCount: 0, sharedRefs: 0 }
  }
  return finalise(chosen, chosenAnchor)
}
