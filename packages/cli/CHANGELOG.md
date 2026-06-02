# Changelog

Changes to `@unified-product-graph/mcp` follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.2 release train.

### Changed
- Floor command fixes across resolution, output, and error reporting.
- Version is read from a single source so `--version`, the logo, and `init` can never drift.

## [0.6.0] - 2026-05-22

Aligned with `@unified-product-graph/core@0.6.0` launch train. No CLI surface changes; co-versioned for clean install matrix across `@unified-product-graph/*`.

## [0.5.0] - 2026-05-19

**Co-version:** pairs with `@unified-product-graph/core@0.5.0`.

First public release. 22 commands across 6 groups.

### Added

- Governance: `health`, `verify`, `diff`, `gaps`.
- Explore: `list`, `tree`, `search`.
- Create & edit: `create`, `update`, `delete`, `connect`.
- Workspace: `init`, `workspace`, `import`, `export`.
- Cloud: `login`, `logout`, `push`, `pull`, `products`, `log`.
- Setup: `mcp setup`, `mcp status`, `mcp run`, `install-skills`.
- Bundled UPG skills for Claude Code.
- Import adapters: Markdown, Notion, Linear, Vistaly, Dovetail, GitHub.
