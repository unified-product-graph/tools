/**
 * Tree assembly for `get_tree`. The implementation moved to the shared tooling
 * package in 0.9.16 so the cloud server assembles identical trees from the same
 * code; this module re-exports it to keep the local import path stable.
 *
 * @see @unified-product-graph/mcp-tooling tree-assemble.ts
 */
export {
  type GraphReader,
  type TreeNode,
  type TreeGap,
  type AssembleOptions,
  type AssembleResult,
  assembleTree,
} from '@unified-product-graph/mcp-tooling'
