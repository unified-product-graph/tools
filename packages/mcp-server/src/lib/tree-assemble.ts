/**
 * Server-side tree assembly for `get_tree`. Walks a `UPGTreePattern`'s
 * type-driven `child_map` over the live graph and returns NESTED data (not
 * rendered text) plus structural `gaps`. Rendering stays in the client.
 *
 * Type-driven, not edge-name-driven: at a node of type T, an OUTGOING edge whose
 * target is a node of a type in `child_map[T]` is a child, whatever the edge is
 * called. (Every canonical parent->child edge stores source=parent; verified
 * 2026-06-11.) This is why the pattern cannot drift when the edge catalogue
 * evolves, unlike the hardcoded edge chains the `/upg-show-tree` skill carried.
 */
import type { GraphReader } from './graph-traverse.js'
import type { UPGTreePattern } from '@unified-product-graph/core'

export interface TreeNode {
  id: string
  type: string
  title: string
  status?: string
  properties?: Record<string, unknown>
  children: TreeNode[]
}

export interface TreeGap {
  node_id: string
  type: string
  title: string
  /** The child types the pattern expects under this node but the graph lacks. */
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
  roots: TreeNode[]
  stats: { nodes: number; levels: number; truncated: boolean }
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

/** Outgoing typed children of `node`: targets whose type is in `childTypes`. */
function childrenOf(reader: GraphReader, nodeId: string, childTypes: string[]): string[] {
  if (childTypes.length === 0) return []
  const allow = new Set(childTypes)
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of reader.getEdgesForNode(nodeId)) {
    if (e.source !== nodeId) continue // follow outgoing (parent -> child) edges only
    if (seen.has(e.target)) continue
    const t = reader.getNode(e.target)
    if (t && allow.has(t.type)) {
      out.push(e.target)
      seen.add(e.target)
    }
  }
  return out
}

/**
 * Assemble the tree forest for a pattern. Tries the anchor, then each fallback,
 * stopping at the first that yields a non-empty forest with at least one child
 * (the "wrong root, empty tree" guard) — or the last candidate regardless.
 */
export function assembleTree(
  reader: GraphReader,
  pattern: UPGTreePattern,
  opts: AssembleOptions,
): AssembleResult {
  const maxNodes = Math.min(Math.max(opts.max_nodes ?? DEFAULT_MAX_NODES, 1), 2000)
  const maxDepth = Math.min(Math.max(opts.depth ?? pattern.natural_depth, 1), 12)
  const includeProps = opts.include_properties

  // Candidate root types: explicit from_id pins the root; else anchor + fallbacks.
  type Build = { anchorType: string; roots: TreeNode[]; nodes: number; levels: number; truncated: boolean; gaps: TreeGap[]; childCount: number }

  const buildFrom = (rootIds: string[], anchorType: string): Build => {
    const visited = new Set<string>()
    const gaps: TreeGap[] = []
    let nodes = 0
    let levels = 0
    let truncated = false
    let childCount = 0

    const expand = (node: TreeNode, depth: number): void => {
      if (depth > levels) levels = depth
      const childTypes = pattern.child_map[node.type] ?? []
      if (depth >= maxDepth) {
        // At the depth ceiling we still report a gap if children were expected.
        if (childTypes.length > 0 && childrenOf(reader, node.id, childTypes).length > 0) truncated = true
        return
      }
      const childIds = childrenOf(reader, node.id, childTypes)
      if (childTypes.length > 0 && childIds.length === 0) {
        gaps.push({ node_id: node.id, type: node.type, title: node.title, missing: childTypes })
        return
      }
      for (const cid of childIds) {
        if (visited.has(cid)) continue
        if (nodes >= maxNodes) { truncated = true; return }
        const child = shell(reader, cid, includeProps)
        if (!child) continue
        visited.add(cid)
        nodes++
        childCount++
        node.children.push(child)
        expand(child, depth + 1)
      }
    }

    const roots: TreeNode[] = []
    for (const rid of rootIds) {
      if (visited.has(rid)) continue
      if (nodes >= maxNodes) { truncated = true; break }
      const root = shell(reader, rid, includeProps)
      if (!root) continue
      visited.add(rid)
      nodes++
      roots.push(root)
      expand(root, 1)
    }
    return { anchorType, roots, nodes, levels, truncated, gaps, childCount }
  }

  // from_id mode: root exactly at the given node.
  if (opts.from_id) {
    const n = reader.getNode(opts.from_id)
    const anchorType = n?.type ?? pattern.anchor_type
    const b = buildFrom([opts.from_id], anchorType)
    return {
      pattern: pattern.id,
      framework_id: pattern.framework_id,
      anchor_type: pattern.anchor_type,
      anchor_used: anchorType,
      roots: b.roots,
      stats: { nodes: b.nodes, levels: b.levels, truncated: b.truncated },
      gaps: b.gaps,
    }
  }

  const candidates = [pattern.anchor_type, ...pattern.fallback_anchors]
  const idsOfType = (type: string): string[] =>
    reader.getAllNodes().filter((n) => n.type === type).map((n) => n.id)

  let chosen: Build | undefined
  for (const cand of candidates) {
    const rootIds = idsOfType(cand)
    if (rootIds.length === 0) continue // no nodes of this type: try next
    const b = buildFrom(rootIds, cand)
    chosen = b
    if (b.childCount > 0) break // non-trivial forest: keep it
    // else: anchor exists but reached nothing; try the next fallback
  }
  // Nothing matched any candidate type: empty forest rooted at the anchor.
  if (!chosen) {
    chosen = { anchorType: pattern.anchor_type, roots: [], nodes: 0, levels: 0, truncated: false, gaps: [], childCount: 0 }
  }

  const result: AssembleResult = {
    pattern: pattern.id,
    framework_id: pattern.framework_id,
    anchor_type: pattern.anchor_type,
    anchor_used: chosen.anchorType,
    roots: chosen.roots,
    stats: { nodes: chosen.nodes, levels: chosen.levels, truncated: chosen.truncated },
    gaps: chosen.gaps,
  }
  if (chosen.anchorType !== pattern.anchor_type) result.anchor_resolved_from = pattern.anchor_type
  return result
}
