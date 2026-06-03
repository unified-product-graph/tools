# Changelog

All notable changes to `@unified-product-graph/markdown` will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.8] - 2026-06-03

Co-versioned with the 0.8.8 train. No functional change.

## [0.8.7] - 2026-06-03

Co-version with the @unified-product-graph/* 0.8.7 release train.

## [0.8.5] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.5 fast-follow (skill_audit + CLI/docs consistency + npx-cache fix). No surface change; co-versioned for a clean install matrix.

## [0.8.4] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.4 release train (framework exercises, led by `core`/`sdk`/`mcp-server`; folds the 0.8.3 patch). No surface change; co-versioned for a clean install matrix.

## [0.8.2] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.2 release train. No surface changes; co-versioned for a clean install matrix.

## [0.6.0] · 2026-05-22

Aligned with `@unified-product-graph/core@0.6.0` launch train.

### Changed

- Bumped peer dependency `@unified-product-graph/core` from `>=0.5.0` to `^0.6.0` to keep the install matrix predictable across the `@unified-product-graph/*` scope.

No markdown surface changes.

## [0.5.0] · 2026-05-19

Initial public release.

### Added

- `parse()`: frontmatter, `[[type:id]]` entity refs, `{{type:id}}` edge refs,
  and inline properties from `.upg.md` source.
- `buildIndex()`: flatten parse results into a typed lookup index.
- `validate()`: resolve refs through an injected lookup function; collect
  missing-ref diagnostics.
- `toPlainMarkdown()` / `updateRefs()`: render to plain CommonMark or rewrite
  refs in place.
- `toTipTapJSON()` / `fromTipTapJSON()`: round-trip with TipTap editor JSON.
- `@unified-product-graph/core` (`>=0.5.0`) is an optional peer dependency
  for ref resolution.
