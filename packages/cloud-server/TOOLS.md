# UPG MCP Cloud Server Tool Reference

Reference for the 54 tools exposed by `@unified-product-graph/cloud-server`. Generated from JSDoc on `src/tools/*.ts`; do not edit by hand.

## Contents

- [Products & Audit](#products-audit): 3 tools
- [Context & Traversal](#context-traversal): 5 tools
- [Nodes](#nodes): 11 tools
- [Edges](#edges): 4 tools
- [Framework Exercises](#framework-exercises): 2 tools
- [Areas](#areas): 4 tools
- [Schema](#schema): 1 tool
- [Collaboration](#collaboration): 4 tools
- [Analytics](#analytics): 1 tool
- [Webhooks](#webhooks): 3 tools
- [Spec Introspection](#spec-introspection): 3 tools
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
- [`get_tree`](#get-tree)
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


### `get_tree`

Assemble a canonical tree pattern (ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org) from the product graph. Walks the pattern's type-driven child map over the live graph (drift-proof, follows whatever edge wired each parent to a child of the expected type), roots at the pattern anchor with fallback, and reports structural gaps. Returns nested data, not rendered text.

**Atomicity:** `atomic (read-only). Reads the named product only.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `depth` | number |  | Max levels. Defaults to the pattern's natural depth. |
| `from_id` | string |  | Explicit root node id. Defaults to the pattern's canonical anchor type. |
| `include_properties` | array |  | Node property keys to inline on each tree node. |
| `max_nodes` | number |  | Cap on assembled nodes. The tree is summarised (stats.truncated) rather than silently cut. |
| `pattern` | string | ✓ | Tree pattern id: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org |
| `product_id` | string | ✓ | The product ID |

**Returns:**

JSON: `{ pattern, framework_id?, anchor_type, anchor_used,
anchor_resolved_from?, roots: TreeNode[], stats: { nodes, levels, truncated },
gaps: [{ node_id, type, title, missing }] }`. Structured data, never rendered text.

**Throws:**

- textError when `product_id` or `pattern` is missing or `pattern` is unknown.

**See also:** `query`, `list_playbooks`


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

Returns the schema for a UPG entity type: valid parent→child edges, properties, lifecycle phases. Optional `include` folds in valid child types / super-domain region; optional `resolve_edge_to` folds in the canonical edge for this type → that target.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `include` | array |  | Optional extra blocks: "valid_children" (folds get_valid_children), "region" (folds get_region_for_entity_type). |
| `resolve_edge_to` | string |  | Optional target entity type. Folds resolve_edge_for_pair(type → target) into a `resolve_edge` block. |
| `type` | string | ✓ | The UPG entity type (e.g. "feature", "persona") |

**Returns:**

JSON: `{ type, alias_of?, domain, expected_properties,
edges_out, edges_in, phases?, initial_phase?, terminal_phases?,
domain_guide?, valid_children?, region?, resolve_edge? }`.

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

_Spec snapshot: playbooks, approaches, domains, frameworks, edge catalogue, regions, lenses, type labels, entity meta, anti-patterns, benchmarks, product stages, plus the curated starter-template library (`list_templates` / `get_template`)._

- [`get_catalog_entry`](#get-catalog-entry)
- [`get_spec_version`](#get-spec-version)
- [`list_catalog`](#list-catalog)

### `get_catalog_entry`

Fetch one static spec catalog record by `kind` + `id` (one faceted tool replacing the 15 `get_*-by-id` spec-introspection tools). Reads `@unified-product-graph/core`. `id` is the record identifier for that kind: `playbook`/`framework`/`lens`/`scale`/`anti_pattern`/`tree_pattern`/`domain_ring`/`region`/`approach` take their record id; `entity_meta` takes an entity-type name; `edge_type` takes an edge-type key; `lifecycle`/`type_label` take an entity type; `domain_guide` takes a domain id; `template` takes a template id. Use `list_catalog` to enumerate a kind.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | The record identifier for that kind (see the tool description for the per-kind id meaning). |
| `kind` | `entity_meta` \| `edge_type` \| `region` \| `domain_guide` \| `domain_ring` \| `framework` \| `lens` \| `lifecycle` \| `playbook` \| `scale` \| `anti_pattern` \| `tree_pattern` \| `type_label` \| `template` \| `approach` | ✓ | Which static spec catalog to read one record from. |

**Returns:**

JSON: the delegated `get_<kind>` record verbatim (shape varies by kind).

**Throws:**

- textError when `kind` or `id` is missing, or the kind is unknown.

**See also:** `list_catalog`, `get_entity_schema`


### `get_spec_version`

Return spec-level metadata for adopter compatibility checks: upg_version, markdown_format_version, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational. Pass `changelog: true` to fold in the spec CHANGELOG (a `whats_new` surface); `since` (a version) returns only newer entries.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `changelog` | boolean |  | When true, include a `changelog` array parsed from the spec CHANGELOG.md. |
| `since` | string |  | With changelog: return only entries strictly newer than this version (e.g. "0.17.0"). |

**Returns:**

JSON: `{ upg_version, markdown_format_version, entity_count, edge_count, domain_count, region_count }`

**See also:** `list_entity_types`, `list_edge_types`, `list_regions`


### `list_catalog`

List a static spec catalog by `kind` (one faceted tool replacing the 25 `list_*` spec-introspection tools). Reads `@unified-product-graph/core`; identical for every client on a given spec version. Kind-specific filters pass straight through: e.g. `playbooks` accepts `region` / `canonical_only` / `framework_id`; `entity_types` accepts `domain` / `maturity` / `deprecated` / `limit` / `cursor`; `benchmarks` requires `benchmark_kind` (`count` | `relationship` | `ratio` | `domain_activation`) plus optional `stage` / `domain`. Use `get_catalog_entry` to fetch one record by id.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `benchmark_kind` | `count` \| `relationship` \| `ratio` \| `domain_activation` |  | Required for kind=benchmarks: which benchmark catalog (remapped to the retired tool's `kind`). |
| `canonical_only` | boolean |  | Filter (playbooks): canonical playbook per region only. |
| `cursor` | string |  | Pagination: opaque cursor from a prior `next_cursor`. |
| `deprecated` | boolean |  | Filter (entity_types): keep only / exclude deprecated types. |
| `domain` | string |  | Filter (entity_types / benchmarks): exact atomic-domain id. |
| `framework_id` | string |  | Filter (playbooks / approaches): exact framework id. |
| `kind` | `entity_types` \| `edge_types` \| `cross_edge_types` \| `regions` \| `domains` \| `domain_rings` \| `frameworks` \| `framework_categories` \| `framework_structure_patterns` \| `lenses` \| `lifecycles` \| `playbooks` \| `scales` \| `anti_patterns` \| `tree_patterns` \| `templates` \| `approaches` \| `type_labels` \| `status_values` \| `product_stages` \| `benchmarks` \| `edge_migrations` \| `scalar_to_edge_migrations` \| `split_migrations` \| `type_migrations` | ✓ | Which static spec catalog to list. |
| `limit` | number |  | Pagination (entity_types / type_labels / frameworks / anti_patterns): page size. |
| `maturity` | string |  | Filter (entity_types): draft \| proposed \| stable \| deprecated \| removed. |
| `region` | string |  | Filter (playbooks): exact UPGRegionId. |
| `stage` | string |  | Filter (benchmarks): UPGProductStage. |

**Returns:**

JSON: the delegated `list_<kind>` payload verbatim (shape varies by kind).

**Throws:**

- textError when `kind` is missing or unknown.

**See also:** `get_catalog_entry`, `get_entity_schema`


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

