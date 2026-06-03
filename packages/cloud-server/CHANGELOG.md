# Changelog

All notable changes to `@unified-product-graph/cloud-server` are documented in this file.

This package co-versions with `@unified-product-graph/core` and `@unified-product-graph/mcp-server`. One version line covers the spec and both reference implementations.

## 0.8.7 · 2026-06-03 · Consolidation + QA train

Co-version with the `@unified-product-graph/*` 0.8.7 release train (framework-surface consolidation + `scoring_lens`, CLI hardening, cross-surface QA, led by `core`/`cli`/`mcp-server`; folds the 0.8.6 train). No cloud-server surface change; co-versioned for a clean install matrix.

## 0.8.5 · 2026-06-02 · Field-report fast-follow

Co-version with the `@unified-product-graph/*` 0.8.5 fast-follow (skill_audit source resolution + CLI/docs consistency + npx-cache fix, led by `cli`/`mcp-server`). No cloud-server surface change; co-versioned for a clean install matrix.

## 0.8.4 · 2026-06-02 · Framework exercises train

Co-version with the `@unified-product-graph/*` 0.8.4 release train (framework exercises led by `core`/`sdk`/`mcp-server`, folding the 0.8.3 CLI/MCP wiring fixes). No cloud-server surface change; co-versioned for a clean install matrix.

## 0.8.2 · 2026-06-02 · E2E remediation train

Co-version with the `@unified-product-graph/*` 0.8.2 release train. No cloud-server surface changes; co-versioned for a clean install matrix alongside the shared write-validation and skills work led by `core`, `sdk`, and `mcp-server`.

## 0.7.6 · 2026-05-30 · Tool UX train (mcp-server lead)

This line is led by `@unified-product-graph/mcp-server` (the `start` tool, `create_node` orphan warning, authored return shapes, and the dissolved singleton tool groups). The cloud server itself is unchanged at runtime; it co-versions and picks up the shared `mcp-tooling` generator changes:

- **Authored return shapes:** the generated tool reference now ships build-time `return_shape` / `return_notes` derived from each handler's authored `@returns`.
- **Parity audit hardening ( /):** the cloud ↔ local parity audit now fails with an actionable "build the manifest first" message instead of a raw `ENOENT` when run without a prior build.

## 0.6.0 · 2026-05-22 · Launch train alignment

Aligned with `@unified-product-graph/core@0.6.0`. Bumped `@unified-product-graph/core` dep to `^0.6.0`. No cloud-server surface changes; co-versioned for the launch train.

## 0.5.0 · 2026-05-19 · Inaugural public release

First public npm release on the `@unified-product-graph/` scope. Co-versions with `@unified-product-graph/core@0.5.0` and `@unified-product-graph/mcp-server@0.5.0`.

### Highlights

- **91 tools across 14 domains.** Full tool-surface parity with the local `mcp-server` (79 shared) plus 12 cloud-only: collaboration, comments, webhooks, audit-log, cross-product-edge, and Postgres-side analytics.
- **Spec introspection.** Playbooks, approaches, domain guides, frameworks, edge catalog, regions, lenses, type labels, entity meta, anti-patterns, benchmarks, lifecycles, scales, and migrations catalogues are all queryable as MCP tools.
- **Approaches.** `plan`, `inspect`, `prioritise`, `trace`, `reflect` ship as definition-lookup handlers; structured execution lands in a follow-on release.
- **Cross-product edges.** `create_cross_product_edge`, `list_portfolio_cross_edges`, `migrate_cross_edges` for portfolio-level relationships.
- **Portfolio hierarchy.** `list_portfolios`, `create_area`, `get_area_context`.
- **Validation and migration.** `validate_graph`, `migrate_type`, `repair_dangling_edges`, `deduplicate_nodes`, `rename_edge_type`, `export_edges`.
- **Audit trail.** Every write carries actor and timestamp; replay supported via append-only edge tables.
- **Self-hostable.** Docker-ready, Postgres-backed; bring your own database.
- **Shared catalog.** Cloud and local both walk `@unified-product-graph/mcp-tooling` for `ToolDefinition`, `resolveEntityType`, `buildEntitySchema`, and atomicity contracts.

### Install

```bash
npm install -g @unified-product-graph/cloud-server
upg-cloud-server --database-url postgres://user:pass@localhost/upg
```

Wire it into your MCP client by pointing at the running server. Database migrations ship with the package; see [README.md](./README.md#database-setup).

### Pairs with

- `@unified-product-graph/core@0.5.0`
- `@unified-product-graph/mcp-server@0.5.0` (tool-surface parity)
- `@unified-product-graph/mcp-tooling@0.5.0` (shared catalog and atomicity contracts)
