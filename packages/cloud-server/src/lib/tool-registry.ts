/**
 * Tool registry for the UPG cloud server. Maps each tool name to its
 * wire-level definition and handler. `server.ts` dispatches by name lookup.
 */

import type { ToolBinding, ToolDefinition } from '@unified-product-graph/mcp-tooling'
import { LIST_CATALOG_DEF, GET_CATALOG_ENTRY_DEF, GET_ENTITY_SCHEMA_DEF } from '@unified-product-graph/mcp-tooling'
import type { CloudContext } from './server-context.js'
import { listProducts, createProduct, getAuditLog } from '../tools/products.js'
import { getProductContext, getGraphDigest, query, getChanges } from '../tools/context.js'
import { getTree } from '../tools/tree.js'
import {
  listNodes, getNode, getNodes, searchNodes,
  createNode, updateNode, deleteNode, getProductGraph, moveNode,
  deduplicateNodes, exportUpgDocument,
} from '../tools/nodes.js'
import { createEdge, deleteEdge, exportEdges, renameEdgeType } from '../tools/edges.js'
import { applyFramework, scoreEntity } from '../tools/frameworks.js'
import { listCatalog, getCatalogEntry } from '../tools/catalog.js'
import { listProductAreas, getAreaGraph, createArea, getAreaContext } from '../tools/areas.js'
import { getEntitySchema } from '../tools/schema.js'
import { addComment, listComments, grantAccess, listCollaborators } from '../tools/collaboration.js'
import { getGraphAnalytics } from '../tools/analytics.js'
import { registerWebhook, listWebhooks, removeWebhook } from '../tools/webhooks.js'
import { getSpecVersion } from '../tools/spec.js'
import { listPortfolios, listPortfolioCrossEdges, createCrossProductEdge, repairDanglingEdges } from '../tools/portfolio.js'
import {
  batchCreateNodes, batchUpdateNodes, batchDeleteNodes,
  batchCreateEdges, batchDeleteEdges, batchMoveNodes,
} from '../tools/batch.js'
import { validateGraph } from '../tools/validation.js'
import { migrateType, migrateCrossEdges } from '../tools/migrations.js'

