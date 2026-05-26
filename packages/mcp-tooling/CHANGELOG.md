# Changelog

All notable changes to `@unified-product-graph/mcp-tooling` are documented
in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] 2026-05-19

### Added

- First public release of `@unified-product-graph/mcp-tooling`.
- Wire-shape primitives: `ToolResult`, `ToolDefinition`, `ToolHandler`,
  `ToolBinding`, `MCPTransport`.
- Catalog helpers: `resolveEntityType`, `UnknownEntityTypeError`,
  `buildEntitySchema`, `buildEntityFields`, `buildAllEntityFields`.
- Atomicity contracts for `migrate_type`, `validate_graph`,
  `rename_edge_type`, `export_edges`, plus the stub envelope for the
  future `migrate_properties` tool.
- Reference generator under `@unified-product-graph/mcp-tooling/generator`,
  with JSDoc walker, audit gate, and three-output emitter.

### Requires

- Node.js `>=18`.
- `@unified-product-graph/core` `^0.4.0`.
