/**
 * Tool registry for the UPG MCP server. Maps each tool name to its wire-shape
 * definition (served via `tools/list`) and its handler in `src/tools/*.ts`.
 */

import type { ToolDefinition } from '@unified-product-graph/mcp-tooling'
import type { ToolHandler } from './server-context.js'
import {
  getProductContext,
  getGraphDigest,
  start,
  getSessionContext,
  updateSessionContext,
} from '../tools/context.js'
import {
  listNodes,
  getNode,
  getNodes,
  searchNodes,
  query,
  createNode,
  updateNode,
  deleteNode,
  batchCreateNodes,
  batchUpdateNodes,
  batchDeleteNodes,
  migrateType,
  migrateProperties,
  deduplicateNodes,
} from '../tools/nodes.js'
import {
  createEdge,
  deleteEdge,
  moveNode,
  batchMoveNodes,
  batchCreateEdges,
  batchDeleteEdges,
  repairDanglingEdges,
  exportEdges,
  renameEdgeType,
} from '../tools/edges.js'
import {
  listProductAreas,
  getAreaGraph,
  getAreaContext,
  createArea,
  getChanges,
} from '../tools/areas.js'
import {
  listLocalProducts,
  switchProduct,
  getWorkspaceInfo,
  initWorkspaceTool,
  createProductTool,
  listPortfolios,
  getOrganization,
  createCrossProductEdge,
  listPortfolioCrossEdges,
  migrateCrossEdges,
} from '../tools/workspace.js'
import { getEntitySchema } from '../tools/schema.js'
import {
  listPlaybooks,
  getPlaybook,
  listApproaches,
  getApproach,
  plan,
  inspect,
  prioritise,
  trace,
  reflect,
  listDomains,
  getDomainGuide,
  listFrameworks,
  getFramework,
  listEdgeTypes,
  getEdgeType,
  listRegions,
  getRegion,
  getRegionForEntity,
  getSpecVersion,
  resolveEdgeForPair,
  listCrossEdgeTypes,
  listLenses,
  getLensTool,
  listTypeLabels,
  getTypeLabel,
  getValidChildrenTool,
  listEntityTypes,
  getEntityMeta,
  listAntiPatterns,
  getAntiPattern,
  listBenchmarks,
  listProductStages,
  listTypeMigrations,
  listEdgeMigrations,
  listSplitMigrations,
  listLifecycles,
  getLifecycle,
  listScales,
  getScale,
  listFrameworkCategories,
  listFrameworkStructurePatterns,
  listDomainRings,
  getDomainRing,
} from '../tools/spec.js'
import { validateGraph, getAntiPatternViolationsFor } from '../tools/validation.js'
import { migrateStatus } from '../tools/migrations.js'
import {
  getSyncState,
  applyPullChangeset,
  pushToCloud,
} from '../tools/sync.js'
import { skillAudit } from '../tools/skills.js'

// `ToolDefinition` lives in `@unified-product-graph/mcp-tooling`. Re-exported
// for backwards-compat with internal imports + the parity audit test.
export type { ToolDefinition }

export interface ToolEntry extends ToolDefinition {
  handler: ToolHandler
}

