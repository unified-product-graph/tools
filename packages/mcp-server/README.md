# UPG MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that reads and writes `.upg` files. The `.upg` file is a portable JSON document holding your product graph: entities (personas, features, hypotheses, OKRs) and the relationships between them.

The server exposes 90 tools. They cover graph reads and writes plus introspection of everything `@unified-product-graph/core` ships: entity types, edges, frameworks, regions, playbooks, lenses, anti-patterns, benchmarks.

See [CHANGELOG.md](./CHANGELOG.md) for the release history.

## Quick Start

### 1. Install

```bash
npm install @unified-product-graph/mcp-server
```

### 2. Configure your MCP client

For Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "unified-product-graph": {
      "command": "npx",
      "args": ["upg-mcp-server"]
    }
  }
}
```

The server auto-discovers `.upg` files in the current directory. To point at a specific file:

```json
{
  "mcpServers": {
    "unified-product-graph": {
      "command": "npx",
      "args": ["upg-mcp-server", "--file", "path/to/product.upg"]
    }
  }
}
```

The config key (`"upg"`) sets the tool prefix your client sees (`mcp__upg__create_node`, etc.). The server identifies itself to the MCP registry as `unified-product-graph`.

### 3. Start using it

If no `.upg` file exists, the server creates a blank `product.upg`. Use `create_node` to start building, or invoke one of the five approach verbs (`plan`, `inspect`, `prioritise`, `trace`, `reflect`) to engage the graph cognitively.

## File Discovery

The server picks the `.upg` file to load in this order:

1. `--file` flag: use that file directly
2. `.upg/workspace.json`: load the default product from a workspace
3. `*.upg` files in cwd: first alphabetically
4. Otherwise: create a blank `product.upg`

## Conceptual Surface

UPG ships five collaborating primitives. The MCP server exposes all five.

| Primitive | What it answers |
|---|---|
| **Region** | "Where in the graph does this thinking live?" (10 super-domain rollups) |
| **Framework** | "What does this thinking tool look like?" (large catalog with `approach_ids` tagged where applicable) |
| **Canonical playbook** | "How do I populate this region from scratch?" (one per region) |
| **Specialised playbook** | "How do I populate this region using framework X?" |
| **Approach** | "What's the path of arrival to engaging this region cognitively?" (5: Plan, Inspect, Prioritise, Trace, Reflect) |

> An approach is the path of arrival to a region (final approach to an airport, coastline approach), not a strategy choice.

## MCP Tools

90 tools across nine domains. Full reference: [TOOLS.md](./TOOLS.md), generated from `src/tools/*.ts` and shipped on npm.

| Domain | Count | What it covers |
|---|---|---|
| Context & Session | 4 | Product overview, graph digest (~500 tokens), lens-aware session state |
| Nodes | 14 | Read, write, batch, search, migrate, deduplicate entities |
| Edges | 9 | Create, delete, batch, rename, repair, export edges |
| Areas & Change Log | 5 | Sub-graph scoping, mutation audit log |
| Workspace & Portfolios | 9 | Multi-product workspace, portfolio cross-edges |
| Schema | 1 | Per-type expected properties + valid edges |
| **Spec Introspection** | **43** | Regions, playbooks, approaches, frameworks, edge catalogue, lenses, type labels, anti-patterns, benchmarks, product stages, entity meta, spec version, migrations, lifecycles, scales, framework categories/patterns, domain rings |
| Cloud Sync | 3 | Push / pull / sync state (cloud server is a separate package) |
| Validation | 2 | Whole-graph correctness pass, per-anti-pattern violation report |

### Approaches (5 verb-led tools)

Each approach handler returns a family-resemblance envelope `{ approach_id, scope, generated_at, approach, params, execution_mode }`. Handlers provide definition lookup today. The LLM is the executor: read the `signature_hint` and synthesise the structured projection.

| Verb | Question | Required args |
|---|---|---|
| `plan({ region? })` | "What should I build next?" | none |
| `inspect({ region?, entities? })` | "What's broken?" | none |
| `prioritise({ candidates, framework_id })` | "What's most important?" | both |
| `trace({ anchor, path, edges_override? })` | "Walk a meaningful path through existing graph" | `anchor` + type-shorthand `path` |
| `reflect({ scope?, mode? })` | "What should I be questioning?" | none (`mode` is one of `assumptions`, `alternatives`, `blind-spots`, `load-bearing`) |

`list_approaches({ framework_id? })` and `get_approach({ id })` give the catalog view; the verb tools are the operational surface.

### Spec Introspection (43 tools)

Every canonical export from `@unified-product-graph/core` is reachable from the server. Highlights:

- **Regions:** `list_regions`, `get_region`, `get_region_for_entity_type`
- **Playbooks:** `list_playbooks({ region?, canonical_only?, framework_id? })`, `get_playbook`
- **Approaches:** `list_approaches`, `get_approach` (catalog view of the 5 verbs)
- **Frameworks:** `list_frameworks`, `get_framework` (large catalog, paginated)
- **Edges:** `list_edge_types`, `get_edge_type`, `resolve_edge_for_pair`, `list_cross_edge_types`
- **Lenses:** `list_lenses`, `get_lens` (resolves `visible_types` in one call)
- **Type labels:** `list_type_labels`, `get_type_label` (framework-aware label resolution)
- **Hierarchy:** `get_valid_children` ("what can I create under this?")
- **Entity meta:** `list_entity_types`, `get_entity_meta` (immutable type_id, maturity tier, since-version, replacements)
- **Domains:** `list_domains` (with `with_guide_only` toggle), `get_domain_guide`
- **Anti-patterns:** `list_anti_patterns`, `get_anti_pattern` (machine-evaluable conditions, remediation, severity, applicable stages)
- **Benchmarks:** `list_benchmarks({ kind })`: count / relationship / ratio / domain-activation catalogs (data behind `get_graph_digest` health logic)
- **Product stages:** `list_product_stages` (canonical 9-stage journey)
- **Spec version:** `get_spec_version` (UPG version + counts)

All spec-introspection handlers are read-only and snapshot from the spec package at server boot. Restart the server to pick up a new spec version.

## Behaviour Notes

**Two-tier entity-type validation.** `create_node`, `batch_create_nodes`, and `update_node` (when changing `type`) apply the same validation: deprecated synonyms alias to canonical with a warning (`jtbd → job`, `pain_point → need`, `kpi → metric`, `research_insight → insight`); unknown types throw `UnknownEntityTypeError` with up to 5 Levenshtein-1 suggestions.

**Edge inference fails closed.** `inferEdgeType` returns a discriminated union: a miss produces a structured failure with catalog-resolvable suggestions. Alias resolution applies first, so a deprecated source/target like `jtbd → need` resolves through `getReplacementType` before catalog lookup.

**Atomic write surfaces.** Every multi-step mutation (`move_node`, `batch_move_nodes`, `update_node` with `type`, `batch_create_nodes` with `edges`) validates against the catalog up front and rolls back fully on any apply-step failure. The graph is bit-for-bit identical to the pre-call state on rejection.

**Digest canonical types.** `get_graph_digest` chain coverage sources entity types from the canonical set via `getReplacementType`. Output keys are canonical (`persona_with_job`, `job_with_need`, `job_total`); legacy-typed nodes count toward canonical totals so post-`migrate_type` graphs report correctly.

## Installing Skills (Claude Code)

The server provides the raw MCP tools. For a guided experience with slash commands (`/upg`, `/upg-new-graph`, `/upg-show-journey`), install the skill files:

```bash
bash scripts/install-skills.sh
```

The install script supports six AI coding tools: Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, and Kiro. Skills are markdown files that layer structured prompts on top of the MCP tools.

## How It Works

- The server loads a `.upg` file into memory on startup
- Reads are served from in-memory indexes (O(1) node/edge lookups)
- Writes are debounced and auto-saved back to the file (300ms delay)
- External file changes are detected via filesystem watcher and hot-reloaded
- Saves use atomic write (write to `.tmp`, then rename) to prevent corruption
- Spec introspection handlers snapshot from `@unified-product-graph/core` at boot

## Companion Docs

- **[TOOLS.md](./TOOLS.md)**: source-of-truth tool reference (auto-generated)
- **[CHANGELOG.md](./CHANGELOG.md)**: release history
- **[unifiedproductgraph.org](https://unifiedproductgraph.org)**: the UPG specification and conceptual model

## Spec

The Unified Product Graph format is documented at [unifiedproductgraph.org](https://unifiedproductgraph.org).

## License

MIT; see [LICENSE](./LICENSE).
