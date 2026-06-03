# Changelog

Changes to `@unified-product-graph/cli` follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.9] - 2026-06-03

### Added
- Slot roles in framework exercises (Phase 3b-2): `upg apply <framework> feat_x:pain_reliever` records a slot role inline, and `upg score <exercise> <entity> --slot-role <role>` adds it to a result.

## [0.8.8] - 2026-06-03

CLI Hardening Wave 2 + cross-surface QA.

### Added
- `check --structure-only` for a spec-conformance-only verdict (pairs with the MCP `structurally_valid`).

### Fixed
- Hardened output sanitization, boundary/shape/range validation, and framework-score validation across the mutation and read commands; stripped control bytes from mutation success lines that echo stored, attacker-controllable titles.
- Option errors now print once instead of twice (N3).
- Corrected stale RICE examples to the shipped 1 to 5 assessment scale (`reach`/`impact`/`confidence`/`effort`), so help, create, and verify agree.

## [0.8.7] - 2026-06-03

CLI hardening + cross-surface QA. New `upg show <exercise>` (read exercise scores back); `export --format` is validated (unknown value exits 3 instead of emitting nothing; `markdown` accepted as `md`); `init` honours `--file`/`$UPG_FILE` and a new `--yes` for non-interactive runs; last-writer provenance is stamped on every write; the `upg use design` help example is corrected to `ux_design`. Co-versions the @unified-product-graph/* 0.8.7 train.

## [0.8.5] - 2026-06-02

Field-report fast-follow (tester report on 0.8.4).

### Fixed
- `upg install-skills` recorded the manifest version as `0.0.0` (it checked the pre-split package name `@unified-product-graph/mcp`); it now reads `@unified-product-graph/cli`. The stale "reinstall @unified-product-graph/mcp" error message is corrected too.
- README: removed dead `@unified-product-graph/mcp` package references from the get-started, npx, and CI/CD examples (that package does not exist; the `upg` bin ships in `@unified-product-graph/cli`), and a stray "cloud sync" phrase left over from the removed Cloud group. A drift test now guards against the dead name.

### Added
- Per-command help for `upg apply` / `upg score`: `--help` now shows usage, options, and examples instead of falling back to the top-level help.

### Changed
- `upg mcp setup` writes `npx -y @unified-product-graph/mcp-server@latest`, so npx resolves the newest server on launch instead of serving a stale cached build after a publish (the npx-cache skew gotcha). Pin a version by hand for reproducible team setups.

### Note
- Bundled skills use a verb-first grammar (renamed in 0.8.x). After upgrading, run `upg install-skills --force` to refresh your local skill set.

## [0.8.4] - 2026-06-02

Framework exercises, plus the 0.8.3 field-report follow-up (docs/wiring consistency) folded in.

### Added
- `upg apply <framework> [ids...]`: run a framework over entities. Creates a `framework_exercise` and an `includes` edge to each entity (`--title`, `--status`).
- `upg score <exercise> <entity> --data '{...}'`: record the framework's result for one entity on the includes edge (`--replace`). Exercises surface in `upg list --type framework_exercise`.

### Fixed
- `upg mcp setup` now writes the config Claude Code actually reads: `.mcp.json` (project) or `~/.claude.json` (user), not `.claude/settings.json`.
- `upg mcp setup` emits the correct launch command: `npx -y @unified-product-graph/mcp-server` (was the dead `@unified-product-graph/mcp mcp run`).
- Usage errors (unknown flag/arg) now exit `3`, matching the published exit-code table (was `1`).
- Bundled README regenerated: dropped the removed Cloud group, fixed the command surface, and corrected the exit-code table to 0/1/2/3. A consistency test guards against future drift.

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
