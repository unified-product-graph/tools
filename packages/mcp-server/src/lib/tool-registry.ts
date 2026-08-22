/**
 * Tool registry for the UPG MCP server. Maps each tool name to its wire-shape
 * definition (served via `tools/list`) and its handler in `src/tools/*.ts`.
 */

import type { ToolDefinition } from '@unified-product-graph/mcp-tooling'
import { LIST_CATALOG_DEF, GET_CATALOG_ENTRY_DEF, GET_ENTITY_SCHEMA_DEF } from '@unified-product-graph/mcp-tooling'
import type { ToolHandler } from './server-context.js'
import { CANONICAL_LENS_IDS } from './server-context.js'
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
  promoteScalarsToEdges,
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
  createPortfolio,
  assignProductToAreaTool,
  updateAreaTool,
  removeProductFromAreaTool,
  deleteAreaTool,
  moveProductToAreaTool,
  getChanges,
} from '../tools/areas.js'
import {
  listLocalProducts,
  switchProduct,
  reloadProduct,
  getWorkspaceInfo,
  initWorkspaceTool,
  createProductTool,
  updateProductTool,
  listPortfolios,
  getOrganization,
  createCrossProductEdge,
  createParityEdge,
  createClassificationEdge,
  linkAreaToAudience,
  batchCreateCrossProductEdges,
  deleteCrossProductEdgeTool,
  batchDeleteCrossProductEdgesTool,
  attachProductToPortfolioTool,
  detachProductFromPortfolioTool,
  listPortfolioCrossEdges,
  migrateCrossEdges,
  upsertCompositionTool,
} from '../tools/workspace.js'
import { portfolioQuery, portfolioDigest, portfolioCensus, portfolioValidate, getPortfolioTree, auditPropertyCoverage, diffClassification, compareClassifications, aggregateEdgePropertiesTool, auditAxisOverlap } from '../tools/portfolio-read.js'
import { cloneStructure } from '../tools/clone-structure.js'
import {
  defineCanonicalEntity,
  registerInstance,
  listRegistry,
  updateCanonicalEntity,
  batchDefineCanonicalEntity,
  batchRegisterInstance,
  promoteToCanonical,
  createRegistryEdge,
  listRegistryEdges,
  deleteCanonicalEntity,
  mergeCanonicalEntities,
} from '../tools/registry.js'
import { getEntitySchema } from '../tools/schema.js'
import { applyFramework, scoreEntity } from '../tools/frameworks.js'
import { getSpecVersion } from '../tools/spec.js'
import { getTree } from '../tools/tree.js'
import { validateGraph, getAntiPatternViolationsFor } from '../tools/validation.js'
import { migrateStatus } from '../tools/migrations.js'
import {
  getSyncState,
  applyPullChangeset,
  pushToCloud,
} from '../tools/sync.js'
import { skillAudit } from '../tools/skills.js'
import { listCatalog, getCatalogEntry } from '../tools/catalog.js'
import { getImportRecipe } from '../tools/import-recipe.js'
import { submitFeedback, FEEDBACK_TYPES } from '../tools/feedback.js'
import { UPG_CROSS_EDGE_TYPES } from '@unified-product-graph/core'

// `ToolDefinition` lives in `@unified-product-graph/mcp-tooling`. Re-exported
// for backwards-compat with internal imports + the parity audit test.
export type { ToolDefinition }

export interface ToolEntry extends ToolDefinition {
  handler: ToolHandler
}

// The cross-edge types creatable through the GENERIC writers
// (`create_cross_product_edge` + `batch_create_cross_product_edges`). Derived
// from the spec union so the single and batch tools share ONE source and can
// never drift again (batch-6 #31: the batch enum had lagged a release behind,
// missing `rolls_up_to`). The dedicated edges — `instance_of` (via
// `register_instance`) and `area_serves_persona` / `area_targets_market_segment`
// (via `link_area_to_audience`) — are excluded; their handlers own creation and
// the generic writers reject them.
const DEDICATED_CROSS_EDGE_TYPES = new Set<string>([
  'instance_of',
  'area_serves_persona',
  'area_targets_market_segment',
])
const GENERIC_CROSS_EDGE_TYPES: string[] = UPG_CROSS_EDGE_TYPES.filter(
  (t) => !DEDICATED_CROSS_EDGE_TYPES.has(t),
)

// ── Composition view shapes, declared INLINE ───────────────────────────────
//
// `member_query` and `presentation` are `type: 'object'` in the runtime
// property registry and `members` is `object[]`, so `get_entity_schema(
// 'composition')` hands an agent three opaque blobs and a sentence of prose.
// Teaching the property-registry generator to nest interface shapes would
// ripple through five generated mirrors and three gates; a tool whose own JSON
// schema declares the shapes costs one file and is the surface an agent
// actually reads before calling.
//
// Kept faithful to `UPGViewQuery` / `UPGViewPresentation` / `CompositionMember`
// in the spec's workspace property domain, including the 0.34.0 changes:
// `orphan_disposition` on presentation, and a clause list discriminated on
// `dimension` so the `type` axis carries entity types rather than free strings.

/** Six-bucket status categories. Mirrors `StatusCategory`, which has no runtime export. */
const STATUS_CATEGORIES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'cancelled']

const TIME_WINDOW_SCHEMA = {
  type: 'object',
  description:
    'A relative or absolute time window, DECLARED rather than resolved. Evaluated at read time in the reader session, never frozen at save, so a view that says "this quarter" means this quarter to whoever opens it. A team cadence is NOT a window: use an edge clause with target_status ["active"] instead.',
  properties: {
    kind: { type: 'string', enum: ['calendar', 'rolling', 'absolute'], description: 'Which window form this is.' },
    anchor: {
      type: 'string',
      enum: ['current', 'previous', 'next', 'last_n', 'next_n'],
      description: 'For kind "calendar": current, previous or next. For kind "rolling": last_n or next_n.',
    },
    unit: {
      type: 'string',
      enum: ['day', 'week', 'month', 'quarter', 'year'],
      description: 'Unit of the window. "day" applies to rolling windows only; "year" to calendar windows only.',
    },
    count: { type: 'integer', description: 'How many units, for kind "rolling".' },
    from: { type: 'string', description: 'ISO date, for kind "absolute".' },
    to: { type: 'string', description: 'ISO date, for kind "absolute".' },
  },
  required: ['kind'],
}

const EDGE_CLAUSE_SCHEMA = {
  type: 'object',
  description:
    'A condition on the edges of a candidate node. Names a moving target without holding an id: target_status ["active"] selects the current planning cycle, and target_designation "viewer" selects whoever is reading.',
  properties: {
    edge_type: { type: 'string', description: 'Canonical edge type (see list_catalog({ kind: "edge_types" })).' },
    direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Which way to walk it from the candidate node.' },
    target_ids: { type: 'array', items: { type: 'string' }, description: 'Admitted endpoint ids. Omit so any edge of this type satisfies the clause.' },
    target_status: { type: 'array', items: { type: 'string' }, description: 'Admitted endpoint phase ids. The designation form on the cadence axis.' },
    target_designation: {
      type: 'string',
      enum: ['viewer'],
      description:
        'Selects the endpoint by ROLE rather than identity. "viewer" resolves in the reader session at read time. Use this for "assigned to me": storing an id would make the view permanently about one colleague.',
    },
  },
  required: ['edge_type', 'direction'],
}

const VIEW_CLAUSE_SCHEMA = {
  description:
    'One clause of the selection. A DISCRIMINATED UNION on `dimension` since 0.34.0: on the `type` axis `values` are canonical entity types, on every other axis they are strings.',
  oneOf: [
    {
      type: 'object',
      description: 'A clause on the `type` axis.',
      properties: {
        dimension: { type: 'string', enum: ['type'] },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Admitted canonical entity types (see list_catalog({ kind: "entity_types" })). Not free strings.',
        },
        negate: { type: 'boolean', description: 'Negates this clause and only this clause.' },
      },
      required: ['dimension'],
    },
    {
      type: 'object',
      description: 'A clause on any axis other than `type`, whose admitted values are strings.',
      properties: {
        dimension: {
          type: 'string',
          enum: ['status', 'status_category', 'tag', 'classification', 'property', 'date', 'edge'],
        },
        values: { type: 'array', items: { type: 'string' }, description: 'Admitted values.' },
        field: { type: 'string', description: 'Property name when `dimension` is "property"; the date field when "date".' },
        window: TIME_WINDOW_SCHEMA,
        edge: EDGE_CLAUSE_SCHEMA,
        negate: { type: 'boolean', description: 'Negates this clause and only this clause.' },
      },
      required: ['dimension'],
    },
  ],
}

const VIEW_QUERY_SCHEMA = {
  type: 'object',
  description:
    'A declarative, portable SELECTION over the graph: which nodes the view shows. Selection only; what it looks like is `presentation`. `clauses` is authoritative and the named fields are a positive-only shorthand for it, so a reader that finds `clauses` uses it and ignores the named fields. Holds no node references except `classified_as`, and relative selections walk from the focused set via `from_focus` rather than naming ids.',
  properties: {
    types: { type: 'array', items: { type: 'string' }, description: 'Canonical entity types admitted. Omit to admit every type.' },
    status: { type: 'array', items: { type: 'string' }, description: 'Canonical phase ids admitted, for example ["todo", "in_progress"].' },
    status_category: {
      type: 'array',
      items: { type: 'string', enum: STATUS_CATEGORIES },
      description: 'Six-bucket categories admitted. The portable form when phase ids differ per type but the reading is the same.',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Freeform tags. `match` governs all-of versus any-of.' },
    classified_as: { type: 'array', items: { type: 'string' }, description: 'Ids of `classification_value` nodes admitted: the grouped-label clause.' },
    properties: {
      type: 'array',
      description: 'Predicates over type-specific properties.',
      items: {
        type: 'object',
        properties: {
          property: { type: 'string', description: 'Property name, resolved against the `properties` bag of the node.' },
          in: { type: 'array', items: { type: 'string' }, description: 'Admitted values. A node matches when its value is one of these.' },
          present: { type: 'boolean', description: 'Match on presence rather than value: true admits nodes carrying the property at all, false admits those that do not.' },
        },
        required: ['property'],
      },
    },
    include_archived: { type: 'boolean', description: 'Whether archived nodes are admitted. Absent means false.' },
    match: { type: 'string', enum: ['all', 'any'], description: 'How the clauses combine. Absent means "all".' },
    from_focus: {
      type: 'object',
      description:
        'Walk outward from the nodes this composition focuses, for a selection that is relative rather than absolute. The anchor is the `composition_focuses_node` edge set, never an id held here.',
      properties: {
        edge_types: { type: 'array', items: { type: 'string' }, description: 'Canonical edge types to traverse.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Which way to walk them.' },
        depth: {
          description:
            'Hops. Absent means 1. Pass the string "unbounded" to walk the relation transitively until it stops producing new nodes: a tree selection has no correct finite depth, and picking a large number silently truncates the first graph deeper than the guess.',
          oneOf: [{ type: 'integer' }, { type: 'string', enum: ['unbounded'] }],
        },
      },
      required: ['edge_types', 'direction'],
    },
    clauses: {
      type: 'array',
      items: VIEW_CLAUSE_SCHEMA,
      description:
        'The faithful representation of the selection: every clause, including the negations, declared windows and edge conditions the named fields above cannot hold. Authoritative when present.',
    },
  },
}

const VIEW_PRESENTATION_SCHEMA = {
  type: 'object',
  description:
    'Advisory rendering intent. A consumer MAY ignore every field here and stay conformant, because every default it then applies is the safe one.',
  properties: {
    group_by: { type: 'string', description: 'Property name, base field, or "status_category", to group lanes by.' },
    sort: {
      type: 'array',
      description: 'Sort keys in precedence order.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Property name or base field to sort on.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
        },
        required: ['key', 'direction'],
      },
    },
    layout: {
      type: 'string',
      enum: ['board', 'table', 'list', 'cards', 'timeline', 'gallery', 'tree'],
      description: 'Requested layout family. Advisory.',
    },
    nest_by: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Edge types to nest by, outermost first, when `layout` is "tree". Naming the edge types keeps the nesting portable: `group_by` partitions a flat set on a value and cannot express nesting, because the levels of a tree are edges rather than property values.',
    },
    orphan_disposition: {
      type: 'string',
      enum: ['root', 'hide'],
      description:
        'What to do with a selected member the nest relation does not reach. Absent means "root", which is the safe reading: everything the scope admits stays visible somewhere. Pay for hiding explicitly, because a consumer that ignores this field must never silently drop a node the scope admitted.',
    },
  },
}

