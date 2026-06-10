/**
 * Tool registry for the UPG cloud server. Maps each tool name to its
 * wire-level definition and handler. `server.ts` dispatches by name lookup.
 */

import type { ToolBinding, ToolDefinition } from '@unified-product-graph/mcp-tooling'
import type { CloudContext } from './server-context.js'
import { listProducts, createProduct, getAuditLog } from '../tools/products.js'
import { getProductContext, getGraphDigest, query, getChanges } from '../tools/context.js'
import {
  listNodes, getNode, getNodes, searchNodes,
  createNode, updateNode, deleteNode, getProductGraph, moveNode,
  deduplicateNodes, exportUpgDocument,
} from '../tools/nodes.js'
import { createEdge, deleteEdge, exportEdges, renameEdgeType } from '../tools/edges.js'
import { applyFramework, scoreEntity } from '../tools/frameworks.js'
import { listProductAreas, getAreaGraph, createArea, getAreaContext } from '../tools/areas.js'
import { getEntitySchema } from '../tools/schema.js'
import { addComment, listComments, grantAccess, listCollaborators } from '../tools/collaboration.js'
import { getGraphAnalytics } from '../tools/analytics.js'
import { registerWebhook, listWebhooks, removeWebhook } from '../tools/webhooks.js'
import {
  listPlaybooks, getPlaybook,
  listApproaches, getApproach,
  plan, inspect, prioritise, trace, reflect,
  listDomains, getDomainGuide,
  listFrameworks, getFramework,
  listEdgeTypes, getEdgeType,
  listRegions, getRegion, getRegionForEntity,
  getSpecVersion, resolveEdgeForPair, listCrossEdgeTypes,
  listLenses, getLensTool,
  listTypeLabels, getTypeLabel, getValidChildrenTool,
  listEntityTypes, getEntityMeta,
  listAntiPatterns, getAntiPattern,
  listBenchmarks, listProductStages,
  // Spec catalogues (migrations, lifecycles, scales, framework metadata, domain rings)
  listTypeMigrations, listEdgeMigrations, listSplitMigrations,
  listLifecycles, getLifecycle,
  listScales, getScale,
  listFrameworkCategories, listFrameworkStructurePatterns,
  listDomainRings, getDomainRing,
} from '../tools/spec.js'
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
  {
    "name": "get_entity_schema",
    "description": "Returns the schema for a UPG entity type: valid parent→child edges, properties, lifecycle phases.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "The UPG entity type (e.g. \"feature\", \"persona\")"
        }
      },
      "required": [
        "type"
      ]
    }
  },
  // ── Spec introspection round 1 ───────────────
  {
    name: 'list_playbooks',
    description:
      'List the canonical UPG playbooks shipped with @unified-product-graph/core. Each playbook bootstraps a region; its creation_sequence answers "what to create when populating this region". Optional filters: region, canonical_only, framework_id. v0.3.0 ships 23 playbooks across 10 regions (10 canonical plus 13 specialised; 3 carry framework_id: BMC, AARRR, build-measure-learn).',
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
      'Return one canonical UPGPlaybook by id (e.g. "playbook:strategy-outcomes", "playbook:business-gtm-growth"). Includes the ordered creation_sequence with full step kinds and prompts. IDs are namespace-prefixed; calling with an "approach:*" id (or one of the 5 bare-verb approach ids) returns null; route via get_approach for the approach catalog.',
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
      'List the 5 canonical UPGApproach records: Plan / Inspect / Prioritise / Trace / Reflect. An approach is the *path of arrival* to a region of the graph (cartographic sense: final approach to an airport, coastline approach), distinct from the strategy-meeting sense. Each record carries id, label, description (with cartographic framing), question_answered, signature_hint, framework_id_examples. Optional filter: framework_id (narrows to approaches whose framework_id_examples include the given id).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        framework_id: { type: 'string', description: 'Exact-match framework id; narrows to approaches whose framework_id_examples include it (discoverability surface; full reverse lookup is on UPGFramework.approach_ids).' },
      },
    },
  },
  {
    name: 'get_approach',
    description:
      'Return one canonical UPGApproach by id. Valid ids are the bare verbs: plan, inspect, prioritise, trace, reflect. Same names as the verb-led MCP tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Approach id, one of: plan, inspect, prioritise, trace, reflect.', enum: ['plan', 'inspect', 'prioritise', 'trace', 'reflect'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'plan',
    description:
      'Plan approach: the path of arrival to "what should I build next?". v0.3.0 ships as a definition lookup: returns the Plan approach record plus invocation params wrapped in the family-resemblance envelope { approach_id, scope, generated_at, approach, params }. The LLM consumes the signature_hint and synthesises { missing_entities, coverage_score } against the live graph. Structured execution lands in v0.3.x. Optional region narrows the scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: { type: 'string', description: 'Optional UPGRegionId; narrows planning scope to a single region (e.g. "users_needs", "business_gtm_growth"). Omit for whole-graph planning.' },
      },
    },
  },
  {
    name: 'inspect',
    description:
      'Inspect approach: the path of arrival to "what\'s broken?". v0.3.0 ships as a definition lookup: returns the Inspect approach record plus invocation params wrapped in the family-resemblance envelope. The LLM consumes the signature_hint and emits { violations: [{ severity, kind, entity_id, description, fix_hint }] } against UPG_ANTI_PATTERNS plus the live graph. Structured execution lands in v0.3.x. Optional region OR optional entities[] scope the audit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: { type: 'string', description: 'Optional UPGRegionId; narrows inspection scope to a single region.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Optional entity_id[]; narrows inspection scope to a specific candidate set. Mutually composable with region.' },
      },
    },
  },
  {
    name: 'prioritise',
    description:
      'Prioritise approach: the path of arrival to "what\'s most important?". v0.3.0 ships as a definition lookup: returns the Prioritise approach record plus invocation params plus framework metadata wrapped in the family-resemblance envelope. Both candidates and framework_id are required. The LLM looks up the framework via get_framework, reads the scoring spec, and emits { ranked: [{ entity_id, score, rationale }], framework_used }. Structured execution lands in v0.3.x.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        candidates: { type: 'array', items: { type: 'string' }, description: 'Required: entity_id[] to rank.' },
        framework_id: { type: 'string', description: 'Required: UPGFramework.id of the scoring lens (e.g. "rice-scoring", "ice-scoring", "kano-model", "cost-of-delay", "wsjf").' },
      },
      required: ['candidates', 'framework_id'],
    },
  },
  {
    name: 'trace',
    description:
      'Trace approach: the path of arrival to "walk a meaningful path through existing graph". v0.3.0 ships as a definition lookup: returns the Trace approach record plus invocation params wrapped in the family-resemblance envelope. The LLM uses anchor plus path to compose query() calls and emits { trail: [{ depth, entity_id, edge_type_in }], reached: entity_id[] }. Path is type-shorthand: ["persona","job","feature"] walks persona→job→feature using the canonical edge per pair. Optional edges_override selects non-canonical edges per hop; element null means "use canonical".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        anchor: { type: 'string', description: 'Required: entity_id where the traversal starts.' },
        path: { type: 'array', items: { type: 'string' }, description: 'Required: UPGEntityType[] type-shorthand path. Each step walks via the canonical edge for the source→target pair.' },
        edges_override: { type: 'array', items: { type: ['string', 'null'] }, description: 'Optional per-hop edge override array. Length must match path length; element null means "use canonical edge for this pair".' },
      },
      required: ['anchor', 'path'],
    },
  },
  {
    name: 'reflect',
    description:
      'Reflect approach: the path of arrival to "what should I be questioning?". v0.3.0 ships as a definition lookup: returns the Reflect approach record plus invocation params wrapped in the family-resemblance envelope. The LLM consumes mode plus scope plus signature_hint and emits { prompts: [{ kind, question, target_entities? }] }. Optional mode is one of the 4 canonical nouns: assumptions / alternatives / blind-spots / load-bearing. Absence of mode signals open reflection. Optional scope accepts a region id, entity id, or null for whole-graph reflection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: ['string', 'null'], description: 'Optional: region id, entity id, or null for whole-graph.' },
        mode: { type: 'string', description: 'Optional: one of assumptions, alternatives, blind-spots, load-bearing. Omit for open reflection.', enum: ['assumptions', 'alternatives', 'blind-spots', 'load-bearing'] },
      },
    },
  },
  {
    name: 'list_domains',
    description:
      'List domains. Default (with_guide_only: true) returns every domain that has a canonical usage guide: id, anchor_entity, and creation_sequence per domain. Pass with_guide_only: false to enumerate every atomic domain from UPG_DOMAINS (~36 at v0.3.0); each row carries id, label, description, types, has_guide. The two shapes share one tool surface, disjoint by the boolean.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        with_guide_only: {
          type: 'boolean',
          description:
            'Default true: return only domains with a canonical usage guide (compact id, anchor_entity, creation_sequence). Pass false to return every atomic domain (id, label, description, types, has_guide).',
        },
      },
    },
  },
  {
    name: 'get_domain_guide',
    description:
      'Return the full UPGDomainUsageGuide for a domain: anchor entity, creation sequence, named patterns (entity and edge chains), required cross-domain bridges, and anti-patterns.',
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
      'List the canonical UPGFramework definitions: the curated, famous product frameworks that anchor the public catalog. Paginated (default limit 50, max 200) to avoid transport overflow. Cursor is opaque; pass next_cursor from a previous response to advance. Optional category filter is exact-match against UPGFramework.category and applied before pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Exact-match filter on UPGFramework.category (e.g. "strategy", "prioritization").' },
        limit: { type: 'number', description: 'Page size (default 50, max 200).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor; pass next_cursor from a previous response.' },
      },
    },
  },
  {
    name: 'get_framework',
    description:
      'Return one canonical UPGFramework by id (e.g. "rice-scoring", "lean-canvas"). Includes all four layers: data, structure, presentation, education.',
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
      'List every canonical edge type from UPG_EDGE_CATALOG, optionally narrowed by source_type and/or target_type. Each entry carries the edge key (type), forward/reverse verbs, classification, and endpoint types. The polymorphic wildcard "node" is preserved on registered polymorphic edges.',
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
      'Return one canonical edge catalogue entry by edge type key (e.g. "persona_pursues_job", "feature_addresses_need").',
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
      'List the 10 canonical UPG super-domain regions from UPG_REGIONS: pure graph topology (entities, anchors, intra/boundary edges, shape archetype). Returns a compact summary per region (id, label, order, shape, mental_model, anchor_type, composes_atomic_domains, entity_count, intra_edge_count, boundary_edge_count). Fixed list, non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_region',
    description:
      'Return the full UPGRegion record by id: anchor entity (with rationale and inbound/outbound cross-edge counts), entity memberships with structural roles, intra-domain edge keys, boundary edges to other regions, shape archetype, and the atomic-domain composition.',
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
      'Resolve which super-domain region contains a given entity type. Wraps getRegionForEntityType. Returns the full UPGRegion record. Useful for adapters and copilots that need to route or render an entity based on its super-domain.',
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
      'Return spec-level metadata for adopter compatibility checks: upg_version, markdown_format_version, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'resolve_edge_for_pair',
    description:
      'Resolve the canonical UPGEdgeType for a source_type → target_type containment pair. Wraps resolveContainmentEdge / UPG_EDGE_PAIR_MAP. Adapter-critical: every import adapter (Markdown, Notion, Linear, GitHub) uses this to look up the right "_contains_" edge before falling back to a polymorphic edge or skipping. Returns { edge_type: null } when the pair is not catalogued.',
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
      'List the canonical cross-product edge types from UPG_CROSS_EDGE_TYPES (shares_persona, shares_competitor, shares_metric, depends_on_product, cannibalises, succeeds, hosts, contributes_to, instance_of, area_serves_persona, area_targets_market_segment, rolls_up_to). Portfolio-level relationships between entities in different products, separate from the within-product UPG_EDGE_CATALOG. instance_of and the area edges (area_serves_persona / area_targets_market_segment) are created via the registry/portfolio tooling in the local MCP server; rolls_up_to (a product metric feeding a company metric) via create_cross_product_edge.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_lenses',
    description:
      'List every canonical UPGLens shipped with @unified-product-graph/core: Product, Design, Engineering, Growth, Business, Research, Marketing, Full. Returns a compact summary per lens (id, name, description, icon, audience, perspective, framework_id, playbook_id, visible_domain_count, intelligence_prompt_count). Drill into get_lens for the full record.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_lens',
    description:
      'Return the full UPGLens record by id (e.g. "product", "ux_design", "engineering", "full") plus the resolved list of entity types visible through that lens. Combines the lens record with visible_types in one response, saving the common "fetch lens, then resolve types" round-trip.',
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
      'List canonical UPGTypeLabel entries: every entity type\'s display label, alt-labels (synonyms), per-framework labels, and (where applicable) designation labels. Paginated (default limit 100, max 500). Cursor is opaque base64 (offset:N) following the list_frameworks convention. External MCP apps need labels for rendering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Page size (default 100, max 500).' },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor; pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_type_label',
    description:
      'Return one canonical UPGTypeLabel by entity type, plus a resolved display label for an optional framework_id and/or designation (wraps resolveLabel). Lookup is exact-match against UPG_TYPE_LABELS_MAP.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Canonical entity type id.' },
        framework_id: {
          type: 'string',
          description: 'Optional framework id (e.g. "lean_canvas", "ost", "design_thinking"); when set, resolved_label uses the framework-specific label.',
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
      'Return the list of valid direct-child entity types for a parent type. Wraps getValidChildren / UPG_VALID_CHILDREN. Returns an empty array when the parent has no registered children. Pairs with get_entity_schema; the natural tool name for "what can I create under this?".',
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
      'List canonical entity types from UPG_ENTITY_META, the source of truth for ontology evolution (every active, deprecated, or removed type with its immutable type_id, maturity tier, and version metadata). Paginated (default limit 50, max 200). Filters AND together and apply before pagination: domain (atomic-domain id), maturity ("draft" | "proposed" | "stable" | "deprecated" | "removed"), deprecated (boolean shortcut). Each row carries the full EntityTypeMeta plus resolved domain_id (null if no atomic-domain mapping).',
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
          description: 'Opaque pagination cursor; pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_entity_meta',
    description:
      'Return one canonical EntityTypeMeta record by entity type name, plus the resolved domain_id (or null if the type has no atomic-domain mapping). Pairs with list_entity_types; drill into a single type\'s lifecycle metadata (maturity tier, since-version, replacement target if deprecated). Pass the canonical name (e.g. "persona", "pain_point"), not the immutable type_id.',
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
      'List the curated cross-domain anti-patterns from UPG_ANTI_PATTERNS. Each row pairs a memorable name with a machine-evaluable IntelligenceCondition, the stages where it can fire, severity, and remediation. Graph-health patterns evaluated against the whole graph, distinct from per-domain anti-patterns surfaced via get_domain_guide. Paginated (default limit 50, max 200). Filters AND together: severity ("high" | "medium" | "low"), stage (UPGProductStage, keeps patterns whose stages[] includes it).',
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
          description: 'Opaque pagination cursor; pass next_cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_anti_pattern',
    description:
      'Return one curated anti-pattern by id (kebab-case slug, e.g. "features-without-hypotheses", "personas-without-jobs"). Includes the full body: structured condition, why-it-matters, remediation, applicable stages, severity, and optional source citation. IDs are stable URL fragments and remain frozen once published.',
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
      'Return one of the four canonical benchmark catalogs, the data behind get_graph_digest health logic. The kind parameter is REQUIRED and routes to the matching source: "count" → UPG_COUNT_BENCHMARKS (per-entity-type ranges across the 9-stage journey); "relationship" → UPG_RELATIONSHIP_BENCHMARKS (parent → child minimum counts per stage); "ratio" → UPG_RATIO_BENCHMARKS (expected ratios between entity-type counts); "domain_activation" → UPG_DOMAIN_ACTIVATION (when each atomic domain is expected to turn on). Optional filters AND together: stage (UPGProductStage), domain (atomic-domain id). Non-paginated (each catalog is small).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['count', 'relationship', 'ratio', 'domain_activation'],
          description: 'Required: which benchmark catalog to return.',
        },
        stage: {
          type: 'string',
          enum: [
            'concept', 'validation', 'build', 'beta', 'launch',
            'growth', 'mature', 'maintenance', 'sunset',
          ],
          description: 'Optional UPGProductStage filter. Semantics depend on kind; see tool description.',
        },
        domain: {
          type: 'string',
          description: 'Optional atomic-domain id filter. Semantics depend on kind; see tool description.',
        },
      },
      required: ['kind'],
    },
  },
  {
    name: 'list_product_stages',
    description:
      'Return the canonical 9-stage product journey from UPG_PRODUCT_STAGES: the closed enum used by create_product, get_graph_digest health logic, benchmark stage scoping, and anti-pattern stage filters. Order is canonical: earliest → latest (concept, validation, build, beta, launch, growth, mature, maintenance, sunset). Trivial enum surface, no filters, no pagination.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // ── Spec introspection round 5 ─────────
  {
    name: 'list_type_migrations',
    description:
      'List every type-rename migration from UPG_MIGRATIONS: the version-scoped registry of deprecated from → canonical to renames (e.g. pain_point → need, hypothesis → hypothesis_claim). Each row carries { from, to, since } where since is the spec version that introduced the migration. Optional from_type filter exact-matches on the from field.',
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
      'List every edge-key migration from UPG_EDGE_MIGRATIONS: renamed or dropped canonical edge type keys (e.g. persona_has_jtbd → persona_pursues_job). Each row carries { kind, from, to?, since }. kind is "rename" or "drop". Optional from_edge filter exact-matches on the from field.',
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
      'List every 1→N split migration from UPG_SPLIT_MIGRATIONS: "one type became multiple types" rules (e.g. experiment → experiment_plan + experiment_run; hypothesis → hypothesis_claim + hypothesis_evidence). Each row includes the full UPGSplitMigration record plus since. Non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_lifecycles',
    description:
      'List lifecycle definitions from UPG_LIFECYCLES. Response includes free_types (UPG_LIFECYCLE_FREE_TYPES: static types with no phase progression) and planned_types (UPG_LIFECYCLE_PLANNED_TYPES: lifecycle planned but not yet authored). Filters: entity_type (exact-match); lifecycle_only (when true, omits free/planned lists).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Exact-match entity type name (e.g. "feature", "hypothesis_claim"). Returns at most one lifecycle.' },
        lifecycle_only: { type: 'boolean', description: 'When true, omit free_types and planned_types from response.' },
      },
    },
  },
  {
    name: 'get_lifecycle',
    description:
      'Return the full UPGLifecycle definition for one entity type: initial phase, terminal phases, and the ordered array of phases with transitions and core states. Returns a descriptive message (not an error) when the type has no lifecycle defined.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', description: 'Canonical entity type name (e.g. "feature", "hypothesis_claim", "opportunity").' },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'list_scales',
    description:
      'List every spec-defined assessment scale from UPG_SCALES: the canonical vocabulary for UPGAssessment values. Each scale carries id, label, description, min, max, steps, and per-point labels plus descriptions. Non-paginated. External scale_extensions are graph-instance–scoped and stay out of this surface.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_scale',
    description:
      'Return one spec-defined assessment scale by id (e.g. "reach_5", "severity_5", "confidence_binary"). Includes the full point array.',
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
      'List all valid framework category values from UPG_FRAMEWORK_CATEGORIES (e.g. "strategy", "prioritization", "discovery", "growth", "engineering"). Use as valid values for the category filter on list_frameworks / get_framework.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_framework_structure_patterns',
    description:
      'List all valid framework structure pattern values from UPG_STRUCTURE_PATTERNS: the visual topological shapes (tree, table, matrix, funnel, collection, quadrant, flow). Mirrors UPGFramework.structure.pattern.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_domain_rings',
    description:
      'List every UPGDomainRing from UPG_DOMAIN_RINGS in canonical order (Nucleus → Understand → Define → Build → Grow → Operate → Extend). Rings are the 7 concentric groupings of the 36 UPG atomic domains. Each ring carries { id, label, description, domain_ids }. Non-paginated.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_domain_ring',
    description:
      'Return one UPGDomainRing by id (e.g. "nucleus", "understand", "define", "build", "grow", "operate", "extend").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Ring id, one of: nucleus, understand, define, build, grow, operate, extend.' },
      },
      required: ['id'],
    },
  },
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
  list_playbooks: listPlaybooks,
  get_playbook: getPlaybook,
  list_approaches: listApproaches,
  get_approach: getApproach,
  plan,
  inspect,
  prioritise,
  trace,
  reflect,
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
  // ── Spec catalogues (migrations, lifecycles, scales, framework metadata, domain rings) ──
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
