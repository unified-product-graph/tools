/**
 * get_tree (cloud, 0.9.16): server-side tree assembly. Assembles a canonical
 * tree pattern (OST, OKR, user, product, validation, strategy, feature_areas,
 * delivery, architecture, journey, design_system, commercial) from a product graph and
 * returns NESTED data plus structural gaps. Rendering
 * (emoji, score dots, ASCII) stays in the client.
 *
 * Shares the exact assembler the local server uses (`assembleTree` in
 * `@unified-product-graph/sdk`); the only cloud-specific work is loading
 * the product's nodes + edges once and wrapping them in a synchronous in-memory
 * `GraphReader`, the way the cloud `query` handler loads `allNodes`/`allEdges`.
 */
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { getTreePattern, UPG_TREE_PATTERNS } from '@unified-product-graph/core'
import { type GraphReader, assembleTree } from '@unified-product-graph/sdk'
import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * Assemble a canonical tree pattern from a product graph, server-side.
 *
 * Walks the pattern's type-driven child map over the live graph, so it follows
 * whatever edge wired a parent to a child of the expected type (drift-proof,
 * unlike hardcoded edge chains). Roots at the pattern's anchor type, falling back
 * through `fallback_anchors` when the anchor has no nodes or reaches nothing (the
 * "wrong root, empty tree" case), and reports the substitution. Natively reports
 * `gaps`: nodes whose pattern expects children the graph lacks (a bet with no
 * initiative, an objective with no key result). The cloud equivalent of the local
 * server's `get_tree`; identical output for an identical graph.
 *
 * Parameters:
 * - `product_id` (required): the product whose graph to assemble.
 * - `pattern` (required): one of `ost`, `okr`, `user`, `product`, `validation`,
 *   `strategy`, `feature_areas`, `delivery`, `architecture`, `journey`,
 *   `design_system`, `commercial` (see `UPG_TREE_PATTERNS`).
 * - `from_id`: explicit root node id; else the pattern's canonical anchor.
 * - `depth`: max levels (default = the pattern's natural depth).
 * - `include_properties`: node property keys to inline on each tree node.
 * - `max_nodes`: cap; the tree is summarised (`stats.truncated`) rather than
 *   silently cut.
 *
 * @returns JSON: `{ pattern, framework_id?, anchor_type, anchor_used,
 *   anchor_resolved_from?, roots: TreeNode[], stats: { nodes, levels, truncated },
 *   gaps: [{ node_id, type, title, missing }] }`. Structured data, never rendered text.
 * @throws textError when `product_id` or `pattern` is missing or `pattern` is unknown.
 * @atomicity atomic (read-only). Reads the named product only.
 * @see query
 * @see list_playbooks
 */
export const getTree: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const productId = args.product_id as string

  const patternId = args.pattern as string | undefined
  if (!patternId) {
    return textError(
      `Missing required parameter: pattern. One of: ${UPG_TREE_PATTERNS.map((p) => p.id).join(', ')}.`,
    )
  }
  const pattern = getTreePattern(patternId)
  if (!pattern) {
    return textError(
      `Unknown tree pattern: "${patternId}". Valid patterns: ${UPG_TREE_PATTERNS.map((p) => p.id).join(', ')}.`,
    )
  }

  const includeProperties = Array.isArray(args.include_properties)
    ? (args.include_properties as string[])
    : undefined

  const allNodes = await store.getAllNodes(productId)
  const allEdges = await store.getAllEdges(productId)

  // In-memory synchronous reader over the one-shot load, so the shared
  // (synchronous) assembler can walk the graph without per-hop awaits.
  const nodeById = new Map<string, UPGBaseNode>(allNodes.map((n) => [n.id, n]))
  const edgesByNode = new Map<string, UPGEdge[]>()
  for (const e of allEdges) {
    let src = edgesByNode.get(e.source)
    if (!src) { src = []; edgesByNode.set(e.source, src) }
    src.push(e)
    if (e.target !== e.source) {
      let tgt = edgesByNode.get(e.target)
      if (!tgt) { tgt = []; edgesByNode.set(e.target, tgt) }
      tgt.push(e)
    }
  }
  const reader: GraphReader = {
    getNode: (id) => nodeById.get(id),
    getAllNodes: () => allNodes,
    getEdgesForNode: (id) => edgesByNode.get(id) ?? [],
  }

  const result = assembleTree(reader, pattern, {
    from_id: args.from_id as string | undefined,
    depth: args.depth as number | undefined,
    include_properties: includeProperties,
    max_nodes: args.max_nodes as number | undefined,
  })

  return text(JSON.stringify(result, null, 2))
}
