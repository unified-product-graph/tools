# @unified-product-graph/mcp-tooling

Five primitives behind every UPG MCP server.

```
ToolResult        wire shape
ToolDefinition    catalog contract
ToolHandler       per-server runtime
ToolBinding       definition + handler
MCPTransport      stdio, HTTP, or your own
```

Plus catalog helpers (`resolveEntityType`, `buildEntitySchema`,
`buildEntityFields`), atomicity envelopes (`MigrateTypeResult`,
`ValidateGraphResult`, `RenameEdgeTypeResult`, `ExportEdgesResult`,
`MigratePropertiesResult`), and a JSDoc-driven reference generator at
`@unified-product-graph/mcp-tooling/generator`.

## Who uses it

- [`@unified-product-graph/mcp-server`](https://www.npmjs.com/package/@unified-product-graph/mcp-server): local `.upg` files over stdio.
- [`@unified-product-graph/cloud-server`](https://www.npmjs.com/package/@unified-product-graph/cloud-server): Postgres-backed multi-tenant graphs over HTTP.

Build a third one? Implement against this package.

## Install

```bash
npm install @unified-product-graph/mcp-tooling @unified-product-graph/core
```

## Minimal tool registry

```ts
import {
  type ToolBinding,
  type ToolResult,
  text,
  buildEntitySchema,
  UnknownEntityTypeError,
} from '@unified-product-graph/mcp-tooling'

interface ServerCtx {
  // Your runtime: graph store, session, cache, etc.
}

const getEntitySchema: ToolBinding<ServerCtx> = {
  definition: {
    name: 'get_entity_schema',
    description: 'Return the canonical schema for a UPG entity type.',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type'],
    },
  },
  handler(args): ToolResult {
    try {
      const schema = buildEntitySchema(args.type)
      return text(JSON.stringify(schema, null, 2))
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) {
        return text(err.message)
      }
      throw err
    }
  },
}
```

Wire bindings into any `MCPTransport`. Same registry, any wire.

## Reference generator

```ts
import { runGenerator } from '@unified-product-graph/mcp-tooling/generator'
```

Three outputs: Markdown reference, JSON tool descriptor catalogue,
per-domain TOC. Each handler documents `@returns`; every write tool
declares `@atomicity` (`atomic`, `atomic-with-rollback`, `non-atomic`,
`atomic (read-only)`). The audit gate fails the build when a tag is
missing.

## License

MIT. See [LICENSE](./LICENSE).

## Links

- Spec: <https://unifiedproductgraph.org>
- Source: <https://github.com/unified-product-graph/mcp-tooling>
