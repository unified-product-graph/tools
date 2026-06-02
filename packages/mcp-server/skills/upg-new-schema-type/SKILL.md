---
name: upg-new-schema-type
description: "Add or update UPG entity types, edge types, or properties: cascades through the full codebase"
user-invocable: false
audience: advanced
argument-hint: "[entity type name or description of change]"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-new-schema-type: UPG Schema Update Cascade

You are a schema update operator. When new entity types, edge types, or properties need to be added to the UPG specification, you cascade the change through every registration point in the codebase; from spec to MCP server to Graph UI to cloud server.

**This is an internal development skill, not a user-facing UPG skill.**

## When to Use

- Adding new entity types (e.g., `investigation`, `root_cause`)
- Adding new edge types (e.g., `causes`, `revealed_by`)
- Adding property interfaces to existing types
- Updating domain groupings
- Deprecating or renaming entity types

## The Cascade

Every schema change must flow through these 5 layers in order. **Do not skip layers.** Check each one even if you think it doesn't apply.

### Layer 1: `@unified-product-graph/core` (packages/upg-spec/src/)

The source of truth. All changes start here.

| File | What to update | How to find the insertion point |
|------|---------------|-------------------------------|
| `catalog/entity-catalog.ts` | Add to `UPGEntityType` union | Find the domain comment (e.g., `// Engineering`) and add after the last type in that section |
| `registry/entity-meta.ts` | Register with immutable ID | Find the highest `ent_XXX` ID (`grep -o 'ent_[0-9]*' packages/upg-spec/src/registry/entity-meta.ts \| sort -t_ -k2 -n \| tail -1`), increment by 1. Set `maturity: 'stable'`, `since: '0.2.0'` |
| `registry/domains.ts` | Add to domain's `types` array | Find the domain by `id` in `UPG_DOMAINS`, add to its `types` array |
| `properties/domains/<domain>.ts` | Add property interface | Create `export interface XxxProperties { ... }` with typed fields. Use existing interfaces as templates. |
| `catalog/edge-catalog.ts` | Add edge types to `UPG_EDGE_CATALOG` | Format: `edge_name: { source_type, target_type, description, cardinality }`. The `UPG_EDGE_PAIR_MAP` is derived automatically. |
| `shapes/edges.ts` / `shapes/base-node.ts` | If modifying UPGEdge / UPGBaseNode | Rarely needed; most additions go in catalog and property interfaces |

**Verify:** `cd packages/upg-spec && npm run build`; must compile clean.

### Layer 2: `upg-mcp-server` (packages/upg-mcp-server/)

The MCP server that reads/writes `.upg` files.

| What to check | When it matters |
|---------------|----------------|
| `src/server.ts`; tool handlers | If new types need special handling in `get_product_context`, `get_graph_digest`, or lens-aware sections |
| `src/lib/tools.ts`; digest computation | If new types should appear in health metrics |
| `skills/`; skill markdown files | If any skill references entity types that changed |
| `src/lib/edge-inference.ts` | If new edge types need inference rules |
| `src/classification.ts` | If tier classification changes |

**Verify:** `cd packages/upg-mcp-server && npm run build`; JS must build (DTS error in preflight.ts is pre-existing, ignore it).

### Layer 3: `apps/graph` (apps/graph/src/)

The Graph UI. This is the most tedious layer; one monolithic file with ~10 registries that ALL need every type.

**Main file:** `apps/graph/src/lib/entity-metadata.ts` (~6300 lines)

**EVERY new NodeType requires entries in ALL of these registries:**

| Registry | Type | Line range | Format |
|----------|------|------------|--------|
| `NodeType` (in `types/graph.ts`) | Union type | ~138–550 | `\| 'type_name'  // phase: X` |
| `NODE_LABELS` | `Record<NodeType, string>` | ~70–435 | `type_name: 'Display Name',` |
| `NODE_LABELS_PLURAL` | `Record<NodeType, string>` | ~436–800 | `type_name: 'Display Names',` |
| `NODE_ICONS` | `Record<NodeType, string>` | ~801–935 | `type_name: '🔍',` |
| `NODE_DESCRIPTIONS` | `Record<NodeType, string>` | ~1166–1530 | `type_name: 'One-line description',` |
| `NODE_LAYER` | `Record<NodeType, string>` | ~1531–1895 | `type_name: 'Engineering',` |
| `NODE_TYPE_TO_SLUG` | `Record<NodeType, string>` | ~2351–2715 | `type_name: 'type-name',` |
| `ENTITY_LAYERS` | Domain grouping | ~3547–3582 | Add to the right domain array |
| `DEFAULT_LAYOUT` | Layout mode | ~3600–3973 | `type_name: 'default',` |
| `PARENT_TYPE_MAP` | `Partial<Record<NodeType, NodeType>>` | ~6135–6330 | `type_name: 'parent_type',` |

**Optional registries (add if applicable):**

