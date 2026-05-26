# @unified-product-graph/cloud-server

**91 MCP tools across 14 domains, backed by Postgres.** Self-hostable [Model Context Protocol](https://modelcontextprotocol.io) server for the [Unified Product Graph](https://unifiedproductgraph.org).

<!-- badges -->
<!-- [![npm](https://img.shields.io/npm/v/@unified-product-graph/cloud-server)](https://www.npmjs.com/package/@unified-product-graph/cloud-server) -->
<!-- [![license](https://img.shields.io/npm/l/@unified-product-graph/cloud-server)](./LICENSE) -->

## What this is

The UPG Cloud Server stores your product graph in Postgres. It exposes graph operations (products, nodes, edges, search, traversal, collaboration, webhooks) as MCP tools that any compatible client (Claude Code, Cursor, etc.) can call.

**Pick this server when you need:**

- **Multi-tenant storage.** One durable store, many products scoped by `product_id`.
- **Collaboration.** Comments, role-based access (`owner` / `editor` / `viewer`), audit log.
- **Outbound webhooks.** Fire on node and edge mutations.
- **A database service** under your UPG stack.

For a single user on a single graph, prefer `@unified-product-graph/mcp-server` plus a `.upg` file: version-controlled, zero infrastructure. Cloud and local share one spec; graphs round-trip between them.

## Quick Start

### Option 1: Docker (recommended)

```bash
cd docker
docker compose up -d
```

This starts Postgres on port `5433` and applies the migrations automatically. The MCP server then connects to it.

### Option 2: Connect to existing Postgres

```bash
UPG_DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx @unified-product-graph/cloud-server
```

Run the [migration](#database-setup) first.

### Option 3: MCP config (Claude Code / Cursor)

Add this to your `.claude/settings.json` or MCP client config:

```json
{
  "mcpServers": {
    "upg-cloud": {
      "command": "npx",
      "args": ["@unified-product-graph/cloud-server", "--database-url", "postgres://upg:upg@localhost:5433/upg"]
    }
  }
}
```

> **Naming.** The config key (`"upg-cloud"`) determines the tool prefix your client sees (`mcp__upg-cloud__*`). The server reports itself to the MCP registry as `unified-product-graph-cloud`. Keep `"upg-cloud"` as the key to stay compatible with existing skill playbooks.

## MCP Tools

**91 tools across 14 domains.** Reference: [`TOOLS.md`](./TOOLS.md) (generated from JSDoc by `npm run generate-tools`). The high-level shape:

| Domain | What it covers |
| ------ | -------------- |
| Products & Audit | `list_products`, `create_product`, `get_audit_log` |
| Context & Traversal | `get_product_context`, `get_graph_digest`, `query`, `get_changes`, `trace` |
| Nodes | CRUD + `get_nodes`, `search_nodes`, `list_nodes`, `move_node`, batch primitives |
| Edges | `create_edge`, `delete_edge`, `export_edges`, `rename_edge_type`, batch primitives |
| Areas | `list_product_areas`, `get_area_graph`, `create_area`, `get_area_context` |
| Portfolios | `create_cross_product_edge`, `list_portfolios`, `list_portfolio_cross_edges`, `migrate_cross_edges` |
| Schema | `get_entity_schema` (catalog-driven, shared with local) |
| Validation & Migration | `validate_graph`, `migrate_type`, `repair_dangling_edges`, `deduplicate_nodes` |
| Collaboration | `add_comment`, `list_comments`, `grant_access`, `list_collaborators` |
| Analytics | `get_graph_analytics` (Postgres-side aggregator) |
| Webhooks | `register_webhook`, `list_webhooks`, `remove_webhook` |
| Spec introspection | playbooks, approaches, domains, frameworks, edge catalog, regions, lenses, type labels, entity meta, anti-patterns, benchmarks, lifecycles, scales |
| Approaches | `plan`, `inspect`, `prioritise`, `trace`, `reflect` |
| Migrations catalogue | `list_type_migrations`, `list_edge_migrations`, `list_split_migrations` |

### Parity with `@unified-product-graph/mcp-server`

Cloud has full tool-surface parity with `@unified-product-graph/mcp-server`. Both walk the same catalog, schema, and atomicity contracts via `@unified-product-graph/mcp-tooling`. Cloud adds collaboration, comments, webhooks, audit-log, cross-product-edge, and Postgres-side analytics on top.

## Database Setup

Docker (`docker compose up -d`) runs migrations automatically. To apply manually:

```bash
psql $UPG_DATABASE_URL -f migrations/001_initial.sql
```

This creates a `upg` schema with:

- **`upg.products`**: products with title, description, stage
- **`upg.nodes`**: typed entities (features, personas, decisions, etc.) with full-text search
- **`upg.edges`**: typed relationships between nodes
- **`upg.comments`**: comments on nodes
- **`upg.audit_log`**: change history per product
- **`upg.collaborators`**: user roles (`owner` / `editor` / `viewer`) per product
- **`upg.webhooks`**: registered webhook endpoints

All tables include timestamps, cascading deletes, and performance indexes.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPG_DATABASE_URL` | Yes | (none) | Postgres connection string. Can also be passed as `--database-url`. |

```bash
# Environment variable
UPG_DATABASE_URL=postgres://upg:upg@localhost:5433/upg npx @unified-product-graph/cloud-server

# CLI flag
npx @unified-product-graph/cloud-server --database-url postgres://upg:upg@localhost:5433/upg
```

## Auth model

The server is an **MCP stdio process**. It speaks MCP over stdin/stdout to a single trusted client (Claude Code, Cursor, etc.).

Multi-tenancy is **graph-shaped**:

- Tools take `product_id` and `user_id` arguments explicitly.
- `grant_access` / `list_collaborators` write to `upg.collaborators` for host-side role checks.
- Authorisation enforcement (does this `user_id` have `editor` on this `product_id`?) sits with the wrapping layer: a hosted gateway, an authenticated HTTP transport, or a per-tenant Postgres role.

For public self-hosting, front the server with an authenticating transport. The current contract: trusted client, graph-shaped multi-tenancy.

## Open protocol, optional commercial layer

UPG is an **open protocol** for representing products as structured graphs. This server is the open-source reference implementation. See [unifiedproductgraph.org](https://unifiedproductgraph.org) for the spec and ecosystem.

Commercial products may layer guided creation journeys, AI copilots, and visual canvases on top. Think Git versus hosted Git providers. The server works standalone with any MCP-compatible client.

## Versioning

`@unified-product-graph/cloud-server` co-versions with `@unified-product-graph/core` and `@unified-product-graph/mcp-server`. One version line covers spec and both reference implementations.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build (also regenerates TOOLS.md from JSDoc)
npm run build

# Type-check
npm run type-check

# Tests
npm test

# Regenerate TOOLS.md only
npm run generate-tools
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local-dev setup, the Docker compose flow, migration conventions, and where to file issues.

## License

MIT. See [LICENSE](./LICENSE).