/** Wire-shape definitions only, passed to `tools/list`. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    "name": "list_products",
    "description": "List all products in this UPG cloud instance.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "create_product",
    "description": "Create a new product graph.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Product name"
        },
        "description": {
          "type": "string",
          "description": "Optional description"
        },
        "stage": {
          "type": "string",
          "description": "idea | mvp | growth | scale"
        }
      },
      "required": [
        "title"
      ]
    }
  },
  {
    "name": "get_product_context",
    "description": "Returns the product summary, entity counts by type, and a human-readable overview of the graph. Use this first to understand what is in the graph.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "list_nodes",
    "description": "List entities in the graph, optionally filtered by type. Supports cursor pagination for large products (1000+ nodes). Default limit 1000, max 10000. Pass next_cursor from a previous response as cursor to advance to the next page. Returns next_cursor in the response when more results remain. Legacy offset param still accepted when cursor is absent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "type": {
          "type": "string",
          "description": "Filter by entity type"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 1000, max 10000)"
        },
        "cursor": {
          "type": "string",
          "description": "Opaque pagination cursor; pass next_cursor from a previous response to advance."
        },
        "offset": {
          "type": "number",
          "description": "Legacy: skip N results (default 0). Use cursor instead for new callers."
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "export_upg_document",
    "description": "Export the full product graph as a UPG document: product metadata, all nodes, and all edges. Used by the upg pull CLI and apply_pull_changeset for sync/backup. Supports cursor pagination for large products (1000+ nodes): default limit 1000, max 10000. Pass next_cursor from a previous response as cursor to advance. Edges are returned in full on every page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "limit": {
          "type": "number",
          "description": "Max nodes per page (default 1000, max 10000)"
        },
        "cursor": {
          "type": "string",
          "description": "Opaque pagination cursor; pass next_cursor from a previous response to advance."
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "get_node",
    "description": "Get a single entity by ID with its full properties and all connected edges.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "node_id": {
          "type": "string",
          "description": "The node ID"
        }
      },
      "required": [
        "node_id"
      ]
    }
  },
  {
    "name": "search_nodes",
    "description": "Full-text search across node titles and descriptions. Title matches rank higher.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "query": {
          "type": "string",
          "description": "Search text"
        },
        "type": {
          "type": "string",
          "description": "Optional type filter"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 20)"
        }
      },
      "required": [
        "product_id",
        "query"
      ]
    }
  },
  {
    "name": "create_node",
    "description": "Create a new entity in the graph. Optionally connect it to a parent node.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "type": {
          "type": "string",
          "description": "UPG entity type (e.g. \"persona\", \"opportunity\")"
        },
        "title": {
          "type": "string",
          "description": "Entity title"
        },
        "description": {
          "type": "string",
          "description": "Optional description"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Freeform tags"
        },
        "status": {
          "type": "string",
          "description": "Lifecycle status"
        },
        "properties": {
          "type": "object",
          "description": "Type-specific fields"
        },
        "parent_id": {
          "type": "string",
          "description": "Parent node ID; creates an edge automatically"
        }
      },
      "required": [
        "product_id",
        "type",
        "title"
      ]
    }
  },
  {
    "name": "update_node",
    "description": "Update an existing entity. Unspecified fields are preserved.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "node_id": {
          "type": "string",
          "description": "The node ID to update"
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "status": {
          "type": "string"
        },
        "properties": {
          "type": "object",
          "description": "Merged with existing properties"
        }
      },
      "required": [
        "node_id"
      ]
    }
  },
  {
    "name": "delete_node",
    "description": "Remove an entity and all its connected edges from the graph.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "node_id": {
          "type": "string",
          "description": "The node ID to delete"
        }
      },
      "required": [
        "node_id"
      ]
    }
  },
  {
    "name": "create_edge",
    "description": "Create a relationship between two nodes. Edge type is auto-inferred if omitted.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "source_id": {
          "type": "string",
          "description": "Source node ID"
        },
        "target_id": {
          "type": "string",
          "description": "Target node ID"
        },
        "type": {
          "type": "string",
          "description": "Edge type; auto-inferred if omitted"
        }
      },
      "required": [
        "source_id",
        "target_id"
      ]
    }
  },
  {
    "name": "delete_edge",
    "description": "Remove a relationship between two nodes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "edge_id": {
          "type": "string",
          "description": "The edge ID to delete"
        }
      },
      "required": [
        "edge_id"
      ]
    }
  },
  {
    "name": "export_edges",
    "description": "Flat enumeration of all edges for a product, optionally filtered by type. Returns lightweight { id, source, target, type } rows ordered by id, intended for migration passes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "types": { "type": "array", "items": { "type": "string" }, "description": "Optional edge type filter" }
      },
      "required": ["product_id"]
    }
  },
  {
    "name": "rename_edge_type",
    "description": "Rename all edges of one type to another across a product. dry_run (default: true) previews the count.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "from": { "type": "string", "description": "Current edge type" },
        "to": { "type": "string", "description": "New edge type" },
        "dry_run": { "type": "boolean", "description": "If true, only count (default: true); pass false to apply." }
      },
      "required": ["product_id", "from", "to"]
    }
  },
    {
    "name": "get_product_graph",
    "description": "Export the full graph for a product (all nodes + edges).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "get_audit_log",
    "description": "Get recent changes (audit log) for a product.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "limit": {
          "type": "number",
          "description": "Max entries (default 50)"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "add_comment",
    "description": "Add a comment on a node in the graph.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "node_id": {
          "type": "string",
          "description": "Node to comment on"
        },
        "user_id": {
          "type": "string",
          "description": "Author user ID"
        },
        "body": {
          "type": "string",
          "description": "Comment text"
        }
      },
      "required": [
        "product_id",
        "node_id",
        "user_id",
        "body"
      ]
    }
  },
  {
    "name": "list_comments",
    "description": "List comments on a node, newest first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "node_id": {
          "type": "string",
          "description": "Node ID"
        }
      },
      "required": [
        "node_id"
      ]
    }
  },
  {
    "name": "grant_access",
    "description": "Grant or update a user's role on a product (owner, editor, viewer).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "user_id": {
          "type": "string",
          "description": "User to grant access to"
        },
        "role": {
          "type": "string",
          "description": "Role: owner | editor | viewer",
          "enum": [
            "owner",
            "editor",
            "viewer"
          ]
        }
      },
      "required": [
        "product_id",
        "user_id",
        "role"
      ]
    }
  },
  {
    "name": "list_collaborators",
    "description": "List all collaborators and their roles for a product.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "list_product_areas",
    "description": "List all product areas in a product. Product areas are top-level organizational units within a product.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "get_area_graph",
    "description": "Get all entities and edges that belong to a product area. Returns the sub-graph scoped to that area.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "area_id": {
          "type": "string",
          "description": "The product area node ID"
        },
        "depth": {
          "type": "number",
          "description": "How many levels deep to traverse (default 3, max 10)"
        }
      },
      "required": [
        "product_id",
        "area_id"
      ]
    }
  },
  {
    "name": "get_graph_analytics",
    "description": "Computed product thinking metrics: hypothesis velocity, persona coverage ratio, evidence density, stale entity rate, orphan rate.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "register_webhook",
    "description": "Register a webhook called when an event occurs on a product (node.created, node.updated, node.deleted, edge.created, edge.deleted; use '*' for all). Delivered async after commit, HMAC-signed via the optional secret (X-UPG-Signature header), with bounded retry; a persistent 4xx auto-disables the registration.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "event": {
          "type": "string",
          "description": "Event name (e.g. node.created, node.updated, node.deleted, edge.created, edge.deleted)"
        },
        "url": {
          "type": "string",
          "description": "Webhook URL to POST to"
        },
        "secret": {
          "type": "string",
          "description": "Optional shared secret for HMAC signature verification"
        }
      },
      "required": [
        "product_id",
        "event",
        "url"
      ]
    }
  },
  {
    "name": "list_webhooks",
    "description": "List all registered webhooks for a product.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "remove_webhook",
    "description": "Remove a registered webhook by ID.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "webhook_id": {
          "type": "string",
          "description": "Webhook ID to remove"
        }
      },
      "required": [
        "webhook_id"
      ]
    }
  },
  {
    "name": "query",
    "description": "Traverse the graph following typed edges. Returns a subgraph in a single call. Replaces multi-step fetch patterns. Supports edge type filtering (including !negation), field projection, and truncation metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "The product ID"
        },
        "from": {
          "type": "string",
          "description": "Start from all nodes of this type"
        },
        "from_id": {
          "type": "string",
          "description": "Start from a specific node ID"
        },
        "traverse": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Edge types to follow per level. Prefix with ! to exclude."
        },
        "depth": {
          "type": "number",
          "description": "Max depth (default 3, max 10)"
        },
        "include": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Node fields: \"title\", \"status\", \"tags\", \"description\", \"properties\""
        },
        "limit": {
          "type": "number",
          "description": "Max nodes (default 200, max 1000)"
        },
        "edge_include": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Edge fields to return. Empty = no edges."
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "get_tree",
    "description": "Assemble a canonical tree pattern (ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org) from the product graph. Walks the pattern's type-driven child map over the live graph (drift-proof, follows whatever edge wired each parent to a child of the expected type), roots at the pattern anchor with fallback, and reports structural gaps. Returns nested data, not rendered text.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "The product ID"
        },
        "pattern": {
          "type": "string",
          "description": "Tree pattern id: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org"
        },
        "from_id": {
          "type": "string",
          "description": "Explicit root node id. Defaults to the pattern's canonical anchor type."
        },
        "depth": {
          "type": "number",
          "description": "Max levels. Defaults to the pattern's natural depth."
        },
        "include_properties": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Node property keys to inline on each tree node."
        },
        "max_nodes": {
          "type": "number",
          "description": "Cap on assembled nodes. The tree is summarised (stats.truncated) rather than silently cut."
        }
      },
      "required": [
        "product_id",
        "pattern"
      ]
    }
  },
  {
    "name": "get_graph_digest",
    "description": "Pre-computed graph analytics: counts, health metrics, chain completeness, business area coverage, lifecycle balance. ~500 tokens vs ~5-8K for equivalent manual fetches.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "The product ID"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "get_nodes",
    "description": "Batch-fetch multiple entities by ID with edges. More efficient than multiple get_node calls.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "The product ID"
        },
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Node IDs to fetch (max 50)"
        },
        "compact_edges": {
          "type": "boolean",
          "description": "Omit titles from edges"
        }
      },
      "required": [
        "product_id",
        "ids"
      ]
    }
  },
  {
    "name": "get_changes",
    "description": "Get a log of recent changes from the audit log.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "The product ID"
        },
        "since": {
          "type": "string",
          "description": "ISO 8601 timestamp; only return changes after this time"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 50)"
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  // Shared with local (0.30.x). This copy had drifted from local's on the
  // description text and never grew `include_notes`, so cloud clients could not
  // reach content they previously received inline. See GET_ENTITY_SCHEMA_DEF.
  GET_ENTITY_SCHEMA_DEF,
  // Faceted spec-catalog surface (0.19.0). Definitions sourced from the shared
  // `@unified-product-graph/mcp-tooling` module so local + cloud are byte-identical.
  LIST_CATALOG_DEF,
  GET_CATALOG_ENTRY_DEF,
  // ── Spec introspection round 1 ───────────────
  // ── Spec introspection round 2 ─────────────────────────────────
  {
    name: 'get_spec_version',
    description:
      'Return spec-level metadata for adopter compatibility checks: upg_version, markdown_format_version, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational. Pass `changelog: true` to fold in the spec CHANGELOG (a `whats_new` surface); `since` (a version) returns only newer entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        changelog: { type: 'boolean', description: 'When true, include a `changelog` array parsed from the spec CHANGELOG.md.' },
        since: { type: 'string', description: 'With changelog: return only entries strictly newer than this version (e.g. "0.17.0").' },
      },
    },
  },
  // ── Spec introspection round 3 ─────────────────────────────────
  // ── Spec introspection round 5 ─────────
  {
    "name": "move_node",
    "description": "Reparent a node to a new parent within the same product. Removes the existing containment edge (if any) and creates a new one with an inferred type. Runs inside a single Postgres transaction.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "node_id": {
          "type": "string",
          "description": "The node to reparent"
        },
        "new_parent_id": {
          "type": "string",
          "description": "The new parent node ID"
        }
      },
      "required": [
        "product_id",
        "node_id",
        "new_parent_id"
      ]
    }
  },
  {
    "name": "create_area",
    "description": "Create a new product area node (type 'area') in a product. Product areas are top-level organisational units within a product.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "title": {
          "type": "string",
          "description": "Area title"
        },
        "description": {
          "type": "string",
          "description": "Optional description"
        }
      },
      "required": [
        "product_id",
        "title"
      ]
    }
  },
  {
    "name": "get_area_context",
    "description": "Returns a summary of a product area: entity counts by type within it, child area count, and description. Traverses containment edges up to depth 2.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "area_id": {
          "type": "string",
          "description": "The area node ID"
        }
      },
      "required": [
        "product_id",
        "area_id"
      ]
    }
  },
  {
    "name": "list_portfolios",
    "description": "List the product portfolio for this UPG cloud instance. For v1, returns all products as a single portfolio. Use before creating cross-product edges to discover valid product IDs.",
    "inputSchema": { "type": "object", "properties": {} }
  },
  {
    "name": "list_portfolio_cross_edges",
    "description": "List all cross-product edges created by a product. Cross-product edges link entities across different products (e.g. shares_persona, depends_on_product).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" }
      },
      "required": ["product_id"]
    }
  },
  {
    "name": "create_cross_product_edge",
    "description": "Create a cross-product edge linking entities across different products. Type must be one of the canonical UPG cross-edge types: shares_persona, shares_competitor, shares_metric, depends_on_product, cannibalises, succeeds, hosts, contributes_to.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "The product creating this cross-edge" },
        "source": { "type": "string", "description": "Qualified source: {product_id}/{node_id}" },
        "target": { "type": "string", "description": "Qualified target: {product_id}/{node_id}" },
        "type": { "type": "string", "description": "Cross-edge type", "enum": ["shares_persona", "shares_competitor", "shares_metric", "depends_on_product", "cannibalises", "succeeds", "hosts", "contributes_to"] }
      },
      "required": ["product_id", "source", "target", "type"]
    }
  },
  {
    "name": "repair_dangling_edges",
    "description": "Find (and optionally remove) cross-product edges that reference a product that no longer exists. Default is dry_run=true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "dry_run": { "type": "boolean", "description": "Default true: report only." },
        "drop": { "type": "array", "items": { "type": "string" }, "description": "Categories to drop when dry_run=false" }
      },
      "required": ["product_id"]
    }
  },
  {
    "name": "batch_create_nodes",
    "description": "Create up to 50 entities in a single atomic Postgres transaction. For each node with a parent_id, a containment edge is created in the same transaction. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "nodes": {
          "type": "array",
          "description": "Nodes to create (max 50)",
          "items": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "description": "UPG entity type" },
              "title": { "type": "string", "description": "Entity title" },
              "description": { "type": "string", "description": "Optional description" },
              "tags": { "type": "array", "items": { "type": "string" }, "description": "Freeform tags" },
              "status": { "type": "string", "description": "Lifecycle status" },
              "properties": { "type": "object", "description": "Type-specific fields" },
              "parent_id": { "type": "string", "description": "Parent node ID; creates a containment edge automatically" }
            },
            "required": ["type", "title"]
          }
        }
      },
      "required": ["product_id", "nodes"]
    }
  },
  {
    "name": "batch_update_nodes",
    "description": "Update up to 50 entities in a single atomic Postgres transaction. Properties are merged with existing (not replaced). Unspecified fields are preserved. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "nodes": {
          "type": "array",
          "description": "Nodes to update (max 50)",
          "items": {
            "type": "object",
            "properties": {
              "id": { "type": "string", "description": "Node ID to update" },
              "title": { "type": "string" },
              "description": { "type": "string" },
              "tags": { "type": "array", "items": { "type": "string" } },
              "status": { "type": "string" },
              "properties": { "type": "object", "description": "Merged with existing properties" }
            },
            "required": ["id"]
          }
        }
      },
      "required": ["product_id", "nodes"]
    }
  },
  {
    "name": "batch_delete_nodes",
    "description": "Delete up to 50 entities and all their connected edges in a single atomic Postgres transaction. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "node_ids": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Node IDs to delete (max 50)"
        }
      },
      "required": ["product_id", "node_ids"]
    }
  },
  {
    "name": "batch_create_edges",
    "description": "Create up to 50 edges in a single atomic Postgres transaction. Edge type is auto-inferred from source/target types when omitted. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "edges": {
          "type": "array",
          "description": "Edges to create (max 50)",
          "items": {
            "type": "object",
            "properties": {
              "source_id": { "type": "string", "description": "Source node ID" },
              "target_id": { "type": "string", "description": "Target node ID" },
              "type": { "type": "string", "description": "Edge type; auto-inferred if omitted" }
            },
            "required": ["source_id", "target_id"]
          }
        }
      },
      "required": ["product_id", "edges"]
    }
  },
  {
    "name": "batch_delete_edges",
    "description": "Delete up to 50 edges in a single atomic Postgres transaction. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "edge_ids": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Edge IDs to delete (max 50)"
        }
      },
      "required": ["product_id", "edge_ids"]
    }
  },
  {
    "name": "batch_move_nodes",
    "description": "Re-parent up to 50 nodes in a single atomic Postgres transaction. For each move, old containment edges are removed and a new containment edge to new_parent_id is created. All-or-nothing: any failure rolls back the entire batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Product ID" },
        "moves": {
          "type": "array",
          "description": "Move operations (max 50)",
          "items": {
            "type": "object",
            "properties": {
              "node_id": { "type": "string", "description": "The node to re-parent" },
              "new_parent_id": { "type": "string", "description": "The new parent node ID" }
            },
            "required": ["node_id", "new_parent_id"]
          }
        }
      },
      "required": ["product_id", "moves"]
    }
  },
  {
    "name": "validate_graph",
    "description": "Validate a product graph for schema drift. Detects entity type drift (unknown types), edge type drift (unknown edge types), and property drift (missing expected properties, sampled over 500 nodes). Dangling edge checks are enforced by Postgres FK constraints and not re-reported here.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "dry_run": {
          "type": "boolean",
          "description": "Always true for validate_graph (validation is read-only)."
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "deduplicate_nodes",
    "description": "Merge a set of duplicate nodes into a canonical node. Rebinds all edges from duplicates to canonical, removes self-loops and duplicate edges, merges properties (canonical wins on conflicts), then deletes the duplicates inside a single atomic Postgres transaction. Default dry_run: true previews the operation without modifying data.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "canonical_id": {
          "type": "string",
          "description": "The node to keep"
        },
        "duplicate_ids": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Nodes to merge into canonical and delete (max 20)"
        },
        "dry_run": {
          "type": "boolean",
          "description": "Default true: report what would happen without changing anything."
        }
      },
      "required": [
        "product_id",
        "canonical_id",
        "duplicate_ids"
      ]
    }
  },
  {
    "name": "migrate_type",
    "description": "Bulk-retype all nodes of one entity type to another within a product. Catalog-aware: after renaming, re-infers edge types for all edges connected to the migrated nodes. Defaults to dry_run=true; pass dry_run=false to apply.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "from_type": {
          "type": "string",
          "description": "Current entity type to migrate away from"
        },
        "to_type": {
          "type": "string",
          "description": "New entity type. Must be a valid UPG entity type."
        },
        "dry_run": {
          "type": "boolean",
          "description": "Default true: count affected nodes without changing anything."
        }
      },
      "required": [
        "product_id",
        "from_type",
        "to_type"
      ]
    }
  },
  {
    "name": "migrate_cross_edges",
 "description": "Find edges in upg.edges that carry a cross-product edge type and move them to upg.cross_product_edges. Cross-product edge types belong in the cross-product table; this tool corrects data from before the tightening. Defaults to dry_run=true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "description": "Product ID"
        },
        "dry_run": {
          "type": "boolean",
          "description": "Default true: report what would move without moving."
        }
      },
      "required": [
        "product_id"
      ]
    }
  },
  {
    "name": "apply_framework",
    "description": "Apply a framework (MoSCoW, RICE, Kano, ...) to a set of entities in a product: creates a framework_exercise node and an `includes` edge to each entity. The per-entity result is recorded on the edge via score_entity, never on the entity node, so the same entity can sit in many exercises and any entity type can be scored. Returns { exercise_id, exercise, included, warnings }.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "product_id": { "type": "string", "description": "Required. Product the exercise belongs to." },
        "framework_id": { "type": "string", "description": "Required. UPGFramework.id (e.g. \"moscow\", \"rice-scoring\")." },
        "title": { "type": "string", "description": "Human label for the exercise (default \"<Framework> exercise\")." },
        "entity_ids": { "type": "array", "items": { "type": "string" }, "description": "Entities to pull into the exercise (any type)." },
        "status": { "type": "string", "description": "Lifecycle phase: draft | active | archived (default draft)." }
      },
      "required": [
        "product_id",
        "framework_id"
      ]
    }
  },
  {
    "name": "score_entity",
    "description": "Record a framework's result for one entity on the exercise's includes edge (a MoSCoW bucket, a RICE score, a canvas slot). Auto-includes the entity if not already in scope. Merges into existing edge properties unless replace is set. The product is resolved from the exercise node. Returns { edge, warnings }.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "exercise_id": { "type": "string", "description": "Required. The framework_exercise id." },
        "entity_id": { "type": "string", "description": "Required. The entity being scored." },
        "values": { "type": "object", "description": "Required. The result as { input: value }, e.g. { \"moscow\": \"must\" } or { \"reach\": 800, \"impact\": 3 }." },
        "replace": { "type": "boolean", "description": "Replace the edge properties instead of merging (default false)." }
      },
      "required": [
        "exercise_id",
        "entity_id",
        "values"
      ]
    }
  }
]

const HANDLERS: Record<string, ToolBinding<CloudContext>['handler']> = {
  list_products: listProducts,
  create_product: createProduct,
  get_audit_log: getAuditLog,
  get_product_context: getProductContext,
  get_graph_digest: getGraphDigest,
  query,
  get_tree: getTree,
  get_changes: getChanges,
  list_nodes: listNodes,
  export_upg_document: exportUpgDocument,
  get_node: getNode,
  get_nodes: getNodes,
  search_nodes: searchNodes,
  create_node: createNode,
  update_node: updateNode,
  delete_node: deleteNode,
  get_product_graph: getProductGraph,
  create_edge: createEdge,
  delete_edge: deleteEdge,
  export_edges: exportEdges,
  rename_edge_type: renameEdgeType,
  // ── Framework exercises (0.8.6 cloud parity) ────────────────────
  apply_framework: applyFramework,
  score_entity: scoreEntity,
  // ── Templates (0.16.x cloud parity) ─────────────────────────────
  list_catalog: listCatalog,
  get_catalog_entry: getCatalogEntry,
  list_product_areas: listProductAreas,
  get_area_graph: getAreaGraph,
  create_area: createArea,
  get_area_context: getAreaContext,
  move_node: moveNode,
  get_entity_schema: getEntitySchema,
  add_comment: addComment,
  list_comments: listComments,
  grant_access: grantAccess,
  list_collaborators: listCollaborators,
  get_graph_analytics: getGraphAnalytics,
  register_webhook: registerWebhook,
  list_webhooks: listWebhooks,
  remove_webhook: removeWebhook,
  // ── Spec introspection ─────────────────────────────────────────
  get_spec_version: getSpecVersion,
  // ── Spec catalogues (migrations, lifecycles, scales, framework metadata, domain rings) ──
  list_portfolios: listPortfolios,
  list_portfolio_cross_edges: listPortfolioCrossEdges,
  create_cross_product_edge: createCrossProductEdge,
  repair_dangling_edges: repairDanglingEdges,
  batch_create_nodes: batchCreateNodes,
  batch_update_nodes: batchUpdateNodes,
  batch_delete_nodes: batchDeleteNodes,
  batch_create_edges: batchCreateEdges,
  batch_delete_edges: batchDeleteEdges,
  batch_move_nodes: batchMoveNodes,
  validate_graph: validateGraph,
  deduplicate_nodes: deduplicateNodes,
  migrate_type: migrateType,
  migrate_cross_edges: migrateCrossEdges,
}

export function getToolHandler(name: string): ToolBinding<CloudContext>['handler'] | undefined {
  return HANDLERS[name]
}
