# UPG MCP Server: Tool Reference

Reference for the 138 tools exposed by `@unified-product-graph/mcp-server`. Generated from JSDoc on `src/tools/*.ts` (do not edit by hand).

## Contents

- [Context & Session](#context-session): 5 tools
- [Nodes](#nodes): 17 tools
- [Edges](#edges): 9 tools
- [Areas & Change Log](#areas-change-log): 11 tools
- [Workspace & Portfolios](#workspace-portfolios): 38 tools
- [Schema](#schema): 1 tool
- [Spec Introspection](#spec-introspection): 51 tools
- [Cloud Sync](#cloud-sync): 3 tools
- [Validation](#validation): 3 tools

## Context & Session

_Product overview, graph digest, lens-aware session state._

- [`get_graph_digest`](#get-graph-digest)
- [`get_product_context`](#get-product-context)
- [`get_session_context`](#get-session-context)
- [`start`](#start)
- [`update_session_context`](#update-session-context)

### `get_graph_digest`

Pre-computed graph analytics in one call: counts, health, chain completeness, business-area coverage, lifecycle balance. ~500 tokens vs ~5-8K for equivalent manual fetches.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `coverage_profile` | array |  | Batch-4 #22: coverage region ids (the keys of the `coverage` block: identity, understanding, discovery, validation, reaching, converting, building, sustaining, learning, operations) to score against instead of the product stage default. Adds `coverage.profile_summary` (overall_pct over just these regions), so a deliberately-scoped product (e.g. a structural spine) reads its parity without out-of-scope regions dragging the headline down. |
| `if_changed_since` | string |  | Hash from a previous response. Returns { changed: false } if graph unchanged (saves ~470 tokens). |

**Returns:**

JSON object: `{ counts, health, chains, coverage, lifecycle,
lens, lens_digest, _hash }`. ~500 tokens vs ~5-8K for equivalent manual
fetches.

**Examples:**

// Fetch machine-readable graph health metrics (no args required)
// Input:
{}
// Output (truncated):
{
  "counts": { "total": 42, "by_type": { "persona": 3, "job": 7, "feature": 12, "hypothesis": 8 } },
  "health": { "orphan_rate": 0.05, "edge_density": 0.74 },
  "chains": { "hypothesis_total": 8, "hypothesis_untested": 6, "hypothesis_validated": 2 },
  "coverage": {
    "identity":      { "covered": 1, "total": 3, "counted_toward_stage": true,  "types_present": ["product"], "types_missing": ["vision", "mission"] },
    "sustaining":    { "covered": 0, "total": 5, "counted_toward_stage": false, "types_present": [], "types_missing": ["business_model", "revenue_stream", "cost_structure", "unit_economics", "pricing_strategy"] },
    "stage_summary": { "stage": "concept", "regions_counted": 3, "regions_complete": 0, "regions_partial": 1, "overall_pct": 11 }
  },
  "lens": "product",
  "lens_digest": { "personas": 3, "outcomes": 5, "hypotheses_validated": 2 },
  "_hash": "sha256-abc123"
}

**See also:** `get_product_context`


### `get_product_context`

Product summary, entity counts by type, and a human-readable graph overview. Call first to understand the file. Pass include_summary for edge counts, orphans, and edges-by-type.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `if_changed_since` | string |  | Hash from a previous response. Returns { changed: false } if graph unchanged. |
| `include_summary` | boolean |  | Include detailed graph statistics (edge counts by type, orphan count) |

**Returns:**

Markdown string with product header, lens preamble, entity counts,
active-domain creation sequences, and `_hash` footer for `if_changed_since`
diffing.

**Examples:**

// Get the product overview in the default product lens (no args required)
// Input:
{}
// Output (truncated):
"## Checkout Redesign\nAn e-commerce checkout optimisation product.\nStage: build\nLens: product\n\n### 🧭 Product Lens\n- Personas: 3\n- Outcomes: 5\n- Hypotheses: 8 (2 validated)\n\n### Graph Stats\n- Nodes: 42\n- Edges: 31\n- Entity types: 9\n...\n_hash: sha256-abc123"

**See also:** `get_graph_digest`, `get_entity_schema`


### `get_session_context`

Read session context: which skills ran, what was recommended, current focus area. Returns `recommendations_to_avoid`; the deduped list of recommendations already given this session. Pick your next recommendation NOT in that array (data-layer dedup, not prose).

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ lens, skills_invoked, recommendations_given,
recommendations_to_avoid, focus_area, custom, skills_count, last_skill,
last_recommendation }`. `recommendations_to_avoid` is the deduped list of
every recommendation given this session; runners should filter their
next recommendation against this array rather than re-deriving the
dedup rule from prose.

**See also:** `update_session_context`


### `start`

Zero-state on-ramp: "there is nothing here yet, where do I begin?". Reads the live graph and, for an empty or barely-started graph, recommends the first canonical playbook (from UPG_PLAYBOOKS) plus the exact create_node call for its anchor entity. Established graphs are routed to plan / inspect / get_graph_digest instead. Takes no arguments.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ graph_state: "empty" | "young" | "established", product,
node_count, recommended_playbook?, first_action?, recommendation,
next_tools }`. `recommended_playbook` and `first_action` are present only
for empty/young graphs.

**Examples:**

// Input (empty graph):
{}
// Output (truncated):
{
  "graph_state": "empty",
  "node_count": 0,
  "recommended_playbook": { "id": "playbook:users-needs", "name": "Users & Needs", "target_anchor_entity": "persona" },
  "first_action": { "tool": "create_node", "args": { "type": "persona", "title": "<your first persona>" } },
  "recommendation": "Your graph is empty. Begin with the \"Users & Needs\" playbook: create your first persona."
}

**See also:** `plan`, `get_playbook`, `list_playbooks`, `get_graph_digest`


### `update_session_context`

Update session context: register a skill invocation, record a recommendation, set focus area, switch lens, or store custom state for cross-skill coordination.

**Atomicity:** `non-atomic. Session mutates in-memory immediately; lens
persistence flushes the .upg file as a separate side-effect that may
succeed or fail independently of the session update.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `custom` | object |  | Arbitrary key-value pairs for cross-skill state |
| `focus_area` | string |  | Set the current focus area (e.g. "strategy", "validation", "user_research") |
| `lens` | `product` \| `ux_design` \| `engineering` \| `growth` \| `business` \| `research` \| `marketing` \| `competitive` \| `full` |  | Switch the active lens. Changes what context, skills, and gaps are surfaced first. Canonical lens ids (derived from core): product, ux_design, engineering, growth, business, research, marketing, full. |
| `persist_lens` | boolean |  | If true, also save the lens to the .upg file so it persists across sessions |
| `recommendation` | string |  | Record a recommendation given to the user (e.g. "Run /upg-new-strategy to fill strategy gap") |
| `skill_invoked` | string |  | Register that this skill was just invoked (e.g. "upg-show-status") |

**Returns:**

JSON: `{ updated: true, session: SessionContext }` reflecting the
new state.

**See also:** `get_session_context`


## Nodes

_Read, search, traverse, mutate, batch, migrate type/properties/status, dedupe._

- [`batch_create_nodes`](#batch-create-nodes)
- [`batch_delete_nodes`](#batch-delete-nodes)
- [`batch_update_nodes`](#batch-update-nodes)
- [`create_node`](#create-node)
- [`deduplicate_nodes`](#deduplicate-nodes)
- [`delete_node`](#delete-node)
- [`get_node`](#get-node)
- [`get_nodes`](#get-nodes)
- [`get_tree`](#get-tree)
- [`list_nodes`](#list-nodes)
- [`migrate_properties`](#migrate-properties)
- [`migrate_status`](#migrate-status)
- [`migrate_type`](#migrate-type)
- [`promote_scalars_to_edges`](#promote-scalars-to-edges)
- [`query`](#query)
- [`search_nodes`](#search-nodes)
- [`update_node`](#update-node)

### `batch_create_nodes`

Create up to 50 entities in one atomic call, optionally with explicit edges in the same transaction. Reference earlier nodes from `parent_ref` / `edges` by a positional `$N` ("$0", "$1") OR by a batch-local `ref` alias declared on a node (e.g. ref:"persona_dev" then from_ref:"persona_dev"); aliases remove the index-counting that most often breaks a batch. `edges` endpoints also accept existing node IDs. All nodes and edges validate up front; on failure nothing lands and the response carries the full `errors` list plus the alias `ref_map`. Pass `validate_only: true` for a dry-run that reports every would-be error WITHOUT writing.

**Atomicity:** `atomic-with-rollback. Full validation pass first, then commit.
`validate_only` never mutates.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edges` | array |  | Optional edges to create alongside the nodes (same atomic transaction). Each edge's from/to may be a `$N` ref into the `nodes` array, a declared `ref` alias, OR an existing node ID. |
| `expect_product` | string |  | Optional guard: abort if the active product is not this id/title/file. Cheap insurance against a forgotten switch_product writing into the wrong graph. |
| `nodes` | array | ✓ | Array of nodes to create (max 50) |
| `validate_only` | boolean |  | Dry-run: run the full validation pass and report `{ valid, errors, would_create_nodes, would_create_edges }` WITHOUT writing. Lets an agent self-correct the whole batch before committing. |

**Returns:**

JSON: on commit, `{ created, edges, explicit_edges?, count,
warnings? }`. On `validate_only`, `{ validate_only, valid, errors,
would_create_nodes, would_create_edges, ref_map?, warnings? }`. On a failed
commit, a `{ error, errors?, ref_map? }` error envelope.

**Throws:**

- Returns an error envelope when `nodes` is missing/non-array or any
validation fails (the batch is rejected atomically).

**See also:** `create_node`, `batch_create_edges`


### `batch_delete_nodes`

Delete up to 50 entities and their connected edges in one atomic call (all succeed or all fail).

**Atomicity:** `atomic. Validation pass rejects the entire batch before any
mutation lands.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `expect_product` | string |  | Optional guard: abort if the active product is not this id/title/file. |
| `node_ids` | array | ✓ | Array of node IDs to delete (max 50) |

**Returns:**

JSON: `{ deleted, edges_removed, count }`.

**Throws:**

- Returns a textError when `node_ids` is missing/non-array, empty,
longer than 50, or any ID does not resolve.

**See also:** `delete_node`


### `batch_update_nodes`

Update up to 50 entities atomically (all succeed or all fail). Unspecified fields preserved. Properties merge with existing.

**Atomicity:** `atomic. Validation pass rejects the entire batch before any
mutation lands.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `expect_product` | string |  | Optional guard: abort if the active product is not this id/title/file. |
| `updates` | array | ✓ | Array of updates to apply (max 50) |

**Returns:**

JSON: `{ updated, count, warnings? }`. `warnings` carries
lifecycle-phase hints aggregated across the batch.

**Throws:**

- Returns a textError when `updates` is missing/non-array, the array
is empty, longer than 50, or any item references a missing node.

**See also:** `update_node`


### `create_node`

Create one entity, optionally with a parent edge. For 3+ entities, use `batch_create_nodes` instead of looping. Portfolio-scoped types (`portfolio`, `organization`, `product_area`) route to `.upg/portfolio.upg` rather than the active product's `nodes[]`.

**Atomicity:** `atomic-with-rollback. Schema validation runs before mutation.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | Optional description |
| `overwrite_organization` | boolean |  | For type="organization" only. When true, replaces the existing portfolio organisation instead of throwing. |
| `parent_id` | string |  | Parent node ID. Creates an edge automatically. Ignored for portfolio-scoped types. |
| `properties` | object |  | Type-specific fields |
| `status` | string |  | Lifecycle status |
| `tags` | array |  | Freeform tags |
| `title` | string | ✓ | Entity title |
| `type` | string | ✓ | UPG entity type (e.g. "persona", "opportunity"). Portfolio-scoped: "portfolio", "organization", "product_area". |

**Returns:**

JSON: `{ node, edge?, unknown_properties?, warning? }`. The `edge`
field is present only when `parent_id` was supplied and a canonical
hierarchy edge could be inferred. `unknown_properties` and `warning` are
present when the caller passed properties not in the entity's schema.
Pass `strict: true` to reject unknown properties instead of
warning. For portfolio-scoped types the response shape is
`{ node, portfolio_file, written_to, warning? }` where `node` is the
persisted typed record.

**Throws:**

- Returns a textError when `type` or `title` is missing, when the type
is unknown (`UnknownEntityTypeError`), when `strict: true` and unknown
properties are present, or when the underlying store rejects the write.

**See also:** `batch_create_nodes`, `update_node`


### `deduplicate_nodes`

Find duplicate entities and return them grouped. `match: "exact"` (default) groups by identical title + type and can merge (dry_run previews; otherwise keeps one per group and redirects edges from the others). `match: "similar"` is a read-only SUGGESTION pass that surfaces near-duplicates exact matching misses: entities of the same type whose titles are fuzzy-similar (token overlap above `similarity_threshold`), plus metrics that share a `statistical_function` and an area with overlapping titles. It never merges; review the candidates and align them by hand (rename then run an exact pass, or `update_node` / `batch_delete_nodes`).

**Atomicity:** `non-atomic. Merges are applied group-by-group; a mid-flight
error leaves earlier groups merged.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | For match: "exact" only. Preview duplicates without merging (default true). Ignored for "similar", which never mutates. |
| `keep` | string |  | Which duplicate to keep when merging: "newest" (default) or "oldest". |
| `match` | string |  | "exact" (default) groups by identical title + type and can merge. "similar" is a read-only pass that surfaces fuzzy-title and same-statistical_function near-duplicates; it never merges. |
| `similarity_threshold` | number |  | For match: "similar" only. Title token-overlap (Jaccard) above which two same-type entities are flagged. 0 to 1, default 0.6. |
| `type` | string |  | Only check this entity type. Omit to check all types. |

**Returns:**

JSON: with `dry_run: true`, `{ duplicates, total_groups,
total_duplicate_nodes, dry_run, message }`. With `dry_run: false`,
`{ merged: true, groups_merged, nodes_removed, edges_redirected,
strategy }`.

**Throws:**

- Returns a textError when `keep` is provided but is not
`"newest"` or `"oldest"`.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`. Pass `dry_run: false` to commit.
Idempotent on retry: a second `dry_run: false` against an
already-deduplicated graph reports zero merges.

**See also:** `search_nodes`, `list_nodes`, `batch_delete_nodes`, `validate_graph`


### `delete_node`

Remove one entity and all its connected edges. For 3+ entities, use `batch_delete_nodes`.

**Atomicity:** `atomic. Node + cascading edges removed in one mutation.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `node_id` | string | ✓ | The node ID to delete |

**Returns:**

JSON: `{ node, removed_edge_ids }`.

**Throws:**

- Returns a textError when `node_id` is missing or the node does not
exist.

**See also:** `batch_delete_nodes`


### `get_node`

Get a single entity by ID, with full properties and all connected edges.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `compact_edges` | boolean |  | Omit source_title/target_title from edges (saves ~30% on edge-heavy nodes) |
| `id` | string |  | Alias for `node_id`. |
| `node_id` | string | ✓ | The node ID. Alias: `id`. |

**Returns:**

JSON: the node object plus an `edges` array. `compact_edges: true`
omits `source_title` and `target_title` (saves ~30% on edge-heavy nodes).

**Throws:**

- Returns a textError when neither `node_id` nor `id` is provided, or
the node does not exist.

**See also:** `get_nodes`


### `get_nodes`

Batch-fetch up to 50 entities by ID. Returns each node with its edges. Use instead of looping `get_node`. A bare id reads the active product; a qualified `{product_id}/{node_id}` (the form list_registry / export_edges / cross-edges return) reads that product cross-portfolio (read-only for non-active products), so a connective pass can fetch node content across graphs without a switch_product sweep. Cross-product results carry a `product_id`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `compact_edges` | boolean |  | Omit titles from edges |
| `ids` | array | ✓ | Node IDs (max 50). Bare (active product) or qualified `{product_id}/{node_id}` for any product in the workspace. |

**Returns:**

JSON array of node objects with edges. Missing IDs are silently
skipped. May include a `degraded` block when the response was
auto-trimmed to fit.

**Throws:**

- Returns a textError when `ids` is missing/empty or longer than 50.

**Warnings (non-error surfaces):**

- Pre-flight payload guardrail: refuses above
`UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
`UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). 50 edge-heavy nodes can
still cross 50 KB. Pass `compact_edges:true` to halve edge size.
- Auto-degrade: between soft and hard limits, the server
may drop edge titles, optional node fields, or truncate the result list.
Surfaced as `degraded.applied[]` on the response.

**See also:** `get_node`


### `get_tree`

Assemble a canonical tree pattern (ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org) from the active product graph, server-side. Returns NESTED data (roots with children) plus structural `gaps` (nodes whose pattern expects children the graph lacks). Walks the pattern type-driven child map over the live graph, so it follows whatever edge wired a parent to a child of the expected type (no hardcoded edge names to drift). Roots at the pattern anchor, falling back through fallback anchors when the anchor has no nodes or reaches nothing, and reports the substitution in `anchor_resolved_from`/`anchor_used`. Rendering stays in the client. Composes with `query`.

**Atomicity:** `atomic (read-only). Reads the active product only.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `depth` | number |  | Max levels (default = the pattern natural depth; max 12). |
| `from_id` | string |  | Explicit root node id; otherwise the pattern canonical anchor. |
| `include_properties` | array |  | Node property keys to inline on each tree node. |
| `max_nodes` | number |  | Cap on nodes; the tree is summarised (stats.truncated) rather than silently cut (default 400, max 2000). |
| `pattern` | string | ✓ | Tree pattern id: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, or org. |

**Returns:**

JSON: `{ pattern, framework_id?, anchor_type, anchor_used,
anchor_resolved_from?, roots: TreeNode[], stats: { nodes, levels, truncated },
gaps: [{ node_id, type, title, missing }] }`. Structured data, never rendered text.

**See also:** `query`, `list_playbooks`


### `list_nodes`

List entities with filtering, edge inclusion, count-only mode, and pagination. For graph-wide edge enumeration, prefer `export_edges` (flat) or `query` (traversal). `list_nodes(include_edges:true)` is for entity-scoped reads.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `count_only` | boolean |  | Return only the total count, no node data |
| `if_changed_since` | string |  | Hash from a previous response. Returns { changed: false } if graph unchanged. |
| `include_edges` | boolean |  | Include compact edge data (id, type, source, target) per node |
| `limit` | number |  | Max results (default 50, max 200) |
| `offset` | number |  | Skip N results (default 0) |
| `parent_id` | string |  | Filter to children of this node (connected by outgoing edge from parent) |
| `status` | string |  | Filter by status value |
| `tags` | array |  | Filter by tags (matches any) |
| `type` | string |  | Filter by entity type |

**Returns:**

JSON: `{ nodes, total, offset, limit, _hash }`. With
`count_only: true`, returns `{ total, _hash }` only. May include a
`degraded` block when the response was auto-trimmed to fit.

**Warnings (non-error surfaces):**

- Pre-flight payload guardrail: refuses with a steering
error when the estimated response exceeds `UPG_MCP_PAYLOAD_HARD_LIMIT`
(default 150 KB), and attaches a `_warning` field above
`UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). For graph-wide reads,
prefer `query` with a tight projection.
- Auto-degrade: between the soft and hard limits, the
response is automatically truncated. Surfaced as
`degraded.applied: ['truncate_at_count_auto']` on the response.

**See also:** `search_nodes`, `query`


### `migrate_properties`

Apply `UPG_PROPERTY_MIGRATIONS` graph-wide with no type rename or edge migration. Pure property pass over all kinds: `drop_props`, `rename_top_level`, `lift_property_to_top_level`, `drop_when_self_referential`, `remap_property_value` (stale enum values, e.g. the 0.9.12 data_flow / integration_pattern / api_contract / service tightenings), and `reshape_value_to_assessment` (a bare number wrapped into an assessment object on its scale, e.g. the 0.10.2 market_trend impact / relevance). `validate_graph` property_drift now surfaces every value-aware rule, so a graph that went invalid on a tightening points here. Default `dry_run=true` previews the per-rule change set; pass `dry_run=false` to commit. Use when you want property cleanup standalone; `migrate_type` folds the same pass into its rename.

**Atomicity:** `non-atomic. Mutations are applied node-by-node; a mid-flight
error may leave the graph partially migrated.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview changes without applying (default true). Pass false to commit. |

**Returns:**

JSON: `{ top_level_renames, lifted_properties, dropped_props,
dropped_self_referential, dry_run }`.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`. Pass `dry_run: false` to commit.
Re-running with `dry_run: true` after a successful commit reports zero
changes (idempotent on the canonical-properties shape).

**See also:** `migrate_type`, `validate_graph`, `list_type_migrations`


### `migrate_status`

Apply `UPG_STATUS_MIGRATIONS` graph-wide: rewrite legacy lifecycle status values to canonical phase ids. Auto-mode (no filters) selects nodes whose current status is invalid against the entity type's lifecycle and has a registered replacement (the same invariant that drives `validate_graph` lifecycle_drift). Surgical mode (`from_status` + `to_status`) overrides the registry and rewrites every (entity_type?, from_status) match. Nodes with invalid statuses but no registered replacement surface under `skipped_no_migration`. Default `dry_run=true`; pass `dry_run=false` to commit.

**Atomicity:** `per-node. Status writes go through `store.updateNode`
one at a time. Dry-run is read-only.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview changes without applying (default true). Pass false to commit. |
| `entity_type` | string |  | Optional. Restrict the rewrite to nodes of this canonical entity type (e.g. "service", "feature"). |
| `from_status` | string |  | Optional. Restrict the rewrite to nodes whose current status equals this exact value. When provided, `to_status` is required and the registry is bypassed. |
| `to_status` | string |  | Required when `from_status` is provided. The canonical phase id to write. |

**Returns:**

JSON: `MigrateStatusResult`.

**Throws:**

- Returns a textError when `from_status` is provided without
`to_status`, or when `entity_type` is provided but isn't a string.

**Warnings (non-error surfaces):**

- Default is `dry_run: true`. Pass `dry_run: false` to commit.
Idempotent on retry; re-running after a successful commit reports
zero changes (canonical statuses pass the validity check).

**See also:** `migrate_type`, `migrate_properties`, `validate_graph`, `list_lifecycles`


### `migrate_type`

Migrate every entity of one type to another, applying defaults from `UPG_MIGRATIONS`. Three passes commit as one write: (1) node rename, (2) edges through `UPG_EDGE_MIGRATIONS` (catalog-aware renames, direction flips, drops; endpoint guards check post-migration types; uncatalogued edges surface as `unmapped_legacy_edges`), (3) every node through `UPG_PROPERTY_MIGRATIONS` (top-level renames, lifts, drops, self-referential cleanup). Type-specific property rules see the post-rename type.

**Atomicity:** `atomic. Single store-level migration call commits or fails as
one mutation. Note: full graph canonicalisation runs as a side-effect of
any node-type migration, so unrelated legacy edges may also be retargeted.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview changes without applying (default false) |
| `from_type` | string | ✓ | The current entity type to migrate FROM |
| `to_type` | string | ✓ | The new entity type to migrate TO |

**Returns:**

JSON: `{ migrated_nodes, migrated_edges, edge_renames,
dropped_edges, unmapped_legacy_edges, defaults_applied, dry_run }`.
`edge_renames` is `[{ id, from, to, flipped }]`; `dropped_edges` is
`[{ id, from }]`; `unmapped_legacy_edges` is `[{ type, count }]`.
`migrated_edges` is the total mutated count (renames + drops).

**Throws:**

- Returns a textError when `from_type` or `to_type` is missing.

**See also:** `rename_edge_type`, `export_edges`, `update_node`


### `promote_scalars_to_edges`

Apply `UPG_SCALAR_TO_EDGE_MIGRATIONS` graph-wide (P14 conformance): promote scalar properties that name a first-class entity into canonical edges. Per rule: find-or-create the referenced entity by normalized title, link it with the canonical edge, then drop the now-redundant scalar (unless the rule keeps it as an actor display-cache). Lossless (the string becomes a real node) and idempotent (re-running mints/links nothing new). Snapshot the .upg first. Default `dry_run=true` previews the per-rule plan (minted / linked / dropped / skipped); pass `dry_run=false` to commit. The rules are listed by `list_scalar_to_edge_migrations`.

**Atomicity:** `atomic per call (one save)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview changes without applying (default true). Pass false to commit. |

**Returns:**

JSON: the `ApplyScalarToEdgeResult` plus `dry_run`.

**See also:** `list_scalar_to_edge_migrations`, `migrate_properties`


### `query`

Traverse the graph following typed edges. Returns a subgraph (nodes + edges) in a single call. Example: query({ from: "persona", traverse: ["persona_pursues_job", "job_surfaces_need"], depth: 2 })

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `depth` | number |  | Max traversal depth (default 3, max 10) |
| `diff_from` | string |  | Result ID from a previous query. Returns only added/removed nodes since that result. |
| `edge_include` | array |  | Edge fields to return: "id", "type", "source", "target". Empty array = no edges. Default: all fields. |
| `from` | string |  | Start from all nodes of this type |
| `from_id` | string |  | Start from a specific node ID (alternative to from) |
| `include` | array |  | Fields to include per node: "title", "status", "tags", "description", "properties" (default: title, status, type) |
| `limit` | number |  | Max nodes to return (default 200, max 1000) |
| `property_include` | array |  | When "properties" is in include, only return these property keys (e.g. ["severity", "importance"]) |
| `traverse` | array |  | Edge types to follow at each level (in order). If omitted, follows all edges. Prefix with ! to exclude (e.g. "!product_builds_feature"). |

**Returns:**

JSON: `{ nodes, edges, total_nodes, total_edges, _result_id,
truncated?, truncated_at_depth?, diff? }`. The `_result_id` is a cache
handle for `diff_from`; cache holds the last 20 results.

**Throws:**

- Returns a textError when neither `from` nor `from_id` is provided,
or when `from_id` does not exist.

**Warnings (non-error surfaces):**

- Pre-flight payload guardrail: refuses above
`UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
`UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). Tighten with `include`
(e.g. `["title"]`) or `edge_include: []` to drop edges from the wire.

**See also:** `list_nodes`, `get_area_graph`


### `search_nodes`

Search entities by text. Default fields: title (score 3) and description (score 1). Add `fields` to include tags (score 2) and properties (score 1). Results include `matched_field`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `fields` | array |  | Fields to search: "title", "description", "tags", "properties" (default: title + description) |
| `limit` | number |  | Max results (default 20, max 100) |
| `query` | string | ✓ | Search text (case-insensitive substring match) |
| `type` | string |  | Optional type filter |

**Returns:**

JSON: `{ results: Array<{ id, type, title, status, tags,
match_field, score }>, total, searched_fields }`.

**Throws:**

- Returns a textError when `query` is missing.

**See also:** `list_nodes`, `query`


### `update_node`

Update one entity. Unspecified fields are preserved. Passing `type` performs an atomic single-node migration: every incident edge is re-inferred against the catalog and rollback applies on failure. For 3+ entities, use `batch_update_nodes`.

**Atomicity:** `atomic-with-rollback (when `type` is changed); atomic for
shallow-merge patches.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  |  |
| `node_id` | string | ✓ | The node ID to update |
| `properties` | object |  | Merged with existing properties |
| `status` | string |  |  |
| `tags` | array |  |  |
| `title` | string |  |  |
| `type` | string |  | Change the entity type. Atomic single-node migration: validates against UPG_TYPES, rewrites incident edges to canonical types. |
| `unset_properties` | array |  | Property keys to DELETE. Applied after the `properties` merge, so one call can set some keys and drop others. Writing `{ key: null }` only stores a literal null; use this to actually remove a key. Unknown keys are ignored. |

**Returns:**

JSON: `{ node, warning?, unknown_properties?, unset? }`. `warning`
aggregates migration warnings and any unknown-property notice.
`unknown_properties` lists property keys not in the entity's schema.
`unset` lists the keys actually removed. Pass `strict: true` to reject
unknown properties instead of warning.

**Throws:**

- Returns a textError when `node_id` is missing, the type migration
fails, the `status` is not a valid lifecycle phase for the type, when
`strict: true` and unknown properties are present, or when the underlying
store rejects the patch.

**See also:** `migrate_type`, `batch_update_nodes`


## Edges

_Single create/delete/move plus matching atomic batches._

- [`batch_create_edges`](#batch-create-edges)
- [`batch_delete_edges`](#batch-delete-edges)
- [`batch_move_nodes`](#batch-move-nodes)
- [`create_edge`](#create-edge)
- [`delete_edge`](#delete-edge)
- [`export_edges`](#export-edges)
- [`move_node`](#move-node)
- [`rename_edge_type`](#rename-edge-type)
- [`repair_dangling_edges`](#repair-dangling-edges)

### `batch_create_edges`

Create up to 50 edges in one atomic call. Use this for 3+ edges instead of looping `create_edge`. Edge type auto-infers when omitted. Pass `validate_only: true` for a dry-run that reports every would-be error WITHOUT writing.

**Atomicity:** `atomic. Full validation pass before any mutation lands.
`validate_only` never mutates.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edges` | array | ✓ | Array of edges to create (max 50) |
| `expect_product` | string |  | Optional guard: abort if the active product is not this id/title/file. |
| `validate_only` | boolean |  | Dry-run: validate every edge and report `{ valid, errors, would_create_edges }` WITHOUT writing. |

**Returns:**

JSON: on commit, `{ created, count }`. On `validate_only`,
`{ validate_only, valid, errors, would_create_edges }`.

**Throws:**

- Returns a textError (or resolver-enriched envelope) when `edges` is
missing/non-array, empty, longer than 50, or any item references a missing
endpoint or unresolvable edge type. The commit path rejects on the first
error; `validate_only` reports them all.

**See also:** `create_edge`


### `batch_delete_edges`

Delete up to 50 edges in one atomic call (all succeed or all fail).

**Atomicity:** `atomic. Validation pass rejects the batch before any mutation
lands.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_ids` | array | ✓ | Array of edge IDs to delete (max 50) |
| `expect_product` | string |  | Optional guard: abort if the active product is not this id/title/file. |

**Returns:**

JSON: `{ deleted, count }`.

**Throws:**

- Returns a textError when `edge_ids` is missing/non-array, empty,
longer than 50, or any ID does not resolve.

**See also:** `delete_edge`


### `batch_move_nodes`

Apply up to 50 atomic re-parents. All moves validate against the schema first; any failure rolls back the whole batch.

**Atomicity:** `atomic-with-rollback.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `moves` | array | ✓ |  |

**Returns:**

JSON: `{ moves, warnings? }` mirroring the per-move result of
`move_node`.

**Throws:**

- Returns a textError when `moves` is missing/non-array or any move
fails validation.

**See also:** `move_node`


### `create_edge`

Create one edge between two nodes. Edge type auto-infers when omitted. Target accepts an ID, or a title+type pair the server resolves. For 3+ edges, use `batch_create_edges`.

**Atomicity:** `atomic. Single store mutation.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `properties` | object |  | Edge-scoped properties. Only permitted on edge types that opt in (currently framework_exercise_includes_node); rejected on plain semantic edges. |
| `source_id` | string | ✓ | Source node ID |
| `target_id` | string |  | Target node ID |
| `target_title` | string |  | Target node title (alternative to target_id; requires target_type). |
| `target_type` | string |  | Target node type (used with target_title for resolution) |
| `type` | string |  | Edge type. Auto-inferred if omitted. |

**Returns:**

JSON: the created edge object plus optional resolution metadata.

**Throws:**

- Returns a textError when `source_id` is missing, the target cannot
be resolved, or the edge violates the catalog.

**Examples:**

// Wire a persona to a job using the canonical edge type persona_pursues_job
// Input:
{ "source_id": "persona_01", "target_id": "job_03", "type": "persona_pursues_job" }
// Output (truncated):
{
  "edge": { "id": "edge_15", "type": "persona_pursues_job", "source": "persona_01", "target": "job_03" },
  "inferred": false
}

**See also:** `batch_create_edges`, `resolve_edge_for_pair`, `list_edge_types`, `get_edge_type`


### `delete_edge`

Remove one edge by ID.

**Atomicity:** `atomic.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_id` | string | ✓ | The edge ID to delete |

**Returns:**

JSON: the removed edge object.

**Throws:**

- Returns a textError when `edge_id` is missing or does not resolve.

**See also:** `batch_delete_edges`, `export_edges`, `repair_dangling_edges`


### `export_edges`

Flat edge enumeration. Returns every edge of the listed `types` (or all edges when `types` is omitted) as `{id, source, target, type}` with no parent-node payload. Right for migration and canonicalisation passes. Paginates via offset/limit.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `if_changed_since` | string |  | Hash from a previous response. Returns { changed: false } if graph unchanged. |
| `limit` | number |  | Max results (default 500, max 2000) |
| `offset` | number |  | Skip N results (default 0) |
| `types` | array |  | Filter by exact edge-type match. Omit to enumerate every edge in the document. |

**Returns:**

JSON: `{ edges, total, offset, limit, types?, _hash }`. Each edge
carries `{ id, source, target, type, mapping_confidence? }`.

**Throws:**

- Returns a textError when `types` is supplied but is not an array of
strings, or when the page would exceed the hard payload limit.

**See also:** `query`, `list_nodes`


### `move_node`

Atomic re-parent. Removes any existing hierarchy edge and creates a new one to `new_parent_id`. Validates against `UPG_EDGE_CATALOG` first; rolls back fully on failure.

**Atomicity:** `atomic-with-rollback. Pre-validates the new edge before
touching the old one.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `new_edge_type` | string |  | Optional override. Must be a key in UPG_EDGE_CATALOG. If omitted, the edge type is inferred from new_parent.type → node.type. |
| `new_parent_id` | string | ✓ | The new parent node id |
| `node_id` | string | ✓ | The node to re-parent |
| `old_edge_id` | string |  | Required when the node has more than one hierarchy edge. Picks which one to delete. |

**Returns:**

JSON: `{ moved: true, node_id, new_parent_id, new_edge,
old_edge_id?, warning? }`. The internal `removed_edge` field is stripped
from the wire payload.

**Throws:**

- Returns a textError when `node_id` or `new_parent_id` is missing,
when the inferred edge type is invalid, or when the node has multiple
hierarchy edges and `old_edge_id` was not supplied.

**See also:** `batch_move_nodes`


### `rename_edge_type`

Exact-match rename of every edge of type `from` to type `to`, optionally flipping source/target. Single transactional pass. Defaults to `dry_run: true`; pass `dry_run: false` to commit. Low-level primitive: skips catalog validation. Use catalog-aware migration tools for validated renames.

**Atomicity:** `atomic. Single-pass mutation; an empty match-set is a clean
no-op rather than an error.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview without mutating (default true) |
| `flip` | boolean |  | When true, swap source/target on each renamed edge (default false) |
| `from` | string | ✓ | Current edge type (exact match) |
| `to` | string | ✓ | New edge type to assign |

**Returns:**

JSON: with `dry_run: true`, `{ dry_run, from, to, flip, would_rename, sample }`.
With `dry_run: false`, `{ dry_run, from, to, flip, renamed, ids }`.

**Throws:**

- Returns a textError when `from` or `to` is missing, when they are
equal and `flip` is false (no-op), or when `from === to` with `flip: true`
on zero matches (still safe but the call is degenerate).

**See also:** `migrate_type`, `export_edges`


### `repair_dangling_edges`

Inspect or drop edges whose source or target node fails to resolve. Each is classified `expected` (cross-product, sibling not loaded; keep), `suspect` (cross-product, missing product-id annotation), or `corrupt` (broken endpoint on a non-cross edge). Defaults to `dry_run: true`. Pass `dry_run: false` plus `drop: ["suspect", "corrupt"]` to remove.

**Atomicity:** `atomic-with-rollback. Classification runs against the live
document before any mutation; with `dry_run: false`, the drop set is
computed up-front and applied in a single index rebuild.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `drop` | array |  | Classes of dangling edge to drop. Only honoured when dry_run is false. Omit to no-op. |
| `dry_run` | boolean |  | When true (default), returns the classification report without mutating. When false, drops edges matching `drop`. |

**Returns:**

JSON: `{ dry_run, report, dropped?, remaining? }`. `report` is
the pre-action classification. With `dry_run: false`, `dropped` is the
count of edges removed and `remaining` is the post-action report.

**Throws:**

- Returns a textError when `drop` is provided alongside
`dry_run: true` (ambiguous), or when `drop` includes an unknown class.

**Warnings (non-error surfaces):**

- Dropping `corrupt` edges is irreversible. The integrity stamp is
re-computed on next save; a subsequent reload won't bring them back.


## Areas & Change Log

_Product areas, the `.upg-area.json` cwd scoper, and the session change log._

- [`assign_product_to_area`](#assign-product-to-area)
- [`create_area`](#create-area)
- [`create_portfolio`](#create-portfolio)
- [`delete_area`](#delete-area)
- [`get_area_context`](#get-area-context)
- [`get_area_graph`](#get-area-graph)
- [`get_changes`](#get-changes)
- [`list_product_areas`](#list-product-areas)
- [`move_product_to_area`](#move-product-to-area)
- [`remove_product_from_area`](#remove-product-from-area)
- [`update_area`](#update-area)

### `assign_product_to_area`

Place an existing product under a product area (adds it to the area's `products[]` in `.upg/portfolio.upg`). Resolves the area against the portfolio document and auto-registers the product on the portfolio registry. Use after `create_product`, or pass `area_id` to `create_product` directly.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | Product area id (from list_product_areas) |
| `product_id` | string | ✓ | Product id (from create_product / list_local_products) |

**Returns:**

JSON: `{ product_id, container_id, container_kind: "product_area",
container_title?, already_member, registered }`.

**Throws:**

- textError on a missing workspace, an unknown product, or an unknown
area id (the message points at list_product_areas / list_local_products).

**See also:** `attach_product_to_portfolio`, `create_product`


### `create_area`

Create a product area entity in the portfolio document (`.upg/portfolio.upg`). Product areas represent the organisational axis (who owns what). Supports nesting via `parent_area_id`. The portfolio document is created on demand.

**Atomicity:** `atomic per write; the portfolio file is read, mutated, and
flushed in one pass.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | What this area covers |
| `owner` | string |  | Person or team that owns this area |
| `parent_area_id` | string |  | Parent area ID for creating a sub-area |
| `strategic_priority` | `urgent` \| `high` \| `medium` \| `low` \| `none` |  | Strategic priority of this area (canonical Priority scale) |
| `title` | string | ✓ | Area name (e.g. "Search", "Payments") |

**Returns:**

JSON: `{ node, portfolio_file, written_to }`. `node` is the typed
`UPGProductArea` record persisted to `portfolio_areas[]`.

**Throws:**

- Returns a textError when `title` is missing or the portfolio write
fails.

**See also:** `list_product_areas`


### `create_portfolio`

Create a portfolio entity in the portfolio document (`.upg/portfolio.upg`): the investment / grouping container products and operating functions belong to. A first-class wrapper over `create_node({type:"portfolio"})` (closes gap G2 / #39). `kind` sets the posture: owned (default), watched (the only kind that relaxes product grading), or the owned-side groupings strategic / internal / gtm (e.g. a Go-to-Market portfolio of revenue operating_functions). The portfolio document is created on demand.

**Atomicity:** `atomic per write.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | The portfolio's strategic focus |
| `hierarchy_model` | `flat` \| `nested` \| `matrix` |  | How products are structured within this portfolio |
| `kind` | `owned` \| `watched` \| `strategic` \| `internal` \| `gtm` |  | Investment posture / grouping (default owned). Only watched relaxes product grading. |
| `parent_portfolio_id` | string |  | Parent portfolio id for nesting (a sub-portfolio) |
| `title` | string | ✓ | Portfolio name (e.g. "Go-to-Market", "Internal Functions") |

**Returns:**

JSON: `{ node, portfolio_file, written_to }`. `node` is the typed
`UPGPortfolio` record persisted to `portfolios[]`.

**Throws:**

- textError when `title` is missing, `kind` is invalid, or the write fails.

**See also:** `list_portfolios`, `create_area`


### `delete_area`

Delete a product area from `.upg/portfolio.upg`. Guarded: refuses while the area still has products unless `force: true`. Child areas are un-nested (their parent link is cleared) so no parent reference dangles.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | Product area id to delete (from list_product_areas) |
| `force` | boolean |  | Delete even if the area still has products (default false) |

**Returns:**

JSON: `{ message, area_id, deleted, unnested_children: string[] }`.

**Throws:**

- textError on a missing workspace, unknown area, or a non-empty area without
`force`.

**See also:** `create_area`, `remove_product_from_area`


### `get_area_context`

Check whether the current working directory has a `.upg-area.json` that scopes work to a specific product area.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ has_area_context: false }` or
`{ has_area_context: true, area_id, area_name, found_at }`.


### `get_area_graph`

Return the sub-graph (entities and edges) scoped to a product area.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | The product area node ID |
| `depth` | number |  | How many levels deep to traverse (default 3, max 10) |

**Returns:**

JSON: `{ area, nodes, edges, node_count, edge_count }`. May
include a `degraded` block when the response was auto-trimmed.

**Throws:**

- Returns a textError when `area_id` is missing, the node does not
exist, or the node is not a `product_area`.

**Warnings (non-error surfaces):**

- Pre-flight payload guardrail: refuses above
`UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
`UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). Reduce `depth` or use
`query` with a tight projection if the area has many neighbours.
- Auto-degrade: between soft and hard, the server may
compact edges, drop optional node fields, or truncate. Surfaced as
`degraded.applied[]` on the response.

**See also:** `list_product_areas`


### `get_changes`

Mutation log for this session. Verify what was created, updated, or deleted without re-fetching.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `since` | string |  | ISO 8601 timestamp. Only returns changes after this time (default: all session changes). |

**Returns:**

JSON: `{ changes, summary: { create, update, delete }, total }`.
`since` filters to ISO 8601 timestamps after the cutoff.


### `list_product_areas`

List product areas from the portfolio document (`.upg/portfolio.upg`). Returns an empty list when no portfolio document exists yet.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ areas: Array<{ id, title, strategic_priority?,
parent_area_id?, products? }>, total }`.

**See also:** `create_area`, `get_area_graph`


### `move_product_to_area`

Move a product to a different product area: remove it from `from_area_id` (or, when omitted, from every area it currently sits in) and add it to `to_area_id`. Convenience over remove_product_from_area + assign_product_to_area.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_area_id` | string |  | Source area id to remove from; omit to remove from all areas |
| `product_id` | string | ✓ | Product id (from list_local_products) |
| `to_area_id` | string | ✓ | Destination product area id (from list_product_areas) |

**Returns:**

JSON: `{ product_id, to_area_id, to_area_title?, removed_from: string[], added }`.

**Throws:**

- textError on a missing workspace, unknown product, or unknown target area.

**See also:** `assign_product_to_area`, `remove_product_from_area`


### `remove_product_from_area`

Remove a product from a product area's `products[]` in `.upg/portfolio.upg` (the product stays registered on the portfolio and in any other container). The inverse of `assign_product_to_area`.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | Product area id (from list_product_areas) |
| `product_id` | string | ✓ | Product id (from list_local_products) |

**Returns:**

JSON: `{ product_id, container_id, container_kind: "product_area",
container_title?, removed }`. `removed: false` (not an error) when the product
was not a member, so retries are idempotent.

**Throws:**

- textError on a missing workspace or an unknown area id.

**See also:** `assign_product_to_area`, `move_product_to_area`


### `update_area`

Edit a product area in `.upg/portfolio.upg` (title, description, strategic_priority, owner) and/or re-parent it via `parent_area_id`. The mirror of `update_product` for the organisational axis. `parent_area_id` is tri-state: omit to leave unchanged, pass null to un-nest (top-level), or pass an area id to re-parent (rejected if it would create a cycle).

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | Product area id to edit (from list_product_areas) |
| `description` | string |  | New area description |
| `owner` | string |  | Person or team that owns this area |
| `parent_area_id` | string,null |  | Re-parent under this area id; null un-nests (top-level); omit to leave unchanged |
| `strategic_priority` | `urgent` \| `high` \| `medium` \| `low` \| `none` |  | Strategic priority (canonical Priority scale) |
| `title` | string |  | New area title |

**Returns:**

JSON: `{ message, area, updated: string[] }`.

**Throws:**

- textError on a missing workspace, unknown area/parent, a re-parent cycle, or
when no editable field is supplied.

**See also:** `create_area`, `list_product_areas`


## Workspace & Portfolios

_Multi-product discovery, switching, init, cross-product edges._

- [`aggregate_edge_properties`](#aggregate-edge-properties)
- [`attach_product_to_portfolio`](#attach-product-to-portfolio)
- [`audit_axis_overlap`](#audit-axis-overlap)
- [`audit_property_coverage`](#audit-property-coverage)
- [`batch_create_cross_product_edges`](#batch-create-cross-product-edges)
- [`batch_define_canonical_entity`](#batch-define-canonical-entity)
- [`batch_delete_cross_product_edges`](#batch-delete-cross-product-edges)
- [`batch_register_instance`](#batch-register-instance)
- [`clone_structure`](#clone-structure)
- [`compare_classifications`](#compare-classifications)
- [`create_classification_edge`](#create-classification-edge)
- [`create_cross_product_edge`](#create-cross-product-edge)
- [`create_parity_edge`](#create-parity-edge)
- [`create_product`](#create-product)
- [`create_registry_edge`](#create-registry-edge)
- [`define_canonical_entity`](#define-canonical-entity)
- [`delete_cross_product_edge`](#delete-cross-product-edge)
- [`detach_product_from_portfolio`](#detach-product-from-portfolio)
- [`diff_classification`](#diff-classification)
- [`get_organization`](#get-organization)
- [`get_portfolio_tree`](#get-portfolio-tree)
- [`get_workspace_info`](#get-workspace-info)
- [`init_workspace`](#init-workspace)
- [`link_area_to_audience`](#link-area-to-audience)
- [`list_local_products`](#list-local-products)
- [`list_portfolio_cross_edges`](#list-portfolio-cross-edges)
- [`list_portfolios`](#list-portfolios)
- [`list_registry`](#list-registry)
- [`migrate_cross_edges`](#migrate-cross-edges)
- [`portfolio_census`](#portfolio-census)
- [`portfolio_digest`](#portfolio-digest)
- [`portfolio_query`](#portfolio-query)
- [`portfolio_validate`](#portfolio-validate)
- [`promote_to_canonical`](#promote-to-canonical)
- [`register_instance`](#register-instance)
- [`switch_product`](#switch-product)
- [`update_canonical_entity`](#update-canonical-entity)
- [`update_product`](#update-product)

### `aggregate_edge_properties`

Aggregate the distribution of one property across every portfolio cross-edge of a type, optionally grouped by a dimension. The digest of the property layer: turns the by-eye "165 high / 53 medium / 0 low, mediums cluster on ext_api_sdk" count over a `jq` dump into one call. `property` defaults to `confidence` (an assessment-object property buckets by its `label`). `group_by`: `none` (one overall distribution, default), `axis` (the classification axis the target value belongs to), `competitor` (the source node), or `value` (the target value). Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document only; never mutates.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_type` | string | ✓ | Cross-edge type to aggregate (e.g. competitor_classified_as_classification_value). |
| `group_by` | `none` \| `axis` \| `competitor` \| `value` |  | Dimension to group the distribution by. Default none (one overall distribution). |
| `property` | string |  | The edge property whose distribution to compute. Default confidence. |

**Returns:**

JSON: `{ shape: "edge_property_aggregate", edge_type, property,
group_by, total, with_property, without_property, overall: [{ key, count }],
groups?: [{ group, group_label?, total, with_property, distribution }] }`.
`overall` is the whole-type distribution; `groups` appears when `group_by` is
not `none`.

**See also:** `audit_property_coverage`, `list_portfolio_cross_edges`


### `attach_product_to_portfolio`

Place an existing product under a portfolio (adds it to the portfolio's `products[]` in `.upg/portfolio.upg`). Resolves the portfolio against the portfolio document and auto-registers the product on the portfolio registry. Use after `create_product`, or pass `portfolio_id` to `create_product` directly.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `portfolio_id` | string | ✓ | Portfolio id (from list_portfolios) |
| `product_id` | string | ✓ | Product id (from create_product / list_local_products) |

**Returns:**

JSON: `{ product_id, container_id, container_kind: "portfolio",
container_title?, already_member, registered }`.

**Throws:**

- textError on a missing workspace, an unknown product, or an unknown
portfolio id (the message points at list_portfolios / list_local_products).

**See also:** `assign_product_to_area`, `create_product`


### `audit_axis_overlap`

List every classified source that holds MORE THAN ONE value on a single-select classification axis (the stale-edge symptom a reclassification leaves when the prior same-axis edge is not retired). From 0.11.3 the classify writer supersedes by default, so this is the regression guard (a clean graph returns `overlaps: []`) and the detector for overlaps already in a graph. A `multi`-select axis is exempt; unaxed values are skipped. Titles resolve to entity names. Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document only; never mutates.`

_No arguments._

**Returns:**

JSON: `{ total, overlaps: Array<{ source, source_title?, axis,
axis_label, values: [{ value, value_label, edge_id, assessed_on? }] }> }`.
`total` is the number of (source, single-select axis) pairs with > 1 value.

**See also:** `create_classification_edge`, `get_portfolio_tree`


### `audit_property_coverage`

Audit which portfolio cross-edges of a given type are MISSING required `properties` keys (the completeness check for a property backfill, without a shell over `portfolio.upg`). Given `edge_type` and `required_keys`, returns the edges that lack any of them, plus (when `check_values`) the edges whose present values fail the type property schema. Resolves entity titles. Example: `audit_property_coverage({ edge_type: "competitor_classified_as_classification_value", required_keys: ["confidence", "assessed_on"] })` returns `missing: []` once every classify edge carries both. Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document only.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `check_values` | boolean |  | Also report edges whose PRESENT properties fail the type property schema (off-scale, missing nested keys). Default true. |
| `edge_type` | string | ✓ | Cross-edge type to audit (e.g. competitor_classified_as_classification_value). |
| `required_keys` | array | ✓ | The properties keys that should be present on every edge of this type (e.g. ["confidence", "assessed_on"]). |
| `source_product_id` | string |  | Restrict to edges whose source node is in this product. |

**Returns:**

JSON: `{ edge_type, required_keys, total, complete,
missing: [{ edge_id, source, target, source_title?, target_title?,
missing_keys }], malformed?: [...] }`.

**See also:** `list_portfolio_cross_edges`, `get_portfolio_tree`


### `batch_create_cross_product_edges`

Create up to 50 cross-product edges in one atomic write (the portfolio-tier mirror of batch_create_edges). Every edge is validated and qualified before anything is written; if any is invalid the whole batch is rejected. Referenced products are auto-registered.

**Atomicity:** `atomic. All edges validated first, then a single portfolio.upg flush.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `auto_create_portfolio` | boolean |  | Create an empty portfolio document if none exists (default false) |
| `dry_run` | boolean |  | Forecast the batch without mutating: returns { dry_run: true, would_counts, edges:[{ would, edge }] } and writes nothing. The pre-flight that makes a large backfill safe to reason about. |
| `edges` | array | ✓ | Cross-product edges to create (max 50). Each: { source_id, target_id, type, source_product_id?, target_product_id? }. |
| `supersede` | boolean |  | Classification edges only. Retire a prior same-axis edge when a classify write moves a source on a single-select axis (default true). Set false to keep both (additive). |

**Returns:**

JSON: `{ message, created: UPGCrossEdge[], count, portfolio_file,
registered_products? }`.

**Throws:**

- textError when `edges` is missing/empty/oversized, when any edge is invalid,
or when no portfolio document exists (pass `auto_create_portfolio: true` to mint one).

**See also:** `create_cross_product_edge`, `list_cross_edge_types`


### `batch_define_canonical_entity`

Batch-create canonical registry entities in one atomic call (the migration counterpart to `define_canonical_entity`). Validates every entity up front (valid type, unique id) then writes all and flushes once, so a registry stand-up is a handful of batches, not one call per canonical.

**Atomicity:** `validate-all-then-write. A single invalid entity rejects the whole batch.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entities` | array | ✓ | Up to 50 canonical entities. |

**Returns:**

JSON: `{ defined: [{ canonical_id, qualified_id, type, title }], count, portfolio_file }`.

**See also:** `define_canonical_entity`


### `batch_delete_cross_product_edges`

Delete up to 50 cross-product edges from `.upg/portfolio.upg` by id in one atomic write (the inverse of batch_create_cross_product_edges). All ids are removed, then a single portfolio flush persists the batch, so retiring a wave of superseded edges costs one write instead of one per id. A missing id is reported deleted: false, not an error, so the call is idempotent. Get ids from list_portfolio_cross_edges.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_ids` | array | ✓ | Cross-product edge ids to delete (max 50, from list_portfolio_cross_edges). |

**Returns:**

JSON: `{ message, deleted: [{ edge_id, deleted, edge? }], count, counts }`.

**Throws:**

- textError when `edge_ids` is missing/empty/oversized or no portfolio exists.

**See also:** `delete_cross_product_edge`, `batch_create_cross_product_edges`


### `batch_register_instance`

Batch-register product instances against canonical entities in one atomic call (the migration counterpart to `register_instance`). Validates every instance up front (canonical exists, same-type) then writes all `instance_of` edges and flushes once. Per-instance idempotent; `alias` honoured per instance.

**Atomicity:** `validate-all-then-write. A single invalid instance rejects the whole batch.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `instances` | array | ✓ | Up to 50 instances. |

**Returns:**

JSON: `{ results: [...], registered, already_existed, count, portfolio_file }`.

**See also:** `register_instance`


### `clone_structure`

Stamp the SHAPE of one product (typed nodes + canonical edges + hierarchy, with `TODO:` placeholder titles) into another, without re-authoring the skeleton. Content (descriptions, properties, real titles, statuses) never crosses; only the structure does. The lever for multi-product structural parity: one stamp plus a content pass replaces a multi-batch rebuild. `from_product` is the read-only exemplar; `into` is the write target and DEFAULTS to the active product (name a non-active product to write there with no `switch_product`). `regions` scopes the clone to entity types in those super-domains. `dry_run: true` previews the plan without writing. Local-only.

**Atomicity:** `atomic-with-rollback on commit (created twins + edges are rolled
back if a hard error lands mid-clone; catalog-invalid source edges are
skipped and reported, not fatal). `dry_run` never writes.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Preview the plan (counts by type, edges, sample titles) without writing. Default false. |
| `from_product` | string | ✓ | Exemplar product (id, file, or basename) whose shape is copied. Read-only. |
| `into` | string |  | Target product to stamp the shape into. Defaults to the ACTIVE product; name a non-active product to write there without switch_product. |
| `regions` | array |  | Optional region ids (or labels) to scope the clone to entity types in those super-domains. Omit to clone the whole shape. |

**Returns:**

JSON: on `dry_run`, `{ dry_run, from, into, into_is_active,
would_clone: { nodes, edges, by_type }, region_scope?, unmatched_regions?,
target_existing_stubs?, sample_titles }`. On commit, `{ cloned: true, from,
into, into_is_active, nodes_created, edges_created, edges_skipped?, by_type,
warnings? }`.

**Throws:**

- Returns a textError when `from_product` is missing/unresolvable, when
`into` is unresolvable, when source and target are the same product, or when
the source has no clonable shape under the given scope.

**See also:** `portfolio_validate`, `batch_create_nodes`, `switch_product`


### `compare_classifications`

Compare two classified nodes (competitors) axis-by-axis: where they AGREE (same classification_value), DIVERGE (different values), or where only one has been graded. The bridge from the classification layer to the parity layer: `create_parity_edge` writes a parity relationship, this derives which axes warrant one. Reuses the same per-node profile assembly as `get_portfolio_tree` competitor_profile, so axis / value / confidence resolution is identical, then joins the two. Divergences are ordered first (the actionable rows). Titles resolve to entity names. Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document and, for title
resolution, referenced product files read-only; never mutates active state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `a` | string | ✓ | First node to compare (qualified or bare id, e.g. p_rival/n_acme or a registry competitor id). |
| `axis` | string |  | Restrict the comparison to one classification axis (bare or qualified id). Omit to compare across every axis either node is graded on. |
| `b` | string | ✓ | Second node to compare (qualified or bare id). |

**Returns:**

JSON: `{ shape: "comparison", a, b, axes: Array<{ axis, axis_label,
a: [{value, value_label, confidence?}], b: [...], status }>, stats:
{ shared_axes, agreements, divergences, a_only, b_only } }`. Divergences are
ordered first (the actionable rows).

**See also:** `get_portfolio_tree`, `create_parity_edge`


### `create_classification_edge`

Place a node in a classification cell, carrying optional confidence and provenance as edge metadata (confidence / assessed_on / rationale / evidence). A typed convenience over the generic edge writers, mirroring create_parity_edge: it picks the edge type from the source node type (a competitor source writes competitor_classified_as_classification_value; any other node writes the polymorphic node_classified_as_classification_value), expands a friendly confidence (low/medium/high) into the canonical confidence_5 assessment, defaults assessed_on to today, and routes automatically. A registry/{value} target (or a supplied node_product_id) writes a cross-edge; a bare local value writes a catalogue edge.

**Atomicity:** `inherits the delegated writer's atomicity.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `assessed_on` | string |  | ISO date the classification was made or last re-checked. Defaults to today. |
| `auto_create_portfolio` | boolean |  | Cross mode only: create an empty portfolio document if none exists (default false). |
| `classification_value_id` | string | ✓ | The target classification_value. Bare for a local value, or registry/{value} for a canonical. |
| `confidence` | `low` \| `medium` \| `high` |  | Confidence this node belongs in this cell. Expanded to a confidence_5 assessment. |
| `evidence` | string |  | A source URL, or a competitor_signal / evidence node id backing the classification. |
| `node_id` | string | ✓ | The node being classified (the edge source). Bare, or {product_id}/{node_id}. |
| `node_product_id` | string |  | Cross mode: product id holding node_id (defaults to the active product). |
| `rationale` | string |  | Short note on why this node sits in this cell. |
| `supersede` | boolean |  | When this classifies the source to a new value on a single-select axis, retire its prior same-axis edge (default true) and record the move in the reclassification history. Set false to keep both values (additive). A multi-select axis always keeps both. |

**Returns:**

JSON: the created edge (within-graph or cross-product shape).

**See also:** `create_cross_product_edge`, `create_edge`


### `create_cross_product_edge`

Create a cross-product relationship between two entities in different products within a portfolio graph. Types: `shares_persona`, `shares_competitor`, `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`, `hosts` (host product runs the hosted product inside itself, directed host to hosted), `contributes_to` (a product strategy entity rolls up to a higher-level one, e.g. product objective → company objective; directed subordinate to superior), `rolls_up_to` (a product metric feeds a company/portfolio metric, e.g. a product KPI → a company north-star; directed feeder to feed, same-type metric → metric). For `instance_of` use `register_instance`; for `area_serves_persona` / `area_targets_market_segment` use `link_area_to_audience`.

**Atomicity:** `non-atomic. Portfolio file create (if new) + edge append are
separate filesystem operations.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | Forecast the write without mutating: returns { dry_run: true, would: create \| update \| unchanged, edge } and writes nothing. Use to reason about a write before running it. |
| `properties` | object |  | Edge metadata, accepted only for cross-edge types declared carries_properties (e.g. feature_rivals_competitor_feature, carrying the parity assessment parity_status / quality / is_gap / assessed_on / evidence / confidence). Rejected for types that do not carry properties. |
| `source_id` | string | ✓ | Source node ID |
| `source_product_id` | string |  | Product ID of the source node |
| `supersede` | boolean |  | Classification edges only. When a classify write moves a source to a new value on a single-select axis, retire the prior same-axis edge (default true) so the source carries one current value. Set false to keep both (additive). A multi-select axis always keeps both. |
| `target_id` | string | ✓ | Target node ID |
| `target_product_id` | string |  | Product ID of the target node |
| `type` | `shares_persona` \| `shares_competitor` \| `shares_metric` \| `shares_job` \| `shares_need` \| `depends_on_product` \| `cannibalises` \| `succeeds` \| `hosts` \| `contributes_to` \| `rolls_up_to` \| `product_implements_specification` \| `product_exposes_specification` \| `feature_conforms_to_specification` \| `api_contract_speaks_specification` \| `product_exposes_primitive` \| `feature_manipulates_primitive` \| `primitive_stored_as_data_type` \| `persona_delegates_to_persona` \| `feature_rivals_competitor_feature` \| `competitor_signal_maps_to_feature` \| `competitor_signal_surfaces_opportunity` \| `competitor_classified_as_classification_value` \| `node_classified_as_classification_value` \| `product_pursues_outcome` \| `product_targets_objective` \| `product_guided_by_vision` \| `product_fulfils_mission` \| `product_organises_around_strategic_theme` \| `product_stands_on_strategic_pillar` \| `product_invests_in_initiative` \| `product_measures_with_metric` \| `outcome_measured_by_metric` \| `objective_achieved_through_key_result` \| `objective_measured_by_metric` \| `key_result_quantified_by_metric` \| `strategic_theme_pursues_initiative` \| `strategic_theme_delivers_outcome` \| `strategic_theme_measured_by_key_result` \| `strategic_theme_contains_objective` \| `initiative_drives_outcome` \| `product_expresses_brand_identity` \| `screen_renders_design_component` \| `screen_markets_product` \| `screen_targets_competitor` \| `feature_surfaces_product` \| `feature_uses_design_component` \| `product_implements_design_system` \| `node_owned_by_team` \| `node_owned_by_department` \| `objective_advances_outcome` \| `journey_phase_realises_operating_stage` | ✓ | Cross-product relationship type |

**Returns:**

JSON: `{ edge, portfolio_file }`.

**Throws:**

- Returns a textError when parameters are missing or invalid, or
when the workspace is not initialised.

**See also:** `list_portfolios`, `list_portfolio_cross_edges`, `migrate_cross_edges`


### `create_parity_edge`

Create the parity / rivalry edge `feature_rivals_competitor_feature` from our `feature` to a `competitor_feature`, carrying the assessment (parity_status / quality / is_gap / assessed_on / evidence / confidence) as edge metadata. A typed convenience over the generic edge writers: it fixes the edge type, validates the parity enums, derives `is_gap` from `parity_status` when omitted, and routes automatically. Within the active graph it writes a catalogue edge (like `create_edge`); cross-product (their `competitor_feature` in a separate watched intelligence graph) it writes a cross-edge (like `create_cross_product_edge`), with the our-side product defaulting to the active product. The edge is authoritative; the node `parity_status` is a denormalised single-rival cache that `validate_graph` checks for divergence.

**Atomicity:** `inherits the delegated writer's atomicity.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `assessed_on` | string |  | ISO date the assessment was made. |
| `auto_create_portfolio` | boolean |  | Cross mode only: create an empty portfolio document if none exists (default false). |
| `competitor_feature_id` | string | ✓ | Their competitor_feature node id (the target). Bare for within-graph, or {product_id}/{node_id} for a competitor in a separate watched graph. |
| `competitor_product_id` | string |  | Cross mode: product id of the watched graph holding the competitor_feature. |
| `confidence` | `low` \| `medium` \| `high` |  | Confidence in the assessment. |
| `evidence` | string |  | Free text, or an evidence / competitor_signal node id backing the assessment. |
| `feature_id` | string | ✓ | Our feature node id (the rivalry edge source). Bare, or {product_id}/{node_id} in cross mode. |
| `feature_product_id` | string |  | Cross mode: product id of our feature (defaults to the active product). |
| `is_gap` | boolean |  | Gap in our offering. Defaults to true when parity_status is behind or unique_to_them. |
| `parity_status` | `ahead` \| `behind` \| `parity` \| `unique_to_us` \| `unique_to_them` | ✓ | Our standing versus theirs on this feature. |
| `quality` | `better` \| `same` \| `worse` \| `missing` |  | Relative quality of our equivalent. |

**Returns:**

JSON: the created edge (within-graph `create_edge` shape, or the
cross-product `{ edge, portfolio_file }` shape).

**See also:** `create_edge`, `create_cross_product_edge`, `validate_graph`


### `create_product`

Create a sibling .upg product in the current workspace. Mints a canonical product id, writes the file, stamps integrity, registers in `workspace.json`. Pairs with `init_workspace` and `switch_product`.

**Atomicity:** `non-atomic. File write + workspace.json patch + optional
portfolio edge are separate mutations.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string |  | Optional product_area id (resolved against portfolio.upg) to place the new product under. |
| `description` | string |  | Optional product description |
| `dir` | string |  | Optional subfolder under .upg/ to write the graph into (e.g. "competitors"). The file lands at .upg/<dir>/<slug>.upg and is registered in workspace.json with that subpath, so a watched portfolio can keep its intelligence graphs in competitors/. Absent writes flat at .upg/<slug>.upg. No leading slash or "..". |
| `member_kind` | `product` \| `org_rollup` \| `watched` \| `operating_function` |  | Workspace member kind. product (default) = a product under management; org_rollup = the company umbrella graph; watched = a monitored intelligence graph (e.g. a competitor); operating_function = a function a team operates (revenue/success/finance/people/marketing), not a product it ships. Stamped into $upg.member_kind and cached in workspace.json; non-product kinds are excluded from counts.products and graded on their own validation profile (product-spine anti-patterns are suppressed). |
| `name` | string | ✓ | Product display title (required, non-empty). |
| `portfolio_id` | string |  | Optional portfolio id (resolved against portfolio.upg) to place the new product under. A portfolio id that resolves only in the active graph still attaches via an in-graph edge (DEPRECATED; prefer attach_product_to_portfolio). |
| `slug` | string |  | Optional slug for the .upg filename. Defaults to a slug derived from `name`. Collisions append `-2`, `-3`, … |
| `stage` | string |  | Product lifecycle stage. See UPGProductStage in @unified-product-graph/core. |

**Returns:**

JSON: `{ message, ...result }`. `result` carries `id`, `title`,
`slug`, `file_path`, and the optional portfolio edge.

**Throws:**

- Returns a textError when the workspace is uninitialised
(`WorkspaceNotInitialisedError`) or the name is invalid
(`InvalidProductNameError`).

**See also:** `init_workspace`


### `create_registry_edge`

Create a canonical-internal edge between two registry entities: the authoring path for `registry.edges`. Canonical entities relate to one another (a registry specification governed_by a registry organization, a primitive defined_by a specification, a specification that extends another specification). These edges live in the portfolio registry and never touch product graphs. Validates that both endpoints exist in the registry, the type is a real `UPG_EDGE_CATALOG` edge, and the catalog source_type/target_type match the two nodes (the canonical edge for the pair). Idempotent: an identical edge (same source/target/type) already present is returned, not duplicated.

**Atomicity:** `non-atomic. Registry edge append to the portfolio document.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_id` | string | ✓ | Source registry entity id (bare or registry/{id}). |
| `target_id` | string | ✓ | Target registry entity id (bare or registry/{id}). |
| `type` | string | ✓ | A UPG_EDGE_CATALOG edge type whose endpoint types match the two registry nodes (see resolve_edge_for_pair). |

**Returns:**

JSON: `{ edge, source, target, portfolio_file, already_existed? }`.

**See also:** `define_canonical_entity`, `list_registry`


### `define_canonical_entity`

Define a canonical shared entity in the portfolio registry (the shared-vocabulary tier of `.upg/portfolio.upg`). Use when an archetype is shared across products (a Developer persona, a North-Star metric, a competitor) and should have ONE authoritative definition that product instances link to via `register_instance`. A canonical entity is a normal node of any active entity type (persona, metric, competitor, market_segment, and any other active type) that lives in the registry rather than in a product. Creates the portfolio document if absent. Returns the canonical node and its `registry/{id}` qualified id.

**Atomicity:** `non-atomic. Portfolio file create (if new) + registry append.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `canonical_id` | string |  | Optional explicit registry id; otherwise derived from type + title (e.g. persona_developer). |
| `description` | string |  | Optional longer description of the canonical entity. |
| `properties` | object |  | Optional properties (e.g. a persona's audience_role). |
| `tags` | array |  | Optional tags. |
| `title` | string | ✓ | Canonical name (e.g. "Developer"). |
| `type` | string | ✓ | Any active UPG entity type, including `proposed`-maturity types. There is no canonical allowlist; persona, metric, competitor, market_segment are common examples, not the allowed set. The only gate is that the type is active (see list_entity_types). |

**Returns:**

JSON: `{ canonical, qualified_id, portfolio_file }`.

**See also:** `register_instance`, `list_registry`


### `delete_cross_product_edge`

Delete a cross-product edge from `.upg/portfolio.upg` by id. The inverse of `create_cross_product_edge`. Returns `deleted: false` (not an error) when no edge with that id exists.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `edge_id` | string | ✓ | Cross-product edge id (from list_portfolio_cross_edges) |

**Returns:**

JSON: `{ edge_id, deleted, edge? }`. `deleted: false` (not an error) when
no edge with that id exists, so retries are idempotent.

**Throws:**

- textError on a missing workspace.

**See also:** `create_cross_product_edge`, `list_portfolio_cross_edges`


### `detach_product_from_portfolio`

Remove a product from a portfolio's `products[]` in `.upg/portfolio.upg` (the product stays registered and in any other container). The inverse of `attach_product_to_portfolio`.

**Atomicity:** `atomic (single portfolio.upg flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `portfolio_id` | string | ✓ | Portfolio id (from list_portfolios) |
| `product_id` | string | ✓ | Product id (from list_local_products) |

**Returns:**

JSON: `{ product_id, container_id, container_kind: "portfolio",
container_title?, removed }`. `removed: false` (not an error) when the product was
not a member, so retries are idempotent.

**Throws:**

- textError on a missing workspace or an unknown portfolio id.

**See also:** `attach_product_to_portfolio`


### `diff_classification`

Show what MOVED on the competitive classification landscape: each competitor reclassification (from one classification_value to another on an axis) since a date. Reads the append-only reclassification history auto-recorded at the classify-write chokepoint, so "did AEM move from integrated to agentic" is one call instead of in-head reasoning. Returns transitions with resolved titles (competitor, from, to), sorted newest first. Pairs with `list_portfolio_cross_edges` freshness (which decides WHEN to re-assess); this surfaces WHAT changed. Empty when nothing moved or no history exists. Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document only; never mutates.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `competitor` | string |  | Restrict to one competitor by its qualified id (e.g. p_rival/n_acme). |
| `product` | string |  | Restrict to reclassifications of competitors owned by this product (matched on the competitor id product prefix). |
| `since` | string |  | ISO date. Only transitions observed on or after this date (e.g. 2026-06-01). Omit for all history. |

**Returns:**

JSON: `{ product?, competitor?, since?, total, transitions: Array<{
signal_id, competitor, competitor_title?, axis, from_value, from_title?,
to_value, to_title?, observed_at, confidence?, observed_by? }> }`, newest
first. Empty `transitions` when nothing moved or no history exists.


### `get_organization`

Get the organisation that owns the current workspace's portfolio. Reads the singleton `portfolio.upg.organization`. Returns `{ organization: null }` when no portfolio document exists yet.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ organization: UPGOrganization | null, portfolio_file? }`.
Returns `{ organization: null }` when no portfolio document exists yet.

**See also:** `list_portfolios`


### `get_portfolio_tree`

Assemble a portfolio-grain tree from `.upg/portfolio.upg` (the portfolio complement to `get_tree`, which is product-scoped). `shape: "landscape"` (default) walks the shared classification registry and the `*_classified_as_classification_value` cross edges: classification axis to its values to the nodes classified at each value, every leaf carrying `confidence` / `assessed_on`; anchor at one axis or value with `from_id`, or omit for the whole portfolio. `shape: "competitor_profile"` returns one node (a competitor) and its position on every axis it has been graded against; `from_id` required. `shape: "structure"` returns the org chart from the portfolio DOCUMENT FIELDS (organisation to product areas / portfolios to their member products, nested), no graph traversal; areas are the ownership axis and portfolios the strategic axis, so a product can appear under both. Titles resolve to entity names (e.g. "Directus"), not opaque ids. Values with no wired axis surface under an `unaxed` bucket. Read-only.

**Atomicity:** `atomic (read-only). Reads the portfolio document and, for title
resolution, referenced product files read-only; never mutates active state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_id` | string |  | Anchor node id (qualified or bare). Optional for landscape (a classification axis or value); required for competitor_profile (the node to profile). |
| `include_members` | boolean |  | Landscape only. Force classified members to inline on the whole-portfolio overview (counts-only by default). Subject to the payload guard. |
| `include_properties` | array |  | Classification-edge property keys to inline on each leaf, in addition to the always-included confidence / assessed_on. |
| `shape` | `landscape` \| `competitor_profile` \| `structure` |  | landscape (axis to value to classified members, default), competitor_profile (one node to its per-axis positions), or structure (org to areas / portfolios to products, from document fields). |

**Returns:**

JSON: the landscape or profile structure (see the SDK shapes).

**See also:** `portfolio_digest`, `list_portfolio_cross_edges`, `get_tree`


### `get_workspace_info`

Workspace info: which product is loaded, what other products are available, current workspace mode.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ mode, workspace_path?, current_product?, current_file?,
products }`. The shape depends on whether `.upg/workspace.json` exists.

**See also:** `init_workspace`


### `init_workspace`

Initialise a UPG workspace. Creates `.upg/` and moves the current .upg file into it. Unlocks multi-product management.

**Atomicity:** `non-atomic. The operation creates a directory and (optionally)
moves a file as separate filesystem mutations.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `move_existing` | boolean |  | Move existing .upg files into the workspace (default true) |

**Returns:**

JSON: `{ message, ...result }`. `result` carries the workspace
path and the moved file's new location.

**Throws:**

- Returns a textError when the workspace already exists
(`WorkspaceAlreadyExistsError`) or another filesystem error occurs.

**Warnings (non-error surfaces):**

- One-time setup operation. Idempotent failure on retry: if the
workspace already exists, raises `WorkspaceAlreadyExistsError`. Pair
with `get_workspace_info` to check state before re-running.

**See also:** `create_product`, `switch_product`, `get_workspace_info`


### `link_area_to_audience`

Link a product area to a canonical audience: create an `area_serves_persona` (target is a registry persona) or `area_targets_market_segment` (target is a registry market_segment) cross-edge, with optional `relevance` (primary/secondary) and `audience_role` qualifiers. The edge type is inferred from the canonical entity's type. Source is the product_area id; target is `registry/{canonical_id}`. This is the only path that creates the area↔audience edges. Idempotent: an existing edge is updated (qualifiers), not duplicated.

**Atomicity:** `non-atomic. Edge append to the portfolio document.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `area_id` | string | ✓ | The product_area id (see list_product_areas). |
| `audience_role` | `buyer` \| `user` \| `champion` \| `influencer` \| `partner` |  | The audience role in this area's context (persona targets only). |
| `canonical_id` | string | ✓ | A registry persona or market_segment (bare or registry/{id}). |
| `relevance` | `primary` \| `secondary` |  | Whether this audience is a primary or secondary focus of the area. |

**Returns:**

JSON: `{ edge, area, canonical, portfolio_file, already_existed?, updated? }`.

**See also:** `define_canonical_entity`, `list_product_areas`


### `list_local_products`

Find every .upg file in the current directory and its immediate subdirectories.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ products: Array<{ file, title, stage, nodes, edges }> }`.
`stage` is the CANONICAL UPGProductStage (legacy values like `idea` are
coerced to `concept`), or `null` when unset — matching what
`get_product_context` reports for the same product ( / DT-MCP-3).

**See also:** `switch_product`, `get_workspace_info`


### `list_portfolio_cross_edges`

List cross-product edges stored in the portfolio document (`.upg/portfolio.upg`), optionally filtered, grouped, title-resolved, property-projected, freshness-filtered, and paginated. Empty list when the portfolio document is absent. Use `type` + `group_by` to read a focused comparison matrix; `resolve_titles` (default on) names entities ("Sitecore") instead of opaque ids; `property_include` trims heavy edge properties; `older_than_days` / `assessed_before` return the stale set (edges whose assessed_on is old or absent); `limit` / `offset` page the flat list. For the nested axis to value to members view use `get_portfolio_tree`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `assessed_before` | string |  | Freshness filter: keep only edges assessed before this ISO date (e.g. 2026-06-15). An edge with no assessed_on counts as stale. |
| `group_by` | `source` \| `target` |  | Group edges by source or target endpoint (the comparison matrix) instead of a flat list. |
| `limit` | number |  | Max edges to return in the flat list (ignored when group_by is set). |
| `offset` | number |  | Skip this many edges before the page (flat list only). |
| `older_than_days` | number |  | Freshness filter: keep only edges whose properties.assessed_on is older than this many days (the stale set). An edge with no assessed_on counts as stale. Wins over assessed_before. |
| `property_include` | array |  | Keep only these keys of each edge properties object (e.g. ["confidence"]). Pass [] to drop properties entirely. |
| `resolve_titles` | boolean |  | Add source_title / target_title to each edge, resolved from the registry and instance_of registrations. Default true. |
| `source_product_id` | string |  | Filter to edges whose source node is in this product. |
| `type` | string |  | Filter to one cross-edge type (e.g. competitor_classified_as_classification_value). |

**Returns:**

JSON: flat `{ cross_edges, total, returned, offset?, has_more?,
portfolio_file? }`, or when grouped `{ grouped_by, groups, total,
group_count }`.

**See also:** `get_portfolio_tree`, `create_cross_product_edge`


### `list_portfolios`

List portfolios from the portfolio document (`.upg/portfolio.upg`). Portfolios represent the strategic axis (where we invest). Returns an empty list when no portfolio document exists yet.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ portfolios: Array<{ id, title, description?,
parent_portfolio_id?, hierarchy_model?, products? }>, total }`.

**See also:** `create_cross_product_edge`, `get_organization`


### `list_registry`

List the canonical shared entities in the portfolio registry. Each row carries id, type, title, optional audience_role, and instance_count. With `include_instances`, attaches the product instances (the `instance_of` edges) pointing at each canonical. Empty when no registry exists yet.

**Atomicity:** `atomic (read-only).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `include_instances` | boolean |  | Attach each canonical's product instances (default false). |
| `type` | string |  | Filter to one entity type (e.g. persona). |

**Returns:**

JSON: `{ registry: Array<{ id, type, title, description?,
audience_role?, instance_count?, instances? }>, total, by_type }`. Returns
an empty registry when none exists yet.

**See also:** `define_canonical_entity`, `register_instance`


### `migrate_cross_edges`

Migrate inline cross-product edges from the current product's `edges[]` into the portfolio document (`.upg/portfolio.upg`) with qualified IDs. `dry_run: true` (default) previews; `dry_run: false` applies. Requires `source_product_id` to qualify source node IDs.

**Atomicity:** `non-atomic. Portfolio write + product file save are separate.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `dry_run` | boolean |  | When true (default), report what would be migrated without writing anything. |
| `source_product_id` | string | ✓ | Product ID that owns the current document's nodes. Used to build qualified source IDs ({product_id}/{node_id}). |
| `target_product_id` | string |  | Product ID that owns the target nodes, when the target node is not in the current product. Edges without a resolvable target product are skipped. |

**Returns:**

JSON: `{ migrated, skipped, dry_run, portfolio_file? }`.

**Throws:**

- Returns a textError when `source_product_id` is missing or when the
workspace is not initialised (in non-dry-run mode).

**Warnings (non-error surfaces):**

- Default is `dry_run: true`. Pass `dry_run: false` to commit. Idempotent
on retry: a second `dry_run: false` after a successful migration finds zero
inline cross-edges and reports `migrated: []`.

**See also:** `create_cross_product_edge`, `list_portfolio_cross_edges`, `list_cross_edge_types`, `init_workspace`


### `portfolio_census`

List product-local nodes of ONE type ACROSS the whole portfolio with a chosen projection (the cross-product `list_nodes`). The overflow-safe answer to "every metric across all 16 graphs, with title + description": the read every canonicalisation / coverage pass needs. Unlike `portfolio_query` (which returns full nodes AND traversed edges, and overflows the payload cap past ~195 nodes), a census never traverses and never returns edges, so payload scales only with row count x projected-field size. Each row is `{ product_id, node_id, <projected> }`; `group_by: "product"` nests rows under each product instead. Read-only; never mutates active-product state.

**Atomicity:** `atomic (read-only). Never mutates active-product state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `group_by` | `none` \| `product` |  | none (one flat `rows` list, default) or product (nest rows under each product, the comparison view). |
| `include` | array |  | Projected fields per node: "title", "status", "tags", "description", "properties" (default: ["title"]). id (as node_id) and product_id are always present. |
| `limit` | number |  | Max rows in the returned page (default 1000, max 5000). Pages the flat sequence; `total` reports the full match count. |
| `offset` | number |  | Skip this many rows before the page (default 0). With `limit`, pages a large census. |
| `property_include` | array |  | When "properties" is in include, only return these property keys. |
| `scope` | array |  | Product IDs (or files) to census. Omit to census ALL products in the workspace. Match by product id, relative file, or basename. (`products` is accepted as an alias.) |
| `status` | string |  | Only census nodes with this lifecycle status. |
| `tags` | array |  | Only census nodes carrying at least one of these tags. |
| `type` | string | ✓ | Entity type to census (e.g. "metric", "persona", "primitive"). Required. |

**Returns:**

JSON. Flat (default): `{ type, rows: Array<{ product_id, node_id,
<projected> }>, total, returned, offset, limit, has_more, products_searched,
products_with_matches, errored_products?, unmatched_scope? }`. With
`group_by: "product"`: a `products: Array<{ product_id, file, title, count,
rows: Array<{ node_id, <projected> }> }>` nesting replaces the flat `rows`.
`total` is the full match count across the portfolio; `rows`/`products` hold
the requested page (`offset`/`limit`). Projection defaults to `["title"]`.

**See also:** `list_nodes`, `portfolio_query`, `portfolio_digest`


### `portfolio_digest`

Roll up every product's counts, health, and stage-coverage in one call (the multi-product `get_graph_digest`). The strategic-surface read that otherwise required `switch_product` + `get_graph_digest` per graph. Returns per-product summaries plus a portfolio rollup (totals, products-by-stage). Read-only; never mutates active-product state.

**Atomicity:** `atomic (read-only). Never mutates active-product state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `coverage_profile` | array |  | Batch-4 #22: coverage region ids (keys of the `coverage` block, e.g. understanding, discovery, building) to score each product against, so "is this product at parity?" is a direct read across the portfolio. Adds `coverage_profile_pct` to every product summary. |
| `scope` | array |  | Product IDs (or files) to summarise. Omit to summarise ALL products in the workspace. |

**Returns:**

JSON: `{ products: Array<{ product_id, file, title, stage,
total_nodes, total_edges, health, coverage_pct, top_types }>, rollup:
{ products, total_nodes, total_edges, by_stage }, errored_products?,
unmatched_scope? }`. `health`/`coverage_pct` come from `computeGraphDigest`,
identical to what `get_graph_digest` reports per product.

**See also:** `get_graph_digest`, `portfolio_query`


### `portfolio_query`

Traverse the graph ACROSS products in one call (the multi-product `query`). Runs the same BFS (typed-edge traversal + field projection) against every product in scope and tags each subgraph with its source `product_id`, without `switch_product` (the active product is read live; others are read-only). Use for portfolio-level questions ("every product's strategy region", "which products have a persona"). `from_id` only matches in its owning product. Read-only.

**Atomicity:** `atomic (read-only). Never mutates active-product state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `depth` | number |  | Max traversal depth (default 3, max 10) |
| `edge_include` | array |  | Edge fields to return: "id", "type", "source", "target". Empty array = no edges. Default: all fields. |
| `from` | string |  | Start from all nodes of this type (in each product) |
| `from_id` | string |  | Start from a specific node ID. Node IDs are product-local; only the owning product returns results. |
| `include` | array |  | Fields per node: "title", "status", "tags", "description", "properties" (default: title, status, type) |
| `limit` | number |  | Max nodes per product (default 100, max 1000) |
| `property_include` | array |  | When "properties" is in include, only return these property keys. |
| `scope` | array |  | Product IDs (or files) to query. Omit to query ALL products in the workspace. Match by product id, relative file, or basename. |
| `traverse` | array |  | Edge types to follow at each level (in order). If omitted, follows all edges. Prefix with ! to exclude. |

**Returns:**

JSON: `{ products: Array<{ product_id, file, title, total_nodes,
total_edges, nodes, edges, truncated? }>, products_searched,
products_with_matches, empty_products, unmatched_scope? }`. Products that
matched zero nodes are summarised in `empty_products`, not expanded, to
keep the payload lean. `from_id` only matches in its owning product; the
rest report empty.

**See also:** `query`, `portfolio_digest`, `list_local_products`


### `portfolio_validate`

Run `validate_graph` ACROSS every product in scope in one call (the audit counterpart to `portfolio_digest`). Replaces the `switch_product` + `validate_graph` round-trip per product. Each product is checked by the SAME single-product code path (schema drift + anti-patterns), so per-product verdicts never diverge. Returns a per-product `valid` / `structurally_valid` + drift + anti-pattern counts, plus a portfolio rollup with `all_valid`. Read-only; the active product is read live, the rest read-only.

**Atomicity:** `atomic (read-only). Never mutates active-product state.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `include_violations` | boolean |  | Include a per-product `top_violations` list (default true). |
| `scope` | array |  | Product IDs (or files) to validate. Omit to validate ALL products in the workspace. |
| `severity` | `high` \| `medium` \| `low` |  | Restrict anti-pattern evaluation to this severity (passed through to validate_graph). |
| `violation_limit` | number |  | Max anti-pattern violations listed per product (default 5, max 25). |

**Returns:**

JSON: `{ products: Array<{ product_id, file, title, valid,
structurally_valid, drift, anti_patterns: { high, medium, low },
top_violations? }>, rollup: { products, valid, invalid, structurally_valid,
anti_pattern_violations, all_valid }, errored_products?, unmatched_scope? }`.
`severity` filters anti-patterns; `include_violations: false` drops the
per-product `top_violations` list. When the portfolio has a canonical
registry, a `registry_drift` block reports `instance_of` edges that point at
a missing canonical, dangle, mismatch type, or were renamed off-canon
(canonical-registry initiative, Phase 3). When the portfolio uses the
foundations tier (a registry specification / primitive or a foundations
cross-edge), a `portfolio_anti_patterns` block reports the portfolio-scoped
(`scope: 'portfolio'`) anti-patterns: specification-without-implementer,
primitive-scattered-without-canonical, product-reimplements-specification (0.9.13).

**See also:** `validate_graph`, `portfolio_digest`, `portfolio_query`, `list_registry`


### `promote_to_canonical`

Promote an existing product node into the registry as its canonical, instead of authoring a fresh thinner one with `define_canonical_entity`. Copies the source node's description/tags/properties into a new registry node and (by default) registers the source as the canonical's first instance. Lets a team canonicalise the rich node they already curated.

**Atomicity:** `non-atomic. Registry node add (+ optional instance_of edge) + flush.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `canonical_id` | string |  | Optional explicit registry id; otherwise derived from type + title. |
| `node_id` | string | ✓ | The existing node (bare resolves against active product or source_product_id; or qualified {product_id}/{node_id}). |
| `register_source` | boolean |  | Register the source node as the first instance (default true). |
| `source_product_id` | string |  | Product ID owning a bare node_id. |

**Returns:**

JSON: `{ canonical, qualified_id, registered_source, edge?, portfolio_file }`.

**See also:** `define_canonical_entity`, `register_instance`


### `register_instance`

Link a product node to a canonical registry entity by creating an `instance_of` cross-edge (product entity → `registry/{id}`). This is the only path that creates `instance_of` edges: it requires the canonical to exist and enforces the same-type constraint (a persona instance_of a persona). Idempotent: re-registering the same instance returns the existing edge. Set `alias: true` to sanction a deliberate title divergence (an informative product-local name) so registry drift detection ignores it. Use after `define_canonical_entity` to attach each product's local copy to the shared definition.

**Atomicity:** `non-atomic. Edge append to the portfolio document.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `alias` | boolean |  | Mark a deliberate title divergence from the canonical as sanctioned, excluding it from registry drift. Can be toggled on an existing instance_of edge. |
| `canonical_id` | string | ✓ | The registry entity id (bare, or registry/{id}). |
| `node_id` | string | ✓ | The product instance node. Bare id resolves against the active product (or source_product_id); a qualified {product_id}/{node_id} targets any workspace product. |
| `source_product_id` | string |  | Product ID owning the instance, when node_id is a bare id not in the active product. |

**Returns:**

JSON: `{ edge, instance, canonical, portfolio_file, already_existed? }`.

**See also:** `define_canonical_entity`, `list_registry`


### `switch_product`

Switch to a different .upg file without restarting the server. In workspace mode, accepts just a filename (e.g. "client-project" or "client-project.upg").

**Atomicity:** `non-atomic. Flushes the current store, stops watching, and
loads the new file as separate filesystem operations.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `file` | string | ✓ | Path to the .upg file (relative, absolute, or a bare product name in workspace mode). Alias: `product`. |
| `product` | string |  | Alias for `file`. |

**Returns:**

JSON: `{ message, file, product: { title, stage }, entities }`.

**Throws:**

- Returns a textError when neither `file` nor `product` is provided, or
the file cannot be resolved, or the load fails (file watcher / parse error).

**Warnings (non-error surfaces):**

- Mutates server-side workspace state. After an MCP reconnect the
server reverts to the workspace default. Call `get_workspace_info`
before any read/mutation to confirm the active product.

**See also:** `get_workspace_info`, `list_local_products`, `init_workspace`


### `update_canonical_entity`

Edit a canonical registry entity in place (title, description, audience_role, tags, properties) WITHOUT disturbing the `instance_of` edges that point at it. The fix for a canonical seeded with a typo or placeholder: correct it via the API instead of hand-editing portfolio.upg. Properties are shallow-merged. At least one editable field is required.

**Atomicity:** `non-atomic. In-place registry node patch + flush.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `audience_role` | string |  | Persona audience role (buyer/user/champion/influencer/partner); merged into properties. |
| `canonical_id` | string | ✓ | The registry entity id (bare, or registry/{id}). |
| `description` | string |  | New description. |
| `properties` | object |  | Properties to shallow-merge into the canonical. |
| `tags` | array |  | Replacement tags. |
| `title` | string |  | New canonical name. |

**Returns:**

JSON: `{ canonical, qualified_id, instance_count, portfolio_file }`.

**See also:** `define_canonical_entity`


### `update_product`

Update the product header (`$upg.product`): stage, title, description, health_status, url, and the workspace member_kind. The supported way to advance a product's lifecycle stage or re-kind a graph; it writes the value get_graph_digest reads, without hand-editing the integrity-hashed .upg file. A title rename or a re-kind also reconciles the workspace.json cache and the portfolio.upg registry, so list_local_products, get_workspace_info, portfolio_census, counts.products, and the watched anti-pattern scoping all show the current value. Set rename_file (or pass an explicit slug) to also rename the .upg file to match the title: it moves the file, repoints the open handle so the rest of the session writes to the new path, and updates the workspace.json file path and the portfolio.upg file_path. The rename is opt-in; a plain title change leaves the filename alone.

**Atomicity:** `atomic (single flush).`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `description` | string |  | Product description. |
| `health_status` | string |  | Product health (free-form, e.g. on_track / at_risk). |
| `member_kind` | `product` \| `org_rollup` \| `watched` \| `operating_function` |  | Workspace member kind. product (default, an owned product), org_rollup (company umbrella graph), watched (a monitored intelligence graph, e.g. a competitor), or operating_function (a function a team operates, across revenue/success/finance/people/marketing, not a product it ships). Non-product kinds are excluded from product coverage / counts and graded on their own validation profile. |
| `rename_file` | boolean |  | Rename the .upg file to match the title slug. Opt-in; moves the file and reconciles the open handle, workspace.json path, and portfolio.upg file_path. |
| `slug` | string |  | Explicit slug for the file rename (implies rename_file). Slugified and collision-resolved so a sibling file is never clobbered. |
| `stage` | string |  | Product lifecycle stage (canonical UPGProductStage). |
| `title` | string |  | Product display title. |
| `url` | string |  | Product URL. |

**Returns:**

JSON: `{ product, updated: string[] }` (the fields changed).

**Throws:**

- textError when no field is supplied, when there is no product header,
or when `stage` is non-canonical (same strict validation as create_product).

**See also:** `create_product`


## Schema

_Entity schema introspection. Same constraints the LSP enforces._

- [`get_entity_schema`](#get-entity-schema)

### `get_entity_schema`

Return expected properties, valid statuses, valid edge types, and domain for an entity type. Lets agents construct valid entities without skill prompts.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `type` | string | ✓ | Entity type (e.g. "hypothesis", "persona", "opportunity") |

**Returns:**

JSON: `{ type, alias_of?, domain, expected_properties, edges_out,
edges_in, phases?, initial_phase?, terminal_phases?, domain_guide? }`.

**Throws:**

- Returns a textError when `type` is missing or unknown.

**See also:** `get_entity_meta`, `list_entity_types`, `get_valid_children`, `get_lifecycle`, `get_domain_guide`, `list_edge_types`, `create_node`


## Spec Introspection

_Canonical playbooks, approaches, domain guides, frameworks, edge catalogue, regions, lenses, type labels, hierarchy, version, cross-edges, entity meta, anti-patterns, benchmarks, bare-verb approach handlers, migrations, lifecycles, scales, framework categories/patterns, and domain rings (from `@unified-product-graph/core`), plus the curated starter-template library (`list_templates` / `get_template`, from `@unified-product-graph/templates`)._

- [`apply_framework`](#apply-framework)
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
- [`get_template`](#get-template)
- [`get_tree_pattern`](#get-tree-pattern)
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
- [`list_scalar_to_edge_migrations`](#list-scalar-to-edge-migrations)
- [`list_scales`](#list-scales)
- [`list_split_migrations`](#list-split-migrations)
- [`list_status_values`](#list-status-values)
- [`list_templates`](#list-templates)
- [`list_tree_patterns`](#list-tree-patterns)
- [`list_type_labels`](#list-type-labels)
- [`list_type_migrations`](#list-type-migrations)
- [`plan`](#plan)
- [`prioritise`](#prioritise)
- [`reflect`](#reflect)
- [`resolve_edge_for_pair`](#resolve-edge-for-pair)
- [`score_entity`](#score-entity)
- [`trace`](#trace)

### `apply_framework`

Apply a framework (MoSCoW, RICE, Kano, ...) to a set of entities: creates a framework_exercise node and an `includes` edge to each entity. The per-entity result is recorded on the edge via score_entity, never on the entity node, so the same entity can sit in many exercises and any entity type can be scored. Returns { exercise_id, exercise, included, warnings }.

**Atomicity:** `atomic.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_ids` | array |  | Entities to pull into the exercise (any type). |
| `framework_id` | string | ✓ | Required. UPGFramework.id (e.g. "moscow", "rice-scoring"). |
| `slot_roles` | object |  | Optional map of entity id → framework slot role (e.g. { "feat_x": "pain_reliever" }), stamped onto each entity's includes edge. Validated against the framework's declared slot roles (warn-only). |
| `status` | string |  | Lifecycle phase: draft \| active \| archived (default draft). |
| `title` | string |  | Human label for the exercise (default "<Framework> exercise"). |

**Returns:**

JSON: `{ exercise_id, exercise, included: [{ edge_id, entity_id, edge_type, slot_role? }], warnings }`
(the shared cross-surface envelope; identical to CLI `apply --json`).

**Throws:**

- textError on a missing/unknown framework_id, or when no requested
entity resolves (no dangling exercise is left behind).

**See also:** `score_entity`


### `get_anti_pattern`

Return one curated anti-pattern by id (kebab-case slug, e.g. "features-without-hypotheses", "personas-without-jobs"). Includes structured condition, why-it-matters, remediation, applicable stages, severity, optional source citation. IDs are stable URL fragments.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Anti-pattern id (kebab-case slug). |

**Returns:**

JSON: `UPGCuratedAntiPattern`

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_anti_patterns`, `get_anti_pattern_violations_for`, `inspect`, `validate_graph`


### `get_approach`

Return one `UPGApproach` by id. Valid ids: `plan`, `inspect`, `prioritise`, `trace`, `reflect` (same names as the verb-led MCP tools).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | `plan` \| `inspect` \| `prioritise` \| `trace` \| `reflect` | ✓ | Approach id. One of: plan, inspect, prioritise, trace, reflect. |

**Returns:**

JSON: the full `UPGApproach` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_approaches`, `plan`, `inspect`, `prioritise`, `trace`, `reflect`


### `get_domain_guide`

Return the full `UPGDomainUsageGuide` for a domain: anchor entity, creation sequence, named patterns (entity + edge chains), required cross-domain bridges, anti-patterns.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `domain_id` | string | ✓ | Canonical domain id (e.g. "user", "market_intelligence", "growth"). |

**Returns:**

JSON: the full `UPGDomainUsageGuide` record.

**Throws:**

- textError when `domain_id` is missing or unknown.

**See also:** `list_domains`, `get_domain_ring`, `list_anti_patterns`, `get_playbook`


### `get_domain_ring`

Return one `UPGDomainRing` by id (one of: `nucleus`, `understand`, `define`, `build`, `grow`, `operate`, `extend`). Returns a descriptive message (not an error) when the id is unknown.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Ring id. One of: nucleus, understand, define, build, grow, operate, extend. |

**Returns:**

JSON: the full `UPGDomainRing` record.

**See also:** `list_domain_rings`, `list_domains`, `get_domain_guide`


### `get_edge_type`

Return one edge catalogue entry by edge type key (e.g. "persona_pursues_job", "feature_addresses_need").

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `type` | string | ✓ | Edge type key from UPG_EDGE_CATALOG. |

**Returns:**

JSON: `{ type, forward_verb, reverse_verb, classification, source_type, target_type }`

**Throws:**

- textError when `type` is missing or unknown.

**See also:** `list_edge_types`, `resolve_edge_for_pair`, `list_edge_migrations`, `rename_edge_type`


### `get_entity_meta`

Return one `EntityTypeMeta` record by entity type name, plus resolved `domain_id` (null when unmapped). One type's lifecycle metadata: maturity tier, since-version, replacement target if deprecated. Pass the canonical name (e.g. "persona", "pain_point"), not the immutable `type_id`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string | ✓ | Canonical entity type name. |

**Returns:**

JSON: `EntityTypeMeta & { domain_id: string | null }`

**Throws:**

- textError when `name` is missing or unknown.

**See also:** `list_entity_types`, `get_type_label`, `get_entity_schema`, `list_type_migrations`


### `get_framework`

Return one `UPGFramework` by id (e.g. "rice-scoring", "lean-canvas"). Includes all four layers: data, structure, presentation, education.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `framework_id` | string |  | Alias for `id` (matches the key used by apply_framework / prioritise). |
| `id` | string | ✓ | Framework id (kebab-case). Alias: `framework_id`. |

**Returns:**

JSON: the full `UPGFramework` record.

**Throws:**

- textError when neither `id` nor `framework_id` is provided, or the
id is unknown.

**See also:** `list_frameworks`, `prioritise`, `get_playbook`, `get_approach`


### `get_lens`

Return the full `UPGLens` record by id (e.g. "product", "ux_design", "engineering", "full") plus the resolved entity types visible through that lens. Combines the lens record with `visible_types` in one response.

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

Return the full `UPGLifecycle` definition for one entity type: initial phase, terminal phases, ordered phases with transitions and core states. Returns a descriptive message (not an error) when the type has no lifecycle.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string | ✓ | Canonical entity type name (e.g. "feature", "hypothesis", "opportunity"). |

**Returns:**

JSON: the full `UPGLifecycle` record, or a descriptive message.

**See also:** `list_lifecycles`, `get_entity_meta`, `get_entity_schema`


### `get_playbook`

Return one `UPGPlaybook` by id (e.g. "playbook:strategy-outcomes", "playbook:business-gtm-growth"). Includes the ordered `creation_sequence` with step kinds and prompts. IDs are namespace-prefixed `playbook:*`. For approaches, use `get_approach`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Playbook id (namespace-prefixed: playbook:*). |

**Returns:**

JSON: the full `UPGPlaybook` record.

**Throws:**

- textError when `id` is missing or unknown.

**Examples:**

// Fetch the full Users & Needs playbook to guide entity creation
// Input:
{ "id": "playbook:users-needs" }
// Output (truncated):
{
  "id": "playbook:users-needs",
  "name": "Users & Needs",
  "region": "users_needs",
  "is_canonical": true,
  "target_anchor_entity": "persona",
  "creation_sequence": ["persona", "job", "need", "pain_point"],
  "steps": [
    { "kind": "create", "type": "persona", "prompt": "Who are the primary users?" },
    { "kind": "create", "type": "job", "prompt": "What jobs do they need to accomplish?" }
  ]
}

**See also:** `list_playbooks`, `get_approach`, `get_framework`, `get_region`


### `get_region`

Return the full `UPGRegion` record by id: anchor entity (with rationale and inbound/outbound cross-edge counts), entity memberships with structural roles, intra-domain edge keys, boundary edges to other regions, shape archetype, atomic-domain composition.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Region id (e.g. "strategy_outcomes", "users_needs", "product_delivery"). See UPG_REGIONS for the full list of 10. |

**Returns:**

JSON: the full `UPGRegion` record plus `coverage_keys` and `business_areas`.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_regions`, `get_region_for_entity_type`, `get_playbook`, `list_lenses`


### `get_region_for_entity_type`

Resolve which super-domain region contains a given entity type. Wraps `getRegionForEntityType`; returns the full `UPGRegion` record. Use for adapters and copilots that route or render an entity by its super-domain.

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

Return one spec-defined assessment scale by id (e.g. "reach_5", "severity_5", "confidence_binary"). Includes the full point array. Returns a descriptive message (not an error) when the id is unknown.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Scale id (e.g. "reach_5", "frequency_5", "severity_5", "importance_5", "confidence_binary"). |

**Returns:**

JSON: the full `UPGScaleDefinition` record including all points.

**See also:** `list_scales`, `get_entity_schema`


### `get_spec_version`

Spec-level metadata for compatibility checks: `upg_version`, `markdown_format_version`, and canonical counts (entity types, edge types, atomic domains, super-domain regions). Pin against the version pair; counts are informational.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ upg_version, markdown_format_version, entity_count, edge_count, domain_count, region_count }`

**See also:** `get_workspace_info`, `list_entity_types`, `list_edge_types`, `list_regions`


### `get_template`

Get a curated starter template in full by id: its entities (with title/description templates, default properties, tags, status), its typed edges (canonical UPG edge per pair), and its prompts (the questions to fill `{{placeholders}}`). Use to instantiate a template: walk the prompts, substitute placeholders, create the entities and typed edges.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Template id (e.g. "saas-business-model"). Run list_templates for the options. |

**Returns:**

`{ template: TemplateSet }`, or `{ error, available }` when the id is unknown


### `get_tree_pattern`

Return the full declarative record for one get_tree pattern: its region, anchor_type, fallback_anchors, gap_policy, natural_depth, and its child map resolved to concrete edges. Each parent-to-child slot carries the canonical `via` edge and its `kind`, resolved live from the edge catalogue, so a client reads the real wiring instead of reverse-engineering it and the pattern cannot cite an edge the grammar lacks.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | ✓ | Tree pattern id: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org. |

**Returns:**

JSON: the `UPGTreePatternDetail` record.

**Throws:**

- textError when `id` is missing or unknown.

**See also:** `list_tree_patterns`, `get_tree`, `resolve_edge_for_pair`


### `get_type_label`

Return one `UPGTypeLabel` by entity type, plus a resolved display label for an optional `framework_id` and/or `designation` (wraps `resolveLabel`). Lookup is exact-match against `UPG_TYPE_LABELS_MAP`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `designation` | string |  | Optional designation key (e.g. "pain", "gap", "desire") for types that use the designation pattern. |
| `entity_type` | string | ✓ | Canonical entity type id. |
| `framework_id` | string |  | Optional framework id (e.g. "lean_canvas", "ost", "design_thinking"). When set, resolved_label uses the framework-specific label. |

**Returns:**

JSON: `{ ...UPGTypeLabel, resolved_label: string }`

**Throws:**

- textError when `entity_type` is missing or unknown.

**See also:** `list_type_labels`, `get_entity_meta`, `list_frameworks`


### `get_valid_children`

Return valid direct-child entity types for a parent type. Wraps `getValidChildren` / `UPG_VALID_CHILDREN`. Empty array when none registered. Answers "what can I create under this?". Pairs with `get_entity_schema`.

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

[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing inspection, invoke the /upg-show-entity skill instead of calling this tool directly. Inspect approach: path of arrival to "what's broken?". Returns the Inspect record + invocation params in the family-resemblance envelope. The LLM consumes `signature_hint` and emits `{ violations: [{ severity, kind, entity_id, description, fix_hint }] }` against `UPG_ANTI_PATTERNS` + the live graph. Optional `region` or `entities[]` scope the audit.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entities` | array |  | Optional entity_id[]. Narrows inspection scope to a specific candidate set. Composable with region. |
| `region` | string |  | Optional UPGRegionId. Narrows inspection scope to a single region. |

**Returns:**

JSON envelope: `{ approach_id, scope, generated_at, approach,
params, violations, summary, execution_mode: "execution_v0_4_0" }`

**See also:** `get_approach`, `list_anti_patterns`, `get_anti_pattern`, `get_anti_pattern_violations_for`, `validate_graph`, `plan`, `reflect`


### `list_anti_patterns`

List curated cross-domain anti-patterns from `UPG_ANTI_PATTERNS`. Each row pairs a memorable name with a machine-evaluable `IntelligenceCondition`, applicable stages, severity, and remediation. Graph-health patterns evaluated whole-graph (distinct from per-domain anti-patterns via `get_domain_guide`). Paginated (default 50, max 200). Filters AND together: `severity` (`high` / `medium` / `low`), `stage` (keeps patterns whose `stages[]` includes the given `UPGProductStage`).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor. Pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 50, max 200). |
| `severity` | `high` \| `medium` \| `low` |  | Exact-match UPGAntiPatternSeverity. |
| `stage` | `concept` \| `validation` \| `build` \| `beta` \| `launch` \| `growth` \| `mature` \| `maintenance` \| `sunset` |  | Keeps anti-patterns whose stages[] includes the given UPGProductStage. |

**Returns:**

JSON: `{ total, count, next_cursor?, anti_patterns: UPGCuratedAntiPattern[] }`

**See also:** `get_anti_pattern`, `get_anti_pattern_violations_for`, `validate_graph`, `inspect`, `get_domain_guide`


### `list_approaches`

List the 5 canonical `UPGApproach` records: Plan, Inspect, Prioritise, Trace, Reflect. An approach is the path of arrival to a region of the graph (final approach to an airport, coastline approach). Each record carries id, label, description, `question_answered`, `signature_hint`, `framework_id_examples`. Optional `framework_id` narrows to approaches whose `framework_id_examples` include it.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `framework_id` | string |  | Exact-match framework id. Narrows to approaches whose framework_id_examples include it (discoverability surface; full reverse lookup is on UPGFramework.approach_ids). |

**Returns:**

JSON: `{ count, approaches: UPGApproach[] }`

**See also:** `get_approach`, `plan`, `inspect`, `prioritise`, `trace`, `reflect`, `list_playbooks`


### `list_benchmarks`

Return one of four canonical benchmark catalogs (the data behind `get_graph_digest` health logic). Required `kind` selects the source: `count` → `UPG_COUNT_BENCHMARKS` (per-entity-type ranges across the 9-stage journey); `relationship` → `UPG_RELATIONSHIP_BENCHMARKS` (parent → child minimum counts per stage); `ratio` → `UPG_RATIO_BENCHMARKS` (expected ratios between entity-type counts); `domain_activation` → `UPG_DOMAIN_ACTIVATION` (when each atomic domain is expected to activate). Optional filters AND together: `stage` (`UPGProductStage`), `domain` (atomic-domain id). Non-paginated.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `domain` | string |  | Optional atomic-domain id filter. Semantics depend on kind (see tool description). |
| `kind` | `count` \| `relationship` \| `ratio` \| `domain_activation` | ✓ | Required. Which benchmark catalog to return. |
| `stage` | `concept` \| `validation` \| `build` \| `beta` \| `launch` \| `growth` \| `mature` \| `maintenance` \| `sunset` |  | Optional UPGProductStage filter. Semantics depend on kind (see tool description). |

**Returns:**

JSON: `{ kind, total, count, benchmarks: ... }`

**Throws:**

- textError when `kind` is missing or not one of the four supported values.

**See also:** `get_graph_digest`, `list_product_stages`, `list_domains`, `list_anti_patterns`


### `list_cross_edge_types`

List the canonical cross-product edge types from `UPG_CROSS_EDGE_TYPES`: `shares_persona`, `shares_competitor`, `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`, `hosts`, `contributes_to`, `instance_of`, `area_serves_persona`, `area_targets_market_segment`, `rolls_up_to`. Portfolio-level relationships across products. Distinct from the within-product `UPG_EDGE_CATALOG`. `instance_of` (product entity to a canonical registry entity) is created via `register_instance`; `area_serves_persona` / `area_targets_market_segment` (a product_area to a registry persona/segment, with primary/secondary relevance) via `link_area_to_audience`; `rolls_up_to` (a product metric feeding a company metric) via `create_cross_product_edge`. None of the area edges go through the generic `create_cross_product_edge`.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, types: readonly UPGCrossEdgeType[] }`

**See also:** `list_edge_types`, `list_portfolio_cross_edges`, `migrate_cross_edges`


### `list_domain_rings`

List every `UPGDomainRing` from `UPG_DOMAIN_RINGS` in canonical order: Nucleus → Understand → Define → Build → Grow → Operate → Extend. Rings are the 7 concentric groupings of the 36 UPG atomic domains. Each ring: `{ id, label, description, domain_ids }`. Non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ rings: UPGDomainRing[], total: number }`

**See also:** `get_domain_ring`, `list_domains`, `get_domain_guide`


### `list_domains`

List domains. Default (`with_guide_only: true`) returns every domain with a canonical usage guide: id + `anchor_entity` + `creation_sequence`. Pass `with_guide_only: false` to enumerate every atomic domain from `UPG_DOMAINS`: id + label + description + types + `has_guide`. The two shapes are disjoint by the boolean.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `with_guide_only` | boolean |  | Default true. Returns only domains with a canonical usage guide (compact id + anchor_entity + creation_sequence). Pass false to return every atomic domain (id + label + description + types + has_guide). |

**Returns:**

JSON: `{ count, domains: Array<{ domain_id, anchor_entity, creation_sequence } | { domain_id, label, description, types, has_guide }> }`

**See also:** `get_domain_guide`, `list_domain_rings`, `get_domain_ring`, `list_regions`, `list_entity_types`


### `list_edge_migrations`

List every edge-key migration from `UPG_EDGE_MIGRATIONS` (renamed or dropped canonical edge keys, e.g. `persona_has_jtbd` → `persona_pursues_job`). Each row: `{ kind, from, to?, since }` where `kind` is `rename` or `drop`. Optional `from_edge` exact-matches `from`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_edge` | string |  | Exact-match filter on the deprecated edge key (e.g. "persona_has_jtbd"). |

**Returns:**

JSON: `{ migrations: [{ kind, from, to?, since }], total: number }`

**See also:** `list_type_migrations`, `list_split_migrations`, `rename_edge_type`, `list_edge_types`, `validate_graph`


### `list_edge_types`

List every canonical edge type from `UPG_EDGE_CATALOG`, optionally narrowed by `source_type` and/or `target_type`. Each entry carries the edge key (`type`), forward/reverse verbs, classification, and endpoint types. The polymorphic wildcard `"node"` is preserved on polymorphic edges.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_type` | string |  | Exact-match filter on UPGEdgeDefinition.source_type. Pass "node" to find polymorphic edges with a wildcard source. |
| `target_type` | string |  | Exact-match filter on UPGEdgeDefinition.target_type. |

**Returns:**

JSON: `{ count, edges: Array<{ type, forward_verb, reverse_verb, classification, source_type, target_type }> }`

**See also:** `get_edge_type`, `resolve_edge_for_pair`, `list_cross_edge_types`, `list_edge_migrations`, `create_edge`


### `list_entity_types`

List canonical entity types from `UPG_ENTITY_META` (source of truth for ontology evolution). Every active, deprecated, or removed type with its immutable `type_id`, maturity tier, and version metadata. Paginated (default 50, max 200). Filters AND together and apply before pagination: `domain` (atomic-domain id), `maturity` (`draft` / `proposed` / `stable` / `deprecated` / `removed`), `deprecated` (boolean shortcut). Each row carries the full `EntityTypeMeta` plus resolved `domain_id` (null if no atomic-domain mapping).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor. Pass next_cursor from a previous response. |
| `deprecated` | boolean |  | true → only deprecated types; false → exclude deprecated and removed types (the active set). Composes with maturity via AND. |
| `domain` | string |  | Exact-match atomic-domain id (e.g. "user", "market_intelligence"). |
| `limit` | number |  | Page size (default 50, max 200). |
| `maturity` | `draft` \| `proposed` \| `stable` \| `deprecated` \| `removed` |  | Exact-match UPGEntityTypeMaturity. |

**Returns:**

JSON: `{ total, count, next_cursor?, types: Array<EntityTypeMeta & { domain_id: string | null }> }`

**See also:** `get_entity_meta`, `get_entity_schema`, `list_type_labels`, `list_type_migrations`, `list_domains`


### `list_framework_categories`

List valid framework category values from `UPG_FRAMEWORK_CATEGORIES` (e.g. "strategy", "prioritization", "discovery", "growth", "engineering"). Use as valid values for the `category` filter on `list_frameworks` / `get_framework`.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ categories: string[], total: number }`

**See also:** `list_frameworks`, `list_framework_structure_patterns`


### `list_framework_structure_patterns`

List valid framework structure-pattern values from `UPG_STRUCTURE_PATTERNS`. Visual topological shapes: tree, table, matrix, funnel, collection, quadrant, flow. Mirrors `UPGFramework.structure.pattern`.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ patterns: string[], total: number }`

**See also:** `list_frameworks`, `list_framework_categories`, `get_framework`


### `list_frameworks`

List the canonical `UPGFramework` definitions: the curated, famous product frameworks that anchor the public catalog (spanning strategy, discovery, prioritisation, design, growth, engineering, and reflection classics). Returns a lightweight summary per framework (id, name, category, description, tags, approach_ids, structure_pattern); call `get_framework(id)` for the full record. Paginated (default 50, max 200). Cursor is opaque: pass `next_cursor` from a previous response. Optional `category` is exact-match against `UPGFramework.category` and applies before pagination.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `category` | string |  | Exact-match filter on UPGFramework.category (e.g. "strategy", "prioritization"). |
| `cursor` | string |  | Opaque pagination cursor. Pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 50, max 200). |

**Returns:**

JSON: `{ total, count, next_cursor?, frameworks: Array<{ id, name, category, description, tags, approach_ids, structure_pattern }> }`

**See also:** `get_framework`, `list_framework_categories`, `list_framework_structure_patterns`, `prioritise`, `list_approaches`


### `list_lenses`

List every canonical `UPGLens` from `@unified-product-graph/core`: Product, Design, Engineering, Growth, Business, Research, Marketing, Full. Returns a compact summary per lens: id, name, description, icon, audience, perspective, `framework_id`, `playbook_id`, `visible_domain_count`, `intelligence_prompt_count`. Use `get_lens` for the full record.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, lenses: Array<{ id, name, description, icon, audience, perspective, framework_id?, playbook_id?, visible_domain_count, intelligence_prompt_count }> }`

**See also:** `get_lens`, `list_regions`, `list_playbooks`, `list_frameworks`


### `list_lifecycles`

List lifecycle definitions from `UPG_LIFECYCLES`. Response includes `free_types` (`UPG_LIFECYCLE_FREE_TYPES`: static types with no phase progression) and `planned_types` (`UPG_LIFECYCLE_PLANNED_TYPES`: lifecycle planned but not yet authored). Filters: `entity_type` (exact-match), `lifecycle_only` (when true, omits the free/planned lists).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string |  | Exact-match entity type name (e.g. "feature", "hypothesis"). Returns at most one lifecycle. |
| `lifecycle_only` | boolean |  | When true, omit free_types and planned_types from response. |

**Returns:**

JSON: `{ lifecycles, total, free_types: string[], planned_types: string[] }`

**See also:** `get_lifecycle`, `list_entity_types`, `get_entity_meta`


### `list_playbooks`

List canonical UPG playbooks from `@unified-product-graph/core`. Each playbook bootstraps a region; its `creation_sequence` answers "what to create when populating this region". Filters: `region`, `canonical_only`, `framework_id`. The catalog spans 10 regions: one canonical playbook per region, plus specialised playbooks (three carry a `framework_id`: BMC, AARRR, build-measure-learn).

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `canonical_only` | boolean |  | When true, return only the canonical playbook per region (W1 invariant restated). |
| `framework_id` | string |  | Exact-match UPGFramework.id (e.g. "business-model-canvas", "pirate-metrics-aarrr"). |
| `region` | string |  | Exact-match UPGRegionId (e.g. "users_needs", "business_gtm_growth"). |

**Returns:**

JSON: `{ count, playbooks: UPGPlaybook[] }`

**Examples:**

// List all canonical playbooks to see what bootstrap paths are available
// Input:
{ "canonical_only": true }
// Output (truncated):
{
  "count": 10,
  "playbooks": [
    {
      "id": "playbook:users-needs",
      "name": "Users & Needs",
      "region": "users_needs",
      "is_canonical": true,
      "target_anchor_entity": "persona",
      "creation_sequence": ["persona", "job", "need", "pain_point"]
    },
    { "id": "playbook:strategy-outcomes", "region": "strategy_outcomes", "is_canonical": true, "..." }
  ]
}

**See also:** `get_playbook`, `list_regions`, `list_approaches`, `list_frameworks`


### `list_product_stages`

Return the canonical 9-stage product journey from `UPG_PRODUCT_STAGES` in order: concept → validation → build → beta → launch → growth → mature → maintenance → sunset. The closed enum used by `create_product`, `get_graph_digest` health logic, benchmark stage scoping, and anti-pattern stage filters.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, stages: readonly UPGProductStage[] }`

**See also:** `list_benchmarks`, `list_anti_patterns`, `list_domain_rings`, `create_product`


### `list_regions`

List the 10 canonical UPG super-domain regions from `UPG_REGIONS`. Returns a compact summary per region: id, label, order, shape, `mental_model`, `anchor_type`, `composes_atomic_domains`, `entity_count`, `intra_edge_count`, `boundary_edge_count`. Fixed list, non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, regions: Array<{ id, label, order, shape, mental_model, anchor_type, composes_atomic_domains, entity_count, intra_edge_count, boundary_edge_count, coverage_keys, business_areas }>, area_taxonomy }`

**See also:** `get_region`, `get_region_for_entity_type`, `list_domains`, `list_playbooks`


### `list_scalar_to_edge_migrations`

List every scalar→edge promotion from `UPG_SCALAR_TO_EDGE_MIGRATIONS` (P14 conformance: a scalar that named a first-class entity, e.g. `business_model.north_star_metric`, becomes a canonical edge). Each row: the full `UPGScalarToEdgeMigration` record plus `since`. The lossless apply is `promote_scalars_to_edges`. Non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ promotions: [...], total: number }`

**See also:** `promote_scalars_to_edges`, `list_split_migrations`


### `list_scales`

List every spec-defined assessment scale from `UPG_SCALES` (canonical vocabulary for `UPGAssessment` values). Each scale carries id, label, description, min, max, steps, and per-point labels + descriptions. Non-paginated. External `scale_extensions` are graph-instance–scoped and excluded here.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ scales: UPGScaleDefinition[], total: number }`

**See also:** `get_scale`, `get_entity_schema`


### `list_split_migrations`

List every 1→N split migration from `UPG_SPLIT_MIGRATIONS` ("one type became multiple types" rules, e.g. `experiment` → `experiment_plan` + `experiment_run`; `hypothesis` → `hypothesis_claim` + `hypothesis_evidence`). Each row: the full `UPGSplitMigration` record plus `since`. Non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ splits: [...], total: number }`

**See also:** `list_type_migrations`, `list_edge_migrations`, `migrate_type`, `validate_graph`


### `list_status_values`

List the valid `status` values an entity type can hold: the pre-flight lookup so you no longer learn the set only from a rejected write. For a lifecycle type, returns each phase as `{ status, label, terminal }` plus `initial_status` and `terminal_statuses`; for a lifecycle-free type, returns `lifecycle_free: true` with empty `values`. The focused, low-token sibling of `get_lifecycle`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_type` | string | ✓ | Canonical entity type name (e.g. "feature", "key_result", "need"). |

**Returns:**

JSON: `{ entity_type, lifecycle_free, initial_status?, terminal_statuses?, values: [{ status, label, terminal }], note? }`.

**See also:** `get_lifecycle`, `get_entity_schema`


### `list_templates`

List the curated starter templates (proven entity patterns for SaaS, marketplace, mobile, OSS, and agency). Returns summaries: id, name, description, industries, stages, entity_count, entity_types. The same library powers the /upg-new-from-template skill and the site gallery. Use with get_template to fetch a full pattern for instantiation.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `industry` | string |  | Filter by industry (saas, marketplace, mobile, oss, agency) |
| `stage` | string |  | Filter by stage (concept, validation, growth, mature) |

**Returns:**

`{ templates: TemplateSummary[] }` — id, name, description, industries, stages, entity_count, entity_types


### `list_tree_patterns`

List the canonical get_tree patterns as summary rows: id, label, the region each is the tree view of, anchor_type, fallback_anchors, natural_depth, gap_policy, and slot_count. The introspectable index of what get_tree can assemble. Pair with list_regions to see which tree-shaped regions have a pattern. Fixed list, non-paginated.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ count, patterns: UPGTreePatternSummary[] }`

**See also:** `get_tree_pattern`, `get_tree`, `list_regions`


### `list_type_labels`

List canonical `UPGTypeLabel` entries: each entity type's display label, alt-labels (synonyms), per-framework labels, and designation labels where applicable. Paginated (default 100, max 500). Cursor is opaque base64 (`offset:N`), same convention as `list_frameworks`. External MCP apps need labels for rendering.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cursor` | string |  | Opaque pagination cursor. Pass next_cursor from a previous response. |
| `limit` | number |  | Page size (default 100, max 500). |

**Returns:**

JSON: `{ total, count, next_cursor?, labels: UPGTypeLabel[] }`

**See also:** `get_type_label`, `list_entity_types`, `get_entity_meta`


### `list_type_migrations`

List every type-rename migration from `UPG_MIGRATIONS` (version-scoped registry of deprecated `from` → canonical `to` renames, e.g. `pain_point` → `need`, `hypothesis` → `hypothesis_claim`). Each row: `{ from, to, since }` where `since` is the spec version that introduced it. Optional `from_type` exact-matches `from`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `from_type` | string |  | Exact-match filter on the deprecated type name (e.g. "pain_point", "hypothesis"). |

**Returns:**

JSON: `{ migrations: [{ from, to, since }], total: number }`

**See also:** `list_edge_migrations`, `list_split_migrations`, `migrate_type`, `migrate_properties`, `validate_graph`, `list_entity_types`


### `plan`

Plan approach: path of arrival to "what should I build next?". Returns the Plan record + invocation params wrapped in `{ approach_id, scope, generated_at, approach, params }`. The LLM consumes `signature_hint` and synthesises `{ missing_entities, coverage_score }` against the live graph. Optional `region` narrows scope; omit `region` to scope to the product's ACTIVE regions; pass `exhaustive:true` to score the full type universe.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `exhaustive` | boolean |  | If true, score against the entire 312-type universe (every domain creation sequence). Off by default; whole-universe gap scoring is noisy for a focused product. Only applies when `region` is omitted. |
| `region` | string |  | Optional UPGRegionId or atomic-domain id. Narrows planning scope to a single region (e.g. "users_needs", "business_gtm_growth"). Omit to scope to the product's active regions. |

**Returns:**

JSON envelope: `{ approach_id, scope, generated_at, approach,
params, missing_entities, coverage_score, expected_count, covered_count,
execution_mode: "execution_v0_4_0" }`.

**Examples:**

// Input: { "region": "users_needs" }
// Output (truncated):
{
  "approach_id": "plan",
  "scope": "users_needs",
  "missing_entities": [
    { "entity_type": "job", "domain": "user", "position_in_sequence": 1,
      "typical_parent_type": "persona",
      "hint": "Add job (step 2 in the user sequence; typically attached under persona)." }
  ],
  "coverage_score": 0.5,
  "execution_mode": "execution_v0_4_0"
}

**See also:** `get_approach`, `list_playbooks`, `get_region`, `inspect`, `prioritise`


### `prioritise`

[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing prioritisation, invoke the /upg-prioritise skill instead of calling this tool directly. Prioritise approach: path of arrival to "what's most important?". Returns the Prioritise record + invocation params + framework metadata in the family-resemblance envelope. Both `candidates` and `framework_id` are required. The LLM looks up the framework via `get_framework`, reads its scoring spec, and emits `{ ranked: [{ entity_id, score, rationale }], framework_used }`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `candidates` | array |  | entity_id[] to rank. Optional when exercise_id is given (the exercise supplies them). |
| `exercise_id` | string |  | Optional (0.8.4). A framework_exercise id: reads each candidate's scoring inputs from its includes-edge properties instead of node.properties, and bypasses the target-type guard so any entity type can be scored. |
| `framework_id` | string | ✓ | Required. UPGFramework.id of the scoring lens (e.g. "rice-scoring", "ice-scoring", "kano-model", "cost-of-delay", "wsjf"). |

**Returns:**

JSON envelope: `{ approach_id, scope, generated_at, approach,
params, framework_resolved, ranked?, required_properties?,
hint?, execution_mode }`. Execution mode is `"execution_v0_4_0"` when
the framework has an expression, `"definition_lookup_v0_4_0"` otherwise.

**Throws:**

- textError when `candidates` or `framework_id` are missing/empty,
or when `framework_id` is not in `UPG_FRAMEWORKS`.

**See also:** `get_approach`, `list_frameworks`, `get_framework`, `plan`, `trace`


### `reflect`

[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing reflection, invoke the /upg-reflect skill instead of calling this tool directly. Reflect approach: path of arrival to "what should I be questioning?". Returns the Reflect record + invocation params in the family-resemblance envelope. The LLM consumes `mode` + `scope` + `signature_hint` and emits `{ prompts: [{ kind, question, target_entities? }] }`. `mode` is one of: `assumptions`, `alternatives`, `blind-spots`, `load-bearing`; omit for open reflection. `scope` accepts a region id, entity id, or `null` for whole-graph.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `mode` | `assumptions` \| `alternatives` \| `blind-spots` \| `load-bearing` |  | Optional. One of: assumptions, alternatives, blind-spots, load-bearing. Omit for open reflection. |
| `scope` | string,null |  | Optional. Region id, entity id, or null for whole-graph. |

**Returns:**

JSON envelope: `{ approach_id, scope, generated_at, approach,
params, prompts, execution_mode: "execution_v0_4_0" }`

**Throws:**

- textError when `mode` is provided but not one of the 4 canonical
nouns.

**See also:** `get_approach`, `inspect`, `plan`, `get_anti_pattern`


### `resolve_edge_for_pair`

Resolve the canonical `UPGEdgeType` for a `source_type` → `target_type` containment pair. Wraps `resolveContainmentEdge` / `UPG_EDGE_PAIR_MAP`. Adapter-critical: every import adapter (Markdown, Notion, Linear, GitHub) uses it to look up the right `_contains_` edge before falling back to a polymorphic edge. Returns `{ edge_type: null }` when the pair is uncatalogued.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `source_type` | string | ✓ | Parent / source entity type. |
| `target_type` | string | ✓ | Child / target entity type. |

**Returns:**

JSON: `{ source_type, target_type, edge_type: string | null,
anchor_hint?, alternate_anchors?, adjacent_edges? }`

**Throws:**

- textError when `source_type` or `target_type` is missing.

**Warnings (non-error surfaces):**

- Returns `edge_type: null` when no canonical pair is registered.
Adapters MUST fall back to a polymorphic edge or skip the relationship,
not synthesise a non-canonical key.

**See also:** `list_edge_types`, `get_edge_type`, `create_edge`, `trace`


### `score_entity`

Record a framework's result for one entity on the exercise's includes edge (a MoSCoW bucket, a RICE score, a canvas slot). Auto-includes the entity if not already in scope. Merges into existing edge properties unless replace is set. Returns { edge, warnings }.

**Atomicity:** `atomic.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_id` | string | ✓ | Required. The entity being scored. |
| `exercise_id` | string | ✓ | Required. The framework_exercise id. |
| `replace` | boolean |  | Replace the edge properties instead of merging (default false). |
| `slot_role` | string |  | Optional framework slot role this entity plays (e.g. "pain_reliever"). Rides the same edge as the scores; validated against the framework's declared slot roles (warn-only). |
| `values` | object | ✓ | Required. The result as { input: value }, e.g. { "moscow": "must" } or { "reach": 4, "impact": 3 }. |

**Returns:**

JSON: `{ edge, warnings }`.

**Throws:**

- textError when the exercise/entity is missing or the node is not a
framework_exercise.

**See also:** `apply_framework`


### `trace`

[LLM-mediated] This tool returns a routing envelope, not computed results. For user-facing tracing, invoke the /upg-trace skill instead of calling this tool directly. Trace approach: path of arrival to "walk a meaningful path through existing graph". Returns the Trace record + invocation params in the family-resemblance envelope. The LLM uses `anchor` + `path` to compose `query()` calls and emits `{ trail: [{ depth, entity_id, edge_type_in }], reached: entity_id[] }`. `path` is type-shorthand: `["persona","job","feature"]` walks persona→job→feature using the canonical edge per pair (via `resolve_edge_for_pair`). Optional `edges_override` selects non-canonical edges per hop; `null` per element means "use canonical".

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `anchor` | string | ✓ | Required. entity_id where the traversal starts. |
| `edges_override` | array |  | Optional. Per-hop edge override array. Length must match path length; element null means "use canonical edge for this pair". |
| `path` | array | ✓ | Required. UPGEntityType[] type-shorthand path. Each step walks via the canonical edge for the source→target pair. |

**Returns:**

JSON envelope: `{ approach_id, scope, generated_at, approach,
params, trail, reached, error?, halted_at_depth?,
execution_mode: "execution_v0_4_0" }`

**Throws:**

- textError when `anchor` or `path` are missing/invalid.

**Examples:**

// Input: { "anchor": "persona_01", "path": ["job", "feature"] }
// Output (truncated):
{
  "approach_id": "trace",
  "trail": [
    { "depth": 0, "entity_id": "persona_01", "edge_type_in": null },
    { "depth": 1, "entity_id": "job_01", "edge_type_in": "persona_pursues_job" }
  ],
  "reached": ["persona_01", "job_01"],
  "execution_mode": "execution_v0_4_0"
}

**See also:** `get_approach`, `resolve_edge_for_pair`, `query`, `get_node`, `plan`, `prioritise`


## Cloud Sync

_Read sync state, pull cloud changes, push local graph._

- [`apply_pull_changeset`](#apply-pull-changeset)
- [`get_sync_state`](#get-sync-state)
- [`push_to_cloud`](#push-to-cloud)

### `apply_pull_changeset`

Apply cloud changes to the local `.upg` file. Takes cloud nodes and edges (from `export_upg_document` on the cloud server), computes the diff, merges into the local graph, and updates `.upg-sync` with new mappings. `strategy`: `cloud_wins` (default), `local_wins`, or `merge` (reports conflicts without resolving).

**Atomicity:** `non-atomic. Node/edge mutations apply incrementally; a partial
failure mid-application leaves the graph in a half-merged state. The
`.upg-sync` file is updated after the merge sweep so its hashes reflect
whatever landed.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `cloud_edges` | array | ✓ | All cloud edges (from export_upg_document) |
| `cloud_endpoint` | string |  | Cloud endpoint URL (e.g. https://cloud.unifiedproductgraph.org) |
| `cloud_nodes` | array | ✓ | All cloud nodes (from export_upg_document) |
| `cloud_product_id` | string | ✓ | Cloud product ID |
| `strategy` | `cloud_wins` \| `local_wins` \| `merge` |  | Conflict resolution: cloud_wins (default), local_wins, or merge (report conflicts without resolving) |

**Returns:**

JSON: `{ nodes_created, nodes_updated, nodes_deleted,
edges_created, edges_deleted, strategy, conflicts?, message? }`.

**Throws:**

- Returns a textError when `cloud_nodes`, `cloud_edges`, or
`cloud_product_id` is missing, or when sync-state I/O fails.

**Warnings (non-error surfaces):**

- Mutates the active product. Always call `get_workspace_info`
first to confirm the right product is loaded; otherwise cloud changes
land in the wrong file. `merge` strategy returns conflicts without
applying them; the caller must re-run with `cloud_wins`/`local_wins`
to commit.

**See also:** `push_to_cloud`, `get_sync_state`, `get_workspace_info`, `get_changes`


### `get_sync_state`

Read the `.upg-sync` file for the active product. Returns cloud product ID, ID mappings, last sync timestamp. Returns null when the product has never been pushed.

**Atomicity:** `atomic (read-only)`

_No arguments._

**Returns:**

JSON: `{ synced: false, message }` or
`{ synced: true, cloud_endpoint, product_id, last_synced_at,
mapped_nodes, mapped_edges, last_snapshot_hash }`.

**See also:** `push_to_cloud`, `apply_pull_changeset`, `get_workspace_info`, `get_changes`


### `push_to_cloud`

Push the current local graph to the cloud in one call. Reads the in-memory graph, POSTs to the cloud import endpoint, and creates or updates the `.upg-sync` file with ID mappings. Auto-discovers `cloud_endpoint` and `api_key` from a `upg-cloud` entry in `.mcp.json`. Recommended push path from Claude Code (zero context cost).

**Atomicity:** `non-atomic. Performs an HTTP round-trip and then writes the
sync file as a separate filesystem mutation. A partial failure (e.g.
cloud accepted some entities, then network broke) is reflected in the
`errors` array; the sync file is only updated when the import call
succeeds.`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `api_key` | string |  | UPG Cloud API key. Auto-discovered from .mcp.json upg-cloud entry if omitted. |
| `cloud_endpoint` | string |  | Cloud base URL. Auto-discovered from .mcp.json upg-cloud entry if omitted. |
| `product_id` | string |  | Optional. Push to an existing cloud product instead of creating new. |
| `strategy` | `create_new` \| `merge` \| `replace` |  | Import strategy. Default: create_new |

**Returns:**

JSON: `{ success, product_id, nodes_created, edges_created,
errors, sync_file_updated }`.

**Throws:**

- Returns a textError when credentials cannot be resolved, the cloud
returns a non-2xx response, or the sync file write fails.

**Warnings (non-error surfaces):**

- Pushes the **currently-loaded** product. Call
`get_workspace_info` first to confirm. Auto-discovers credentials
from `.mcp.json`'s `upg-cloud` server entry; falls back to explicit
`cloud_endpoint` + `api_key` arguments. Default `strategy: 'create_new'`
creates a fresh cloud product on every call; pass `product_id` to
target an existing one.

**See also:** `apply_pull_changeset`, `get_sync_state`, `get_workspace_info`


## Validation

_Schema-drift detection, full per-node drift reports, and source-vs-deployed integrity audits of UPG `/upg-*` skills._

- [`get_anti_pattern_violations_for`](#get-anti-pattern-violations-for)
- [`skill_audit`](#skill-audit)
- [`validate_graph`](#validate-graph)

### `get_anti_pattern_violations_for`

Reverse lookup: given an entity id, return anti-pattern violations whose `target_entities` include the entity's type. Use after `validate_graph` to drill into one entity's implicated patterns. Matches by entity type today; tightens to specific ids in a future revision. Underpins the Inspect approach.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `entity_id` | string | ✓ | Node id to look up. |

**Returns:**

JSON: `{ entity_id, type, violations: [...] }`.

**Throws:**

- textError when `entity_id` is missing or unknown.

**Warnings (non-error surfaces):**

- Phase 1 matches by entity TYPE, not specific id. Every entity of
the same type shares the same violation set. Phase 1.x will tighten to
per-id matching once `target_entities` carries ids.

**Examples:**

// Find all anti-pattern violations that implicate a specific feature node
// Input:
{ "entity_id": "feature_04" }
// Output (truncated):
{
  "entity_id": "feature_04",
  "type": "feature",
  "violations": [
    {
      "anti_pattern_id": "features-without-hypotheses",
      "name": "Features Without Hypotheses",
      "severity": "high",
      "why_it_matters": "Building without a testable hypothesis means no way to evaluate success.",
      "remediation": "Link each feature to a hypothesis_claim via feature_tests_hypothesis."
    }
  ]
}

**See also:** `validate_graph`, `list_anti_patterns`, `get_anti_pattern`, `inspect`


### `skill_audit`

Audit one or every UPG skill for source-vs-deployed integrity. Use before recommending a skill to confirm `.claude/skills/<name>/SKILL.md` is a symlink to canonical source and the bodies match. When `in_sync: false`, what you read from `packages/upg-mcp-server/skills/` is NOT what the user will experience.

**Atomicity:** `atomic (read-only filesystem stat + read)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string |  | Optional skill name (e.g. "upg-trace"). If omitted, audits every canonical skill. |

**Returns:**

`{ skills: SkillAuditRecord[] }`


### `validate_graph`

Walk the loaded graph and return a per-class, per-node report of schema drift plus anti-pattern violations from `UPG_ANTI_PATTERNS`. Schema-drift classes: non-canonical entity types, non-canonical edge types, top-level fields outside `UPGBaseNode`, invalid status values, self-referential `source_id`/`source_type`, properties matching `UPG_PROPERTY_MIGRATIONS` rules. Anti-patterns: catalog entries that fired against the live graph, sorted high → medium → low. Each entry carries `suggested_migration` (drift) or `remediation` (anti-pattern). Top-level `valid` is true iff drift is empty AND no violations fired. Read-only; pairs with `migrate_type`, `rename_edge_type`, `get_anti_pattern_violations_for`.

**Atomicity:** `atomic (read-only)`

**Arguments:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `anti_pattern_ids` | array |  | Restrict anti-pattern evaluation to a subset of catalog ids (e.g. ["features-without-hypotheses"]). |
| `if_changed_since` | string |  | Hash from a previous response. Returns { changed: false } if graph unchanged. |
| `include_polymorphic_upgrades` | boolean |  | When true, include a `polymorphic_with_typed_alternative` array listing polymorphic edges (e.g. node_owned_by_person, node_constrains_node) that have a more-specific typed alternative for their actual source/target pair. Opt-in only; omitted by default to avoid cluttering routine validation output. Does not affect `valid`; these are advisory suggestions. |
| `limit` | number |  | Max entries per class (default 100, max 1000) |
| `pending_edges` | array |  | Pre-commit preview edges (paired with pending_nodes). Each item: `{ from, to, type? }`, where from/to is an existing node id OR a `$N` index into pending_nodes; type is inferred from endpoints when omitted. |
| `pending_nodes` | array |  | Batch-4 #18 pre-commit preview: nodes you are ABOUT to create. When supplied (with/without pending_edges), validate_graph evaluates anti-patterns against the CURRENT graph PLUS this delta WITHOUT writing, and returns which violations the delta would newly trigger or resolve. Each item: `{ type, title?, status?, tags?, properties? }`. |
| `scope` | `all` \| `entity_drift` \| `edge_drift` \| `property_drift` \| `top_level_drift` \| `lifecycle_drift` \| `self_referential` |  | Which drift class(es) to include in the response (default "all"). Counts in `summary` are always returned for every class. |
| `severity` | `high` \| `medium` \| `low` |  | Filter anti-pattern violations to one severity tier. |
| `skip_anti_patterns` | boolean |  | Skip anti-pattern evaluation. Only returns schema drift. |
| `skip_drift` | boolean |  | Skip the schema-drift block. Only returns anti-pattern violations. |

**Returns:**

JSON: `{ valid, structurally_valid?, summary, entity_drift?,
edge_drift?, property_drift?, top_level_drift?, lifecycle_drift?,
self_referential?, anti_pattern_violations?, notes?, _hash }`. Per-class
drift arrays appear only when the requested `scope` includes that class.
Each array is capped at `limit` (default 100). `structurally_valid` is
omitted when `skip_drift: true`.

**Throws:**

- Returns a textError when `scope` or `severity` is not one of the
recognised values.

**Warnings (non-error surfaces):**

- `valid` is true ONLY when both drift is empty AND no anti-pattern
violations fired — it conflates structure and product-health. For a pure
spec-conformance check read `structurally_valid` (or set
`skip_anti_patterns: true`, which makes `valid` track structure alone).
`skip_drift: true` gives a catalog-only run and omits `structurally_valid`.

**Examples:**

// Run a full graph health check (schema drift + anti-pattern violations)
// Input:
{}
// Output (truncated):
{
  "valid": false,
  "summary": {
    "entity_drift": 2,
    "edge_drift": 0,
    "property_drift": 1,
    "anti_pattern_violations_high": 1,
    "anti_pattern_violations_medium": 2,
    "anti_pattern_violations_low": 0,
    "spec_version": "0.5.0",
    "scope": "all"
  },
  "entity_drift": [
    { "id": "pain_01", "type": "pain_point", "title": "Slow onboarding", "suggested_migration": { "kind": "rename", "to": "need" } }
  ],
  "anti_pattern_violations": [
    { "anti_pattern_id": "features-without-hypotheses", "severity": "high", "remediation": "Add hypothesis_claim nodes linked to features via feature_tests_hypothesis" }
  ],
  "_hash": "sha256-abc123"
}

// Run a full graph health check; schema drift + anti-pattern violations
// Input:
{}
// Output (truncated):
{
  "valid": false,
  "summary": {
    "entity_drift": 2,
    "edge_drift": 0,
    "property_drift": 1,
    "anti_pattern_violations_high": 1,
    "anti_pattern_violations_medium": 2,
    "anti_pattern_violations_low": 0,
    "spec_version": "0.4.0",
    "scope": "all"
  },
  "entity_drift": [
    { "id": "pain_01", "type": "pain_point", "title": "Slow onboarding", "suggested_migration": { "kind": "rename", "to": "need" } }
  ],
  "anti_pattern_violations": [
    { "anti_pattern_id": "features-without-hypotheses", "severity": "high", "remediation": "Add hypothesis_claim nodes linked to features via feature_tests_hypothesis" }
  ],
  "_hash": "sha256-abc123"
}

**See also:** `migrate_type`, `migrate_properties`, `rename_edge_type`, `get_anti_pattern_violations_for`, `list_anti_patterns`, `list_type_migrations`, `list_edge_migrations`, `inspect`

