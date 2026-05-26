# Changelog

All notable changes to `@unified-product-graph/mcp-server` are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
