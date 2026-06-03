# Changelog

All notable changes to `@unified-product-graph/adapters` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.7] - 2026-06-03

Co-version with the @unified-product-graph/* 0.8.7 release train.

## [0.8.5] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.5 fast-follow (skill_audit + CLI/docs consistency + npx-cache fix). No adapters surface change; co-versioned for a clean install matrix.

## [0.8.4] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.4 release train (framework exercises, led by `core`/`sdk`/`mcp-server`; folds the 0.8.3 patch). No adapters surface change; co-versioned for a clean install matrix.

## [0.8.2] - 2026-06-02

Co-version with the @unified-product-graph/* 0.8.2 release train. No surface changes; co-versioned for a clean install matrix.

## [0.6.0] - 2026-05-22

Aligned with `@unified-product-graph/core@0.6.0` launch train.

### Changed

- Bumped `@unified-product-graph/core` dependency to `^0.6.0`.

No adapter surface changes.

## [0.5.0] - 2026-05-19

Initial public release.

### Added

- 37 import adapters covering product, research, analytics, CRM, design,
  delivery, and collaboration tools.
- Markdown adapter parses structured `.md` files into UPG entities using
  heading hierarchy and keyword inference.
- Notion adapter runs in both directions. The import direction maps databases
  and relation properties to UPG nodes and edges. The reverse direction lives
  in two sub-modules: a schema generator and a workspace discovery classifier.
- Delivery-layer adapters: Linear, GitHub, GitLab, Jira, Shortcut.
- Research-layer adapters: Dovetail, Condens, Lookback, Sprig, Maze, Vistaly.
- Analytics adapters: Amplitude, PostHog, Pendo.
- Customer-platform adapters: HubSpot, Salesforce, Intercom, Gainsight, Zendesk.
- Product-platform adapters: Productboard, Aha!, Airfocus, Craft.io, Chisel, ProdPad, Canny.
- OKR adapters: Quantive, Lattice.
- Utility adapters: Figma, Miro, Storybook, Confluence, Coda, Slack, LaunchDarkly.
- `UPGAdapter` interface for building custom adapters.
- `ADAPTERS` registry plus `getAdapter(name)` lookup.

### Versioning note

This is the first published version. The `0.5.0` baseline aligns with
`@unified-product-graph/core@0.5.0`. The adapters package tracks the
core spec major/minor going forward.
