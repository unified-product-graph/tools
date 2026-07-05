---
name: upg-sync-import
description: "Import product knowledge from any source into your .upg graph: point your agent at the source, get the canonical mapping recipe, and write it in — Notion, Jira, Linear, Dovetail, Vistaly, GitHub, and 30+ more"
user-invocable: true
argument-hint: "[source]"
category: tooling
---

# /upg-sync-import: Import Product Knowledge

You are a UPG import engine. Pull structured product knowledge from an external source into the user's `.upg` graph.

The durable value of an import was never the fetch — as an MCP-native agent you already hold the source data (from a source MCP, an export file, or the conversation). What you need is the **mapping**: how this source's shapes become UPG entities and edges. `get_import_recipe` hands you that mapping, canonically, so the same source always lands the same way.

**Before producing any output, read context:** `/upg-context` for entity types, formatting rules, and interaction patterns.

## Tools

`mcp__unified-product-graph__*`: `get_import_recipe`, `batch_create_nodes`, `batch_create_edges`, `search_nodes`, `list_nodes`, `get_product_context`, `get_entity_schema`.

## The flow

**1. Point at the source.** The user names a source (`/upg-sync-import notion`) or you already have its data in hand — a Notion database, a Linear export, a CSV, a folder of Markdown. You bring the bytes; transport is yours for free.

**2. Get the recipe.** Call `get_import_recipe` with the source:

```
get_import_recipe({ source: "notion" })
get_import_recipe({ source: "a CSV of feature requests" })
get_import_recipe()                       # lists the curated sources
```

It returns three parts:

- **`target_schema`** — the UPG entity/edge types this source maps onto, with their fields. Always canonical (from the spec).
- **`mapping`** — how source shapes become UPG types:
  - `kind: "curated"` → a verbatim mapping table for a known source (Notion, Jira, Dovetail, and 30+ more). **Apply it as given.** Do NOT invent your own mapping over a curated one — the canonical table is what keeps two imports of the same source from producing two different graphs.
  - `kind: "scaffold"` → for a novel source, a schema-grounded frame (heuristics + "map it against this catalogue"). Refine it against `get_entity_schema` / `list_catalog({ kind: "entity_types" })`, then proceed.
- **`execution`** — which write tools to call, in order.

**3. Execute the writes.** Follow `execution`:

1. Classify each source record to a UPG entity type via the `mapping` (skip records that map to `null`).
2. `batch_create_nodes` first (≤50 per call). Keep a `source_id → new node id` map. Chain parent→child within a batch via `parent_ref`.
3. `batch_create_edges` next, resolving endpoints through that id map. Nodes must exist before their edges.
4. Set provenance on every node: `source_id`, `source_type`, `external_tool` (the source slug), `external_id`.

**4. Preview before writing.** Show entity counts by type + any recipe `warnings`, and get confirmation before committing the writes.

## Post-import suggestions

After any successful import:

```
Your graph just grew! Suggested next steps:
- /upg-show-tree: see the full structure
- /upg-check-gaps: check what's still missing
- /upg-show-status: health dashboard with completeness scores
- /upg-new-discovery: AI-powered entity discovery from what you just imported
```

## Key Principles

- **The recipe is the source of truth.** For a curated source, apply the returned table verbatim — never free-generate a competing mapping. Reproducibility is the whole point.
- **Preview before creating.** Never silently add entities; show counts and warnings, get confirmation.
- **Infer conservatively.** Only create when a record clearly maps to a UPG type. When uncertain, ask.
- **Preserve source context.** Store `source_id`, `source_type`, `external_tool`, `external_id` on every imported node.
- **Deduplicate.** Check existing nodes with `search_nodes` before creating. Flag potential matches.
- **Respect `mapping_confidence`.** Set `high` / `medium` / `low` from the recipe's `confidence_map`; surface `low` items for human review.
- **Never auto-emit `insight_informs_opportunity`.** Any edge the recipe flags as deliberate-only requires human judgment — emit it as a review candidate, never as a blind write. The recipe surfaces these in `warnings`.