const COMPOSITION_MEMBER_SCHEMA = {
  type: 'object',
  description:
    'One block in the frozen arrangement. THE ARRANGEMENT IS FROZEN, THE CONTENT IS NOT: a member carries layout and a POINTER captured at publish, never resolved data, and `href` is re-resolved against current graph data at render. Do not treat a member as cached content.',
  properties: {
    id: { type: 'string', description: 'Stable id of the block within this composition.' },
    href: { type: 'string', description: 'Tool-namespaced view reference. Opaque to every other tool and preserved verbatim.' },
    title: { type: 'string', description: 'Display title captured at publish, shown as a fallback while the target resolves.' },
    x: { type: 'number', description: 'Horizontal position of the block.' },
    y: { type: 'number', description: 'Vertical position of the block.' },
    width: { type: 'number', description: 'Width of the block.' },
    height: { type: 'number', description: 'Height of the block.' },
    collapsed: { type: 'boolean', description: 'Whether the block is drawn collapsed.' },
    derived: {
      type: 'boolean',
      description:
        'True when this member arrived by running `member_query` rather than by a person placing it. Membership is derived, position is authored, and both are real.',
    },
  },
  required: ['id', 'href', 'title', 'x', 'y', 'width', 'height'],
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
        coverage_profile: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch-4 #22: coverage region ids (the keys of the `coverage` block: identity, understanding, discovery, validation, reaching, converting, building, sustaining, learning, operations) to score against instead of the product stage default. Adds `coverage.profile_summary` (overall_pct over just these regions), so a deliberately-scoped product (e.g. a structural spine) reads its parity without out-of-scope regions dragging the headline down.',
        },
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
        node_id: { type: 'string', description: 'The node ID. Alias: `id`.' },
        id: { type: 'string', description: 'Alias for `node_id`.' },
        compact_edges: { type: 'boolean', description: 'Omit source_title/target_title from edges (saves ~30% on edge-heavy nodes)' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'get_nodes',
    description:
      'Batch-fetch up to 50 entities by ID. Returns each node with its edges. Use instead of looping `get_node`. A bare id reads the active product; a qualified `{product_id}/{node_id}` (the form list_registry / export_edges / cross-edges return) reads that product cross-portfolio (read-only for non-active products), so a connective pass can fetch node content across graphs without a switch_product sweep. Cross-product results carry a `product_id`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node IDs (max 50). Bare (active product) or qualified `{product_id}/{node_id}` for any product in the workspace.',
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
        diff_from: { type: 'string', description: 'Result ID from a previous query. Returns added/removed NODES, plus added/removed EDGES when `edge_include` asks for edges. Two calls that differ only by `configuration` therefore diff one configuration against another.' },
        configuration: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Read ONE configuration instead of the union. Maps a configuration_axis (by node id, or by title when unambiguous) to a single one of its values. Surfaces absent under that value are dropped, composition edges qualified to other values are dropped, and edges left dangling go with them. An unknown axis or value is an error, never a silent no-op. Omit to read the union, which is the default and unchanged behaviour.',
        },
      },
    },
  },
  {
    name: 'get_tree',
    description:
      'Assemble a canonical tree pattern (ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org) from the active product graph, server-side. Returns NESTED data (roots with children) plus structural `gaps` (nodes whose pattern expects children the graph lacks). Walks the pattern type-driven child map over the live graph, so it follows whatever edge wired a parent to a child of the expected type (no hardcoded edge names to drift). Roots at the pattern anchor, falling back through fallback anchors when the anchor has no nodes or reaches nothing, and reports the substitution in `anchor_resolved_from`/`anchor_used`. Rendering stays in the client. Composes with `query`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Tree pattern id: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, or org.' },
        from_id: { type: 'string', description: 'Explicit root node id; otherwise the pattern canonical anchor.' },
        depth: { type: 'number', description: 'Max levels (default = the pattern natural depth; max 12).' },
        include_properties: { type: 'array', items: { type: 'string' }, description: 'Node property keys to inline on each tree node.' },
        max_nodes: { type: 'number', description: 'Cap on nodes; the tree is summarised (stats.truncated) rather than silently cut (default 400, max 2000).' },
        configuration: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Read ONE configuration instead of the union. Maps a configuration_axis (by node id, or by title when unambiguous) to a single one of its values. Surfaces absent under that value are dropped, composition edges qualified to other values are dropped, and edges left dangling go with them. An unknown axis or value is an error, never a silent no-op. Omit to read the union, which is the default and unchanged behaviour.',
        },
      },
      required: ['pattern'],
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
        key: {
          type: 'string',
          description: 'Optional citable key for this entity (e.g. "LTN-311"). Unique within the product across entity types, immutable once assigned, and never reused, so it is settable HERE and refused by update_node / batch_update_nodes. Supply one you already hold (an imported tracker key, or one your create surface chose); this tool never mints one for you.',
        },
        archived: {
          type: 'boolean',
          description: 'Sweep this entity out of default views. Orthogonal to `status`: an entity can be done and live, or done and archived, and those are different facts.',
        },
        archived_at: {
          type: 'string',
          description: 'ISO timestamp archived. Pairs with `archived: true`.',
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
    description: 'Update one entity. Unspecified fields are preserved. `key` is NOT updatable: it is minted once at create, never reused, and passing it here is refused rather than ignored. Passing `type` performs an atomic single-node migration: every incident edge is re-inferred against the catalog and rollback applies on failure. For 3+ entities, use `batch_update_nodes`.',
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
        archived: {
          type: 'boolean',
          description: 'Sweep this entity out of default views. Orthogonal to `status`: an entity can be done and live, or done and archived, and those are different facts.',
        },
        archived_at: {
          type: ['string', 'null'],
          description: 'ISO timestamp archived. Pairs with `archived: true`. Pass null to clear it.',
        },
        unset_properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Property keys to DELETE. Applied after the `properties` merge, so one call can set some keys and drop others. Writing `{ key: null }` only stores a literal null; use this to actually remove a key. Unknown keys are ignored.',
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
      'Create up to 50 entities in one atomic call, optionally with explicit edges in the same transaction. Reference earlier nodes from `parent_ref` / `edges` by a positional `$N` ("$0", "$1") OR by a batch-local `ref` alias declared on a node (e.g. ref:"persona_dev" then from_ref:"persona_dev"); aliases remove the index-counting that most often breaks a batch. `edges` endpoints also accept existing node IDs. All nodes and edges validate up front; on failure nothing lands and the response carries the full `errors` list plus the alias `ref_map`. Pass `validate_only: true` for a dry-run that reports every would-be error WITHOUT writing.',
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
              ref: { type: 'string', description: 'Optional batch-local alias for this node, usable from parent_ref / edges instead of a positional $N. Must be unique and not look like "$N".' },
              parent_id: { type: 'string', description: 'Parent node ID. Creates an edge automatically.' },
              parent_ref: { type: 'string', description: 'Reference a node created earlier in this batch by positional index ("$0", "$1") or by its declared `ref` alias.' },
              key: { type: 'string', description: 'Optional citable key for this entity (e.g. "LTN-311"). Unique within the product across entity types, immutable once assigned, and never reused, so it is settable HERE and refused by update_node / batch_update_nodes. Supply one you already hold (an imported tracker key, or one your create surface chose); this tool never mints one for you.' },
              archived: { type: 'boolean', description: 'Sweep this entity out of default views. Orthogonal to `status`: an entity can be done and live, or done and archived, and those are different facts.' },
              archived_at: { type: 'string', description: 'ISO timestamp archived. Pairs with `archived: true`.' },
            },
            required: ['type', 'title'],
          },
          description: 'Array of nodes to create (max 50)',
        },
        edges: {
          type: 'array',
          description:
            'Optional edges to create alongside the nodes (same atomic transaction). Each edge\'s from/to may be a `$N` ref into the `nodes` array, a declared `ref` alias, OR an existing node ID.',
          items: {
            type: 'object',
            properties: {
              from_ref: {
                type: 'string',
                description: '`$N` ref, declared `ref` alias, or existing node id for the source endpoint',
              },
              to_ref: {
                type: 'string',
                description: '`$N` ref, declared `ref` alias, or existing node id for the target endpoint',
              },
              type: {
                type: 'string',
                description: 'Optional explicit edge type (must be in UPG_EDGE_CATALOG). If omitted, inferred from canonical source/target types.',
              },
            },
            required: ['from_ref', 'to_ref'],
          },
        },
        validate_only: {
          type: 'boolean',
          description: 'Dry-run: run the full validation pass and report `{ valid, errors, would_create_nodes, would_create_edges }` WITHOUT writing. Lets an agent self-correct the whole batch before committing.',
        },
        expect_product: {
          type: 'string',
          description: 'Optional guard: abort if the active product is not this id/title/file. Cheap insurance against a forgotten switch_product writing into the wrong graph.',
        },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'batch_update_nodes',
    description:
      'Update up to 50 entities atomically (all succeed or all fail). Unspecified fields preserved. Properties merge with existing; pass `unset_properties` per entry to remove keys rather than writing a literal null. `key` is NOT updatable: an entry carrying one is refused and the whole batch lands nothing.',
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
              archived: { type: 'boolean', description: 'Sweep this entity out of default views. Orthogonal to `status`: an entity can be done and live, or done and archived, and those are different facts.' },
              archived_at: { type: ['string', 'null'], description: 'ISO timestamp archived. Pairs with `archived: true`. Pass null to clear it.' },
              unset_properties: {
                type: 'array',
                items: { type: 'string' },
                description: 'Property keys to DELETE from this node. Applied after the `properties` merge, so one entry can set some keys and drop others. Writing `{ key: null }` only stores a literal null; use this to actually remove a key. Unknown keys are ignored.',
              },
            },
            required: ['node_id'],
          },
          description: 'Array of updates to apply (max 50)',
        },
        expect_product: {
          type: 'string',
          description: 'Optional guard: abort if the active product is not this id/title/file.',
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
        expect_product: {
          type: 'string',
          description: 'Optional guard: abort if the active product is not this id/title/file.',
        },
      },
      required: ['node_ids'],
    },
  },
  {
    name: 'batch_create_edges',
    description:
      'Create up to 50 edges in one atomic call. Use this for 3+ edges instead of looping `create_edge`. Edge type auto-infers when omitted. Pass `validate_only: true` for a dry-run that reports every would-be error WITHOUT writing.',
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
        validate_only: {
          type: 'boolean',
          description: 'Dry-run: validate every edge and report `{ valid, errors, would_create_edges }` WITHOUT writing.',
        },
        expect_product: {
          type: 'string',
          description: 'Optional guard: abort if the active product is not this id/title/file.',
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
        expect_product: {
          type: 'string',
          description: 'Optional guard: abort if the active product is not this id/title/file.',
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
        properties: {
          type: 'object' as const,
          description: 'Edge-scoped properties. Only permitted on edge types that opt in (currently framework_exercise_includes_node); rejected on plain semantic edges.',
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
            'Path to the .upg file (relative, absolute, or a bare product name in workspace mode). Alias: `product`.',
        },
        product: {
          type: 'string',
          description: 'Alias for `file`.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'reload_product',
    description:
      'Re-read the ACTIVE product from disk, discarding any unsaved in-memory changes. The in-band escape from a wedged save-conflict: when the active product was edited in another session, flush()/switch_product keep throwing CONFLICT and the stale snapshot persists; this clears it WITHOUT restarting the server. When there are unsaved changes you must pass `discard_local: true` to proceed (the reload would drop them); with no unsaved changes it is a safe refresh. Local-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        discard_local: {
          type: 'boolean',
          description:
            'Discard unsaved in-memory changes and re-read from disk. Required (true) when the active product has unsaved changes; ignored when it is clean. Default false.',
        },
      },
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
            'Optional portfolio id (resolved against portfolio.upg) to place the new product under. A portfolio id that resolves only in the active graph still attaches via an in-graph edge (DEPRECATED; prefer attach_product_to_portfolio).',
        },
        area_id: {
          type: 'string',
          description: 'Optional product_area id (resolved against portfolio.upg) to place the new product under.',
        },
        dir: {
          type: 'string',
          description:
            'Optional subfolder under .upg/ to write the graph into (e.g. "competitors"). The file lands at .upg/<dir>/<slug>.upg and is registered in workspace.json with that subpath, so a watched portfolio can keep its intelligence graphs in competitors/. Absent writes flat at .upg/<slug>.upg. No leading slash or "..".',
        },
        member_kind: {
          type: 'string',
          enum: ['product', 'org_rollup', 'watched', 'operating_function'],
          description:
            'Workspace member kind. product (default) = a product under management; org_rollup = the company umbrella graph; watched = a monitored intelligence graph (e.g. a competitor); operating_function = a function a team operates (revenue/success/finance/people/marketing), not a product it ships. Stamped into $upg.member_kind and cached in workspace.json; non-product kinds are excluded from counts.products and graded on their own validation profile (product-spine anti-patterns are suppressed).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_product',
    description:
      "Update the product header (`$upg.product`): stage, title, description, health_status, url, and the workspace member_kind. The supported way to advance a product's lifecycle stage or re-kind a graph; it writes the value get_graph_digest reads, without hand-editing the integrity-hashed .upg file. A title rename or a re-kind also reconciles the workspace.json cache and the portfolio.upg registry, so list_local_products, get_workspace_info, portfolio_census, counts.products, and the watched anti-pattern scoping all show the current value. Set rename_file (or pass an explicit slug) to also rename the .upg file to match the title: it moves the file, repoints the open handle so the rest of the session writes to the new path, and updates the workspace.json file path and the portfolio.upg file_path. The rename is opt-in; a plain title change leaves the filename alone.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        stage: { type: 'string', description: 'Product lifecycle stage (canonical UPGProductStage).' },
        title: { type: 'string', description: 'Product display title.' },
        description: { type: 'string', description: 'Product description.' },
        health_status: { type: 'string', description: 'Product health (free-form, e.g. on_track / at_risk).' },
        url: { type: 'string', description: 'Product URL.' },
        member_kind: {
          type: 'string',
          enum: ['product', 'org_rollup', 'watched', 'operating_function'],
          description: 'Workspace member kind. product (default, an owned product), org_rollup (company umbrella graph), watched (a monitored intelligence graph, e.g. a competitor), or operating_function (a function a team operates, across revenue/success/finance/people/marketing, not a product it ships). Non-product kinds are excluded from product coverage / counts and graded on their own validation profile.',
        },
        rename_file: { type: 'boolean', description: 'Rename the .upg file to match the title slug. Opt-in; moves the file and reconciles the open handle, workspace.json path, and portfolio.upg file_path.' },
        slug: { type: 'string', description: 'Explicit slug for the file rename (implies rename_file). Slugified and collision-resolved so a sibling file is never clobbered.' },
      },
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
      'Apply `UPG_PROPERTY_MIGRATIONS` graph-wide with no type rename or edge migration. Pure property pass over all kinds: `drop_props`, `rename_top_level`, `lift_property_to_top_level`, `drop_when_self_referential`, `remap_property_value` (stale enum values, e.g. the 0.9.12 data_flow / integration_pattern / api_contract / service tightenings), and `reshape_value_to_assessment` (a bare number wrapped into an assessment object on its scale, e.g. the 0.10.2 market_trend impact / relevance). `validate_graph` property_drift now surfaces every value-aware rule, so a graph that went invalid on a tightening points here. Default `dry_run=true` previews the per-rule change set; pass `dry_run=false` to commit. Use when you want property cleanup standalone; `migrate_type` folds the same pass into its rename.',
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
    name: 'promote_scalars_to_edges',
    description:
      'Apply `UPG_SCALAR_TO_EDGE_MIGRATIONS` graph-wide (P14 conformance): promote scalar properties that name a first-class entity into canonical edges. Per rule: find-or-create the referenced entity by normalized title, link it with the canonical edge, then drop the now-redundant scalar (unless the rule keeps it as an actor display-cache). Lossless (the string becomes a real node) and idempotent (re-running mints/links nothing new). Snapshot the .upg first. Default `dry_run=true` previews the per-rule plan (minted / linked / dropped / skipped); pass `dry_run=false` to commit. The rules are listed by `list_scalar_to_edge_migrations`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'Preview changes without applying (default true). Pass false to commit.',
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
      'Find duplicate entities and return them grouped. `match: "exact"` (default) groups by identical title + type and can merge (dry_run previews; otherwise keeps one per group and redirects edges from the others). `match: "similar"` is a read-only SUGGESTION pass that surfaces near-duplicates exact matching misses: entities of the same type whose titles are fuzzy-similar (token overlap above `similarity_threshold`), plus metrics that share a `statistical_function` and an area with overlapping titles. It never merges; review the candidates and align them by hand (rename then run an exact pass, or `update_node` / `batch_delete_nodes`).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Only check this entity type. Omit to check all types.' },
        match: { type: 'string', description: '"exact" (default) groups by identical title + type and can merge. "similar" is a read-only pass that surfaces fuzzy-title and same-statistical_function near-duplicates; it never merges.' },
        similarity_threshold: { type: 'number', description: 'For match: "similar" only. Title token-overlap (Jaccard) above which two same-type entities are flagged. 0 to 1, default 0.6.' },
        dry_run: { type: 'boolean', description: 'For match: "exact" only. Preview duplicates without merging (default true). Ignored for "similar", which never mutates.' },
        keep: { type: 'string', description: 'Which duplicate to keep when merging: "newest" (default) or "oldest".' },
      },
    },
  },
  // Shared with cloud (0.30.x): the two hand-maintained copies had already
  // drifted before `include_notes` widened the gap. See GET_ENTITY_SCHEMA_DEF.
  GET_ENTITY_SCHEMA_DEF,
  // Faceted spec-catalog surface (0.19.0). Definitions sourced from the shared
  // `@unified-product-graph/mcp-tooling` module so local + cloud are byte-identical.
  LIST_CATALOG_DEF,
  GET_CATALOG_ENTRY_DEF,
  // ── Spec introspection ─────────────────────────────────
  {
    name: 'apply_framework',
    description:
      'Apply a framework (MoSCoW, RICE, Kano, ...) to a set of entities: creates a framework_exercise node and an `includes` edge to each entity. The per-entity result is recorded on the edge via score_entity, never on the entity node, so the same entity can sit in many exercises and any entity type can be scored. Returns { exercise_id, exercise, included, warnings }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        framework_id: { type: 'string', description: 'Required. UPGFramework.id (e.g. "moscow", "rice-scoring").' },
        title: { type: 'string', description: 'Human label for the exercise (default "<Framework> exercise").' },
        entity_ids: { type: 'array', items: { type: 'string' }, description: 'Entities to pull into the exercise (any type).' },
        slot_roles: { type: 'object' as const, description: 'Optional map of entity id → framework slot role (e.g. { "feat_x": "pain_reliever" }), stamped onto each entity\'s includes edge. Validated against the framework\'s declared slot roles (warn-only).' },
        status: { type: 'string', description: 'Lifecycle phase: draft | active | archived (default draft).' },
      },
      required: ['framework_id'],
    },
  },
  {
    name: 'score_entity',
    description:
      "Record a framework's result for one entity on the exercise's includes edge (a MoSCoW bucket, a RICE score, a canvas slot). Auto-includes the entity if not already in scope. Merges into existing edge properties unless replace is set. Returns { edge, warnings }.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        exercise_id: { type: 'string', description: 'Required. The framework_exercise id.' },
        entity_id: { type: 'string', description: 'Required. The entity being scored.' },
        values: { type: 'object' as const, description: 'Required. The result as { input: value }, e.g. { "moscow": "must" } or { "reach": 4, "impact": 3 }.' },
        slot_role: { type: 'string', description: 'Optional framework slot role this entity plays (e.g. "pain_reliever"). Rides the same edge as the scores; validated against the framework\'s declared slot roles (warn-only).' },
        replace: { type: 'boolean', description: 'Replace the edge properties instead of merging (default false).' },
      },
      required: ['exercise_id', 'entity_id', 'values'],
    },
  },
  // ── Spec introspection round 2 ─────────────────────────────────
  {
    name: 'get_spec_version',
    description:
      'Spec-level metadata for compatibility checks: `upg_version`, `markdown_format_version`, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational. Pass `changelog: true` to fold in the spec CHANGELOG (a `whats_new` surface); `since` (a version) returns only newer entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        changelog: { type: 'boolean', description: 'When true, include a `changelog` array parsed from the spec CHANGELOG.md.' },
        since: { type: 'string', description: 'With changelog: return only entries strictly newer than this version (e.g. "0.17.0").' },
      },
    },
  },
  // ── Spec introspection round 3 ─────────────────────────────────
  // ── Spec introspection round 5 ──────────────────────────────────
  {
    name: 'validate_graph',
    description:
      'Walk the loaded graph and return a per-class, per-node report of schema drift plus anti-pattern violations from `UPG_ANTI_PATTERNS`. Schema-drift classes: non-canonical entity types, non-canonical edge types, top-level fields outside `UPGBaseNode`, invalid status values, self-referential `source_id`/`source_type`, properties matching `UPG_PROPERTY_MIGRATIONS` rules. Anti-patterns: catalog entries that fired against the live graph, sorted high → medium → low. Each entry carries `suggested_migration` (drift) or `remediation` (anti-pattern). Top-level `valid` is true iff drift is empty AND no violations fired. Read-only; pairs with `migrate_type`, `rename_edge_type`, `get_anti_pattern_violations_for`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'entity_drift', 'edge_drift', 'property_drift', 'top_level_drift', 'lifecycle_drift', 'self_referential', 'configuration_drift'],
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
        configuration: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Evaluate ANTI-PATTERNS against one configuration instead of across the family. Maps a configuration_axis (by node id, or by title when unambiguous) to a single one of its values. Configuration drift is NOT narrowed: the declarations it checks are facts about the whole family, so they are always validated on the union, by design. Omit this and anti-patterns are still evaluated per projection automatically: findings true everywhere report unqualified, findings true in only some report annotated with where they hold, and findings true only of the superposed union are suppressed and counted. Rejected with an error alongside skip_anti_patterns: true, since it would then have no effect.',
        },
        if_changed_since: { type: 'string', description: 'Hash from a previous response. Returns { changed: false } if graph unchanged.' },
        include_polymorphic_upgrades: { type: 'boolean', description: 'When true, include a `polymorphic_with_typed_alternative` array listing polymorphic edges (e.g. node_owned_by_person, node_constrains_node) that have a more-specific typed alternative for their actual source/target pair. Opt-in only; omitted by default to avoid cluttering routine validation output. Does not affect `valid`; these are advisory suggestions.' },
        pending_nodes: {
          type: 'array',
          description: 'Batch-4 #18 pre-commit preview: nodes you are ABOUT to create. When supplied (with/without pending_edges), validate_graph evaluates anti-patterns against the CURRENT graph PLUS this delta WITHOUT writing, and returns which violations the delta would newly trigger or resolve. Each item: `{ type, title?, status?, tags?, properties? }`.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'UPG entity type' },
              title: { type: 'string' },
              status: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              properties: { type: 'object' },
            },
            required: ['type'],
          },
        },
        pending_edges: {
          type: 'array',
          description: 'Pre-commit preview edges (paired with pending_nodes). Each item: `{ from, to, type? }`, where from/to is an existing node id OR a `$N` index into pending_nodes; type is inferred from endpoints when omitted.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Existing node id or $N pending ref' },
              to: { type: 'string', description: 'Existing node id or $N pending ref' },
              type: { type: 'string', description: 'Edge type (inferred when omitted)' },
            },
            required: ['from', 'to'],
          },
        },
      },
    },
  },
  {
    name: 'get_anti_pattern_violations_for',
    description:
      'Reverse lookup: given an entity id, return the anti-pattern violations that implicate it. Use after `validate_graph` to drill into one entity\'s implicated patterns. Matches by node id where the detector can name nodes and by entity type otherwise; each violation carries `matched_by` saying which, so a type match can be read as the approximation it is. Underpins the Inspect approach.',
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
    name: 'get_import_recipe',
    description:
      'Get an import recipe for a source: (a) the target UPG schema slice (entity/edge types in play + fields), (b) the source→UPG mapping, a canonical CURATED table served verbatim when one exists (Notion, Jira, Dovetail, and 30+ more), else a schema-grounded SCAFFOLD, and (c) the write tools to call in order (batch_create_nodes → batch_create_edges). You already hold the source data and the write tools; this returns the mapping guidance, executes nothing. The consistency guarantee: a curated source resolves to ONE mapping, so the same source imported twice yields the same graph. Surfaces every deliberate-only edge (e.g. insight_informs_opportunity) as a warning, never a silent write. Sibling of get_catalog_entry (kind: "template"). Omit source to list curated sources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          description: 'Source slug or free-text description (e.g. "notion", "Linear issues", "a CSV of feature requests"). Omit to list the curated sources.',
        },
      },
    },
  },
  {
    name: 'submit_feedback',
    description:
      "Send feedback about the Unified Product Graph (a bug, a feature request, an observation) to the project's triage queue at unifiedproductgraph.org, from any MCP client. Anonymous; no account. SHAPE IT FIRST for actionability, asking the user at most one round of questions (don't guess): a bug wants steps to reproduce, expected vs actual, and severity (`details`); a feature_request wants the underlying problem, the desired outcome, and any current workaround (`details`). CONSENT IS REQUIRED: the tool sends NOTHING unless you pass confirmed:true. Call it first WITHOUT confirmed to get back the exact payload, show that payload to the user (including the auto-collected `context`), and only re-call with confirmed:true after they say yes. PRIVACY: `context` is auto-assembled from the MCP client name/version, the server version, the runtime, and graph SIZE counts only; it never includes node titles, descriptions, or any graph content.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: [...FEEDBACK_TYPES],
          description:
            'Intake type: "bug" (something is broken), "feature_request" (something is missing), "observation" (a note/pattern worth recording), or "general".',
        },
        title: {
          type: 'string',
          description: 'A concise one-line summary (≤200 chars).',
        },
        description: {
          type: 'string',
          description: 'The full report (≤5000 chars). Make it actionable: enough for someone to act without a follow-up.',
        },
        details: {
          type: 'object',
          description:
            'Type-aware structured fields (optional). For a bug: steps_to_reproduce, expected, actual, severity (low|medium|high|critical). For a feature_request: problem, desired_outcome, workaround. Ignored for observation/general.',
          properties: {
            steps_to_reproduce: { type: 'string', description: 'bug: how to reproduce it' },
            expected: { type: 'string', description: 'bug: what should happen' },
            actual: { type: 'string', description: 'bug: what actually happens' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'bug: impact severity' },
            problem: { type: 'string', description: 'feature_request: the underlying problem' },
            desired_outcome: { type: 'string', description: 'feature_request: the outcome wanted' },
            workaround: { type: 'string', description: 'feature_request: any current workaround' },
          },
        },
        product_stage: {
          type: 'string',
          description: 'Optional product stage the reporter is working at.',
        },
        confirmed: {
          type: 'boolean',
          description:
            'CONSENT GATE. Must be true to actually send. Omit (or false) to get back a preview of the exact payload and send nothing.',
        },
      },
      required: ['type', 'title', 'description'],
    },
  },
  {
    name: 'update_session_context',
    description:
      'Update session context: register a skill invocation, record a recommendation, set focus area, switch lens, or store custom state for cross-skill coordination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_invoked: { type: 'string', description: 'Register that this skill was just invoked (e.g. "upg-show-status")' },
        recommendation: { type: 'string', description: 'Record a recommendation given to the user (e.g. "Run /upg-new-strategy to fill strategy gap")' },
        focus_area: { type: 'string', description: 'Set the current focus area (e.g. "strategy", "validation", "user_research")' },
        lens: { type: 'string', enum: [...CANONICAL_LENS_IDS], description: 'Switch the active lens. Changes what context, skills, and gaps are surfaced first. Canonical lens ids (derived from core): product, ux_design, engineering, growth, business, research, marketing, full.' },
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
          enum: ['urgent', 'high', 'medium', 'low', 'none'],
          description: 'Strategic priority of this area (canonical Priority scale)',
        },
        owner: { type: 'string', description: 'Person or team that owns this area' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_portfolio',
    description:
      'Create a portfolio entity in the portfolio document (`.upg/portfolio.upg`): the investment / grouping container products and operating functions belong to. A first-class wrapper over `create_node({type:"portfolio"})` (closes gap G2 / #39). `kind` sets the posture: owned (default), watched (the only kind that relaxes product grading), or the owned-side groupings strategic / internal / gtm (e.g. a Go-to-Market portfolio of revenue operating_functions). The portfolio document is created on demand.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Portfolio name (e.g. "Go-to-Market", "Internal Functions")' },
        description: { type: 'string', description: "The portfolio's strategic focus" },
        kind: {
          type: 'string',
          enum: ['owned', 'watched', 'strategic', 'internal', 'gtm'],
          description: 'Investment posture / grouping (default owned). Only watched relaxes product grading.',
        },
        parent_portfolio_id: { type: 'string', description: 'Parent portfolio id for nesting (a sub-portfolio)' },
        hierarchy_model: {
          type: 'string',
          enum: ['flat', 'nested', 'matrix'],
          description: 'How products are structured within this portfolio',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'assign_product_to_area',
    description:
      "Place an existing product under a product area (adds it to the area's `products[]` in `.upg/portfolio.upg`). Resolves the area against the portfolio document and auto-registers the product on the portfolio registry. Use after `create_product`, or pass `area_id` to `create_product` directly.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'Product id (from create_product / list_local_products)' },
        area_id: { type: 'string', description: 'Product area id (from list_product_areas)' },
      },
      required: ['product_id', 'area_id'],
    },
  },
  {
    name: 'update_area',
    description:
      'Edit a product area in `.upg/portfolio.upg` (title, description, strategic_priority, owner) and/or re-parent it via `parent_area_id`. The mirror of `update_product` for the organisational axis. `parent_area_id` is tri-state: omit to leave unchanged, pass null to un-nest (top-level), or pass an area id to re-parent (rejected if it would create a cycle).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        area_id: { type: 'string', description: 'Product area id to edit (from list_product_areas)' },
        title: { type: 'string', description: 'New area title' },
        description: { type: 'string', description: 'New area description' },
        strategic_priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low', 'none'],
          description: 'Strategic priority (canonical Priority scale)',
        },
        parent_area_id: {
          type: ['string', 'null'],
          description: 'Re-parent under this area id; null un-nests (top-level); omit to leave unchanged',
        },
        owner: { type: 'string', description: 'Person or team that owns this area' },
      },
      required: ['area_id'],
    },
  },
  {
    name: 'remove_product_from_area',
    description:
      "Remove a product from a product area's `products[]` in `.upg/portfolio.upg` (the product stays registered on the portfolio and in any other container). The inverse of `assign_product_to_area`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'Product id (from list_local_products)' },
        area_id: { type: 'string', description: 'Product area id (from list_product_areas)' },
      },
      required: ['product_id', 'area_id'],
    },
  },
  {
    name: 'delete_area',
    description:
      'Delete a product area from `.upg/portfolio.upg`. Guarded: refuses while the area still has products unless `force: true`. Child areas are un-nested (their parent link is cleared) so no parent reference dangles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        area_id: { type: 'string', description: 'Product area id to delete (from list_product_areas)' },
        force: { type: 'boolean', description: 'Delete even if the area still has products (default false)' },
      },
      required: ['area_id'],
    },
  },
  {
    name: 'move_product_to_area',
    description:
      'Move a product to a different product area: remove it from `from_area_id` (or, when omitted, from every area it currently sits in) and add it to `to_area_id`. Convenience over remove_product_from_area + assign_product_to_area.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'Product id (from list_local_products)' },
        to_area_id: { type: 'string', description: 'Destination product area id (from list_product_areas)' },
        from_area_id: { type: 'string', description: 'Source area id to remove from; omit to remove from all areas' },
      },
      required: ['product_id', 'to_area_id'],
    },
  },
  {
    name: 'attach_product_to_portfolio',
    description:
      "Place an existing product under a portfolio (adds it to the portfolio's `products[]` in `.upg/portfolio.upg`). Resolves the portfolio against the portfolio document and auto-registers the product on the portfolio registry. Use after `create_product`, or pass `portfolio_id` to `create_product` directly.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'Product id (from create_product / list_local_products)' },
        portfolio_id: { type: 'string', description: 'Portfolio id (from list_portfolios)' },
      },
      required: ['product_id', 'portfolio_id'],
    },
  },
  {
    name: 'detach_product_from_portfolio',
    description:
      "Remove a product from a portfolio's `products[]` in `.upg/portfolio.upg` (the product stays registered and in any other container). The inverse of `attach_product_to_portfolio`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'Product id (from list_local_products)' },
        portfolio_id: { type: 'string', description: 'Portfolio id (from list_portfolios)' },
      },
      required: ['product_id', 'portfolio_id'],
    },
  },
  {
    name: 'upsert_composition',
    description:
      'Create or republish a composition (a named, published view) at `slug`, writing the node and its `composition_focuses_node` edges in ONE atomic commit. Use this instead of create_node/update_node for any composition write, because `rev` is DERIVED: it is re-read inside the write and incremented only on a transition into `published`, so update_node({ properties: { rev: N } }) writes whatever number you happen to be holding and is silently wrong. Reads stay generic: list_nodes({ type: "composition" }) enumerates views, and the id IS the slug so get_node({ id: slug }) returns the view and its focus edges together. Pass `rev` to make the write conditional on the revision you last read; a mismatch refuses with `stored_rev` and leaves the file byte-unchanged rather than overwriting a print you never saw. Omitting `members` PRESERVES the stored arrangement (so retiring or renaming a view does not erase what it looked like) while `[]` clears it. A `focus_node_ids` entry that does not resolve in this graph is dropped rather than written as a dangling edge. To withdraw a view, write lifecycle "retired" rather than deleting it, so existing links resolve to something honest.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description: 'The slug, which IS the node id. A composition is addressed by what appears in its URL, so no surrogate id is minted. Reusing an existing slug republishes that view.',
        },
        title: { type: 'string', description: 'Display title of the view.' },
        description: { type: 'string', description: 'What this view is for. Omit to leave any stored description alone.' },
        lifecycle: {
          type: 'string',
          enum: ['draft', 'published', 'retired'],
          description:
            'Where the view stands: "draft" while it is being arranged and has never been live, "published" once it resolves at its slug, "retired" when withdrawn but kept so old links resolve. Only a write with "published" increments `rev`.',
        },
        focus_node_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Nodes this view is ABOUT, written as `composition_focuses_node` edges. This is what makes "which published views show this persona?" answerable to a tool that cannot parse the URLs of whichever tool published the view. An empty set is valid: a view scoped by query rather than enumeration focuses nothing in particular. Ids that do not resolve here are dropped.',
        },
        members: {
          type: 'array',
          items: COMPOSITION_MEMBER_SCHEMA,
          description:
            'The frozen block arrangement. OMIT to leave the stored arrangement untouched; pass [] to clear it. The two are different instructions.',
        },
        member_query: VIEW_QUERY_SCHEMA,
        presentation: VIEW_PRESENTATION_SCHEMA,
        published_by: { type: 'string', description: 'Publisher handle or email. A display scalar.' },
        rev: {
          type: 'integer',
          minimum: 0,
          description:
            'The revision you last read, as an optimistic PRECONDITION. Never the value written: the stored revision is re-derived inside the write, so two publishers racing produce N+1 then N+2. Supplying it turns "I am publishing" into "I am publishing what I saw at rev N", and a mismatch returns status "stale_revision" with `stored_rev`. Omit to publish unconditionally.',
        },
      },
      required: ['slug', 'title', 'lifecycle'],
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
      'Create a cross-product relationship between two entities in different products within a portfolio graph. Types: `shares_persona`, `shares_competitor`, `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`, `hosts` (host product runs the hosted product inside itself, directed host to hosted), `contributes_to` (a product strategy entity rolls up to a higher-level one, e.g. product objective → company objective; directed subordinate to superior), `rolls_up_to` (a product metric feeds a company/portfolio metric, e.g. a product KPI → a company north-star; directed feeder to feed, same-type metric → metric). For `instance_of` use `register_instance`; for `area_serves_persona` / `area_targets_market_segment` use `link_area_to_audience`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'Source node ID' },
        target_id: { type: 'string', description: 'Target node ID' },
        type: {
          type: 'string',
          enum: GENERIC_CROSS_EDGE_TYPES,
          description: 'Cross-product relationship type',
        },
        source_product_id: { type: 'string', description: 'Product ID of the source node' },
        target_product_id: { type: 'string', description: 'Product ID of the target node' },
        properties: {
          type: 'object',
          description:
            'Edge metadata, accepted only for cross-edge types declared carries_properties (e.g. feature_rivals_competitor_feature, carrying the parity assessment parity_status / quality / is_gap / assessed_on / evidence / confidence). Rejected for types that do not carry properties.',
        },
        dry_run: { type: 'boolean', description: 'Forecast the write without mutating: returns { dry_run: true, would: create | update | unchanged, edge } and writes nothing. Use to reason about a write before running it.' },
        supersede: { type: 'boolean', description: 'Classification edges only. When a classify write moves a source to a new value on a single-select axis, retire the prior same-axis edge (default true) so the source carries one current value. Set false to keep both (additive). A multi-select axis always keeps both.' },
      },
      required: ['source_id', 'target_id', 'type'],
    },
  },
  {
    name: 'create_parity_edge',
    description:
      'Create the parity / rivalry edge `feature_rivals_competitor_feature` from our `feature` to a `competitor_feature`, carrying the assessment (parity_status / quality / is_gap / assessed_on / evidence / confidence) as edge metadata. A typed convenience over the generic edge writers: it fixes the edge type, validates the parity enums, derives `is_gap` from `parity_status` when omitted, and routes automatically. Within the active graph it writes a catalogue edge (like `create_edge`); cross-product (their `competitor_feature` in a separate watched intelligence graph) it writes a cross-edge (like `create_cross_product_edge`), with the our-side product defaulting to the active product. The edge is authoritative; the node `parity_status` is a denormalised single-rival cache that `validate_graph` checks for divergence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        feature_id: { type: 'string', description: 'Our feature node id (the rivalry edge source). Bare, or {product_id}/{node_id} in cross mode.' },
        competitor_feature_id: { type: 'string', description: 'Their competitor_feature node id (the target). Bare for within-graph, or {product_id}/{node_id} for a competitor in a separate watched graph.' },
        parity_status: {
          type: 'string',
          enum: ['ahead', 'behind', 'parity', 'unique_to_us', 'unique_to_them'],
          description: 'Our standing versus theirs on this feature.',
        },
        quality: {
          type: 'string',
          enum: ['better', 'same', 'worse', 'missing'],
          description: 'Relative quality of our equivalent.',
        },
        is_gap: { type: 'boolean', description: 'Gap in our offering. Defaults to true when parity_status is behind or unique_to_them.' },
        assessed_on: { type: 'string', description: 'ISO date the assessment was made.' },
        evidence: { type: 'string', description: 'Free text, or an evidence / competitor_signal node id backing the assessment.' },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Confidence in the assessment.',
        },
        feature_product_id: { type: 'string', description: 'Cross mode: product id of our feature (defaults to the active product).' },
        competitor_product_id: { type: 'string', description: 'Cross mode: product id of the watched graph holding the competitor_feature.' },
        auto_create_portfolio: { type: 'boolean', description: 'Cross mode only: create an empty portfolio document if none exists (default false).' },
      },
      required: ['feature_id', 'competitor_feature_id', 'parity_status'],
    },
  },
  {
    name: 'create_classification_edge',
    description:
      'Place a node in a classification cell, carrying optional confidence and provenance as edge metadata (confidence / assessed_on / rationale / evidence). A typed convenience over the generic edge writers, mirroring create_parity_edge: it picks the edge type from the source node type (a competitor source writes competitor_classified_as_classification_value; any other node writes the polymorphic node_classified_as_classification_value), expands a friendly confidence (low/medium/high) into the canonical confidence_5 assessment, defaults assessed_on to today, and routes automatically. A registry/{value} target (or a supplied node_product_id) writes a cross-edge; a bare local value writes a catalogue edge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The node being classified (the edge source). Bare, or {product_id}/{node_id}.' },
        classification_value_id: { type: 'string', description: 'The target classification_value. Bare for a local value, or registry/{value} for a canonical.' },
        node_product_id: { type: 'string', description: 'Cross mode: product id holding node_id (defaults to the active product).' },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Confidence this node belongs in this cell. Expanded to a confidence_5 assessment.',
        },
        assessed_on: { type: 'string', description: 'ISO date the classification was made or last re-checked. Defaults to today.' },
        rationale: { type: 'string', description: 'Short note on why this node sits in this cell.' },
        evidence: { type: 'string', description: 'A source URL, or a competitor_signal / evidence node id backing the classification.' },
        supersede: { type: 'boolean', description: 'When this classifies the source to a new value on a single-select axis, retire its prior same-axis edge (default true) and record the move in the reclassification history. Set false to keep both values (additive). A multi-select axis always keeps both.' },
        auto_create_portfolio: { type: 'boolean', description: 'Cross mode only: create an empty portfolio document if none exists (default false).' },
      },
      required: ['node_id', 'classification_value_id'],
    },
  },
  {
    name: 'link_area_to_audience',
    description:
      'Link a product area to a canonical audience: create an `area_serves_persona` (target is a registry persona) or `area_targets_market_segment` (target is a registry market_segment) cross-edge, with optional `relevance` (primary/secondary) and `audience_role` qualifiers. The edge type is inferred from the canonical entity\'s type. Source is the product_area id; target is `registry/{canonical_id}`. This is the only path that creates the area↔audience edges. Idempotent: an existing edge is updated (qualifiers), not duplicated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        area_id: { type: 'string', description: 'The product_area id (see list_product_areas).' },
        canonical_id: { type: 'string', description: 'A registry persona or market_segment (bare or registry/{id}).' },
        relevance: { type: 'string', enum: ['primary', 'secondary'], description: 'Whether this audience is a primary or secondary focus of the area.' },
        audience_role: { type: 'string', enum: ['buyer', 'user', 'champion', 'influencer', 'partner'], description: 'The audience role in this area\'s context (persona targets only).' },
      },
      required: ['area_id', 'canonical_id'],
    },
  },
  {
    name: 'delete_cross_product_edge',
    description:
      'Delete a cross-product edge from `.upg/portfolio.upg` by id. The inverse of `create_cross_product_edge`. Returns `deleted: false` (not an error) when no edge with that id exists.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_id: { type: 'string', description: 'Cross-product edge id (from list_portfolio_cross_edges)' },
      },
      required: ['edge_id'],
    },
  },
  {
    name: 'batch_create_cross_product_edges',
    description:
      'Create up to 50 cross-product edges in one atomic write (the portfolio-tier mirror of batch_create_edges). Every edge is validated and qualified before anything is written; if any is invalid the whole batch is rejected. Referenced products are auto-registered.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
          type: 'array',
          description: 'Cross-product edges to create (max 50). Each: { source_id, target_id, type, source_product_id?, target_product_id? }.',
          items: {
            type: 'object',
            properties: {
              source_id: { type: 'string', description: 'Source node ID (bare or qualified {product_id}/{node_id})' },
              target_id: { type: 'string', description: 'Target node ID (bare or qualified {product_id}/{node_id})' },
              type: {
                type: 'string',
                enum: GENERIC_CROSS_EDGE_TYPES,
                description: 'Cross-product relationship type (parity with create_cross_product_edge; `rolls_up_to` included). For `instance_of` use `register_instance`; for the area edges use `link_area_to_audience`.',
              },
              source_product_id: { type: 'string', description: 'Product ID of the source node (qualifies a bare source_id)' },
              target_product_id: { type: 'string', description: 'Product ID of the target node (qualifies a bare target_id)' },
              properties: { type: 'object', description: 'Edge metadata, accepted only for cross-edge types declared carries_properties (e.g. the classification edges). Validated against the type property_schema; rejected for types that do not carry properties.' },
            },
            required: ['source_id', 'target_id', 'type'],
          },
        },
        auto_create_portfolio: { type: 'boolean', description: 'Create an empty portfolio document if none exists (default false)' },
        dry_run: { type: 'boolean', description: 'Forecast the batch without mutating: returns { dry_run: true, would_counts, edges:[{ would, edge }] } and writes nothing. The pre-flight that makes a large backfill safe to reason about.' },
        supersede: { type: 'boolean', description: 'Classification edges only. Retire a prior same-axis edge when a classify write moves a source on a single-select axis (default true). Set false to keep both (additive).' },
      },
      required: ['edges'],
    },
  },
  {
    name: 'batch_delete_cross_product_edges',
    description:
      'Delete up to 50 cross-product edges from `.upg/portfolio.upg` by id in one atomic write (the inverse of batch_create_cross_product_edges). All ids are removed, then a single portfolio flush persists the batch, so retiring a wave of superseded edges costs one write instead of one per id. A missing id is reported deleted: false, not an error, so the call is idempotent. Get ids from list_portfolio_cross_edges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_ids: {
          type: 'array',
          description: 'Cross-product edge ids to delete (max 50, from list_portfolio_cross_edges).',
          items: { type: 'string' },
        },
      },
      required: ['edge_ids'],
    },
  },
  {
    name: 'list_portfolio_cross_edges',
    description:
      'List cross-product edges stored in the portfolio document (`.upg/portfolio.upg`), optionally filtered, grouped, title-resolved, property-projected, freshness-filtered, and paginated. Empty list when the portfolio document is absent. Use `type` + `group_by` to read a focused comparison matrix; `resolve_titles` (default on) names entities ("Sitecore") instead of opaque ids; `property_include` trims heavy edge properties; `older_than_days` / `assessed_before` return the stale set (edges whose assessed_on is old or absent); `limit` / `offset` page the flat list. For the nested axis to value to members view use `get_portfolio_tree`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Filter to one cross-edge type (e.g. competitor_classified_as_classification_value).' },
        source_product_id: { type: 'string', description: 'Filter to edges whose source node is in this product.' },
        group_by: { type: 'string', enum: ['source', 'target'], description: 'Group edges by source or target endpoint (the comparison matrix) instead of a flat list.' },
        resolve_titles: { type: 'boolean', description: 'Add source_title / target_title to each edge, resolved from the registry and instance_of registrations. Default true.' },
        property_include: { type: 'array', items: { type: 'string' }, description: 'Keep only these keys of each edge properties object (e.g. ["confidence"]). Pass [] to drop properties entirely.' },
        older_than_days: { type: 'number', description: 'Freshness filter: keep only edges whose properties.assessed_on is older than this many days (the stale set). An edge with no assessed_on counts as stale. Wins over assessed_before.' },
        assessed_before: { type: 'string', description: 'Freshness filter: keep only edges assessed before this ISO date (e.g. 2026-06-15). An edge with no assessed_on counts as stale.' },
        limit: { type: 'number', description: 'Max edges to return in the flat list (ignored when group_by is set).' },
        offset: { type: 'number', description: 'Skip this many edges before the page (flat list only).' },
      },
    },
  },
  {
    name: 'define_canonical_entity',
    description:
      'Define a canonical shared entity in the portfolio registry (the shared-vocabulary tier of `.upg/portfolio.upg`). Use when an archetype is shared across products (a Developer persona, a North-Star metric, a competitor) and should have ONE authoritative definition that product instances link to via `register_instance`. A canonical entity is a normal node of any active entity type (persona, metric, competitor, market_segment, and any other active type) that lives in the registry rather than in a product. Creates the portfolio document if absent. Returns the canonical node and its `registry/{id}` qualified id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Any active UPG entity type, including `proposed`-maturity types. There is no canonical allowlist; persona, metric, competitor, market_segment are common examples, not the allowed set. The only gate is that the type is active (see list_entity_types).' },
        title: { type: 'string', description: 'Canonical name (e.g. "Developer").' },
        description: { type: 'string', description: 'Optional longer description of the canonical entity.' },
        properties: { type: 'object', description: 'Optional properties (e.g. a persona\'s audience_role).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        canonical_id: { type: 'string', description: 'Optional explicit registry id; otherwise derived from type + title (e.g. persona_developer).' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'register_instance',
    description:
      'Link a product node to a canonical registry entity by creating an `instance_of` cross-edge (product entity → `registry/{id}`). This is the only path that creates `instance_of` edges: it requires the canonical to exist and enforces the same-type constraint (a persona instance_of a persona). Idempotent: re-registering the same instance returns the existing edge. Set `alias: true` to sanction a deliberate title divergence (an informative product-local name) so registry drift detection ignores it. Use after `define_canonical_entity` to attach each product\'s local copy to the shared definition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The product instance node. Bare id resolves against the active product (or source_product_id); a qualified {product_id}/{node_id} targets any workspace product.' },
        canonical_id: { type: 'string', description: 'The registry entity id (bare, or registry/{id}).' },
        source_product_id: { type: 'string', description: 'Product ID owning the instance, when node_id is a bare id not in the active product.' },
        alias: { type: 'boolean', description: 'Mark a deliberate title divergence from the canonical as sanctioned, excluding it from registry drift. Can be toggled on an existing instance_of edge.' },
      },
      required: ['node_id', 'canonical_id'],
    },
  },
  {
    name: 'list_registry',
    description:
      'List the canonical shared entities in the portfolio registry. Each row carries id, type, title, optional audience_role, and TWO counts that answer different questions: `instance_count` (inbound `instance_of` edges from PRODUCT graphs) and `registry_edge_count` (the registry\'s own internal edges on either endpoint, written by `create_registry_edge`). A canonical with `instance_count: 0` is NOT necessarily unreferenced, so check `registry_edge_count` before treating one as safe to retire or re-point. With `include_instances` / `include_edges`, attaches the instances / registry-internal edges themselves. Empty when no registry exists yet.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Filter to one entity type (e.g. persona).' },
        include_instances: { type: 'boolean', description: 'Attach each canonical\'s product instances (default false).' },
        include_edges: { type: 'boolean', description: 'Attach each canonical\'s registry-internal edges, each tagged inbound/outbound (default false).' },
      },
    },
  },
  {
    name: 'update_canonical_entity',
    description:
      'Edit a canonical registry entity in place (title, description, audience_role, tags, properties) WITHOUT disturbing the `instance_of` edges that point at it. The fix for a canonical seeded with a typo or placeholder: correct it via the API instead of hand-editing portfolio.upg. Properties are shallow-merged. At least one editable field is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canonical_id: { type: 'string', description: 'The registry entity id (bare, or registry/{id}).' },
        title: { type: 'string', description: 'New canonical name.' },
        description: { type: 'string', description: 'New description.' },
        audience_role: { type: 'string', description: 'Persona audience role (buyer/user/champion/influencer/partner); merged into properties.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        properties: { type: 'object', description: 'Properties to shallow-merge into the canonical.' },
      },
      required: ['canonical_id'],
    },
  },
  {
    name: 'delete_canonical_entity',
    description:
      'Delete a canonical entity from the portfolio registry: the registry counterpart to `delete_node` (which only sees the active product). Retires an obsolete or twin canonical that would otherwise linger as a 0-instance orphan in `list_registry`. Safe by default: refuses while anything still references the canonical (instance_of edges, area/classification cross-edges, registry-internal edges) unless `cascade: true`, which deletes those references in the same atomic flush, severing the instances. When instances should SURVIVE under another canonical, use `merge_canonical_entities` instead: it repoints them. Preview the exact blast radius first with `dry_run: true`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canonical_id: { type: 'string', description: 'The registry entity id (bare, or registry/{id}).' },
        cascade: { type: 'boolean', description: 'Also delete every edge referencing the canonical (default false). Without it, a referenced canonical is refused.' },
        dry_run: { type: 'boolean', description: 'Preview the canonical + every referencing edge that deletion would remove; nothing is written (default false).' },
      },
      required: ['canonical_id'],
    },
  },
  {
    name: 'merge_canonical_entities',
    description:
      'Merge two or more canonical registry entities into one surviving canonical: the fix for twin canonicals created across separate canonicalization passes (e.g. `persona_editor` + `persona_editor_2` with every instance registered under both). In one atomic flush: repoints every cross-edge from `registry/{loser}` to `registry/{keep}` (a repoint that would duplicate an existing edge, the double-parented instance case, drops the redundant edge instead, preserving any `alias` sanction), repoints registry-internal edges (self-loops and duplicates drop), unions each loser\'s description/tags/properties into the keeper\'s GAPS (the keeper always wins where both define a value), then deletes the losers. All canonicals must share one entity type. Preview the full plan with `dry_run: true`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keep: { type: 'string', description: 'The surviving canonical id (bare, or registry/{id}).' },
        merge: { type: 'array', items: { type: 'string' }, description: '1–20 canonical ids to fold into keep. Same type as keep.' },
        dry_run: { type: 'boolean', description: 'Preview the merge plan (repoints, drops, property fills); nothing is written (default false).' },
      },
      required: ['keep', 'merge'],
    },
  },
  {
    name: 'batch_define_canonical_entity',
    description:
      'Batch-create canonical registry entities in one atomic call (the migration counterpart to `define_canonical_entity`). Validates every entity up front (valid type, unique id) then writes all and flushes once, so a registry stand-up is a handful of batches, not one call per canonical.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entities: {
          type: 'array',
          description: 'Up to 50 canonical entities.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Any active UPG entity type (no allowlist; see define_canonical_entity).' },
              title: { type: 'string', description: 'Canonical name.' },
              canonical_id: { type: 'string', description: 'Optional explicit registry id.' },
              description: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              properties: { type: 'object' },
            },
            required: ['type', 'title'],
          },
        },
      },
      required: ['entities'],
    },
  },
  {
    name: 'batch_register_instance',
    description:
      'Batch-register product instances against canonical entities in one atomic call (the migration counterpart to `register_instance`). Validates every instance up front (canonical exists, same-type) then writes all `instance_of` edges and flushes once. Per-instance idempotent; `alias` honoured per instance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instances: {
          type: 'array',
          description: 'Up to 50 instances.',
          items: {
            type: 'object',
            properties: {
              node_id: { type: 'string', description: 'The product instance node (bare or qualified).' },
              canonical_id: { type: 'string', description: 'The registry entity id (bare or registry/{id}).' },
              source_product_id: { type: 'string', description: 'Product ID owning a bare node_id.' },
              alias: { type: 'boolean', description: 'Sanction a deliberate title divergence.' },
            },
            required: ['node_id', 'canonical_id'],
          },
        },
      },
      required: ['instances'],
    },
  },
  {
    name: 'promote_to_canonical',
    description:
      'Promote an existing product node into the registry as its canonical, instead of authoring a fresh thinner one with `define_canonical_entity`. Copies the source node\'s description/tags/properties into a new registry node and (by default) registers the source as the canonical\'s first instance. Lets a team canonicalise the rich node they already curated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_id: { type: 'string', description: 'The existing node (bare resolves against active product or source_product_id; or qualified {product_id}/{node_id}).' },
        source_product_id: { type: 'string', description: 'Product ID owning a bare node_id.' },
        canonical_id: { type: 'string', description: 'Optional explicit registry id; otherwise derived from type + title.' },
        register_source: { type: 'boolean', description: 'Register the source node as the first instance (default true).' },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'create_registry_edge',
    description:
      'Create a canonical-internal edge between two registry entities: the authoring path for `registry.edges`. Canonical entities relate to one another (a registry specification governed_by a registry organization, a primitive defined_by a specification, a specification that extends another specification). These edges live in the portfolio registry and never touch product graphs. Validates that both endpoints exist in the registry, the type is a real `UPG_EDGE_CATALOG` edge, and the catalog source_type/target_type match the two nodes (the canonical edge for the pair). Idempotent: an identical edge (same source/target/type) already present is returned, not duplicated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'Source registry entity id (bare or registry/{id}).' },
        target_id: { type: 'string', description: 'Target registry entity id (bare or registry/{id}).' },
        type: { type: 'string', description: 'A UPG_EDGE_CATALOG edge type whose endpoint types match the two registry nodes (see resolve_edge_for_pair).' },
      },
      required: ['source_id', 'target_id', 'type'],
    },
  },
  {
    name: 'list_registry_edges',
    description:
      'Enumerate the registry\'s INTERNAL edges: the read counterpart to `create_registry_edge`. These edges live in `registry.edges` in the portfolio document and never touch a product graph, which is why the product-scoped readers miss them. `export_edges` enumerates the ACTIVE PRODUCT\'s edges and returns an empty array for registry-only types, and an empty array meaning *wrong scope* is indistinguishable from one meaning *no such edges*. Ask this tool "what points at this canonical" before planning any migration that retires or re-points registry entities, because `list_registry`\'s `instance_count` counts only inbound `instance_of` edges from product graphs, not these. Returns the same `{ id, source, target, type }` shape as `export_edges`, with bare (unqualified) registry endpoint ids.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: 'Filter to these catalog edge types (omit to enumerate all registry edges).' },
        endpoint_id: { type: 'string', description: 'Filter to edges touching this registry node in EITHER direction (bare or registry/{id}).' },
        source_id: { type: 'string', description: 'Filter to edges leaving this registry node (bare or registry/{id}).' },
        target_id: { type: 'string', description: 'Filter to edges arriving at this registry node (bare or registry/{id}).' },
      },
    },
  },
  {
    name: 'portfolio_query',
    description:
      'Traverse the graph ACROSS products in one call (the multi-product `query`). Runs the same BFS (typed-edge traversal + field projection) against every product in scope and tags each subgraph with its source `product_id`, without `switch_product` (the active product is read live; others are read-only). Use for portfolio-level questions ("every product\'s strategy region", "which products have a persona"). `from_id` only matches in its owning product. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start from all nodes of this type (in each product)' },
        from_id: { type: 'string', description: 'Start from a specific node ID. Node IDs are product-local; only the owning product returns results.' },
        traverse: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow at each level (in order). If omitted, follows all edges. Prefix with ! to exclude.',
        },
        depth: { type: 'number', description: 'Max traversal depth (default 3, max 10)' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields per node: "title", "status", "tags", "description", "properties" (default: title, status, type)',
        },
        limit: { type: 'number', description: 'Max nodes per product (default 100, max 1000)' },
        edge_include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge fields to return: "id", "type", "source", "target". Empty array = no edges. Default: all fields.',
        },
        property_include: {
          type: 'array',
          items: { type: 'string' },
          description: 'When "properties" is in include, only return these property keys.',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Product IDs (or files) to query. Omit to query ALL products in the workspace. Match by product id, relative file, or basename.',
        },
      },
    },
  },
  {
    name: 'portfolio_digest',
    description:
      'Roll up every product\'s counts, health, and stage-coverage in one call (the multi-product `get_graph_digest`). The strategic-surface read that otherwise required `switch_product` + `get_graph_digest` per graph. Returns per-product summaries plus a portfolio rollup (totals, products-by-stage). Read-only; never mutates active-product state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Product IDs (or files) to summarise. Omit to summarise ALL products in the workspace.',
        },
        coverage_profile: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch-4 #22: coverage region ids (keys of the `coverage` block, e.g. understanding, discovery, building) to score each product against, so "is this product at parity?" is a direct read across the portfolio. Adds `coverage_profile_pct` to every product summary.',
        },
      },
    },
  },
  {
    name: 'portfolio_census',
    description:
      'List product-local nodes of ONE type ACROSS the whole portfolio with a chosen projection (the cross-product `list_nodes`). The overflow-safe answer to "every metric across all 16 graphs, with title + description": the read every canonicalisation / coverage pass needs. Unlike `portfolio_query` (which returns full nodes AND traversed edges, and overflows the payload cap past ~195 nodes), a census never traverses and never returns edges, so payload scales only with row count x projected-field size. Each row is `{ product_id, node_id, <projected> }`; `group_by: "product"` nests rows under each product instead. Read-only; never mutates active-product state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Entity type to census (e.g. "metric", "persona", "primitive"). Required.' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Projected fields per node: "title", "status", "tags", "description", "properties" (default: ["title"]). id (as node_id) and product_id are always present.',
        },
        property_include: {
          type: 'array',
          items: { type: 'string' },
          description: 'When "properties" is in include, only return these property keys.',
        },
        group_by: {
          type: 'string',
          enum: ['none', 'product'],
          description: 'none (one flat `rows` list, default) or product (nest rows under each product, the comparison view).',
        },
        status: { type: 'string', description: 'Only census nodes with this lifecycle status.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only census nodes carrying at least one of these tags.',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Product IDs (or files) to census. Omit to census ALL products in the workspace. Match by product id, relative file, or basename. (`products` is accepted as an alias.)',
        },
        limit: { type: 'number', description: 'Max rows in the returned page (default 1000, max 5000). Pages the flat sequence; `total` reports the full match count.' },
        offset: { type: 'number', description: 'Skip this many rows before the page (default 0). With `limit`, pages a large census.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_portfolio_tree',
    description:
      'Assemble a portfolio-grain tree from `.upg/portfolio.upg` (the portfolio complement to `get_tree`, which is product-scoped). `shape: "landscape"` (default) walks the shared classification registry and the `*_classified_as_classification_value` cross edges: classification axis to its values to the nodes classified at each value, every leaf carrying `confidence` / `assessed_on`; anchor at one axis or value with `from_id`, or omit for the whole portfolio. `shape: "competitor_profile"` returns one node (a competitor) and its position on every axis it has been graded against; `from_id` required. `shape: "structure"` returns the org chart from the portfolio DOCUMENT FIELDS (organisation to product areas / portfolios to their member products, nested), no graph traversal; areas are the ownership axis and portfolios the strategic axis, so a product can appear under both. Titles resolve to entity names (e.g. "Directus"), not opaque ids. Values with no wired axis surface under an `unaxed` bucket. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        shape: { type: 'string', enum: ['landscape', 'competitor_profile', 'structure'], description: 'landscape (axis to value to classified members, default), competitor_profile (one node to its per-axis positions), or structure (org to areas / portfolios to products, from document fields).' },
        from_id: { type: 'string', description: 'Anchor node id (qualified or bare). Optional for landscape (a classification axis or value); required for competitor_profile (the node to profile).' },
        include_properties: { type: 'array', items: { type: 'string' }, description: 'Classification-edge property keys to inline on each leaf, in addition to the always-included confidence / assessed_on.' },
        include_members: { type: 'boolean', description: 'Landscape only. Force classified members to inline on the whole-portfolio overview (counts-only by default). Subject to the payload guard.' },
      },
    },
  },
  {
    name: 'audit_property_coverage',
    description:
      'Audit which portfolio cross-edges of a given type are MISSING required `properties` keys (the completeness check for a property backfill, without a shell over `portfolio.upg`). Given `edge_type` and `required_keys`, returns the edges that lack any of them, plus (when `check_values`) the edges whose present values fail the type property schema. Resolves entity titles. Example: `audit_property_coverage({ edge_type: "competitor_classified_as_classification_value", required_keys: ["confidence", "assessed_on"] })` returns `missing: []` once every classify edge carries both. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_type: { type: 'string', description: 'Cross-edge type to audit (e.g. competitor_classified_as_classification_value).' },
        required_keys: { type: 'array', items: { type: 'string' }, description: 'The properties keys that should be present on every edge of this type (e.g. ["confidence", "assessed_on"]).' },
        source_product_id: { type: 'string', description: 'Restrict to edges whose source node is in this product.' },
        check_values: { type: 'boolean', description: 'Also report edges whose PRESENT properties fail the type property schema (off-scale, missing nested keys). Default true.' },
      },
      required: ['edge_type', 'required_keys'],
    },
  },
  {
    name: 'diff_classification',
    description:
      'Show what MOVED on the competitive classification landscape: each competitor reclassification (from one classification_value to another on an axis) since a date. Reads the append-only reclassification history auto-recorded at the classify-write chokepoint, so "did AEM move from integrated to agentic" is one call instead of in-head reasoning. Returns transitions with resolved titles (competitor, from, to), sorted newest first. Pairs with `list_portfolio_cross_edges` freshness (which decides WHEN to re-assess); this surfaces WHAT changed. Empty when nothing moved or no history exists. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        product: { type: 'string', description: 'Restrict to reclassifications of competitors owned by this product (matched on the competitor id product prefix).' },
        competitor: { type: 'string', description: 'Restrict to one competitor by its qualified id (e.g. p_rival/n_acme).' },
        since: { type: 'string', description: 'ISO date. Only transitions observed on or after this date (e.g. 2026-06-01). Omit for all history.' },
      },
    },
  },
  {
    name: 'compare_classifications',
    description:
      'Compare two classified nodes (competitors) axis-by-axis: where they AGREE (same classification_value), DIVERGE (different values), or where only one has been graded. The bridge from the classification layer to the parity layer: `create_parity_edge` writes a parity relationship, this derives which axes warrant one. Reuses the same per-node profile assembly as `get_portfolio_tree` competitor_profile, so axis / value / confidence resolution is identical, then joins the two. Divergences are ordered first (the actionable rows). Titles resolve to entity names. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        a: { type: 'string', description: 'First node to compare (qualified or bare id, e.g. p_rival/n_acme or a registry competitor id).' },
        b: { type: 'string', description: 'Second node to compare (qualified or bare id).' },
        axis: { type: 'string', description: 'Restrict the comparison to one classification axis (bare or qualified id). Omit to compare across every axis either node is graded on.' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'aggregate_edge_properties',
    description:
      'Aggregate the distribution of one property across every portfolio cross-edge of a type, optionally grouped by a dimension. The digest of the property layer: turns the by-eye "165 high / 53 medium / 0 low, mediums cluster on ext_api_sdk" count over a `jq` dump into one call. `property` defaults to `confidence` (an assessment-object property buckets by its `label`). `group_by`: `none` (one overall distribution, default), `axis` (the classification axis the target value belongs to), `competitor` (the source node), or `value` (the target value). Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_type: { type: 'string', description: 'Cross-edge type to aggregate (e.g. competitor_classified_as_classification_value).' },
        group_by: { type: 'string', enum: ['none', 'axis', 'competitor', 'value'], description: 'Dimension to group the distribution by. Default none (one overall distribution).' },
        property: { type: 'string', description: 'The edge property whose distribution to compute. Default confidence.' },
      },
      required: ['edge_type'],
    },
  },
  {
    name: 'audit_axis_overlap',
    description:
      'List every classified source that holds MORE THAN ONE value on a single-select classification axis (the stale-edge symptom a reclassification leaves when the prior same-axis edge is not retired). From 0.11.3 the classify writer supersedes by default, so this is the regression guard (a clean graph returns `overlaps: []`) and the detector for overlaps already in a graph. A `multi`-select axis is exempt; unaxed values are skipped. Titles resolve to entity names. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'portfolio_validate',
    description:
      'Run `validate_graph` ACROSS every product in scope in one call (the audit counterpart to `portfolio_digest`). Replaces the `switch_product` + `validate_graph` round-trip per product. Each product is checked by the SAME single-product code path (schema drift + anti-patterns), so per-product verdicts never diverge. Returns a per-product `valid` / `structurally_valid` + drift + anti-pattern counts, plus a portfolio rollup with `all_valid`. Read-only; the active product is read live, the rest read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Product IDs (or files) to validate. Omit to validate ALL products in the workspace.',
        },
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Restrict anti-pattern evaluation to this severity (passed through to validate_graph).',
        },
        include_violations: {
          type: 'boolean',
          description: 'Include a per-product `top_violations` list (default true).',
        },
        violation_limit: {
          type: 'number',
          description: 'Max anti-pattern violations listed per product (default 5, max 25).',
        },
      },
    },
  },
  {
    name: 'clone_structure',
    description:
      'Stamp the SHAPE of one product (typed nodes + canonical edges + hierarchy, with `TODO:` placeholder titles) into another, without re-authoring the skeleton. Content (descriptions, properties, real titles, statuses) never crosses; only the structure does. The lever for multi-product structural parity: one stamp plus a content pass replaces a multi-batch rebuild. `from_product` is the read-only exemplar; `into` is the write target and DEFAULTS to the active product (name a non-active product to write there with no `switch_product`). `regions` scopes the clone to entity types in those super-domains. `dry_run: true` previews the plan without writing. Local-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_product: {
          type: 'string',
          description: 'Exemplar product (id, file, or basename) whose shape is copied. Read-only.',
        },
        into: {
          type: 'string',
          description: 'Target product to stamp the shape into. Defaults to the ACTIVE product; name a non-active product to write there without switch_product.',
        },
        regions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional region ids (or labels) to scope the clone to entity types in those super-domains. Omit to clone the whole shape.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the plan (counts by type, edges, sample titles) without writing. Default false.',
        },
      },
      required: ['from_product'],
    },
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
  get_tree: getTree,
  create_node: createNode,
  update_node: updateNode,
  delete_node: deleteNode,
  batch_create_nodes: batchCreateNodes,
  batch_update_nodes: batchUpdateNodes,
  batch_delete_nodes: batchDeleteNodes,
  batch_create_edges: batchCreateEdges,
  batch_delete_edges: batchDeleteEdges,
  apply_framework: applyFramework,
  score_entity: scoreEntity,
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
  reload_product: reloadProduct,
  get_workspace_info: getWorkspaceInfo,
  init_workspace: initWorkspaceTool,
  create_product: createProductTool,
  update_product: updateProductTool,
  migrate_type: migrateType,
  migrate_properties: migrateProperties,
  promote_scalars_to_edges: promoteScalarsToEdges,
  migrate_status: migrateStatus,
  deduplicate_nodes: deduplicateNodes,
  get_entity_schema: getEntitySchema,
  get_spec_version: getSpecVersion,
  validate_graph: validateGraph,
  get_anti_pattern_violations_for: getAntiPatternViolationsFor,
  get_session_context: getSessionContext,
  update_session_context: updateSessionContext,
  skill_audit: skillAudit,
  list_catalog: listCatalog,
  get_catalog_entry: getCatalogEntry,
  get_import_recipe: getImportRecipe,
  submit_feedback: submitFeedback,
  get_area_context: getAreaContext,
  create_area: createArea,
  create_portfolio: createPortfolio,
  assign_product_to_area: assignProductToAreaTool,
  update_area: updateAreaTool,
  remove_product_from_area: removeProductFromAreaTool,
  delete_area: deleteAreaTool,
  move_product_to_area: moveProductToAreaTool,
  list_portfolios: listPortfolios,
  get_organization: getOrganization,
  create_cross_product_edge: createCrossProductEdge,
  create_parity_edge: createParityEdge,
  create_classification_edge: createClassificationEdge,
  link_area_to_audience: linkAreaToAudience,
  delete_cross_product_edge: deleteCrossProductEdgeTool,
  batch_create_cross_product_edges: batchCreateCrossProductEdges,
  batch_delete_cross_product_edges: batchDeleteCrossProductEdgesTool,
  attach_product_to_portfolio: attachProductToPortfolioTool,
  detach_product_from_portfolio: detachProductFromPortfolioTool,
  upsert_composition: upsertCompositionTool,
  list_portfolio_cross_edges: listPortfolioCrossEdges,
  define_canonical_entity: defineCanonicalEntity,
  register_instance: registerInstance,
  list_registry: listRegistry,
  update_canonical_entity: updateCanonicalEntity,
  batch_define_canonical_entity: batchDefineCanonicalEntity,
  batch_register_instance: batchRegisterInstance,
  promote_to_canonical: promoteToCanonical,
  create_registry_edge: createRegistryEdge,
  list_registry_edges: listRegistryEdges,
  delete_canonical_entity: deleteCanonicalEntity,
  merge_canonical_entities: mergeCanonicalEntities,
  portfolio_query: portfolioQuery,
  portfolio_digest: portfolioDigest,
  portfolio_census: portfolioCensus,
  get_portfolio_tree: getPortfolioTree,
  audit_property_coverage: auditPropertyCoverage,
  diff_classification: diffClassification,
  compare_classifications: compareClassifications,
  aggregate_edge_properties: aggregateEdgePropertiesTool,
  audit_axis_overlap: auditAxisOverlap,
  portfolio_validate: portfolioValidate,
  clone_structure: cloneStructure,
  migrate_cross_edges: migrateCrossEdges,
  get_sync_state: getSyncState,
  apply_pull_changeset: applyPullChangeset,
  push_to_cloud: pushToCloud,
}

