# Unified Product Graph — Tools

> 🧪 **Public beta.** UPG v0.6 is an early public beta — the spec, APIs, and these packages may still change. Not broadly announced yet; issues and feedback are very welcome.

The **reference implementation** of the [UPG standard](https://github.com/unified-product-graph/spec): a programmatic SDK, a CLI, local + cloud MCP servers, import adapters, and the `.upg.md` renderer.

> **Read-only mirror.** Synced one-way from the canonical TPC monorepo. UPG is currently developed upstream; this repo exists for source transparency and the npm `repository` link. Issues welcome. PRs are accepted by being ported upstream — we're migrating toward develop-in-the-open.

## Packages
| Dir | npm | Role |
|---|---|---|
| `packages/sdk` | [`@unified-product-graph/sdk`](https://www.npmjs.com/package/@unified-product-graph/sdk) | Programmatic read/write of `.upg` graphs |
| `packages/cli` | [`@unified-product-graph/cli`](https://www.npmjs.com/package/@unified-product-graph/cli) | `upg` command-line tool |
| `packages/mcp-server` | [`@unified-product-graph/mcp-server`](https://www.npmjs.com/package/@unified-product-graph/mcp-server) | Local MCP server for `.upg` files |
| `packages/cloud-server` | [`@unified-product-graph/cloud-server`](https://www.npmjs.com/package/@unified-product-graph/cloud-server) | Postgres-backed multi-tenant MCP server |
| `packages/adapters` | [`@unified-product-graph/adapters`](https://www.npmjs.com/package/@unified-product-graph/adapters) | Import from Markdown, Notion, Linear, GitHub… |
| `packages/markdown` | [`@unified-product-graph/markdown`](https://www.npmjs.com/package/@unified-product-graph/markdown) | `.upg.md` parse/render |
| `packages/mcp-tooling` | *(internal)* | Shared MCP tool-registry/transport — bundled into the servers, not published |

All published at **v0.6.0**. Depends on the standard: [`@unified-product-graph/core`](https://www.npmjs.com/package/@unified-product-graph/core) (from the [`spec`](https://github.com/unified-product-graph/spec) repo).

## Building
Standalone build is **not yet wired** — packages reference the upstream monorepo's shared config, and the servers bundle the internal `frameworks` (which lives in the `spec` repo) + `mcp-tooling`. The canonical build & test run in the monorepo. (Develop-in-the-open migration will make this self-contained.)

## Links
- Site & docs: https://unifiedproductgraph.org
- The standard: [`unified-product-graph/spec`](https://github.com/unified-product-graph/spec)