/** Wire-shape definitions passed to `tools/list`. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_product_context',
    description:
      'Product summary, entity counts by type, and a human-readable graph overview. Call first to understand the file. Pass include_summary for edge counts, orphans, and edges-by-type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_summary: {
          type: 'boolean',
          description: 'Include detailed graph statistics (edge counts by type, orphan count)',
        },
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged.' },
      },
    },
  },
  {
    name: 'get_graph_digest',
    description:
      'Pre-computed graph analytics in one call: counts, health, chain completeness, business-area coverage, lifecycle balance. ~500 tokens vs ~5-8K for equivalent manual fetches.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged (saves ~470 tokens).' },
      },
    },
  },
  {
    name: 'start',
    description:
      'Zero-state on-ramp: "there is nothing here yet, where do I begin?". Reads the live graph and, for an empty or barely-started graph, recommends the first canonical playbook (from UPG_PLAYBOOKS) plus the exact create_node call for its anchor entity. Established graphs are routed to plan / inspect / get_graph_digest instead. Takes no arguments.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_nodes',
    description:
      'List entities with filtering, edge inclusion, count-only mode, and pagination. For graph-wide edge enumeration, prefer `export_edges` (flat) or `query` (traversal). `list_nodes(include_edges:true)` is for entity-scoped reads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Filter by entity type' },
        status: { type: 'string', description: 'Filter by status value' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (matches any)' },
        parent_id: { type: 'string', description: 'Filter to children of this node (connected by outgoing edge from parent)' },
        include_edges: { type: 'boolean', description: 'Include compact edge data (id, type, source, target) per node' },
        count_only: { type: 'boolean', description: 'Return only the total count, no node data' },
        offset: { type: 'number', description: 'Skip N results (default 0)' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged.' },
      },
    },
  },
  {
    name: 'get_node',
    description:
      'Get a single entity by ID, with full properties and all connected edges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The node ID' },
        compact_edges: { type: 'boolean', description: 'Omit source_title/target_title from edges (saves ~30% on edge-heavy nodes)' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'get_nodes',
    description:
      'Batch-fetch up to 50 entities by ID. Returns each node with its edges. Use instead of looping `get_node`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of node IDs to fetch (max 50)',
        },
        compact_edges: { type: 'boolean', description: 'Omit titles from edges' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'search_nodes',
    description:
      'Search entities by text. Default fields: title (score 3) and description (score 1). Add `fields` to include tags (score 2) and properties (score 1). Results include `matched_field`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search text (case-insensitive substring match)' },
        type: { type: 'string', description: 'Optional type filter' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to search: "title", "description", "tags", "properties" (default: title + description)',
        },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query',
    description:
      'Traverse the graph following typed edges. Returns a subgraph (nodes + edges) in a single call. Example: query({ from: "persona", traverse: ["persona_pursues_job", "job_surfaces_need"], depth: 2 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start from all nodes of this type' },
        from_id: { type: 'string', description: 'Start from a specific node ID (alternative to from)' },
        traverse: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow at each level (in order). If omitted, follows all edges. Prefix with ! to exclude (e.g. "!product_builds_feature").',
        },
        depth: { type: 'number', description: 'Max traversal depth (default 3, max 10)' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to include per node: "title", "status", "tags", "description", "properties" (default: title, status, type)',
        },
        limit: { type: 'number', description: 'Max nodes to return (default 200, max 1000)' },
        edge_include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge fields to return: "id", "type", "source", "target". Empty array = no edges. Default: all fields.',
        },
        property_include: {
          type: 'array',
          items: { type: 'string' },
          description: 'When "properties" is in include, only return these property keys (e.g. ["severity", "importance"])',
        },
        diff_from: { type: 'string', description: 'Result ID from a previous query. Returns only added/removed nodes since that result.' },
      },
    },
  },
  {
    name: 'create_node',
    description:
      'Create one entity, optionally with a parent edge. For 3+ entities, use `batch_create_nodes` instead of looping. Portfolio-scoped types (`portfolio`, `organization`, `product_area`) route to `.upg/portfolio.upg` rather than the active product\'s `nodes[]`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'UPG entity type (e.g. "persona", "opportunity"). Portfolio-scoped: "portfolio", "organization", "product_area".',
        },
        title: { type: 'string', description: 'Entity title' },
        description: { type: 'string', description: 'Optional description' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Freeform tags',
        },
        status: { type: 'string', description: 'Lifecycle status' },
        properties: {
          type: 'object',
          description: 'Type-specific fields',
        },
        parent_id: {
          type: 'string',
          description: 'Parent node ID. Creates an edge automatically. Ignored for portfolio-scoped types.',
        },
        overwrite_organization: {
          type: 'boolean',
          description: 'For type="organization" only. When true, replaces the existing portfolio organisation instead of throwing.',
        },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'update_node',
    description: 'Update one entity. Unspecified fields are preserved. Passing `type` performs an atomic single-node migration: every incident edge is re-inferred against the catalog and rollback applies on failure. For 3+ entities, use `batch_update_nodes`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The node ID to update' },
        type: { type: 'string', description: 'Change the entity type. Atomic single-node migration: validates against UPG_TYPES, rewrites incident edges to canonical types.' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        properties: {
          type: 'object',
          description: 'Merged with existing properties',
        },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'delete_node',
    description: 'Remove one entity and all its connected edges. For 3+ entities, use `batch_delete_nodes`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The node ID to delete' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'batch_create_nodes',
    description:
      'Create up to 50 entities in one atomic call, optionally with explicit edges in the same transaction. Use `parent_ref` ("$0", "$1") to reference nodes created earlier in the same batch. The optional `edges` array accepts the same `$N` refs (or existing node IDs) for both endpoints. All nodes and edges validate up front; on failure nothing lands.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'UPG entity type (e.g. "persona", "opportunity")' },
              title: { type: 'string', description: 'Entity title' },
              description: { type: 'string', description: 'Optional description' },
              status: { type: 'string', description: 'Lifecycle status' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Freeform tags' },
              properties: { type: 'object', description: 'Type-specific fields' },
              parent_id: { type: 'string', description: 'Parent node ID. Creates an edge automatically.' },
              parent_ref: { type: 'string', description: 'Reference a node created earlier in this batch by index, e.g. "$0", "$1"' },
            },
            required: ['type', 'title'],
          },
          description: 'Array of nodes to create (max 50)',
        },
        edges: {
          type: 'array',
          description:
            'Optional edges to create alongside the nodes (same atomic transaction). Each edge\'s from/to may be a `$N` ref into the `nodes` array OR an existing node ID.',
          items: {
            type: 'object',
            properties: {
              from_ref: {
                type: 'string',
                description: '`$N` ref or existing node id for the source endpoint',
              },
              to_ref: {
                type: 'string',
                description: '`$N` ref or existing node id for the target endpoint',
              },
              type: {
                type: 'string',
                description: 'Optional explicit edge type (must be in UPG_EDGE_CATALOG). If omitted, inferred from canonical source/target types.',
              },
            },
            required: ['from_ref', 'to_ref'],
          },
        },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'batch_update_nodes',
    description:
      'Update up to 50 entities atomically (all succeed or all fail). Unspecified fields preserved. Properties merge with existing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node_id: { type: 'string', description: 'The node ID to update' },
              title: { type: 'string' },
              description: { type: 'string' },
              status: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              properties: { type: 'object', description: 'Merged with existing properties' },
            },
            required: ['node_id'],
          },
          description: 'Array of updates to apply (max 50)',
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'batch_delete_nodes',
    description:
      'Delete up to 50 entities and their connected edges in one atomic call (all succeed or all fail).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of node IDs to delete (max 50)',
        },
      },
      required: ['node_ids'],
    },
  },
  {
    name: 'batch_create_edges',
    description:
      'Create up to 50 edges in one atomic call. Use this for 3+ edges instead of looping `create_edge`. Edge type auto-infers when omitted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source_id: { type: 'string', description: 'Source node ID' },
              target_id: { type: 'string', description: 'Target node ID' },
              type: { type: 'string', description: 'Edge type. Auto-inferred if omitted.' },
            },
            required: ['source_id', 'target_id'],
          },
          description: 'Array of edges to create (max 50)',
        },
      },
      required: ['edges'],
    },
  },
  {
    name: 'batch_delete_edges',
    description:
      'Delete up to 50 edges in one atomic call (all succeed or all fail).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of edge IDs to delete (max 50)',
        },
      },
      required: ['edge_ids'],
    },
  },
  {
    name: 'repair_dangling_edges',
    description:
      'Inspect or drop edges whose source or target node fails to resolve. Each is classified `expected` (cross-product, sibling not loaded; keep), `suspect` (cross-product, missing product-id annotation), or `corrupt` (broken endpoint on a non-cross edge). Defaults to `dry_run: true`. Pass `dry_run: false` plus `drop: ["suspect", "corrupt"]` to remove.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'When true (default), returns the classification report without mutating. When false, drops edges matching `drop`.',
        },
        drop: {
          type: 'array',
          items: { type: 'string', enum: ['expected', 'suspect', 'corrupt'] },
          description: 'Classes of dangling edge to drop. Only honoured when dry_run is false. Omit to no-op.',
        },
      },
    },
  },
  {
    name: 'export_edges',
    description:
      'Flat edge enumeration. Returns every edge of the listed `types` (or all edges when `types` is omitted) as `{id, source, target, type}` with no parent-node payload. Right for migration and canonicalisation passes. Paginates via offset/limit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by exact edge-type match. Omit to enumerate every edge in the document.',
        },
        offset: { type: 'number', description: 'Skip N results (default 0)' },
        limit: { type: 'number', description: 'Max results (default 500, max 2000)' },
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged.' },
      },
    },
  },
  {
    name: 'rename_edge_type',
    description:
      'Exact-match rename of every edge of type `from` to type `to`, optionally flipping source/target. Single transactional pass. Defaults to `dry_run: true`; pass `dry_run: false` to commit. Low-level primitive: skips catalog validation. Use catalog-aware migration tools for validated renames.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Current edge type (exact match)' },
        to: { type: 'string', description: 'New edge type to assign' },
        flip: { type: 'boolean', description: 'When true, swap source/target on each renamed edge (default false)' },
        dry_run: { type: 'boolean', description: 'Preview without mutating (default true)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'create_edge',
    description:
      'Create one edge between two nodes. Edge type auto-infers when omitted. Target accepts an ID, or a title+type pair the server resolves. For 3+ edges, use `batch_create_edges`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'Source node ID' },
        target_id: { type: 'string', description: 'Target node ID' },
        target_title: { type: 'string', description: 'Target node title (alternative to target_id; requires target_type).' },
        target_type: { type: 'string', description: 'Target node type (used with target_title for resolution)' },
        type: {
          type: 'string',
          description: 'Edge type. Auto-inferred if omitted.',
        },
      },
      required: ['source_id'],
    },
  },
  {
    name: 'delete_edge',
    description: 'Remove one edge by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_id: { type: 'string', description: 'The edge ID to delete' },
      },
      required: ['edge_id'],
    },
  },
  {
    name: 'move_node',
    description:
      'Atomic re-parent. Removes any existing hierarchy edge and creates a new one to `new_parent_id`. Validates against `UPG_EDGE_CATALOG` first; rolls back fully on failure.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The node to re-parent' },
        new_parent_id: { type: 'string', description: 'The new parent node id' },
        new_edge_type: {
          type: 'string',
          description:
            'Optional override. Must be a key in UPG_EDGE_CATALOG. If omitted, the edge type is inferred from new_parent.type → node.type.',
        },
        old_edge_id: {
          type: 'string',
          description:
            'Required when the node has more than one hierarchy edge. Picks which one to delete.',
        },
      },
      required: ['node_id', 'new_parent_id'],
    },
  },
  {
    name: 'batch_move_nodes',
    description:
      'Apply up to 50 atomic re-parents. All moves validate against the schema first; any failure rolls back the whole batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        moves: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              node_id: { type: 'string' },
              new_parent_id: { type: 'string' },
              new_edge_type: { type: 'string' },
              old_edge_id: { type: 'string' },
            },
            required: ['node_id', 'new_parent_id'],
          },
        },
      },
      required: ['moves'],
    },
  },
  {
    name: 'get_changes',
    description:
      'Mutation log for this session. Verify what was created, updated, or deleted without re-fetching.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'ISO 8601 timestamp. Only returns changes after this time (default: all session changes).' },
      },
    },
  },
  {
    name: 'list_product_areas',
    description:
      'List product areas from the portfolio document (`.upg/portfolio.upg`). Returns an empty list when no portfolio document exists yet.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_area_graph',
    description:
      'Return the sub-graph (entities and edges) scoped to a product area.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        area_id: { type: 'string', description: 'The product area node ID' },
        depth: {
          type: 'number',
          description: 'How many levels deep to traverse (default 3, max 10)',
        },
      },
      required: ['area_id'],
    },
  },
  {
    name: 'list_local_products',
    description:
      'Find every .upg file in the current directory and its immediate subdirectories.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'switch_product',
    description:
      'Switch to a different .upg file without restarting the server. In workspace mode, accepts just a filename (e.g. "client-project" or "client-project.upg").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description:
            'Path to the .upg file (relative, absolute, or a bare product name in workspace mode).',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'get_workspace_info',
    description:
      'Workspace info: which product is loaded, what other products are available, current workspace mode.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'init_workspace',
    description:
      'Initialise a UPG workspace. Creates `.upg/` and moves the current .upg file into it. Unlocks multi-product management.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        move_existing: {
          type: 'boolean',
          description:
            'Move existing .upg files into the workspace (default true)',
        },
      },
    },
  },
  {
    name: 'create_product',
    description:
      'Create a sibling .upg product in the current workspace. Mints a canonical product id, writes the file, stamps integrity, registers in `workspace.json`. Pairs with `init_workspace` and `switch_product`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Product display title (required, non-empty).',
        },
        slug: {
          type: 'string',
          description:
            'Optional slug for the .upg filename. Defaults to a slug derived from `name`. Collisions append `-2`, `-3`, …',
        },
        description: { type: 'string', description: 'Optional product description' },
        stage: {
          type: 'string',
          description: 'Product lifecycle stage. See UPGProductStage in @unified-product-graph/core.',
        },
        portfolio_id: {
          type: 'string',
          description:
            'Optional portfolio node id in the current store. When provided, a `portfolio_contains_product` edge is created in the current graph.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'migrate_type',
    description:
      'Migrate every entity of one type to another, applying defaults from `UPG_MIGRATIONS`. Three passes commit as one write: (1) node rename, (2) edges through `UPG_EDGE_MIGRATIONS` (catalog-aware renames, direction flips, drops; endpoint guards check post-migration types; uncatalogued edges surface as `unmapped_legacy_edges`), (3) every node through `UPG_PROPERTY_MIGRATIONS` (top-level renames, lifts, drops, self-referential cleanup). Type-specific property rules see the post-rename type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_type: { type: 'string', description: 'The current entity type to migrate FROM' },
        to_type: { type: 'string', description: 'The new entity type to migrate TO' },
        dry_run: { type: 'boolean', description: 'Preview changes without applying (default false)' },
      },
      required: ['from_type', 'to_type'],
    },
  },
  {
    name: 'migrate_properties',
    description:
      'Apply `UPG_PROPERTY_MIGRATIONS` graph-wide with no type rename or edge migration. Pure property pass: `drop_props`, `rename_top_level`, `lift_property_to_top_level`, `drop_when_self_referential`. Default `dry_run=true` previews the per-rule change set; pass `dry_run=false` to commit. Use when you want property cleanup standalone; `migrate_type` folds the same pass into its rename.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dry_run: {
          type: 'boolean',
          description:
            'Preview changes without applying (default true). Pass false to commit.',
        },
      },
    },
  },
  {
    name: 'migrate_status',
    description:
      'Apply `UPG_STATUS_MIGRATIONS` graph-wide: rewrite legacy lifecycle status values to canonical phase ids. Auto-mode (no filters) selects nodes whose current status is invalid against the entity type\'s lifecycle and has a registered replacement (the same invariant that drives `validate_graph` lifecycle_drift). Surgical mode (`from_status` + `to_status`) overrides the registry and rewrites every (entity_type?, from_status) match. Nodes with invalid statuses but no registered replacement surface under `skipped_no_migration`. Default `dry_run=true`; pass `dry_run=false` to commit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: {
          type: 'string',
          description:
            'Optional. Restrict the rewrite to nodes of this canonical entity type (e.g. "service", "feature").',
        },
        from_status: {
          type: 'string',
          description:
            'Optional. Restrict the rewrite to nodes whose current status equals this exact value. When provided, `to_status` is required and the registry is bypassed.',
        },
        to_status: {
          type: 'string',
          description:
            'Required when `from_status` is provided. The canonical phase id to write.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Preview changes without applying (default true). Pass false to commit.',
        },
      },
    },
  },
  {
    name: 'deduplicate_nodes',
    description:
      'Find duplicate entities (same title + type) and return them grouped. `dry_run` previews; otherwise keeps one per group and redirects edges from the others.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Only check this entity type. Omit to check all types.' },
        dry_run: { type: 'boolean', description: 'Preview duplicates without merging (default true)' },
        keep: { type: 'string', description: 'Which duplicate to keep when merging: "newest" (default) or "oldest".' },
      },
    },
  },
  {
    name: 'get_entity_schema',
    description:
      'Return expected properties, valid statuses, valid edge types, and domain for an entity type. Lets agents construct valid entities without skill prompts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Entity type (e.g. "hypothesis", "persona", "opportunity")' },
      },
      required: ['type'],
    },
  },
  // ── Spec introspection ─────────────────────────────────
  {
    name: 'list_playbooks',
    description:
      'List canonical UPG playbooks from `@unified-product-graph/core`. Each playbook bootstraps a region; its `creation_sequence` answers "what to create when populating this region". Filters: `region`, `canonical_only`, `framework_id`. The catalog spans 10 regions: one canonical playbook per region, plus specialised playbooks (three carry a `framework_id`: BMC, AARRR, build-measure-learn).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: { type: 'string', description: 'Exact-match UPGRegionId (e.g. "users_needs", "business_gtm_growth").' },
        canonical_only: { type: 'boolean', description: 'When true, return only the canonical playbook per region (W1 invariant restated).' },
        framework_id: { type: 'string', description: 'Exact-match UPGFramework.id (e.g. "business-model-canvas", "pirate-metrics-aarrr").' },
      },
    },
  },
  {
    name: 'get_playbook',
    description:
      'Return one `UPGPlaybook` by id (e.g. "playbook:strategy-outcomes", "playbook:business-gtm-growth"). Includes the ordered `creation_sequence` with step kinds and prompts. IDs are namespace-prefixed `playbook:*`. For approaches, use `get_approach`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Playbook id (namespace-prefixed: playbook:*).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_approaches',
    description:
      'List the 5 canonical `UPGApproach` records: Plan, Inspect, Prioritise, Trace, Reflect. An approach is the path of arrival to a region of the graph (final approach to an airport, coastline approach). Each record carries id, label, description, `question_answered`, `signature_hint`, `framework_id_examples`. Optional `framework_id` narrows to approaches whose `framework_id_examples` include it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        framework_id: { type: 'string', description: 'Exact-match framework id. Narrows to approaches whose framework_id_examples include it (discoverability surface; full reverse lookup is on UPGFramework.approach_ids).' },
      },
    },
  },
  {
    name: 'get_approach',
    description:
      'Return one `UPGApproach` by id. Valid ids: `plan`, `inspect`, `prioritise`, `trace`, `reflect` (same names as the verb-led MCP tools).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Approach id. One of: plan, inspect, prioritise, trace, reflect.', enum: ['plan', 'inspect', 'prioritise', 'trace', 'reflect'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'plan',
    description:
      'Plan approach: path of arrival to "what should I build next?". Returns the Plan record + invocation params wrapped in `{ approach_id, scope, generated_at, approach, params }`. The LLM consumes `signature_hint` and synthesises `{ missing_entities, coverage_score }` against the live graph. Optional `region` narrows scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: { type: 'string', description: 'Optional UPGRegionId. Narrows planning scope to a single region (e.g. "users_needs", "business_gtm_growth"). Omit for whole-graph planning.' },
      },
    },
  },
  {
    name: 'inspect',
    description:
      '[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing inspection, invoke the /upg-inspect skill instead of calling this tool directly. Inspect approach: path of arrival to "what\'s broken?". Returns the Inspect record + invocation params in the family-resemblance envelope. The LLM consumes `signature_hint` and emits `{ violations: [{ severity, kind, entity_id, description, fix_hint }] }` against `UPG_ANTI_PATTERNS` + the live graph. Optional `region` or `entities[]` scope the audit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: { type: 'string', description: 'Optional UPGRegionId. Narrows inspection scope to a single region.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Optional entity_id[]. Narrows inspection scope to a specific candidate set. Composable with region.' },
      },
    },
  },
  {
    name: 'prioritise',
    description:
      '[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing prioritisation, invoke the /upg-prioritise skill instead of calling this tool directly. Prioritise approach: path of arrival to "what\'s most important?". Returns the Prioritise record + invocation params + framework metadata in the family-resemblance envelope. Both `candidates` and `framework_id` are required. The LLM looks up the framework via `get_framework`, reads its scoring spec, and emits `{ ranked: [{ entity_id, score, rationale }], framework_used }`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        candidates: { type: 'array', items: { type: 'string' }, description: 'Required. entity_id[] to rank.' },
        framework_id: { type: 'string', description: 'Required. UPGFramework.id of the scoring lens (e.g. "rice-scoring", "ice-scoring", "kano-model", "cost-of-delay", "wsjf").' },
      },
      required: ['candidates', 'framework_id'],
    },
  },
  {
    name: 'trace',
    description:
      '[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing tracing, invoke the /upg-trace skill instead of calling this tool directly. Trace approach: path of arrival to "walk a meaningful path through existing graph". Returns the Trace record + invocation params in the family-resemblance envelope. The LLM uses `anchor` + `path` to compose `query()` calls and emits `{ trail: [{ depth, entity_id, edge_type_in }], reached: entity_id[] }`. `path` is type-shorthand: `["persona","job","feature"]` walks persona→job→feature using the canonical edge per pair (via `resolve_edge_for_pair`). Optional `edges_override` selects non-canonical edges per hop; `null` per element means "use canonical".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        anchor: { type: 'string', description: 'Required. entity_id where the traversal starts.' },
        path: { type: 'array', items: { type: 'string' }, description: 'Required. UPGEntityType[] type-shorthand path. Each step walks via the canonical edge for the source→target pair.' },
        edges_override: { type: 'array', items: { type: ['string', 'null'] }, description: 'Optional. Per-hop edge override array. Length must match path length; element null means "use canonical edge for this pair".' },
      },
      required: ['anchor', 'path'],
    },
  },
  {
    name: 'reflect',
    description:
      '[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing reflection, invoke the /upg-reflect skill instead of calling this tool directly. Reflect approach: path of arrival to "what should I be questioning?". Returns the Reflect record + invocation params in the family-resemblance envelope. The LLM consumes `mode` + `scope` + `signature_hint` and emits `{ prompts: [{ kind, question, target_entities? }] }`. `mode` is one of: `assumptions`, `alternatives`, `blind-spots`, `load-bearing`; omit for open reflection. `scope` accepts a region id, entity id, or `null` for whole-graph.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: ['string', 'null'], description: 'Optional. Region id, entity id, or null for whole-graph.' },
        mode: { type: 'string', description: 'Optional. One of: assumptions, alternatives, blind-spots, load-bearing. Omit for open reflection.', enum: ['assumptions', 'alternatives', 'blind-spots', 'load-bearing'] },
      },
    },
  },
  {
    name: 'list_domains',
    description:
      'List domains. Default (`with_guide_only: true`) returns every domain with a canonical usage guide: id + `anchor_entity` + `creation_sequence`. Pass `with_guide_only: false` to enumerate every atomic domain from `UPG_DOMAINS`: id + label + description + types + `has_guide`. The two shapes are disjoint by the boolean.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        with_guide_only: {
          type: 'boolean',
          description:
            'Default true. Returns only domains with a canonical usage guide (compact id + anchor_entity + creation_sequence). Pass false to return every atomic domain (id + label + description + types + has_guide).',
        },
      },
    },
  },
  {
    name: 'get_domain_guide',
    description:
      'Return the full `UPGDomainUsageGuide` for a domain: anchor entity, creation sequence, named patterns (entity + edge chains), required cross-domain bridges, anti-patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain_id: { type: 'string', description: 'Canonical domain id (e.g. "user", "market_intelligence", "growth").' },
      },
      required: ['domain_id'],
    },
  },
  {
    name: 'list_frameworks',
    description:
      'List the canonical `UPGFramework` definitions; the 34 curated, famous product frameworks that anchor the public catalog (spanning strategy, discovery, prioritisation, design, growth, engineering, and reflection classics). Paginated (default 50, max 200). Cursor is opaque: pass `next_cursor` from a previous response. Optional `category` is exact-match against `UPGFramework.category` and applies before pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Exact-match filter on UPGFramework.category (e.g. "strategy", "prioritization").' },
        limit: { type: 'number', description: 'Page size (default 50, max 200).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor. Pass next_cursor from a previous response.' },
      },
    },
  },
  {
    name: 'get_framework',
    description:
      'Return one `UPGFramework` by id (e.g. "rice-scoring", "lean-canvas"). Includes all four layers: data, structure, presentation, education.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Framework id (kebab-case).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_edge_types',
    description:
      'List every canonical edge type from `UPG_EDGE_CATALOG`, optionally narrowed by `source_type` and/or `target_type`. Each entry carries the edge key (`type`), forward/reverse verbs, classification, and endpoint types. The polymorphic wildcard `"node"` is preserved on polymorphic edges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_type: { type: 'string', description: 'Exact-match filter on UPGEdgeDefinition.source_type. Pass "node" to find polymorphic edges with a wildcard source.' },
        target_type: { type: 'string', description: 'Exact-match filter on UPGEdgeDefinition.target_type.' },
      },
    },
  },
  {
    name: 'get_edge_type',
    description:
      'Return one edge catalogue entry by edge type key (e.g. "persona_pursues_job", "feature_addresses_need").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Edge type key from UPG_EDGE_CATALOG.' },
      },
      required: ['type'],
    },
  },
  // ── Spec introspection round 2 ─────────────────────────────────
  {
    name: 'list_regions',
    description:
      'List the 10 canonical UPG super-domain regions from `UPG_REGIONS`. Returns a compact summary per region: id, label, order, shape, `mental_model`, `anchor_type`, `composes_atomic_domains`, `entity_count`, `intra_edge_count`, `boundary_edge_count`. Fixed list, non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_region',
    description:
      'Return the full `UPGRegion` record by id: anchor entity (with rationale and inbound/outbound cross-edge counts), entity memberships with structural roles, intra-domain edge keys, boundary edges to other regions, shape archetype, atomic-domain composition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description:
            'Region id (e.g. "strategy_outcomes", "users_needs", "product_delivery"). See UPG_REGIONS for the full list of 10.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_region_for_entity_type',
    description:
      'Resolve which super-domain region contains a given entity type. Wraps `getRegionForEntityType`; returns the full `UPGRegion` record. Use for adapters and copilots that route or render an entity by its super-domain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: {
          type: 'string',
          description: 'Canonical entity type (e.g. "persona", "feature", "metric").',
        },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'get_spec_version',
    description:
      'Spec-level metadata for compatibility checks: `upg_version`, `markdown_format_version`, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'resolve_edge_for_pair',
    description:
      'Resolve the canonical `UPGEdgeType` for a `source_type` → `target_type` containment pair. Wraps `resolveContainmentEdge` / `UPG_EDGE_PAIR_MAP`. Adapter-critical: every import adapter (Markdown, Notion, Linear, GitHub) uses it to look up the right `_contains_` edge before falling back to a polymorphic edge. Returns `{ edge_type: null }` when the pair is uncatalogued.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_type: { type: 'string', description: 'Parent / source entity type.' },
        target_type: { type: 'string', description: 'Child / target entity type.' },
      },
      required: ['source_type', 'target_type'],
    },
  },
  {
    name: 'list_cross_edge_types',
    description:
      'List the canonical cross-product edge types from `UPG_CROSS_EDGE_TYPES`: `shares_persona`, `shares_competitor`, `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`. Portfolio-level relationships across products. Distinct from the within-product `UPG_EDGE_CATALOG`.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_lenses',
    description:
      'List every canonical `UPGLens` from `@unified-product-graph/core`: Product, Design, Engineering, Growth, Business, Research, Marketing, Full. Returns a compact summary per lens: id, name, description, icon, audience, perspective, `framework_id`, `playbook_id`, `visible_domain_count`, `intelligence_prompt_count`. Use `get_lens` for the full record.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_lens',
    description:
      'Return the full `UPGLens` record by id (e.g. "product", "ux_design", "engineering", "full") plus the resolved entity types visible through that lens. Combines the lens record with `visible_types` in one response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Lens id (e.g. "product", "ux_design", "full").' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_type_labels',
    description:
      'List canonical `UPGTypeLabel` entries: each entity type\'s display label, alt-labels (synonyms), per-framework labels, and designation labels where applicable. Paginated (default 100, max 500). Cursor is opaque base64 (`offset:N`), same convention as `list_frameworks`. External MCP apps need labels for rendering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Page size (default 100, max 500).' },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor. Pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_type_label',
    description:
      'Return one `UPGTypeLabel` by entity type, plus a resolved display label for an optional `framework_id` and/or `designation` (wraps `resolveLabel`). Lookup is exact-match against `UPG_TYPE_LABELS_MAP`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Canonical entity type id.' },
        framework_id: {
          type: 'string',
          description: 'Optional framework id (e.g. "lean_canvas", "ost", "design_thinking"). When set, resolved_label uses the framework-specific label.',
        },
        designation: {
          type: 'string',
          description: 'Optional designation key (e.g. "pain", "gap", "desire") for types that use the designation pattern.',
        },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'get_valid_children',
    description:
      'Return valid direct-child entity types for a parent type. Wraps `getValidChildren` / `UPG_VALID_CHILDREN`. Empty array when none registered. Answers "what can I create under this?". Pairs with `get_entity_schema`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        parent_type: { type: 'string', description: 'Canonical parent entity type.' },
      },
      required: ['parent_type'],
    },
  },
  // ── Spec introspection round 3 ─────────────────────────────────
  {
    name: 'list_entity_types',
    description:
      'List canonical entity types from `UPG_ENTITY_META` (source of truth for ontology evolution). Every active, deprecated, or removed type with its immutable `type_id`, maturity tier, and version metadata. Paginated (default 50, max 200). Filters AND together and apply before pagination: `domain` (atomic-domain id), `maturity` (`draft` / `proposed` / `stable` / `deprecated` / `removed`), `deprecated` (boolean shortcut). Each row carries the full `EntityTypeMeta` plus resolved `domain_id` (null if no atomic-domain mapping).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Exact-match atomic-domain id (e.g. "user", "market_intelligence").' },
        maturity: {
          type: 'string',
          enum: ['draft', 'proposed', 'stable', 'deprecated', 'removed'],
          description: 'Exact-match UPGEntityTypeMaturity.',
        },
        deprecated: {
          type: 'boolean',
          description: 'true → only deprecated types; false → exclude deprecated and removed types (the active set). Composes with maturity via AND.',
        },
        limit: { type: 'number', description: 'Page size (default 50, max 200).' },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor. Pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_entity_meta',
    description:
      'Return one `EntityTypeMeta` record by entity type name, plus resolved `domain_id` (null when unmapped). One type\'s lifecycle metadata: maturity tier, since-version, replacement target if deprecated. Pass the canonical name (e.g. "persona", "pain_point"), not the immutable `type_id`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Canonical entity type name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_anti_patterns',
    description:
      'List curated cross-domain anti-patterns from `UPG_ANTI_PATTERNS`. Each row pairs a memorable name with a machine-evaluable `IntelligenceCondition`, applicable stages, severity, and remediation. Graph-health patterns evaluated whole-graph (distinct from per-domain anti-patterns via `get_domain_guide`). Paginated (default 50, max 200). Filters AND together: `severity` (`high` / `medium` / `low`), `stage` (keeps patterns whose `stages[]` includes the given `UPGProductStage`).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Exact-match UPGAntiPatternSeverity.',
        },
        stage: {
          type: 'string',
          enum: [
            'concept', 'validation', 'build', 'beta', 'launch',
            'growth', 'mature', 'maintenance', 'sunset',
          ],
          description: 'Keeps anti-patterns whose stages[] includes the given UPGProductStage.',
        },
        limit: { type: 'number', description: 'Page size (default 50, max 200).' },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor. Pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_anti_pattern',
    description:
      'Return one curated anti-pattern by id (kebab-case slug, e.g. "features-without-hypotheses", "personas-without-jobs"). Includes structured condition, why-it-matters, remediation, applicable stages, severity, optional source citation. IDs are stable URL fragments.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Anti-pattern id (kebab-case slug).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_benchmarks',
    description:
      'Return one of four canonical benchmark catalogs (the data behind `get_graph_digest` health logic). Required `kind` selects the source: `count` → `UPG_COUNT_BENCHMARKS` (per-entity-type ranges across the 9-stage journey); `relationship` → `UPG_RELATIONSHIP_BENCHMARKS` (parent → child minimum counts per stage); `ratio` → `UPG_RATIO_BENCHMARKS` (expected ratios between entity-type counts); `domain_activation` → `UPG_DOMAIN_ACTIVATION` (when each atomic domain is expected to activate). Optional filters AND together: `stage` (`UPGProductStage`), `domain` (atomic-domain id). Non-paginated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['count', 'relationship', 'ratio', 'domain_activation'],
          description: 'Required. Which benchmark catalog to return.',
        },
        stage: {
          type: 'string',
          enum: [
            'concept', 'validation', 'build', 'beta', 'launch',
            'growth', 'mature', 'maintenance', 'sunset',
          ],
          description: 'Optional UPGProductStage filter. Semantics depend on kind (see tool description).',
        },
        domain: {
          type: 'string',
          description: 'Optional atomic-domain id filter. Semantics depend on kind (see tool description).',
        },
      },
      required: ['kind'],
    },
  },
  {
    name: 'list_product_stages',
    description:
      'Return the canonical 9-stage product journey from `UPG_PRODUCT_STAGES` in order: concept → validation → build → beta → launch → growth → mature → maintenance → sunset. The closed enum used by `create_product`, `get_graph_digest` health logic, benchmark stage scoping, and anti-pattern stage filters.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // ── Spec introspection round 5 ──────────────────────────────────
  {
    name: 'list_type_migrations',
    description:
      'List every type-rename migration from `UPG_MIGRATIONS` (version-scoped registry of deprecated `from` → canonical `to` renames, e.g. `pain_point` → `need`, `hypothesis` → `hypothesis_claim`). Each row: `{ from, to, since }` where `since` is the spec version that introduced it. Optional `from_type` exact-matches `from`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_type: { type: 'string', description: 'Exact-match filter on the deprecated type name (e.g. "pain_point", "hypothesis").' },
      },
    },
  },
  {
    name: 'list_edge_migrations',
    description:
      'List every edge-key migration from `UPG_EDGE_MIGRATIONS` (renamed or dropped canonical edge keys, e.g. `persona_has_jtbd` → `persona_pursues_job`). Each row: `{ kind, from, to?, since }` where `kind` is `rename` or `drop`. Optional `from_edge` exact-matches `from`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_edge: { type: 'string', description: 'Exact-match filter on the deprecated edge key (e.g. "persona_has_jtbd").' },
      },
    },
  },
  {
    name: 'list_split_migrations',
    description:
      'List every 1→N split migration from `UPG_SPLIT_MIGRATIONS` ("one type became multiple types" rules, e.g. `experiment` → `experiment_plan` + `experiment_run`; `hypothesis` → `hypothesis_claim` + `hypothesis_evidence`). Each row: the full `UPGSplitMigration` record plus `since`. Non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_lifecycles',
    description:
      'List lifecycle definitions from `UPG_LIFECYCLES`. Response includes `free_types` (`UPG_LIFECYCLE_FREE_TYPES`: static types with no phase progression) and `planned_types` (`UPG_LIFECYCLE_PLANNED_TYPES`: lifecycle planned but not yet authored). Filters: `entity_type` (exact-match), `lifecycle_only` (when true, omits the free/planned lists).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Exact-match entity type name (e.g. "feature", "hypothesis"). Returns at most one lifecycle.' },
        lifecycle_only: { type: 'boolean', description: 'When true, omit free_types and planned_types from response.' },
      },
    },
  },
  {
    name: 'get_lifecycle',
    description:
      'Return the full `UPGLifecycle` definition for one entity type: initial phase, terminal phases, ordered phases with transitions and core states. Returns a descriptive message (not an error) when the type has no lifecycle.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Canonical entity type name (e.g. "feature", "hypothesis", "opportunity").' },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'list_scales',
    description:
      'List every spec-defined assessment scale from `UPG_SCALES` (canonical vocabulary for `UPGAssessment` values). Each scale carries id, label, description, min, max, steps, and per-point labels + descriptions. Non-paginated. External `scale_extensions` are graph-instance–scoped and excluded here.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_scale',
    description:
      'Return one spec-defined assessment scale by id (e.g. "reach_5", "severity_5", "confidence_binary"). Includes the full point array. Returns a descriptive message (not an error) when the id is unknown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Scale id (e.g. "reach_5", "frequency_5", "severity_5", "importance_5", "confidence_binary").' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_framework_categories',
    description:
      'List valid framework category values from `UPG_FRAMEWORK_CATEGORIES` (e.g. "strategy", "prioritization", "discovery", "growth", "engineering"). Use as valid values for the `category` filter on `list_frameworks` / `get_framework`.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_framework_structure_patterns',
    description:
      'List valid framework structure-pattern values from `UPG_STRUCTURE_PATTERNS`. Visual topological shapes: tree, table, matrix, funnel, collection, quadrant, flow. Mirrors `UPGFramework.structure.pattern`.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_domain_rings',
    description:
      'List every `UPGDomainRing` from `UPG_DOMAIN_RINGS` in canonical order: Nucleus → Understand → Define → Build → Grow → Operate → Extend. Rings are the 7 concentric groupings of the 36 UPG atomic domains. Each ring: `{ id, label, description, domain_ids }`. Non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_domain_ring',
    description:
      'Return one `UPGDomainRing` by id (one of: `nucleus`, `understand`, `define`, `build`, `grow`, `operate`, `extend`). Returns a descriptive message (not an error) when the id is unknown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Ring id. One of: nucleus, understand, define, build, grow, operate, extend.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'validate_graph',
    description:
      'Walk the loaded graph and return a per-class, per-node report of schema drift plus anti-pattern violations from `UPG_ANTI_PATTERNS`. Schema-drift classes: non-canonical entity types, non-canonical edge types, top-level fields outside `UPGBaseNode`, invalid status values, self-referential `source_id`/`source_type`, properties matching `UPG_PROPERTY_MIGRATIONS` rules. Anti-patterns: catalog entries that fired against the live graph, sorted high → medium → low. Each entry carries `suggested_migration` (drift) or `remediation` (anti-pattern). Top-level `valid` is true iff drift is empty AND no violations fired. Read-only; pairs with `migrate_type`, `rename_edge_type`, `get_anti_pattern_violations_for`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'entity_drift', 'edge_drift', 'property_drift', 'top_level_drift', 'lifecycle_drift', 'self_referential'],
          description: 'Which drift class(es) to include in the response (default "all"). Counts in `summary` are always returned for every class.',
        },
        limit: { type: 'number', description: 'Max entries per class (default 100, max 1000)' },
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Filter anti-pattern violations to one severity tier.',
        },
        anti_pattern_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict anti-pattern evaluation to a subset of catalog ids (e.g. ["features-without-hypotheses"]).',
        },
        skip_drift: { type: 'boolean', description: 'Skip the schema-drift block. Only returns anti-pattern violations.' },
        skip_anti_patterns: { type: 'boolean', description: 'Skip anti-pattern evaluation. Only returns schema drift.' },
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged.' },
        include_polymorphic_upgrades: { type: 'boolean', description: 'When true, include a `polymorphic_with_typed_alternative` array listing polymorphic edges (e.g. node_owned_by_person, node_constrains_node) that have a more-specific typed alternative for their actual source/target pair. Opt-in only; omitted by default to avoid cluttering routine validation output. Does not affect `valid`; these are advisory suggestions.' },
      },
    },
  },
  {
    name: 'get_anti_pattern_violations_for',
    description:
      'Reverse lookup: given an entity id, return anti-pattern violations whose `target_entities` include the entity\'s type. Use after `validate_graph` to drill into one entity\'s implicated patterns. Matches by entity type today; tightens to specific ids in a future revision. Underpins the Inspect approach.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: { type: 'string', description: 'Node id to look up.' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'get_session_context',
    description:
      'Read session context: which skills ran, what was recommended, current focus area. Returns `recommendations_to_avoid`; the deduped list of recommendations already given this session. Pick your next recommendation NOT in that array (data-layer dedup, not prose).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'skill_audit',
    description:
      'Audit one or every UPG skill for source-vs-deployed integrity. Use before recommending a skill to confirm `.claude/skills/<name>/SKILL.md` is a symlink to canonical source and the bodies match. When `in_sync: false`, what you read from `packages/upg-mcp-server/skills/` is NOT what the user will experience.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Optional skill name (e.g. "upg-trace"). If omitted, audits every canonical skill.',
        },
      },
    },
  },
  {
    name: 'update_session_context',
    description:
      'Update session context: register a skill invocation, record a recommendation, set focus area, switch lens, or store custom state for cross-skill coordination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_invoked: { type: 'string', description: 'Register that this skill was just invoked (e.g. "upg-status")' },
        recommendation: { type: 'string', description: 'Record a recommendation given to the user (e.g. "Run /upg-strategy to fill strategy gap")' },
        focus_area: { type: 'string', description: 'Set the current focus area (e.g. "strategy", "validation", "user_research")' },
        lens: { type: 'string', enum: ['product', 'engineering', 'design', 'growth'], description: 'Switch the active lens. Changes what context, skills, and gaps are surfaced first.' },
        persist_lens: { type: 'boolean', description: 'If true, also save the lens to the .upg file so it persists across sessions' },
        custom: { type: 'object', description: 'Arbitrary key-value pairs for cross-skill state' },
      },
    },
  },
  {
    name: 'get_area_context',
    description:
      'Check whether the current working directory has a `.upg-area.json` that scopes work to a specific product area.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_area',
    description:
      'Create a product area entity in the portfolio document (`.upg/portfolio.upg`). Product areas represent the organisational axis (who owns what). Supports nesting via `parent_area_id`. The portfolio document is created on demand.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Area name (e.g. "Search", "Payments")' },
        description: { type: 'string', description: 'What this area covers' },
        parent_area_id: {
          type: 'string',
          description: 'Parent area ID for creating a sub-area',
        },
        strategic_priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Strategic priority of this area',
        },
        owner: { type: 'string', description: 'Person or team that owns this area' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_portfolios',
    description:
      'List portfolios from the portfolio document (`.upg/portfolio.upg`). Portfolios represent the strategic axis (where we invest). Returns an empty list when no portfolio document exists yet.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_organization',
    description:
      'Get the organisation that owns the current workspace\'s portfolio. Reads the singleton `portfolio.upg.organization`. Returns `{ organization: null }` when no portfolio document exists yet.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_cross_product_edge',
    description:
      'Create a cross-product relationship between two entities in different products within a portfolio graph. Types: `shares_persona`, `shares_competitor`, `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'Source node ID' },
        target_id: { type: 'string', description: 'Target node ID' },
        type: {
          type: 'string',
          enum: ['shares_persona', 'shares_competitor', 'shares_metric', 'depends_on_product', 'cannibalises', 'succeeds'],
          description: 'Cross-product relationship type',
        },
        source_product_id: { type: 'string', description: 'Product ID of the source node' },
        target_product_id: { type: 'string', description: 'Product ID of the target node' },
      },
      required: ['source_id', 'target_id', 'type'],
    },
  },
  {
    name: 'list_portfolio_cross_edges',
    description:
      'List all cross-product edges stored in the portfolio document (`.upg/portfolio.upg`). Empty list when the portfolio document is absent.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'migrate_cross_edges',
    description:
      'Migrate inline cross-product edges from the current product\'s `edges[]` into the portfolio document (`.upg/portfolio.upg`) with qualified IDs. `dry_run: true` (default) previews; `dry_run: false` applies. Requires `source_product_id` to qualify source node IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_product_id: {
          type: 'string',
          description: 'Product ID that owns the current document\'s nodes. Used to build qualified source IDs ({product_id}/{node_id}).',
        },
        target_product_id: {
          type: 'string',
          description: 'Product ID that owns the target nodes, when the target node is not in the current product. Edges without a resolvable target product are skipped.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true (default), report what would be migrated without writing anything.',
        },
      },
      required: ['source_product_id'],
    },
  },
  // ── Sync tools ────────────────────────────────────────────────────────────
  {
    name: 'get_sync_state',
    description:
      'Read the `.upg-sync` file for the active product. Returns cloud product ID, ID mappings, last sync timestamp. Returns null when the product has never been pushed.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'apply_pull_changeset',
    description:
      'Apply cloud changes to the local `.upg` file. Takes cloud nodes and edges (from `export_upg_document` on the cloud server), computes the diff, merges into the local graph, and updates `.upg-sync` with new mappings. `strategy`: `cloud_wins` (default), `local_wins`, or `merge` (reports conflicts without resolving).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cloud_nodes: {
          type: 'array',
          description: 'All cloud nodes (from export_upg_document)',
          items: { type: 'object' },
        },
        cloud_edges: {
          type: 'array',
          description: 'All cloud edges (from export_upg_document)',
          items: { type: 'object' },
        },
        cloud_product_id: { type: 'string', description: 'Cloud product ID' },
        cloud_endpoint: { type: 'string', description: 'Cloud endpoint URL (e.g. https://cloud.unifiedproductgraph.org)' },
        strategy: {
          type: 'string',
          enum: ['cloud_wins', 'local_wins', 'merge'],
          description: 'Conflict resolution: cloud_wins (default), local_wins, or merge (report conflicts without resolving)',
        },
      },
      required: ['cloud_nodes', 'cloud_edges', 'cloud_product_id'],
    },
  },
  {
    name: 'push_to_cloud',
    description:
      'Push the current local graph to the cloud in one call. Reads the in-memory graph, POSTs to the cloud import endpoint, and creates or updates the `.upg-sync` file with ID mappings. Auto-discovers `cloud_endpoint` and `api_key` from a `upg-cloud` entry in `.mcp.json`. Recommended push path from Claude Code (zero context cost).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cloud_endpoint: {
          type: 'string',
          description: 'Cloud base URL. Auto-discovered from .mcp.json upg-cloud entry if omitted.',
        },
        api_key: {
          type: 'string',
          description: 'UPG Cloud API key. Auto-discovered from .mcp.json upg-cloud entry if omitted.',
        },
        strategy: {
          type: 'string',
          enum: ['create_new', 'merge', 'replace'],
          description: 'Import strategy. Default: create_new',
        },
        product_id: {
          type: 'string',
          description: 'Optional. Push to an existing cloud product instead of creating new.',
        },
      },
      required: [],
    },
  },
]

/**
 * Handler binding. Maps every tool name to the top-level function in
 * `src/tools/*.ts`. Kept separate from `TOOL_DEFINITIONS` so `tools/list`
 * stays a pure data dump and the dispatch path can lookup by name in O(1).
 */
