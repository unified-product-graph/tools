/**
 * Tree assembly for `get_tree`. The implementation lives in the SDK (the
 * graph-data layer, shared by both servers and the CLI); this module re-exports
 * it to keep the local import path stable.
 *
 * @see @unified-product-graph/sdk lib/tree-assemble.ts
 */
export {
  type GraphReader,
  type TreeNode,
  type TreeGap,
  type AssembleOptions,
  type AssembleResult,
  assembleTree,
} from '@unified-product-graph/sdk'
