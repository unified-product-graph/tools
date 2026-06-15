/**
 * get_tree: server-side tree assembly (0.9.15). Assembles a canonical tree
 * pattern (OST, OKR, user, product, validation, strategy, feature_areas,
 * delivery, architecture, journey, design_system, commercial) from the active product graph
 * and returns NESTED data plus structural gaps. Rendering (emoji, score dots,
 * ASCII) stays in the client.
 */
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { getTreePattern, UPG_TREE_PATTERNS } from '@unified-product-graph/core'
import { assembleTree } from '../lib/tree-assemble.js'

/**
 * Assemble a canonical tree pattern from the active product graph, server-side.
 *
 * Replaces the client-side, edge-name-hardcoded tree assembly the `/upg-show-tree`
 * skill did (which drifted: it shipped edge chains a real graph did not use).
 * `get_tree` walks the pattern's type-driven child map over the live graph, so it
 * follows whatever edge wired a parent to a child of the expected type. It roots
 * at the pattern's anchor type, falling back through `fallback_anchors` when the
 * anchor has no nodes or reaches nothing (the "wrong root, empty tree" case), and
 * reports the substitution. It natively reports `gaps`: nodes whose pattern
 * expects children the graph lacks (a bet with no initiative, an objective with
 * no key result). Composes with `query`; it is the canonical-pattern convenience
 * on top, the way `list_status_values` sits on `get_lifecycle`.
 *
 * Parameters:
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
 * @atomicity atomic (read-only). Reads the active product only.
 * @see query
 * @see list_playbooks
 */
export const getTree: ToolHandler = (args, ctx): ToolResult => {
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

  const result = assembleTree(ctx.store, pattern, {
    from_id: args.from_id as string | undefined,
    depth: args.depth as number | undefined,
    include_properties: includeProperties,
    max_nodes: args.max_nodes as number | undefined,
  })

  return text(JSON.stringify(result, null, 2))
}