| Registry | When |
|----------|------|
| `TOP_LEVEL_TYPES` (~6065) | If the type can be a root node (no required parent) |
| `BOARD_GROUP_OPTIONS` (~3974) | If the type should have board view grouping |
| `VALID_CHILDREN` (if exists) | For explicit child-type allowlists |

**How to add to entity-metadata.ts efficiently:**

1. Search for an existing type in the same domain to use as a template
2. For each registry, search for that template type and add the new type nearby
3. Follow alphabetical or domain ordering within each registry

**Verify:** `cd apps/graph && npx tsc --noEmit`; the `Record<NodeType, ...>` pattern will catch any missing entries at compile time.

### Layer 4: `upg-cloud-server` (packages/upg-cloud-server/)

The cloud API server with PostgreSQL storage.

| What to check | When it matters |
|---------------|----------------|
| `src/store/pg-store.ts`; `rowToEdge()` | If new fields were added to UPGEdge (e.g., `confidence`, `note`); need column or JSONB field |
| `src/store/pg-store.ts`; `rowToNode()` | If new fields were added to UPGBaseNode |
| Database migrations | If new columns needed for new edge/node properties |

**Usually no changes needed** for additive entity types; the cloud server stores types as strings and properties as JSONB. But check edge/node serialisation if interface shapes changed.

### Layer 5: `apps/upg-site` (apps/upg-site/)

The documentation site.

| What to check | When it matters |
|---------------|----------------|
| Entity type documentation pages | If new types need user-facing docs |
| Sanity CMS content | If framework docs reference entity types |
| Domain/layer overview pages | If domain composition changed |

**Usually deferred**: docs update is a separate task.

## Workflow

### Step 1: Gather Requirements

Ask for or determine:
- **Entity type name(s)**: snake_case, singular (e.g., `root_cause`)
- **Domain**: which domain does it belong to? (e.g., `engineering`)
- **Properties**: what typed fields does it have?
- **Parent type**: what's its canonical parent in the hierarchy?
- **Edge types**: what relationships does it have with other types?
- **Display metadata**: label, plural, icon, description, layer name

### Step 2: Execute the Cascade

Work through Layers 1–5 in order. For each layer:
1. Read the relevant files
2. Find the insertion points
3. Make the changes
4. Verify the build

### Step 3: Verify

Run these checks after all changes:
```bash
# Layer 1
cd packages/upg-spec && npm run build

# Layer 2
cd packages/upg-mcp-server && npm run build

# Layer 3 (most likely to catch missing entries)
cd apps/graph && npx tsc --noEmit

# Layer 4 (if changed)
cd packages/upg-cloud-server && npm run build
```

**The `Record<NodeType, ...>` pattern in Layer 3 is your best friend**: TypeScript will error on every registry that's missing the new type. Let the compiler find what you missed.

### Step 4: Commit

Use a commit message like:
```
feat(upg-spec): add <type_name> entity type to <domain> domain

Cascade: spec → mcp-server → graph → cloud-server
```

## ID Assignment Rules

- Entity type IDs are immutable and sequential: `ent_001`, `ent_002`, ...
- Always find the current highest: `grep -o 'ent_[0-9]*' packages/upg-spec/src/registry/entity-meta.ts | sort -t_ -k2 -n | tail -1`
- Increment by 1 for each new type
- **Never reuse an ID**, even if the previous type was deprecated

## Edge Type Rules

- Edges live in `UPG_EDGE_CATALOG` in `catalog/edge-catalog.ts`
- Format: `edge_name: { source_type, target_type, description, cardinality }`
- `UPG_EDGE_PAIR_MAP` (`source_type:target_type` → edge key) is derived automatically; don't edit it
- Check for duplicates before adding: search for the pair in the catalog
- Edge names should be verb-based: `causes`, `blocks`, `enables`, `implements`, `specifies`

## Common Patterns

**Adding a debugging/troubleshooting entity (like investigation, root_cause):**
- Domain: `engineering`
- Parent: usually `service` or `bounded_context`
- Edges: `causes`, `affects`, `revealed_by`
- Properties: `status`, `severity`, `category`

**Adding a design governance entity:**
- For design decisions specifically, use the consolidated `decision` type with `layer: "design"` (see v0.2.0 migration) rather than creating a new type.
- Domain: `design`
- Parent: usually `product` or `design_system`
- Edges: `decision_informs_decision`, `decision_affects_component`, `decision_affects_screen`
- Properties (DecisionProperties): `layer`, `status` (proposed/accepted/deprecated/superseded), `context`, `decision`, `consequences`

**Adding a growth/marketing entity:**
- Domain: `growth` or `go_to_market`
- Parent: varies
- Edges: `targets`, `feeds`, `measures`
- Properties: domain-specific metrics

## Key Principle

**The compiler is the checklist.** After adding to Layer 1 (spec) and Layer 3 (graph), run `tsc --noEmit` on `apps/graph`. Every `Record<NodeType, ...>` will error if you missed a registration. Fix each error = complete cascade.
