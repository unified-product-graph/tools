# @unified-product-graph/sdk

Programmatic SDK for reading and writing [Unified Product Graph](https://unifiedproductgraph.org) `.upg` files.

```bash
npm install @unified-product-graph/sdk
```

```ts
import { UPGClient } from '@unified-product-graph/sdk'

const upg = new UPGClient({ file: './product.upg' })

// Nodes
await upg.nodes.create({ type: 'feature', title: 'Dark mode' })
await upg.nodes.list({ type: 'feature' })
await upg.nodes.get('node-id')
await upg.nodes.update('node-id', { status: 'active' })
await upg.nodes.delete('node-id')

// Edges
await upg.edges.connect('src-id', 'tgt-id')
await upg.edges.list({ source: 'node-id' })

// Graph-level
await upg.health()
await upg.search('dark mode')
await upg.verify()
```

## Why this exists

`@unified-product-graph/core` is the spec and type package. This SDK is the programmatic client that builds on top of it. The Unified Product Graph CLI and MCP server are both thin frontends over this SDK.

## Documentation

- [Getting started](https://unifiedproductgraph.org/sdk)
- [API reference](https://unifiedproductgraph.org/sdk/reference)
- [Building an adapter](https://unifiedproductgraph.org/sdk/guides/adapter)

## License

MIT © The Product Creator
