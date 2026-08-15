# Unified Product Graph: Tools

> 🧪 **Early alpha.** UPG v0.30.0. APIs and packages are still evolving and breaking changes can land between versions. Pin a version if you need stability. Issues and feedback are welcome.

The reference implementation of the [UPG standard](https://github.com/unified-product-graph/spec): a programmatic SDK, a CLI, local and cloud MCP servers, import adapters, and the `.upg.md` renderer.

## Packages

| Dir | npm | Role |
|---|---|---|
| `packages/sdk` | [`@unified-product-graph/sdk`](https://www.npmjs.com/package/@unified-product-graph/sdk) | Programmatic read/write of `.upg` graphs |
| `packages/cli` | [`@unified-product-graph/cli`](https://www.npmjs.com/package/@unified-product-graph/cli) | `upg` command-line tool |
| `packages/mcp-server` | [`@unified-product-graph/mcp-server`](https://www.npmjs.com/package/@unified-product-graph/mcp-server) | Local MCP server for `.upg` files |
| `packages/cloud-server` | [`@unified-product-graph/cloud-server`](https://www.npmjs.com/package/@unified-product-graph/cloud-server) | Postgres-backed multi-tenant MCP server |
| `packages/adapters` | [`@unified-product-graph/adapters`](https://www.npmjs.com/package/@unified-product-graph/adapters) | Import from Markdown, Notion, Linear, GitHub, and more |
| `packages/markdown` | [`@unified-product-graph/markdown`](https://www.npmjs.com/package/@unified-product-graph/markdown) | `.upg.md` parse/render |
| `packages/mcp-tooling` | *(internal)* | Shared MCP tool-registry/transport, bundled into the servers |

Built on the standard: [`@unified-product-graph/core`](https://www.npmjs.com/package/@unified-product-graph/core).

## Links

- Site and docs: https://unifiedproductgraph.org
- The standard: [`unified-product-graph/spec`](https://github.com/unified-product-graph/spec)