/**
 * Tools that honour the `configuration` read parameter (0.30.0).
 *
 * The seam is deliberately narrow. Every other tool must REFUSE the argument
 * rather than ignore it: a caller who passes `configuration` to a tool that
 * drops it believes they are looking at one member of the configuration family
 * while reading the superposed union, which is precisely the confusion this
 * release exists to remove. Silence is the one response that cannot be right.
 *
 * Widening the seam is a scope decision, not a convenience: it is banked as a
 * candidate for a later release, on field demand.
 */
export const CONFIGURATION_AWARE_TOOLS: readonly string[] = [
  'query',
  'get_tree',
  'validate_graph',
]

/**
 * Reject `configuration` on a tool that does not implement it.
 *
 * Applied at dispatch so the guarantee holds for every tool at once, including
 * tools added later, rather than depending on each handler remembering.
 */
export function rejectUnsupportedConfiguration(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (args.configuration === undefined || args.configuration === null) return undefined
  if (CONFIGURATION_AWARE_TOOLS.includes(name)) return undefined
  return (
    `"${name}" does not support the \`configuration\` parameter and will not silently ignore it. ` +
    `Reading one configuration is implemented on: ${CONFIGURATION_AWARE_TOOLS.join(', ')}. ` +
    `Remove the argument to read the union, which is every configuration at once.`
  )
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
