# UPG MCP Cloud Server Tool Reference

Reference for the 93 tools exposed by `@unified-product-graph/cloud-server`. Generated from JSDoc on `src/tools/*.ts`; do not edit by hand.

## Contents

- [Products & Audit](#products-audit): 3 tools
- [Context & Traversal](#context-traversal): 4 tools
- [Nodes](#nodes): 11 tools
- [Edges](#edges): 4 tools
- [Framework Exercises](#framework-exercises): 2 tools
- [Areas](#areas): 4 tools
- [Schema](#schema): 1 tool
- [Collaboration](#collaboration): 4 tools
- [Analytics](#analytics): 1 tool
- [Webhooks](#webhooks): 3 tools
- [Spec Introspection](#spec-introspection): 43 tools
- [Portfolio](#portfolio): 4 tools
- [Atomic Batches](#atomic-batches): 6 tools
- [Validation](#validation): 1 tool
- [Migrations](#migrations): 2 tools

## Products & Audit

_Multi-tenant primitives: list, create, audit log._

- [`create_product`](#create-product)
- [`get_audit_log`](#get-audit-log)
- [`list_products`](#list-products)

### `create_product`

Create a new product graph.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | Optional description |
| `stage` | string |  | idea \| mvp \| growth \| scale |
| `title` | string | ✓ | Product name |

**Returns:**

JSON: `{ product: { id, title, description?, stage? } }`.

**Throws:**

- textError when `title` is missing.

**Warnings (non-error surfaces):**

- Billing-relevant: product count typically drives plan tier;
creation may trigger a tier upgrade or hit the plan's product cap.

**See also:** `list_products`, `grant_access`, `list_product_stages`


### `get_audit_log`

Get recent changes (audit log) for a product.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `limit` | number |  | Max entries (default 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ entries: Array<{ ...mutation }> }`.

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Retention-windowed: entries beyond the plan-tier retention period
are pruned. An empty window may mean "out of retention", not "no activity".

**See also:** `get_graph_analytics`, `get_graph_digest`, `list_products`


### `list_products`

List all products in this UPG cloud instance.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ products: Array<{ id, title, description?, stage? }> }`.

**Warnings (non-error surfaces):**

- RLS-bounded; an empty list can mean "no products" or "no access".
Pair with `list_collaborators` to confirm scope on a specific product.

**See also:** `create_product`, `get_product_context`, `get_graph_digest`, `list_collaborators`


## Context & Traversal

_Product summary, digest, BFS traversal, change feed._

- [`get_changes`](#get-changes)
- [`get_graph_digest`](#get-graph-digest)
- [`get_product_context`](#get-product-context)
- [`query`](#query)

### `get_changes`

Get a log of recent changes from the audit log.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `limit` | number |  | Max results (default 50) |
| `product_id` | string | ✓ | The product ID |
| `since` | string |  | ISO 8601 timestamp; only return changes after this time |

**Returns:**

JSON: `{ changes: AuditEntry[], total }`.

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Backed by the audit log: entries beyond the plan-tier
retention window are pruned and stay out of this surface. The `since`
filter runs in-memory after the store fetches up to `limit` entries,
so narrow `since` windows on busy products may surface fewer rows
than expected (raise `limit` to compensate).

**See also:** `get_audit_log`, `get_graph_digest`, `get_product_context`


### `get_graph_digest`

Pre-computed graph analytics: counts, health metrics, chain completeness, business area coverage, lifecycle balance. ~500 tokens vs ~5-8K for equivalent manual fetches.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | The product ID |

**Returns:**

JSON with `product`, `counts`, `health`, `chains`, `coverage`,
`lifecycle` keys (~500 tokens of summary). Note: chain keys still use the
v0.1 names (`persona_with_jtbd` etc.) pending a canonical rename.

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Chain keys carry v0.1 names (`persona_with_jtbd`,
`hypothesis_total`) pending a canonical rename. Lifecycle bucketing
uses local heuristics (`BUSINESS_AREAS` / `LIFECYCLE_PHASES`
constants in this file) rather than the canonical `UPG_DOMAINS` ring,
so it may drift from spec across versions.

**See also:** `get_product_context`, `get_graph_analytics`, `list_benchmarks`, `validate_graph`


### `get_product_context`

Returns the product summary, entity counts by type, and a human-readable overview of the graph. Use this first to understand what is in the graph.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

Text: `## <product title>` followed by description/stage,
graph stats (node/edge/type counts), and a sorted breakdown of entities
per type. Errors with `Product not found: <id>` for unknown products.

**Throws:**

- textError when `product_id` is missing or the product
is not visible to the caller.

**See also:** `get_graph_digest`, `get_graph_analytics`, `get_entity_schema`, `list_nodes`


### `query`

Traverse the graph following typed edges. Returns a subgraph in a single call. Replaces multi-step fetch patterns. Supports edge type filtering (including !negation), field projection, and truncation metadata.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `depth` | number |  | Max depth (default 3, max 10) |
| `edge_include` | array |  | Edge fields to return. Empty = no edges. |
| `from` | string |  | Start from all nodes of this type |
| `from_id` | string |  | Start from a specific node ID |
| `include` | array |  | Node fields: "title", "status", "tags", "description", "properties" |
| `limit` | number |  | Max nodes (default 200, max 1000) |
| `product_id` | string | ✓ | The product ID |
| `traverse` | array |  | Edge types to follow per level. Prefix with ! to exclude. |

**Returns:**

JSON: `{ nodes, edges, total_nodes, total_edges,
truncated?, truncated_at_depth?, hint? }`. Truncates with a hint when
`limit` is reached.

**Throws:**

- textError when `product_id` is missing, or when
neither `from` nor `from_id` is provided, or when `from_id` does not
resolve.

**Warnings (non-error surfaces):**

- Pre-loads the entire product graph into memory before
filtering; for products beyond ~10K nodes this can be heavy. Use
`from_id` plus a tight `depth` for narrow slices, and pair with
`include` / `edge_include` to trim wire payload. Truncation is silent
beyond `limit`, so check `truncated` before assuming the result is
complete.

**See also:** `list_nodes`, `get_node`, `get_area_graph`, `search_nodes`, `resolve_edge_for_pair`, `trace`


## Nodes

_Entity CRUD scoped to a product._

- [`create_node`](#create-node)
- [`deduplicate_nodes`](#deduplicate-nodes)
- [`delete_node`](#delete-node)
- [`export_upg_document`](#export-upg-document)
- [`get_node`](#get-node)
- [`get_nodes`](#get-nodes)
- [`get_product_graph`](#get-product-graph)
- [`list_nodes`](#list-nodes)
- [`move_node`](#move-node)
- [`search_nodes`](#search-nodes)
- [`update_node`](#update-node)

### `create_node`

Create a new entity in the graph. Optionally connect it to a parent node.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | Optional description |
| `parent_id` | string |  | Parent node ID; creates an edge automatically |
| `product_id` | string | ✓ | Product ID |
| `properties` | object |  | Type-specific fields |
| `status` | string |  | Lifecycle status |
| `tags` | array |  | Freeform tags |
| `title` | string | ✓ | Entity title |
| `type` | string | ✓ | UPG entity type (e.g. "persona", "opportunity") |

**Returns:**

JSON: `{ node, edge?, warning? }`. `edge` is null when no
`parent_id` is passed; `warning` is present on lifecycle/parent issues.

**Throws:**

- textError when `product_id`, `type`, or `title` is
missing.

**Warnings (non-error surfaces):**

- Pass `parent_id` to auto-create a containment edge with inferred
type; missing parents are reported via `warning` rather than failing
the create.

**See also:** `batch_create_nodes`, `update_node`, `get_entity_schema`, `list_entity_types`, `get_valid_children`


### `deduplicate_nodes`

Merge a set of duplicate nodes into a canonical node. Rebinds all edges from duplicates to canonical, removes self-loops and duplicate edges, merges properties (canonical wins on conflicts), then deletes the duplicates inside a single atomic Postgres transaction. Default dry_run: true previews the operation without modifying data.

**Atomicity:** `atomic-with-rollback (all mutations committed or rolled back
together).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `canonical_id` | string | ✓ | The node to keep |
| `dry_run` | boolean |  | Default true: report what would happen without changing anything. |
| `duplicate_ids` | array | ✓ | Nodes to merge into canonical and delete (max 20) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

With `dry_run: true` (default): `{ canonical_id, duplicate_ids,
edges_to_rebind, nodes_to_delete, dry_run }`. With `dry_run: false`:
`{ canonical_id, merged_ids, rebound_edges, removed_self_loops,
removed_duplicate_edges, dry_run }`.

**Throws:**

- textError when `product_id`, `canonical_id`, or
`duplicate_ids` are missing, when the arrays exceed limits, when
`canonical_id` appears in `duplicate_ids`, or when any node does not
exist / does not belong to the product.

**Warnings (non-error surfaces):**

- Default `dry_run: true`; pass `dry_run: false` to commit. The
merge is permanent: duplicates are deleted, their edges rebound to
the canonical, self-loops removed, and duplicate edges deduplicated.
The change stands once committed (no undo); the audit log records
each merge for the retention window.

**See also:** `search_nodes`, `get_nodes`, `delete_node`, `validate_graph`


### `delete_node`

Remove an entity and all its connected edges from the graph.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `node_id` | string | ✓ | The node ID to delete |

**Returns:**

JSON: `{ deleted_node_id, deleted_node_title, deleted_edge_ids }`.
Errors propagate from the store (e.g. unknown id).

**Throws:**

- textError when `node_id` is missing or the store
rejects the deletion.

**Warnings (non-error surfaces):**

- Cascade-deletes ALL incident edges, including cross-product
edges where the node is an endpoint. The operation is permanent (no
soft-delete or undo); the audit log records the removal. Pair with
`get_node` first if you need a snapshot.

**See also:** `batch_delete_nodes`, `get_node`, `deduplicate_nodes`


### `export_upg_document`

Export the full product graph as a UPG document: product metadata, all nodes, and all edges. Used by the upg pull CLI and apply_pull_changeset for sync/backup. Supports cursor pagination for large products (1000+ nodes): default limit 1000, max 10000. Pass next_cursor from a previous response as cursor to advance. Edges are returned in full on every page.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response to advance. |
| `limit` | number |  | Max nodes per page (default 1000, max 10000) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ product, nodes, edges, total_nodes, limit, next_cursor? }`.
`next_cursor` is present when more node pages remain.

**Throws:**

- textError when `product_id` is missing or the product is
not visible to the caller.

**Warnings (non-error surfaces):**

- For very large products (10 000+ nodes) iterate via `cursor`
plus `next_cursor` rather than relying on a single call. Every page
returns the full edge set, so deduplicate on the client when
assembling multiple pages.

**See also:** `apply_pull_changeset`, `get_product_graph`, `list_nodes`


### `get_node`

Get a single entity by ID with its full properties and all connected edges.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `node_id` | string | ✓ | The node ID |

**Returns:**

JSON: `{ node, edges_out, edges_in }`. Errors with
`Node not found: <id>` for unknown ids.

**Throws:**

- textError when `node_id` is missing or the node does
not exist (or the caller has no access; RLS shares the same shape for
both).

**See also:** `list_nodes`, `get_nodes`, `search_nodes`, `query`


### `get_nodes`

Batch-fetch multiple entities by ID with edges. More efficient than multiple get_node calls.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `compact_edges` | boolean |  | Omit titles from edges |
| `ids` | array | ✓ | Node IDs to fetch (max 50) |
| `product_id` | string | ✓ | The product ID |

**Returns:**

JSON: `{ nodes, total, not_found? }`. `not_found` lists any
requested ids that did not resolve and appears only when at least one
miss occurred.

**Throws:**

- textError when `product_id` or `ids` is missing/empty,
or when `ids` exceeds 50.

**Warnings (non-error surfaces):**

- `not_found` shares the same shape for "node doesn't exist" and
"node exists but caller lacks access" (RLS treats them alike). Pass
`compact_edges: true` to drop neighbour-title hydration on edge-heavy
nodes (~30% smaller wire payload).

**See also:** `get_node`, `list_nodes`, `query`


### `get_product_graph`

Export the full graph for a product (all nodes + edges).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ product, nodes, edges }`.

**Throws:**

- textError when `product_id` is missing or the product
is not visible to the caller.

**Warnings (non-error surfaces):**

- Returns the **entire** graph in one payload; for products
with thousands of nodes/edges this can be tens of MB. Prefer `query`
with a depth limit plus `include` projection for slices, or
`list_nodes` plus cursor pagination for full enumeration without the
wire-size hit.

**See also:** `query`, `list_nodes`, `get_graph_digest`, `get_graph_analytics`


### `list_nodes`

List entities in the graph, optionally filtered by type. Supports cursor pagination for large products (1000+ nodes). Default limit 1000, max 10000. Pass next_cursor from a previous response as cursor to advance to the next page. Returns next_cursor in the response when more results remain. Legacy offset param still accepted when cursor is absent.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response to advance. |
| `limit` | number |  | Max results (default 1000, max 10000) |
| `offset` | number |  | Legacy: skip N results (default 0). Use cursor instead for new callers. |
| `product_id` | string | ✓ | Product ID |
| `type` | string |  | Filter by entity type |

**Returns:**

JSON: `{ nodes, total, limit, next_cursor? }`. `next_cursor` is
present when more results remain. `total` reflects the filtered count
before pagination.

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- RLS-bounded: only nodes in products the caller has read access
to are returned. An empty list can mean "no nodes" or "no access".
Default `limit: 1000`, max 10000. For products with 1000+ nodes use
`cursor` pagination: keep calling with the returned `next_cursor` until
it is absent.

**See also:** `get_node`, `get_nodes`, `search_nodes`, `query`


### `move_node`

Reparent a node to a new parent within the same product. Removes the existing containment edge (if any) and creates a new one with an inferred type. Runs inside a single Postgres transaction.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `new_parent_id` | string | ✓ | The new parent node ID |
| `node_id` | string | ✓ | The node to reparent |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ node_id, old_parent_id, new_parent_id, edge_created }`.
`old_parent_id` is `null` when the node had no prior containment edge.

**Throws:**

- textError when either node is missing, the nodes belong
to different products (cross-product reparenting is not allowed), or
the caller tries to move a node onto itself.

**See also:** `batch_move_nodes`, `resolve_edge_for_pair`, `get_valid_children`


### `search_nodes`

Full-text search across node titles and descriptions. Title matches rank higher.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `limit` | number |  | Max results (default 20) |
| `product_id` | string | ✓ | Product ID |
| `query` | string | ✓ | Search text |
| `type` | string |  | Optional type filter |

**Returns:**

JSON: `{ results: Array<node & { match_field }>, total }`.

**Throws:**

- textError when `product_id` or `query` is missing.

**Warnings (non-error surfaces):**

- RLS-bounded: only nodes in products the caller has read
access to participate. Substring match is case-insensitive and runs
in-memory after a full product fetch; for very large products this
can be heavy. A Postgres-side full-text index is a future optimisation.

**See also:** `list_nodes`, `get_node`, `query`


### `update_node`

Update an existing entity. Unspecified fields are preserved.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  |  |
| `node_id` | string | ✓ | The node ID to update |
| `properties` | object |  | Merged with existing properties |
| `status` | string |  |  |
| `tags` | array |  |  |
| `title` | string |  |  |

**Returns:**

JSON: `{ node: updatedNode, warning? }`. Errors propagate from
the store (e.g. unknown node id).

**Throws:**

- textError when `node_id` is missing or the store
rejects the update (unknown id).

**Warnings (non-error surfaces):**

- Lifecycle-aware: invalid status values produce a `warning` but
the update still applies. For type changes, use `migrate_type`
instead; direct type mutation via this tool is unsupported.

**See also:** `migrate_type`, `batch_update_nodes`, `get_lifecycle`


## Edges

_Edge create and delete._

- [`create_edge`](#create-edge)
- [`delete_edge`](#delete-edge)
- [`export_edges`](#export-edges)
- [`rename_edge_type`](#rename-edge-type)

### `create_edge`

Create a relationship between two nodes. Edge type is auto-inferred if omitted.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_id` | string | ✓ | Source node ID |
| `target_id` | string | ✓ | Target node ID |
| `type` | string |  | Edge type; auto-inferred if omitted |

**Returns:**

JSON: `{ edge: { id, source, target, type }, warning? }`.

**Throws:**

- textError when `source_id`/`target_id` is missing, an endpoint
lookup fails, source and target resolve to the same node, an explicit
`type` violates the catalog's source/target pair, or no canonical edge
exists for the pair and no `type` was supplied (enriched with resolver
hints).

**See also:** `resolve_edge_for_pair`, `list_edge_types`, `get_edge_type`, `batch_create_edges`


### `delete_edge`

Remove a relationship between two nodes.

**Atomicity:** `atomic-with-rollback`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_id` | string | ✓ | The edge ID to delete |

**Returns:**

JSON: `{ deleted_edge_id }`.

**Throws:**

- textError when `edge_id` is missing or unknown.

**See also:** `batch_delete_edges`, `export_edges`


### `export_edges`

Flat enumeration of all edges for a product, optionally filtered by type. Returns lightweight { id, source, target, type } rows ordered by id, intended for migration passes.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |
| `types` | array |  | Optional edge type filter |

**Returns:**

JSON: `{ edges: [{ id, source, target, type }], total: number }`.

**Throws:**

- textError when `product_id` is missing or the store rejects the read.

**See also:** `list_edge_types`, `rename_edge_type`, `query`


### `rename_edge_type`

Rename all edges of one type to another across a product. dry_run (default: true) previews the count.

**Atomicity:** `atomic-with-rollback (write path)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | If true, only count (default: true); pass false to apply. |
| `from` | string | ✓ | Current edge type |
| `product_id` | string | ✓ | Product ID |
| `to` | string | ✓ | New edge type |

**Returns:**

JSON: `{ from, to, affected: number, dry_run: boolean }`.

**Throws:**

- textError when `product_id`, `from`, or `to` is missing.

**See also:** `list_edge_types`, `get_edge_type`, `export_edges`, `migrate_type`


## Framework Exercises

_Apply a framework over entities; record per-entity results on the includes edge._

- [`apply_framework`](#apply-framework)
- [`score_entity`](#score-entity)

### `apply_framework`

Apply a framework (MoSCoW, RICE, Kano, ...) to a set of entities in a product: creates a framework_exercise node and an `includes` edge to each entity. The per-entity result is recorded on the edge via score_entity, never on the entity node, so the same entity can sit in many exercises and any entity type can be scored. Returns { exercise_id, exercise, included, warnings }.

**Atomicity:** `per-write atomic; the exercise node and each includes edge commit
independently (a target that cannot be included is reported in `warnings`).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_ids` | array |  | Entities to pull into the exercise (any type). |
| `framework_id` | string | ✓ | Required. UPGFramework.id (e.g. "moscow", "rice-scoring"). |
| `product_id` | string | ✓ | Required. Product the exercise belongs to. |
| `status` | string |  | Lifecycle phase: draft \| active \| archived (default draft). |
| `title` | string |  | Human label for the exercise (default "<Framework> exercise"). |

**Returns:**

JSON: `{ exercise_id, exercise, included: [{ edge_id, entity_id }], warnings }`.

**Throws:**

- textError on a missing product_id/framework_id or an unknown framework_id.

**See also:** `score_entity`


### `score_entity`

Record a framework's result for one entity on the exercise's includes edge (a MoSCoW bucket, a RICE score, a canvas slot). Auto-includes the entity if not already in scope. Merges into existing edge properties unless replace is set. The product is resolved from the exercise node. Returns { edge, warnings }.

**Atomicity:** `atomic-with-rollback (single edge upsert).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_id` | string | ✓ | Required. The entity being scored. |
| `exercise_id` | string | ✓ | Required. The framework_exercise id. |
| `replace` | boolean |  | Replace the edge properties instead of merging (default false). |
| `values` | object | ✓ | Required. The result as { input: value }, e.g. { "moscow": "must" } or { "reach": 800, "impact": 3 }. |

**Returns:**

JSON: `{ edge, warnings }`.

**Throws:**

- textError when the exercise/entity is missing or the node is not a
framework_exercise.

**See also:** `apply_framework`


## Areas

_Product-area listing and subgraph BFS._

- [`create_area`](#create-area)
- [`get_area_context`](#get-area-context)
- [`get_area_graph`](#get-area-graph)
- [`list_product_areas`](#list-product-areas)

### `create_area`

Create a new product area node (type 'area') in a product. Product areas are top-level organisational units within a product.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | Optional description |
| `product_id` | string | ✓ | Product ID |
| `title` | string | ✓ | Area title |

**Returns:**

JSON: `{ node }`.

**Throws:**

- textError when `product_id` or `title` is missing.

**See also:** `list_product_areas`, `get_area_context`


### `get_area_context`

Returns a summary of a product area: entity counts by type within it, child area count, and description. Traverses containment edges up to depth 2.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | The area node ID |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ area: { id, title, description }, entity_counts, total_entities, child_areas }`.

**Throws:**

- textError when `product_id` or `area_id` is missing, or the area lookup fails.

**See also:** `create_area`, `get_area_graph`


### `get_area_graph`

Get all entities and edges that belong to a product area. Returns the sub-graph scoped to that area.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | The product area node ID |
| `depth` | number |  | How many levels deep to traverse (default 3, max 10) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ area, nodes, edges }`.

**Throws:**

- textError when `product_id` or `area_id` is missing, or store rejects.

**See also:** `list_product_areas`, `get_area_context`, `query`


### `list_product_areas`

List all product areas in a product. Product areas are top-level organizational units within a product.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ areas, total }`.

**Throws:**

- textError when `product_id` is missing.

**See also:** `get_area_graph`, `get_area_context`, `create_area`


## Schema

_Per-type spec contract: properties, edges in and out, lifecycle._

- [`get_entity_schema`](#get-entity-schema)

### `get_entity_schema`

Returns the schema for a UPG entity type: valid parent→child edges, properties, lifecycle phases.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `type` | string | ✓ | The UPG entity type (e.g. "feature", "persona") |

**Returns:**

JSON: `{ type, alias_of?, domain, expected_properties,
edges_out, edges_in, phases?, initial_phase?, terminal_phases?,
domain_guide? }`.

**Throws:**

- textError when `type` is missing or unknown
(`UnknownEntityTypeError`).

**See also:** `get_entity_meta`, `list_entity_types`, `get_valid_children`, `get_lifecycle`, `get_domain_guide`, `list_edge_types`, `create_node`


## Collaboration

_Comments and role-based access. Cloud-only._

- [`add_comment`](#add-comment)
- [`grant_access`](#grant-access)
- [`list_collaborators`](#list-collaborators)
- [`list_comments`](#list-comments)

### `add_comment`

Add a comment on a node in the graph.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `body` | string | ✓ | Comment text |
| `node_id` | string | ✓ | Node to comment on |
| `product_id` | string | ✓ | Product ID |
| `user_id` | string | ✓ | Author user ID |

**Returns:**

JSON: `{ comment: { id, product_id, node_id, user_id, body, created_at } }`.

**Throws:**

- textError when `product_id`, `node_id`, `user_id`, or `body` is missing.

**Warnings (non-error surfaces):**

- `user_id` MUST resolve to a member of the product's collaborator set,
or downstream RLS rejects the insert.

**See also:** `list_comments`, `list_collaborators`, `grant_access`


### `grant_access`

Grant or update a user's role on a product (owner, editor, viewer).

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |
| `role` | `owner` \| `editor` \| `viewer` | ✓ | Role: owner \| editor \| viewer |
| `user_id` | string | ✓ | User to grant access to |

**Returns:**

JSON: `{ granted: { product_id, user_id, role } }`.

**Throws:**

- textError when `product_id`, `user_id`, or `role` is missing.

**Warnings (non-error surfaces):**

- Billing-relevant: collaborator count typically drives plan tier;
a grant may trigger a tier upgrade or hit a seat-limit cap.

**See also:** `list_collaborators`, `add_comment`


### `list_collaborators`

List all collaborators and their roles for a product.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ collaborators: Array<{ user_id, role, granted_at }> }`.

**Throws:**

- textError when `product_id` is missing.

**See also:** `grant_access`, `list_comments`


### `list_comments`

List comments on a node, newest first.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `node_id` | string | ✓ | Node ID |

**Returns:**

JSON: `{ comments: Comment[] }`.

**Throws:**

- textError when `node_id` is missing.

**Warnings (non-error surfaces):**

- RLS-bounded; an empty array can mean "no comments" or "no access".

**See also:** `add_comment`, `list_collaborators`


## Analytics

_Postgres-side metrics aggregator._

- [`get_graph_analytics`](#get-graph-analytics)

### `get_graph_analytics`

Computed product thinking metrics: hypothesis velocity, persona coverage ratio, evidence density, stale entity rate, orphan rate.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ product: { id, title }, analytics }`.

**Throws:**

- textError when `product_id` is missing or the product is invisible
to the caller (RLS-bounded; "not found" and "no access" share wording).

**See also:** `get_graph_digest`, `get_product_context`, `get_audit_log`


## Webhooks

_Outbound event sinks._

- [`list_webhooks`](#list-webhooks)
- [`register_webhook`](#register-webhook)
- [`remove_webhook`](#remove-webhook)

### `list_webhooks`

List all registered webhooks for a product.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ webhooks: Webhook[] }`.

**Throws:**

- textError when `product_id` is missing.

**See also:** `register_webhook`, `remove_webhook`


### `register_webhook`

Register a webhook called when an event occurs on a product (node.created, node.updated, node.deleted, edge.created, edge.deleted; use '*' for all). Delivered async after commit, HMAC-signed via the optional secret (X-UPG-Signature header), with bounded retry; a persistent 4xx auto-disables the registration.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `event` | string | ✓ | Event name (e.g. node.created, node.updated, node.deleted, edge.created, edge.deleted) |
| `product_id` | string | ✓ | Product ID |
| `secret` | string |  | Optional shared secret for HMAC signature verification |
| `url` | string | ✓ | Webhook URL to POST to |

**Returns:**

JSON: `{ webhook: { id, product_id, event, url, secret?, created_at } }`.

**Throws:**

- textError when `product_id`, `event`, or `url` is missing.

**See also:** `list_webhooks`, `remove_webhook`


### `remove_webhook`

Remove a registered webhook by ID.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `webhook_id` | string | ✓ | Webhook ID to remove |

**Returns:**

JSON: `{ removed: <webhook_id> }`.

**Throws:**

- textError when `webhook_id` is missing or the store rejects the deletion.

**See also:** `register_webhook`, `list_webhooks`


## Spec Introspection

_Spec snapshot: playbooks, approaches, domains, frameworks, edge catalogue, regions, lenses, type labels, entity meta, anti-patterns, benchmarks, product stages._

- [`get_anti_pattern`](#get-anti-pattern)
- [`get_approach`](#get-approach)
- [`get_domain_guide`](#get-domain-guide)
- [`get_domain_ring`](#get-domain-ring)
- [`get_edge_type`](#get-edge-type)
- [`get_entity_meta`](#get-entity-meta)
- [`get_framework`](#get-framework)
- [`get_lens`](#get-lens)
- [`get_lifecycle`](#get-lifecycle)
- [`get_playbook`](#get-playbook)
- [`get_region`](#get-region)
- [`get_region_for_entity_type`](#get-region-for-entity-type)
- [`get_scale`](#get-scale)
- [`get_spec_version`](#get-spec-version)
- [`get_type_label`](#get-type-label)
- [`get_valid_children`](#get-valid-children)
- [`inspect`](#inspect)
- [`list_anti_patterns`](#list-anti-patterns)
- [`list_approaches`](#list-approaches)
- [`list_benchmarks`](#list-benchmarks)
- [`list_cross_edge_types`](#list-cross-edge-types)
- [`list_domain_rings`](#list-domain-rings)
- [`list_domains`](#list-domains)
- [`list_edge_migrations`](#list-edge-migrations)
- [`list_edge_types`](#list-edge-types)
- [`list_entity_types`](#list-entity-types)
- [`list_framework_categories`](#list-framework-categories)
- [`list_framework_structure_patterns`](#list-framework-structure-patterns)
- [`list_frameworks`](#list-frameworks)
- [`list_lenses`](#list-lenses)
- [`list_lifecycles`](#list-lifecycles)
- [`list_playbooks`](#list-playbooks)
- [`list_product_stages`](#list-product-stages)
- [`list_regions`](#list-regions)
- [`list_scales`](#list-scales)
- [`list_split_migrations`](#list-split-migrations)
- [`list_type_labels`](#list-type-labels)
- [`list_type_migrations`](#list-type-migrations)
- [`plan`](#plan)
- [`prioritise`](#prioritise)
- [`reflect`](#reflect)
- [`resolve_edge_for_pair`](#resolve-edge-for-pair)
- [`trace`](#trace)

### `get_anti_pattern`

Return one curated anti-pattern by id (kebab-case slug, e.g. "features-without-hypotheses", "personas-without-jobs"). Includes the full body: structured condition, why-it-matters, remediation, applicable stages, severity, and optional source citation. IDs are stable URL fragments and remain frozen once published.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Anti-pattern id (kebab-case slug). |

**Returns:**

JSON: `UPGCuratedAntiPattern`

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_anti_patterns`, `inspect`, `validate_graph`


### `get_approach`

Return one canonical UPGApproach by id. Valid ids are the bare verbs: plan, inspect, prioritise, trace, reflect. Same names as the verb-led MCP tools.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | `plan` \| `inspect` \| `prioritise` \| `trace` \| `reflect` | ✓ | Approach id, one of: plan, inspect, prioritise, trace, reflect. |

**Returns:**

JSON: the full `UPGApproach` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_approaches`, `plan`, `inspect`, `prioritise`, `trace`, `reflect`


### `get_domain_guide`

Return the full UPGDomainUsageGuide for a domain: anchor entity, creation sequence, named patterns (entity and edge chains), required cross-domain bridges, and anti-patterns.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `domain_id` | string | ✓ | Canonical domain id (e.g. "user", "market_intelligence", "growth"). |

**Returns:**

JSON: the full `UPGDomainUsageGuide` record.

**Throws:**

- textError when `domain_id` is missing or unknown.

**See also:** `list_domains`, `list_anti_patterns`, `get_playbook`


### `get_domain_ring`

Return one UPGDomainRing by id (e.g. "nucleus", "understand", "define", "build", "grow", "operate", "extend").

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Ring id, one of: nucleus, understand, define, build, grow, operate, extend. |

**Returns:**

JSON: the full `UPGDomainRing` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_domain_rings`, `list_domains`, `get_domain_guide`


### `get_edge_type`

Return one canonical edge catalogue entry by edge type key (e.g. "persona_pursues_job", "feature_addresses_need").

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `type` | string | ✓ | Edge type key from UPG_EDGE_CATALOG. |

**Returns:**

JSON: `{ type, forward_verb, reverse_verb, classification, source_type, target_type }`

**Throws:**

- textError when `type` is missing or unknown.

**See also:** `list_edge_types`, `resolve_edge_for_pair`, `rename_edge_type`


### `get_entity_meta`

Return one canonical EntityTypeMeta record by entity type name, plus the resolved domain_id (or null if the type has no atomic-domain mapping). Pairs with list_entity_types; drill into a single type's lifecycle metadata (maturity tier, since-version, replacement target if deprecated). Pass the canonical name (e.g. "persona", "pain_point"), not the immutable type_id.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string | ✓ | Canonical entity type name. |

**Returns:**

JSON: `EntityTypeMeta & { domain_id: string | null }`

**Throws:**

- textError when `name` is missing or unknown.

**See also:** `list_entity_types`, `get_type_label`, `get_entity_schema`


### `get_framework`

Return one canonical UPGFramework by id (e.g. "rice-scoring", "lean-canvas"). Includes all four layers: data, structure, presentation, education.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Framework id (kebab-case). |

**Returns:**

JSON: the full `UPGFramework` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_frameworks`, `prioritise`, `get_playbook`, `get_approach`


### `get_lens`

Return the full UPGLens record by id (e.g. "product", "ux_design", "engineering", "full") plus the resolved list of entity types visible through that lens. Combines the lens record with visible_types in one response, saving the common "fetch lens, then resolve types" round-trip.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Lens id (e.g. "product", "ux_design", "full"). |

**Returns:**

JSON: `{ ...UPGLens, visible_types: string[] }`

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_lenses`, `get_playbook`, `get_framework`, `list_entity_types`


### `get_lifecycle`

Return the full UPGLifecycle definition for one entity type: initial phase, terminal phases, and the ordered array of phases with transitions and core states. Returns a descriptive message (not an error) when the type has no lifecycle defined.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string | ✓ | Canonical entity type name (e.g. "feature", "hypothesis_claim", "opportunity"). |

**Returns:**

JSON: the full `UPGLifecycle` record, or a descriptive message.

**Throws:**

- textError when `entity_type` is missing, lifecycle-free,
lifecycle-planned, or unknown.

**See also:** `list_lifecycles`, `get_entity_meta`, `get_entity_schema`


### `get_playbook`

Return one canonical UPGPlaybook by id (e.g. "playbook:strategy-outcomes", "playbook:business-gtm-growth"). Includes the ordered creation_sequence with full step kinds and prompts. IDs are namespace-prefixed; calling with an "approach:*" id (or one of the 5 bare-verb approach ids) returns null; route via get_approach for the approach catalog.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Playbook id (namespace-prefixed: playbook:*). |

**Returns:**

JSON: the full `UPGPlaybook` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_playbooks`, `get_approach`, `get_framework`, `get_region`


### `get_region`

Return the full UPGRegion record by id: anchor entity (with rationale and inbound/outbound cross-edge counts), entity memberships with structural roles, intra-domain edge keys, boundary edges to other regions, shape archetype, and the atomic-domain composition.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Region id (e.g. "strategy_outcomes", "users_needs", "product_delivery"). See UPG_REGIONS for the full list of 10. |

**Returns:**

JSON: the full `UPGRegion` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_regions`, `get_region_for_entity_type`, `get_playbook`, `list_lenses`


### `get_region_for_entity_type`

Resolve which super-domain region contains a given entity type. Wraps getRegionForEntityType. Returns the full UPGRegion record. Useful for adapters and copilots that need to route or render an entity based on its super-domain.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string | ✓ | Canonical entity type (e.g. "persona", "feature", "metric"). |

**Returns:**

JSON: the full `UPGRegion` record.

**Throws:**

- textError when `entity_type` is missing or no region contains it.

**See also:** `get_region`, `list_regions`, `get_entity_meta`, `list_entity_types`


### `get_scale`

Return one spec-defined assessment scale by id (e.g. "reach_5", "severity_5", "confidence_binary"). Includes the full point array.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Scale id (e.g. "reach_5", "frequency_5", "severity_5", "importance_5", "confidence_binary"). |

**Returns:**

JSON: the full `UPGScaleDefinition` record including all points.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_scales`, `get_entity_schema`


### `get_spec_version`

Return spec-level metadata for adopter compatibility checks: upg_version, markdown_format_version, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ upg_version, markdown_format_version, entity_count, edge_count, domain_count, region_count }`

**See also:** `list_entity_types`, `list_edge_types`, `list_regions`


### `get_type_label`

Return one canonical UPGTypeLabel by entity type, plus a resolved display label for an optional framework_id and/or designation (wraps resolveLabel). Lookup is exact-match against UPG_TYPE_LABELS_MAP.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `designation` | string |  | Optional designation key (e.g. "pain", "gap", "desire") for types that use the designation pattern. |
| `entity_type` | string | ✓ | Canonical entity type id. |
| `framework_id` | string |  | Optional framework id (e.g. "lean_canvas", "ost", "design_thinking"); when set, resolved_label uses the framework-specific label. |

**Returns:**

JSON: `{ ...UPGTypeLabel, resolved_label: string }`

**Throws:**

- textError when `entity_type` is missing or unknown.

**See also:** `list_type_labels`, `get_entity_meta`, `list_frameworks`


### `get_valid_children`

Return the list of valid direct-child entity types for a parent type. Wraps getValidChildren / UPG_VALID_CHILDREN. Returns an empty array when the parent has no registered children. Pairs with get_entity_schema; the natural tool name for "what can I create under this?".

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `parent_type` | string | ✓ | Canonical parent entity type. |

**Returns:**

JSON: `{ parent_type, valid_children: string[] }`

**Throws:**

- textError when `parent_type` is missing.

**See also:** `get_entity_schema`, `list_entity_types`, `get_entity_meta`, `create_node`


### `inspect`

Inspect approach: the path of arrival to "what's broken?". v0.3.0 ships as a definition lookup: returns the Inspect approach record plus invocation params wrapped in the family-resemblance envelope. The LLM consumes the signature_hint and emits { violations: [{ severity, kind, entity_id, description, fix_hint }] } against UPG_ANTI_PATTERNS plus the live graph. Structured execution lands in v0.3.x. Optional region OR optional entities[] scope the audit.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entities` | array |  | Optional entity_id[]; narrows inspection scope to a specific candidate set. Mutually composable with region. |
| `region` | string |  | Optional UPGRegionId; narrows inspection scope to a single region. |

**Returns:**

JSON envelope: `{ approach_id: 'inspect', scope, generated_at, approach, params }`

**Warnings (non-error surfaces):**

- v0.3.0 returns the approach record only; the caller (LLM) is
the executor. Structured execution (run anti-pattern matchers plus
structural lints) lands in v0.3.x.

**See also:** `get_approach`, `list_anti_patterns`, `get_anti_pattern`, `validate_graph`, `plan`, `reflect`


### `list_anti_patterns`

List the curated cross-domain anti-patterns from UPG_ANTI_PATTERNS. Each row pairs a memorable name with a machine-evaluable IntelligenceCondition, the stages where it can fire, severity, and remediation. Graph-health patterns evaluated against the whole graph, distinct from per-domain anti-patterns surfaced via get_domain_guide. Paginated (default limit 50, max 200). Filters AND together: severity ("high" | "medium" | "low"), stage (UPGProductStage, keeps patterns whose stages[] includes it).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 50, max 200). |
| `severity` | `high` \| `medium` \| `low` |  | Exact-match UPGAntiPatternSeverity. |
| `stage` | `concept` \| `validation` \| `build` \| `beta` \| `launch` \| `growth` \| `mature` \| `maintenance` \| `sunset` |  | Keeps anti-patterns whose stages[] includes the given UPGProductStage. |

**Returns:**

JSON: `{ total, count, next_cursor?, anti_patterns: UPGCuratedAntiPattern[] }`

**See also:** `get_anti_pattern`, `validate_graph`, `inspect`, `get_domain_guide`


### `list_approaches`

List the 5 canonical UPGApproach records: Plan / Inspect / Prioritise / Trace / Reflect. An approach is the *path of arrival* to a region of the graph (cartographic sense: final approach to an airport, coastline approach), distinct from the strategy-meeting sense. Each record carries id, label, description (with cartographic framing), question_answered, signature_hint, framework_id_examples. Optional filter: framework_id (narrows to approaches whose framework_id_examples include the given id).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `framework_id` | string |  | Exact-match framework id; narrows to approaches whose framework_id_examples include it (discoverability surface; full reverse lookup is on UPGFramework.approach_ids). |

**Returns:**

JSON: `{ count, approaches: UPGApproach[] }`

**See also:** `get_approach`, `plan`, `inspect`, `prioritise`, `trace`, `reflect`, `list_playbooks`


### `list_benchmarks`

Return one of the four canonical benchmark catalogs, the data behind get_graph_digest health logic. The kind parameter is REQUIRED and routes to the matching source: "count" → UPG_COUNT_BENCHMARKS (per-entity-type ranges across the 9-stage journey); "relationship" → UPG_RELATIONSHIP_BENCHMARKS (parent → child minimum counts per stage); "ratio" → UPG_RATIO_BENCHMARKS (expected ratios between entity-type counts); "domain_activation" → UPG_DOMAIN_ACTIVATION (when each atomic domain is expected to turn on). Optional filters AND together: stage (UPGProductStage), domain (atomic-domain id). Non-paginated (each catalog is small).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `domain` | string |  | Optional atomic-domain id filter. Semantics depend on kind; see tool description. |
| `kind` | `count` \| `relationship` \| `ratio` \| `domain_activation` | ✓ | Required: which benchmark catalog to return. |
| `stage` | `concept` \| `validation` \| `build` \| `beta` \| `launch` \| `growth` \| `mature` \| `maintenance` \| `sunset` |  | Optional UPGProductStage filter. Semantics depend on kind; see tool description. |

**Returns:**

JSON: `{ kind, total, count, benchmarks: ... }`

**Throws:**

- textError when `kind` is missing or not one of the four supported values.

**See also:** `get_graph_digest`, `list_product_stages`, `list_domains`, `list_anti_patterns`


### `list_cross_edge_types`

List the canonical cross-product edge types from UPG_CROSS_EDGE_TYPES (shares_persona, shares_competitor, shares_metric, depends_on_product, cannibalises, succeeds, hosts, contributes_to, instance_of, area_serves_persona, area_targets_market_segment, rolls_up_to). Portfolio-level relationships between entities in different products, separate from the within-product UPG_EDGE_CATALOG. instance_of and the area edges (area_serves_persona / area_targets_market_segment) are created via the registry/portfolio tooling in the local MCP server; rolls_up_to (a product metric feeding a company metric) via create_cross_product_edge.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, types: readonly UPGCrossEdgeType[] }`

**See also:** `list_edge_types`, `list_portfolio_cross_edges`, `migrate_cross_edges`


### `list_domain_rings`

List every UPGDomainRing from UPG_DOMAIN_RINGS in canonical order (Nucleus → Understand → Define → Build → Grow → Operate → Extend). Rings are the 7 concentric groupings of the 36 UPG atomic domains. Each ring carries { id, label, description, domain_ids }. Non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ rings: UPGDomainRing[], total: number }`

**See also:** `get_domain_ring`, `list_domains`, `get_domain_guide`


### `list_domains`

List domains. Default (with_guide_only: true) returns every domain that has a canonical usage guide: id, anchor_entity, and creation_sequence per domain. Pass with_guide_only: false to enumerate every atomic domain from UPG_DOMAINS (~36 at v0.3.0); each row carries id, label, description, types, has_guide. The two shapes share one tool surface, disjoint by the boolean.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `with_guide_only` | boolean |  | Default true: return only domains with a canonical usage guide (compact id, anchor_entity, creation_sequence). Pass false to return every atomic domain (id, label, description, types, has_guide). |

**Returns:**

JSON: `{ count, domains: Array<{ domain_id, anchor_entity, creation_sequence } | { domain_id, label, description, types, has_guide }> }`

**See also:** `get_domain_guide`, `list_regions`, `list_entity_types`


### `list_edge_migrations`

List every edge-key migration from UPG_EDGE_MIGRATIONS: renamed or dropped canonical edge type keys (e.g. persona_has_jtbd → persona_pursues_job). Each row carries { kind, from, to?, since }. kind is "rename" or "drop". Optional from_edge filter exact-matches on the from field.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_edge` | string |  | Exact-match filter on the deprecated edge key (e.g. "persona_has_jtbd"). |

**Returns:**

JSON: `{ migrations: [{ kind, from, to?, since }], total: number }`

**See also:** `list_type_migrations`, `list_split_migrations`, `rename_edge_type`, `list_edge_types`, `validate_graph`


### `list_edge_types`

List every canonical edge type from UPG_EDGE_CATALOG, optionally narrowed by source_type and/or target_type. Each entry carries the edge key (type), forward/reverse verbs, classification, and endpoint types. The polymorphic wildcard "node" is preserved on registered polymorphic edges.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_type` | string |  | Exact-match filter on UPGEdgeDefinition.source_type. Pass "node" to find polymorphic edges with a wildcard source. |
| `target_type` | string |  | Exact-match filter on UPGEdgeDefinition.target_type. |

**Returns:**

JSON: `{ count, edges: Array<{ type, forward_verb, reverse_verb, classification, source_type, target_type }> }`

**See also:** `get_edge_type`, `resolve_edge_for_pair`, `list_cross_edge_types`, `create_edge`


### `list_entity_types`

List canonical entity types from UPG_ENTITY_META, the source of truth for ontology evolution (every active, deprecated, or removed type with its immutable type_id, maturity tier, and version metadata). Paginated (default limit 50, max 200). Filters AND together and apply before pagination: domain (atomic-domain id), maturity ("draft" | "proposed" | "stable" | "deprecated" | "removed"), deprecated (boolean shortcut). Each row carries the full EntityTypeMeta plus resolved domain_id (null if no atomic-domain mapping).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response. |
| `deprecated` | boolean |  | true → only deprecated types; false → exclude deprecated and removed types (the active set). Composes with maturity via AND. |
| `domain` | string |  | Exact-match atomic-domain id (e.g. "user", "market_intelligence"). |
| `limit` | number |  | Page size (default 50, max 200). |
| `maturity` | `draft` \| `proposed` \| `stable` \| `deprecated` \| `removed` |  | Exact-match UPGEntityTypeMaturity. |

**Returns:**

JSON: `{ total, count, next_cursor?, types: Array<EntityTypeMeta & { domain_id: string | null }> }`

**See also:** `get_entity_meta`, `get_entity_schema`, `list_type_labels`, `list_domains`


### `list_framework_categories`

List all valid framework category values from UPG_FRAMEWORK_CATEGORIES (e.g. "strategy", "prioritization", "discovery", "growth", "engineering"). Use as valid values for the category filter on list_frameworks / get_framework.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ categories: string[], total: number }`

**See also:** `list_frameworks`, `list_framework_structure_patterns`


### `list_framework_structure_patterns`

List all valid framework structure pattern values from UPG_STRUCTURE_PATTERNS: the visual topological shapes (tree, table, matrix, funnel, collection, quadrant, flow). Mirrors UPGFramework.structure.pattern.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ patterns: string[], total: number }`

**See also:** `list_frameworks`, `list_framework_categories`, `get_framework`


### `list_frameworks`

List the canonical UPGFramework definitions: the curated, famous product frameworks that anchor the public catalog. Paginated (default limit 50, max 200) to avoid transport overflow. Cursor is opaque; pass next_cursor from a previous response to advance. Optional category filter is exact-match against UPGFramework.category and applied before pagination.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `category` | string |  | Exact-match filter on UPGFramework.category (e.g. "strategy", "prioritization"). |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 50, max 200). |

**Returns:**

JSON: `{ total, count, next_cursor?, frameworks: UPGFramework[] }`

**See also:** `get_framework`, `prioritise`, `list_approaches`


### `list_lenses`

List every canonical UPGLens shipped with @unified-product-graph/core: Product, Design, Engineering, Growth, Business, Research, Marketing, Full. Returns a compact summary per lens (id, name, description, icon, audience, perspective, framework_id, playbook_id, visible_domain_count, intelligence_prompt_count). Drill into get_lens for the full record.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, lenses: Array<{ id, name, description, icon, audience, perspective, framework_id?, playbook_id?, visible_domain_count, intelligence_prompt_count }> }`

**See also:** `get_lens`, `list_regions`, `list_playbooks`, `list_frameworks`


### `list_lifecycles`

List lifecycle definitions from UPG_LIFECYCLES. Response includes free_types (UPG_LIFECYCLE_FREE_TYPES: static types with no phase progression) and planned_types (UPG_LIFECYCLE_PLANNED_TYPES: lifecycle planned but not yet authored). Filters: entity_type (exact-match); lifecycle_only (when true, omits free/planned lists).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string |  | Exact-match entity type name (e.g. "feature", "hypothesis_claim"). Returns at most one lifecycle. |
| `lifecycle_only` | boolean |  | When true, omit free_types and planned_types from response. |

**Returns:**

JSON: `{ lifecycles, total, free_types: string[], planned_types: string[] }`

**See also:** `get_lifecycle`, `list_entity_types`, `get_entity_meta`


### `list_playbooks`

List the canonical UPG playbooks shipped with @unified-product-graph/core. Each playbook bootstraps a region; its creation_sequence answers "what to create when populating this region". Optional filters: region, canonical_only, framework_id. v0.3.0 ships 23 playbooks across 10 regions (10 canonical plus 13 specialised; 3 carry framework_id: BMC, AARRR, build-measure-learn).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `canonical_only` | boolean |  | When true, return only the canonical playbook per region (W1 invariant restated). |
| `framework_id` | string |  | Exact-match UPGFramework.id (e.g. "business-model-canvas", "pirate-metrics-aarrr"). |
| `region` | string |  | Exact-match UPGRegionId (e.g. "users_needs", "business_gtm_growth"). |

**Returns:**

JSON: `{ count, playbooks: UPGPlaybook[] }`

**See also:** `get_playbook`, `list_regions`, `list_approaches`, `list_frameworks`


### `list_product_stages`

Return the canonical 9-stage product journey from UPG_PRODUCT_STAGES: the closed enum used by create_product, get_graph_digest health logic, benchmark stage scoping, and anti-pattern stage filters. Order is canonical: earliest → latest (concept, validation, build, beta, launch, growth, mature, maintenance, sunset). Trivial enum surface, no filters, no pagination.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, stages: readonly UPGProductStage[] }`

**See also:** `list_benchmarks`, `list_anti_patterns`, `create_product`


### `list_regions`

List the 10 canonical UPG super-domain regions from UPG_REGIONS: pure graph topology (entities, anchors, intra/boundary edges, shape archetype). Returns a compact summary per region (id, label, order, shape, mental_model, anchor_type, composes_atomic_domains, entity_count, intra_edge_count, boundary_edge_count). Fixed list, non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, regions: Array<{ id, label, order, shape, mental_model, anchor_type, composes_atomic_domains, entity_count, intra_edge_count, boundary_edge_count }> }`

**See also:** `get_region`, `get_region_for_entity_type`, `list_domains`, `list_playbooks`


### `list_scales`

List every spec-defined assessment scale from UPG_SCALES: the canonical vocabulary for UPGAssessment values. Each scale carries id, label, description, min, max, steps, and per-point labels plus descriptions. Non-paginated. External scale_extensions are graph-instance–scoped and stay out of this surface.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ scales: UPGScaleDefinition[], total: number }`

**See also:** `get_scale`, `get_entity_schema`


### `list_split_migrations`

List every 1→N split migration from UPG_SPLIT_MIGRATIONS: "one type became multiple types" rules (e.g. experiment → experiment_plan + experiment_run; hypothesis → hypothesis_claim + hypothesis_evidence). Each row includes the full UPGSplitMigration record plus since. Non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ splits: [...], total: number }`

**See also:** `list_type_migrations`, `list_edge_migrations`, `migrate_type`, `validate_graph`


### `list_type_labels`

List canonical UPGTypeLabel entries: every entity type's display label, alt-labels (synonyms), per-framework labels, and (where applicable) designation labels. Paginated (default limit 100, max 500). Cursor is opaque base64 (offset:N) following the list_frameworks convention. External MCP apps need labels for rendering.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor; pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 100, max 500). |

**Returns:**

JSON: `{ total, count, next_cursor?, labels: UPGTypeLabel[] }`

**See also:** `get_type_label`, `list_entity_types`, `get_entity_meta`


### `list_type_migrations`

List every type-rename migration from UPG_MIGRATIONS: the version-scoped registry of deprecated from → canonical to renames (e.g. pain_point → need, hypothesis → hypothesis_claim). Each row carries { from, to, since } where since is the spec version that introduced the migration. Optional from_type filter exact-matches on the from field.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_type` | string |  | Exact-match filter on the deprecated type name (e.g. "pain_point", "hypothesis"). |

**Returns:**

JSON: `{ migrations: [{ from, to, since }], total: number }`

**See also:** `list_edge_migrations`, `list_split_migrations`, `migrate_type`, `validate_graph`, `list_entity_types`


### `plan`

Plan approach: the path of arrival to "what should I build next?". v0.3.0 ships as a definition lookup: returns the Plan approach record plus invocation params wrapped in the family-resemblance envelope { approach_id, scope, generated_at, approach, params }. The LLM consumes the signature_hint and synthesises { missing_entities, coverage_score } against the live graph. Structured execution lands in v0.3.x. Optional region narrows the scope.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `region` | string |  | Optional UPGRegionId; narrows planning scope to a single region (e.g. "users_needs", "business_gtm_growth"). Omit for whole-graph planning. |

**Returns:**

JSON envelope: `{ approach_id: 'plan', scope, generated_at, approach, params }`

**Warnings (non-error surfaces):**

- v0.3.0 returns the approach record only; the caller (LLM) is
the executor. Structured execution (compute coverage_score from
canonical region playbooks) lands in v0.3.x.

**See also:** `get_approach`, `list_playbooks`, `get_region`, `inspect`, `prioritise`


### `prioritise`

Prioritise approach: the path of arrival to "what's most important?". v0.3.0 ships as a definition lookup: returns the Prioritise approach record plus invocation params plus framework metadata wrapped in the family-resemblance envelope. Both candidates and framework_id are required. The LLM looks up the framework via get_framework, reads the scoring spec, and emits { ranked: [{ entity_id, score, rationale }], framework_used }. Structured execution lands in v0.3.x.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `candidates` | array | ✓ | Required: entity_id[] to rank. |
| `framework_id` | string | ✓ | Required: UPGFramework.id of the scoring lens (e.g. "rice-scoring", "ice-scoring", "kano-model", "cost-of-delay", "wsjf"). |

**Returns:**

JSON envelope: `{ approach_id: 'prioritise', scope, generated_at, approach, params }`

**Throws:**

- textError when `candidates` or `framework_id` are missing/empty.

**Warnings (non-error surfaces):**

- v0.3.0 returns the approach record plus framework lookup only.
Structured execution (apply framework's `computed_properties` to each
candidate, return ranked output) lands in v0.3.x.

**See also:** `get_approach`, `list_frameworks`, `get_framework`, `plan`, `trace`


### `reflect`

Reflect approach: the path of arrival to "what should I be questioning?". v0.3.0 ships as a definition lookup: returns the Reflect approach record plus invocation params wrapped in the family-resemblance envelope. The LLM consumes mode plus scope plus signature_hint and emits { prompts: [{ kind, question, target_entities? }] }. Optional mode is one of the 4 canonical nouns: assumptions / alternatives / blind-spots / load-bearing. Absence of mode signals open reflection. Optional scope accepts a region id, entity id, or null for whole-graph reflection.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `mode` | `assumptions` \| `alternatives` \| `blind-spots` \| `load-bearing` |  | Optional: one of assumptions, alternatives, blind-spots, load-bearing. Omit for open reflection. |
| `scope` | string,null |  | Optional: region id, entity id, or null for whole-graph. |

**Returns:**

JSON envelope: `{ approach_id: 'reflect', scope, generated_at, approach, params }`

**Throws:**

- textError when `mode` is provided but not one of the 4 canonical nouns.

**Warnings (non-error surfaces):**

- v0.3.0 returns the approach record only; the caller (LLM)
emits the prompts. Structured execution (template-driven prompt
generation per mode plus targeted entity selection) lands in v0.3.x.

**See also:** `get_approach`, `inspect`, `plan`, `get_anti_pattern`


### `resolve_edge_for_pair`

Resolve the canonical UPGEdgeType for a source_type → target_type containment pair. Wraps resolveContainmentEdge / UPG_EDGE_PAIR_MAP. Adapter-critical: every import adapter (Markdown, Notion, Linear, GitHub) uses this to look up the right "_contains_" edge before falling back to a polymorphic edge or skipping. Returns { edge_type: null } when the pair is not catalogued.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_type` | string | ✓ | Parent / source entity type. |
| `target_type` | string | ✓ | Child / target entity type. |

**Returns:**

JSON: `{ source_type, target_type, edge_type: string | null }`

**Throws:**

- textError when `source_type` or `target_type` is missing.

**Warnings (non-error surfaces):**

- Returns `edge_type: null` when no canonical pair is registered;
adapters MUST fall back to a polymorphic edge or skip the relationship
rather than synthesise a non-canonical key.

**See also:** `list_edge_types`, `get_edge_type`, `create_edge`, `trace`


### `trace`

Trace approach: the path of arrival to "walk a meaningful path through existing graph". v0.3.0 ships as a definition lookup: returns the Trace approach record plus invocation params wrapped in the family-resemblance envelope. The LLM uses anchor plus path to compose query() calls and emits { trail: [{ depth, entity_id, edge_type_in }], reached: entity_id[] }. Path is type-shorthand: ["persona","job","feature"] walks persona→job→feature using the canonical edge per pair. Optional edges_override selects non-canonical edges per hop; element null means "use canonical".

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `anchor` | string | ✓ | Required: entity_id where the traversal starts. |
| `edges_override` | array |  | Optional per-hop edge override array. Length must match path length; element null means "use canonical edge for this pair". |
| `path` | array | ✓ | Required: UPGEntityType[] type-shorthand path. Each step walks via the canonical edge for the source→target pair. |

**Returns:**

JSON envelope: `{ approach_id: 'trace', scope, generated_at, approach, params }`

**Throws:**

- textError when `anchor` or `path` are missing/invalid.

**Warnings (non-error surfaces):**

- v0.3.0 returns the approach record only; the LLM composes the
actual traversal via `query()`. Structured execution (BFS walker that
returns `{ trail, reached }`) lands in v0.3.x.

**See also:** `get_approach`, `resolve_edge_for_pair`, `query`, `get_node`, `plan`, `prioritise`


## Portfolio

_Cross-product edges and portfolio view._

- [`create_cross_product_edge`](#create-cross-product-edge)
- [`list_portfolio_cross_edges`](#list-portfolio-cross-edges)
- [`list_portfolios`](#list-portfolios)
- [`repair_dangling_edges`](#repair-dangling-edges)

### `create_cross_product_edge`

Create a cross-product edge linking entities across different products. Type must be one of the canonical UPG cross-edge types: shares_persona, shares_competitor, shares_metric, depends_on_product, cannibalises, succeeds, hosts, contributes_to.

**Atomicity:** `atomic`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | The product creating this cross-edge |
| `source` | string | ✓ | Qualified source: {product_id}/{node_id} |
| `target` | string | ✓ | Qualified target: {product_id}/{node_id} |
| `type` | `shares_persona` \| `shares_competitor` \| `shares_metric` \| `depends_on_product` \| `cannibalises` \| `succeeds` \| `hosts` \| `contributes_to` | ✓ | Cross-edge type |

**Returns:**

JSON: `{ edge: { id, source, target, type, created_by_product_id } }`

**Throws:**

- textError when `product_id`, `source`, `target`, or
`type` is missing, or `type` is not a UPG cross-edge type.

**Warnings (non-error surfaces):**

- Source/target are qualified strings (`{product_id}/{node_id}`)
and skip FK validation against the products table. A target
referencing a deleted product becomes a dangling cross-edge; sweep
periodically with `repair_dangling_edges`.

**See also:** `list_cross_edge_types`, `list_portfolio_cross_edges`, `repair_dangling_edges`, `migrate_cross_edges`


### `list_portfolio_cross_edges`

List all cross-product edges created by a product. Cross-product edges link entities across different products (e.g. shares_persona, depends_on_product).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ edges: [{ id, source, target, type }], total: number }`

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Returns only edges this product **created**; edges another
product created targeting this product surface through that product's
own call. To audit all incident cross-edges, query each product in
the portfolio.

**See also:** `create_cross_product_edge`, `list_cross_edge_types`, `migrate_cross_edges`


### `list_portfolios`

List the product portfolio for this UPG cloud instance. For v1, returns all products as a single portfolio. Use before creating cross-product edges to discover valid product IDs.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ portfolios: [{ id, title, products: [{ id, title, stage? }] }], total: number }`

**Warnings (non-error surfaces):**

- v1 returns a single synthetic `'default'` portfolio per
instance; multi-portfolio scoping arrives once auth is wired.
Treat the `id: 'default'` shape as transitional.

**See also:** `list_products`, `list_portfolio_cross_edges`


### `repair_dangling_edges`

Find (and optionally remove) cross-product edges that reference a product that no longer exists. Default is dry_run=true.

**Atomicity:** `atomic-with-rollback (when drop is requested)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `drop` | array |  | Categories to drop when dry_run=false |
| `dry_run` | boolean |  | Default true: report only. |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ dangling: [{ id, source, target, type }], dangling_count, dry_run, dropped }`

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`. Pass `dry_run: false` AND
`drop: ['dangling_cross_edges']` to actually delete; the second
guard prevents accidental drops. Per-edge errors during deletion
(concurrent removal) are swallowed; check `dropped` against
`dangling_count` to detect partial application.

**See also:** `create_cross_product_edge`, `list_portfolio_cross_edges`, `migrate_cross_edges`


## Atomic Batches

_Atomic batches: nodes and edges in one Postgres transaction._

- [`batch_create_edges`](#batch-create-edges)
- [`batch_create_nodes`](#batch-create-nodes)
- [`batch_delete_edges`](#batch-delete-edges)
- [`batch_delete_nodes`](#batch-delete-nodes)
- [`batch_move_nodes`](#batch-move-nodes)
- [`batch_update_nodes`](#batch-update-nodes)

### `batch_create_edges`

Create up to 50 edges in a single atomic Postgres transaction. Edge type is auto-inferred from source/target types when omitted. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edges` | array | ✓ | Edges to create (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ created: [{ id, source_id, target_id, type }], count }`.

**Throws:**

- textError when `edges` is missing / non-array / empty / >50, any
item is missing `source_id` / `target_id`, any endpoint does not exist, an
explicit `type` violates the catalog's source/target pair, or an inferred
pair has no canonical edge. Any such failure rejects the whole batch
before BEGIN.

**Warnings (non-error surfaces):**

- Inference is catalog-strict: an unmapped pair is refused rather
than fabricating a `${source}_contains_${target}` edge. Pass an explicit
`type` (resolved via `resolve_edge_for_pair`) for non-catalog edges.

**See also:** `create_edge`, `resolve_edge_for_pair`, `batch_delete_edges`


### `batch_create_nodes`

Create up to 50 entities in a single atomic Postgres transaction. For each node with a parent_id, a containment edge is created in the same transaction. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `nodes` | array | ✓ | Nodes to create (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ created: [{ id, type, title }], count, warnings? }`.

**Throws:**

- textError when `nodes` is missing / non-array, any required field
(`type`, `title`) is absent, or any node carries a declared property whose
value type mismatches the schema (rejects the whole batch before BEGIN).

**Warnings (non-error surfaces):**

- Validation runs inline before BEGIN; a single bad item rejects
the entire batch before any database mutation. Parent containment edges
are catalog-strict: a non-canonical parent→child pair skips the edge with
a warning rather than fabricating a `_contains_` edge (matches
`create_node`). A missing parent likewise skips the edge.

**See also:** `create_node`, `batch_create_edges`, `batch_update_nodes`


### `batch_delete_edges`

Delete up to 50 edges in a single atomic Postgres transaction. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_ids` | array | ✓ | Edge IDs to delete (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ deleted: [id], count }`.

**Throws:**

- textError when `edge_ids` is missing / non-array / empty / >50, or
any ID does not resolve in the given product.

**See also:** `delete_edge`, `batch_create_edges`, `export_edges`


### `batch_delete_nodes`

Delete up to 50 entities and all their connected edges in a single atomic Postgres transaction. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `node_ids` | array | ✓ | Node IDs to delete (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ deleted: [id], count }`.

**Throws:**

- textError when `node_ids` is missing / non-array / empty / >50, or
any ID does not resolve.

**Warnings (non-error surfaces):**

- Cascade-deletes ALL edges incident on each node, in either
direction. Removal is hard; recovery flows through the audit log,
which records each removal for the retention window.

**See also:** `delete_node`, `batch_delete_edges`, `deduplicate_nodes`


### `batch_move_nodes`

Re-parent up to 50 nodes in a single atomic Postgres transaction. For each move, old containment edges are removed and a new containment edge to new_parent_id is created. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `moves` | array | ✓ | Move operations (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ moved: [{ node_id, new_parent_id }], count }`.

**Throws:**

- textError when `moves` is missing / non-array / empty / >50, or any
`node_id` / `new_parent_id` does not resolve.

**Warnings (non-error surfaces):**

- Heuristic deletion of "old containment" edges relies on LIKE
patterns (`%_contains_%`, `%_has_%`, `%_produces_%`) rather than the
canonical edge catalog. Edges matching the patterns yet semantically
non-containment may be removed alongside the intended ones. A follow-up
will tighten this to catalog-aware classification.

**See also:** `move_node`, `batch_create_edges`, `resolve_edge_for_pair`


### `batch_update_nodes`

Update up to 50 entities in a single atomic Postgres transaction. Properties are merged with existing (not replaced). Unspecified fields are preserved. All-or-nothing: any failure rolls back the entire batch.

**Atomicity:** `atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `nodes` | array | ✓ | Nodes to update (max 50) |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ updated: [id], count }`.

**Throws:**

- textError when `nodes` is missing / non-array / empty / >50, or any
item is missing `id`, or any `id` does not resolve.

**Warnings (non-error surfaces):**

- Properties merge with `||`: top-level keys overwrite while nested
keys stay shallow (deep-merge stays out of scope). To clear a property,
pass it as `null`. Items with no setClauses (every field undefined) are
silently skipped.

**See also:** `update_node`, `batch_create_nodes`, `migrate_type`


## Validation

_Schema drift detection across entity types, edge types, and properties._

- [`validate_graph`](#validate-graph)

### `validate_graph`

Validate a product graph for schema drift. Detects entity type drift (unknown types), edge type drift (unknown edge types), and property drift (missing expected properties, sampled over 500 nodes). Dangling edge checks are enforced by Postgres FK constraints and not re-reported here.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Always true for validate_graph (validation is read-only). |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ valid, product_id, summary, entity_type_drift,
edge_type_drift, property_drift, notes }`.

**Throws:**

- textError when `product_id` is missing or the product
is not visible to the caller.

**Warnings (non-error surfaces):**

- *Property drift is sampled** (first 500 nodes by id order);
for products beyond 500 nodes the drift list is incomplete. Each
reported type carries one example node id; run again or query
`list_nodes` for full coverage.

**See also:** `migrate_type`, `migrate_cross_edges`, `rename_edge_type`, `list_anti_patterns`, `list_type_migrations`, `list_edge_migrations`, `inspect`


## Migrations

_Catalog-aware retypes and cross-product-edge relocation._

- [`migrate_cross_edges`](#migrate-cross-edges)
- [`migrate_type`](#migrate-type)

### `migrate_cross_edges`

Find edges in upg.edges that carry a cross-product edge type and move them to upg.cross_product_edges. Cross-product edge types belong in the cross-product table; this tool corrects data from before the tightening. Defaults to dry_run=true.

**Atomicity:** `atomic-with-rollback (false only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Default true: report what would move without moving. |
| `product_id` | string | ✓ | Product ID |

**Returns:**

JSON: `{ product_id, migrated, count, dry_run }`.

**Throws:**

- textError when `product_id` is missing.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`; pass `dry_run: false` to commit.
Idempotent on retry: a second `dry_run: false` finds zero matching
intra-product rows and reports `count: 0`. Migrated rows get a fresh
`ce_*` id while the original edge id falls away; the audit log retains
the trail.

**See also:** `list_cross_edge_types`, `list_portfolio_cross_edges`, `validate_graph`, `migrate_type`


### `migrate_type`

Bulk-retype all nodes of one entity type to another within a product. Catalog-aware: after renaming, re-infers edge types for all edges connected to the migrated nodes. Defaults to dry_run=true; pass dry_run=false to apply.

**Atomicity:** `atomic-with-rollback (false only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Default true: count affected nodes without changing anything. |
| `from_type` | string | ✓ | Current entity type to migrate away from |
| `product_id` | string | ✓ | Product ID |
| `to_type` | string | ✓ | New entity type. Must be a valid UPG entity type. |

**Returns:**

JSON: `{ from_type, to_type, affected_nodes, retyped_edges, dry_run }`.

**Throws:**

- textError when `product_id`, `from_type`, or `to_type`
is missing, or when `to_type` is not a known UPG entity type.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`; pass `dry_run: false` to commit.
Idempotent on retry: a second `dry_run: false` finds zero `from_type`
nodes and reports `affected_nodes: 0`. Edge re-inference uses
`resolveContainmentEdge`, so already-canonical edges may change type
when the new pair has a different canonical edge.

**See also:** `validate_graph`, `migrate_cross_edges`, `rename_edge_type`, `list_type_migrations`, `list_entity_types`

