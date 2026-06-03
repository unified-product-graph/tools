# Changelog

All notable changes to `@unified-product-graph/mcp-server` are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.11] - 2026-06-03

### Fixed
- Startup deprecation check no longer flags canonical types. It used `getDeprecatedTypes()` (the historical migration union, which still contains `hypothesis` from the v0.2.8 split) and walked `UPG_MIGRATIONS` for the replacement, so a graph with canonical `hypothesis` nodes printed a bogus warning pointing a canonical type at a deprecated one. Detection and the suggested replacement now come from entity-meta (`isDeprecatedType` / `getReplacementType`). Genuinely deprecated types (`hypothesis_claim`, `pain_point`, `jtbd`) still warn, in the correct direction. (#1976)

## [0.8.10] - 2026-06-03

Co-versioned 0.8.10 release, in lockstep with the package train. No changes to `@unified-product-graph/mcp-server` itself; it inherits the core framework-score validation fix (Kano sum-denominator false positive) via its `@unified-product-graph/core` dependency.

## [0.8.9] - 2026-06-03

### Added
- `apply_framework` accepts `slot_roles` (entity id to role); `score_entity` accepts `slot_role` (Phase 3b-2), validated against the framework's declared slot roles.

### Changed
- Bundles core 0.8.9 (scoring_lens to scoring_method rename; slot_role on the exercise edge).

## [0.8.8] - 2026-06-03

### Added
- `validate_graph` now returns `structurally_valid` (spec conformance, independent of product-health linting) alongside the existing `valid` (combined structure + health, unchanged). N4.
- Non-breaking parameter aliases: `get_node` accepts `node_id`|`id`, `get_framework` `id`|`framework_id`, `switch_product` `file`|`product`; the canonical key wins and errors name both. N2.

### Changed
- Bundles core 0.8.8 (slot roles, kano/raid-log scoring lenses, framework-score validation).

## [0.8.7] - 2026-06-03

`list_frameworks` now returns a lightweight summary per framework (the full four-layer record was overflowing the tool-result token cap on the default call); `get_framework` returns the full record. `apply_framework` shares one cross-surface envelope with the CLI (`{ exercise_id, exercise, included, warnings }`). `get_framework` gives a helpful error on an unknown id. Last-writer provenance is stamped on writes. The `upg-prioritise` skill teaches the apply/score exercise flow. Co-versions the @unified-product-graph/* 0.8.7 train.

## [0.8.5] - 2026-06-02

Field-report fast-follow (tester report on 0.8.4).

### Fixed
- `skill_audit` no longer false-reports skills as out of sync on npm/npx installs. It resolved the canonical source from `process.cwd()/packages/upg-mcp-server/skills` — a monorepo-only path absent in a user's project — so every deployed skill came back unverifiable. It now resolves the skills bundled in the installed package (relative to the module), and treats a symlink to a byte-identical bundle, or a matching copy, as healthy: content match, not deployment method, is the signal.

### Changed
- The `prioritise` `type_mismatch` hint now points to the framework_exercise escape hatch (`apply_framework` / `upg apply`, then prioritise with `exercise_id`), so scoring a non-target entity type is discoverable.

## [0.8.4] - 2026-06-02

Framework exercises, with the 0.8.3 launch fix folded in.

### Added
- `apply_framework` and `score_entity` tools: create a `framework_exercise` and record per-entity results on the includes edge (94 to 96 tools).
- `create_edge` accepts gated `properties` (only edge types that opt in). `prioritise` accepts an optional `exercise_id` that sources scoring inputs from the includes edges and scores across any entity type.

### Fixed
- The server no longer crashes with `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` when launched via `upg mcp run` — `parseArgs` now tolerates stray positionals. The standalone `upg-mcp-server` bin is unaffected.

## [0.8.2] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.2 release train.

### Changed
- Tool handlers now enforce the shared write-validation policy directly: `batch_create_edges` rejects invalid edge types, `update_node` honours property unset and rejects invalid status, and session-context updates reject invalid lenses.
- Bundled skills renamed to a consistent verb-based grammar and reworked to be MCP-first: schemas, lifecycles, and edges are fetched from the server before writes rather than hard-coded.

### Added
- `skill_audit` all-mode for full-surface review.

## [0.7.6] - 2026-05-30

### Added

- **`start` tool:** a zero-state on-ramp. An empty or barely-started graph gives an agent nothing to plan against; `start` reads the live graph and recommends the first canonical playbook (from `UPG_PLAYBOOKS`) plus the exact `create_node` call for its anchor entity. Young graphs (< 8 non-product nodes) get the first canonical playbook whose anchor isn't present yet; established graphs are routed to `plan` / `inspect` / `get_graph_digest`. 94 tools total.

### Changed

- **`create_node` orphan warning:** when a node lands with no parent and its type sits at position > 0 in its domain's creation sequence (the spec expects it under the domain anchor), the response carries a warning naming the typical parent and the canonical edge. Anchors, roots, and guide-less types never warn.
- **Tool reference return shapes are now authored-source-derived:** the generator parses each tool's `@returns` prose into a structured `return_shape` / `return_notes` at build time, shipped on the manifest. Fixed a `create_node` `@returns` wrap artifact at source.
- **Dissolved the singleton `Migrations` and `Skills Introspection` tool-reference sections:** `migrate_status` now groups under Nodes and `skill_audit` under Validation, without moving the source. Reference drops from 11 to 9 domains.

## [0.6.3] - 2026-05-27

### Changed

- **`list_frameworks` / `get_framework` now serve the 34 canonical frameworks**, not the full 216-record research library. They previously imported `UPG_FRAMEWORKS` from the internal `@unified-product-graph/frameworks` package; they now source it from `@unified-product-graph/core`'s canonical surface, matching `cloud-server`, the published `core` export, and the public catalog on unifiedproductgraph.org. Research frameworks remain internal and are promoted into the canonical set incrementally as each is reviewed. `get_framework` for a non-canonical id now returns "Unknown framework id".

## [0.6.2] - 2026-05-26

### Fixed

- **Server failed to start when launched through a symlinked path**, which broke the primary install path `claude mcp add upg -- npx @unified-product-graph/mcp-server`, npx `.bin` shims, global installs, and macOS `/tmp`. The entrypoint guard compared `process.argv[1]` (literal invocation path) to `import.meta.url` (symlink-resolved by the ESM loader) as raw strings; when they diverged the server exited 0 with no output, which MCP clients report as "Failed to connect." The guard now compares realpaths. Added a regression test that spawns the built binary through a symlink.

## [0.6.1] - 2026-05-26

### Changed

- Metadata only: `UPG_VERSION` aligned to 0.6.1 and `repository` repointed to the public `unified-product-graph/tools` mirror. No runtime changes.

## [0.6.0] - 2026-05-22

Aligned with `@unified-product-graph/core@0.6.0` launch train.

### Changed

- Bumped peer/dependency on `@unified-product-graph/core` to `^0.6.0`.
- Internal `UPG_FRAMEWORKS` consumer surface now reflects the 34 canonical frameworks (was 216). Affects any tool that enumerates frameworks for label resolution or slot lookup.

## [0.5.0] - 2026-05-19

Inaugural public release on the `@unified-product-graph/` npm scope. Co-versioned with `@unified-product-graph/core@0.5.0`.

### Added

- **90 tools** across 9 domains: read, write, walk, schema, playbooks, approaches, validation, migration, workspace. See [TOOLS.md](./TOOLS.md) for the full reference.
- **5 canonical approaches** as bare-verb tools: `plan`, `inspect`, `prioritise`, `trace`, `reflect`.
- **23 region-anchored playbooks** across 10 regions (one canonical playbook per region plus 13 specialised entry paths).
- **Spec introspection** wired through to `@unified-product-graph/core`: entity types, edge types, lifecycles, migrations, anti-patterns, frameworks, lenses, type labels, valid children, regions, benchmarks, product stages, scales, domain rings.
- **Migration tooling**: `migrate_type`, `migrate_properties`, `rename_edge_type`, `repair_dangling_edges`.
- **Batch operations**: `batch_create_nodes`, `batch_create_edges`, `batch_update_nodes`, `batch_delete_nodes`, `batch_move_nodes`.
- **Cloud sync**: `get_sync_state`, `apply_pull_changeset`, `push_to_cloud`. Auto-discovers credentials from a `upg-cloud` entry in `.mcp.json`.
- **40+ skill files** for Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, and Kiro, installable via `bash scripts/install-skills.sh`.

### Install

```bash
# In Claude Code
claude mcp add upg -- npx @unified-product-graph/mcp-server

# In any other MCP client (JSON config)
{
  "mcpServers": {
    "upg": { "command": "npx", "args": ["@unified-product-graph/mcp-server"] }
  }
}
```

### Dependencies

- `@modelcontextprotocol/sdk ^1.27.0`
- `@unified-product-graph/core ^0.5.0`
- `@unified-product-graph/frameworks ^0.5.0`
- `chokidar ^4.0.0`
- `nanoid ^5.1.0`

### Requires

- Node.js 20 or later

---

Earlier pre-release development history is not maintained in this changelog. Subsequent releases will track core's version line unless a server-specific change demands otherwise.