const HANDLERS: Record<string, ToolHandler> = {
  get_product_context: getProductContext,
  get_graph_digest: getGraphDigest,
  start,
  list_nodes: listNodes,
  get_node: getNode,
  get_nodes: getNodes,
  search_nodes: searchNodes,
  query: query,
  create_node: createNode,
  update_node: updateNode,
  delete_node: deleteNode,
  batch_create_nodes: batchCreateNodes,
  batch_update_nodes: batchUpdateNodes,
  batch_delete_nodes: batchDeleteNodes,
  batch_create_edges: batchCreateEdges,
  batch_delete_edges: batchDeleteEdges,
  repair_dangling_edges: repairDanglingEdges,
  export_edges: exportEdges,
  rename_edge_type: renameEdgeType,
  create_edge: createEdge,
  delete_edge: deleteEdge,
  move_node: moveNode,
  batch_move_nodes: batchMoveNodes,
  get_changes: getChanges,
  list_product_areas: listProductAreas,
  get_area_graph: getAreaGraph,
  list_local_products: listLocalProducts,
  switch_product: switchProduct,
  get_workspace_info: getWorkspaceInfo,
  init_workspace: initWorkspaceTool,
  create_product: createProductTool,
  migrate_type: migrateType,
  migrate_properties: migrateProperties,
  migrate_status: migrateStatus,
  deduplicate_nodes: deduplicateNodes,
  get_entity_schema: getEntitySchema,
  list_playbooks: listPlaybooks,
  get_playbook: getPlaybook,
  list_approaches: listApproaches,
  get_approach: getApproach,
  plan: plan,
  inspect: inspect,
  prioritise: prioritise,
  trace: trace,
  reflect: reflect,
  list_domains: listDomains,
  get_domain_guide: getDomainGuide,
  list_frameworks: listFrameworks,
  get_framework: getFramework,
  list_edge_types: listEdgeTypes,
  get_edge_type: getEdgeType,
  list_regions: listRegions,
  get_region: getRegion,
  get_region_for_entity_type: getRegionForEntity,
  get_spec_version: getSpecVersion,
  resolve_edge_for_pair: resolveEdgeForPair,
  list_cross_edge_types: listCrossEdgeTypes,
  list_lenses: listLenses,
  get_lens: getLensTool,
  list_type_labels: listTypeLabels,
  get_type_label: getTypeLabel,
  get_valid_children: getValidChildrenTool,
  list_entity_types: listEntityTypes,
  get_entity_meta: getEntityMeta,
  list_anti_patterns: listAntiPatterns,
  get_anti_pattern: getAntiPattern,
  list_benchmarks: listBenchmarks,
  list_product_stages: listProductStages,
  list_type_migrations: listTypeMigrations,
  list_edge_migrations: listEdgeMigrations,
  list_split_migrations: listSplitMigrations,
  list_lifecycles: listLifecycles,
  get_lifecycle: getLifecycle,
  list_scales: listScales,
  get_scale: getScale,
  list_framework_categories: listFrameworkCategories,
  list_framework_structure_patterns: listFrameworkStructurePatterns,
  list_domain_rings: listDomainRings,
  get_domain_ring: getDomainRing,
  validate_graph: validateGraph,
  get_anti_pattern_violations_for: getAntiPatternViolationsFor,
  get_session_context: getSessionContext,
  update_session_context: updateSessionContext,
  skill_audit: skillAudit,
  get_area_context: getAreaContext,
  create_area: createArea,
  list_portfolios: listPortfolios,
  get_organization: getOrganization,
  create_cross_product_edge: createCrossProductEdge,
  list_portfolio_cross_edges: listPortfolioCrossEdges,
  migrate_cross_edges: migrateCrossEdges,
  get_sync_state: getSyncState,
  apply_pull_changeset: applyPullChangeset,
  push_to_cloud: pushToCloud,
}

/** Combined registry: definition + handler for each tool. */
export const TOOL_REGISTRY: ToolEntry[] = TOOL_DEFINITIONS.map((def) => ({
  ...def,
  handler: HANDLERS[def.name] ?? (() => {
    throw new Error(`No handler bound for tool: ${def.name}`)
  }),
}))

/** Resolve a handler by tool name. Returns `undefined` for unknown tools. */
export function getToolHandler(name: string): ToolHandler | undefined {
  return HANDLERS[name]
}
