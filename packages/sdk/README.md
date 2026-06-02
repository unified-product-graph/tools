# @unified-product-graph/sdk

Programmatic SDK for reading and writing [Unified Product Graph](https://unifiedproductgraph.org) `.upg` files.

> ESM only. Use `import`, not `require`.

```bash
npm install @unified-product-graph/sdk
```

```ts
import { UPGClient } from '@unified-product-graph/sdk'

const upg = new UPGClient({ file: './product.upg' })

// Nodes
await upg.nodes.create({ type: 'feature', title: 'Dark mode' })
await upg.nodes.createMany({ nodes: [/* ...atomic, parent_ref chaining... */] })
await upg.nodes.list({ type: 'feature' })
await upg.nodes.get('node-id')                       // node only
await upg.nodes.get('node-id', { withEdges: true })  // { node, edges_out, edges_in }
await upg.nodes.inspect('node-id')                   // same as withEdges
await upg.nodes.update('node-id', { status: 'active' })
await upg.nodes.update('node-id', { unset_properties: ['effort'] }) // delete a key
await upg.nodes.delete('node-id')

// Edges (see "Edges: inference & direction" below — this is the #1 gotcha)
await upg.edges.connect('src-id', 'tgt-id')
await upg.edges.resolve('solution', 'feature')       // { type } | null — ask before you connect
await upg.edges.list({ source: 'node-id' })

// Schema introspection (no separate core import needed)
upg.schema.validChildren('feature_area')             // → ['feature', 'feature_area', ...]
upg.schema.edgesFrom('feature')                      // → outgoing canonical edges
upg.schema.edgeFor('solution', 'feature')            // → 'solution_becomes_feature' | null

// Product metadata
await upg.product.update({ stage: 'build' })

// One disk write for a batch of mutations
await upg.transaction(async () => {
  const a = await upg.nodes.create({ type: 'persona', title: 'A' })
  await upg.nodes.create({ type: 'job', title: 'J', parent_id: a.node.id })
})

// Graph-level
await upg.health()
await upg.search('dark mode')
const v = await upg.verify()
if (!v.ok) { /* v.tampered / v.quarantined / v.orphanedEdges explain why */ }
```

## Edges: inference & direction

`upg.edges.connect(src, tgt)` is the part people get wrong. Three rules:

1. **The edge type is INFERRED from `(source.type, target.type)`** when you don't pass `type`.
2. **Direction matters.** `solution → feature` resolves to `solution_becomes_feature`; the
   reverse has no canonical edge. An explicit `type` does **not** override direction — the type's
   declared source/target must match the nodes (a "wrong-way" link is inexpressible; reorient the call).
3. **Most type pairs have NO canonical edge.** For those, `connect` returns an **error object — it does
   not throw**:

   ```ts
   const r = await upg.edges.connect(a, b)
   if ('error' in r) {
     // r.error, r.no_canonical_edge_for?: { source_type, target_type }
   } else {
     // r.edge, r.warning?
   }
   ```

   (Contrast `nodes.create`, which THROWS `UnknownEntityTypeError` for an unknown type and
   `WriteValidationError` for an invalid status.)

Use `upg.edges.resolve(srcType, tgtType)` or `upg.schema.edgeFor(a, b)` to discover the edge and
direction **before** connecting, instead of probing.

## Write validation (one posture, everywhere)

Single and batch tools share one validation pass:

| dimension | posture |
|-----------|---------|
| entity `type` | strict — unknown rejects (alias → warning) |
| `status` | strict — must be in the type's lifecycle phases, else rejects |
| `properties` | permissive — unknown keys are stored with a warning |

Pass `{ strict: true }` to promote unknown-property warnings to rejections at authoring time.
`unset_properties: [...]` deletes keys (writing `{ key: null }` only stores a literal null).

## Intelligence layer

Beyond CRUD, the SDK ships the functions that power the `plan` / `trace` / `prioritise` /
`reflect` / `inspect` approach tools:

- `executePlan(store, { exhaustive? } | regionId)` — missing-entity backlog. Defaults to the
  product's **active regions** (pass `{ exhaustive: true }` for the full type universe).
- `executeTrace(store, anchorId, path)` — walk a typed path. **`path` lists the entity types AFTER
  the anchor**, e.g. `executeTrace(store, personaId, ['job', 'need'])` walks persona → job → need.
- `executePrioritise(framework, ids, store)` — framework-driven scoring (pass a framework OBJECT,
  e.g. `UPG_FRAMEWORKS_BY_ID['rice-scoring']`). Returns one of three result kinds:
  `execution` (ranked scores), `fallback` (no numeric formula — e.g. a bucketing framework like
  MoSCoW), or `type_mismatch` (candidates whose type ≠ the framework's target). The
  `type_mismatch` result names the target and the offending types so you know exactly why nothing
  ranked:
  ```ts
  import { frameworkTargetTypes, executePrioritise, UPG_FRAMEWORKS_BY_ID } from '@unified-product-graph/sdk'

  const rice = UPG_FRAMEWORKS_BY_ID['rice-scoring']
  frameworkTargetTypes(rice)            // → ['feature']  — pick candidates of this type up front
  const res = executePrioritise(rice, featureIds, store)
  if (res.kind === 'type_mismatch') console.log(res.hint)  // "rice-scoring scores feature; 3 need mismatched"
  else if (res.kind === 'execution') console.log(res.ranked)
  ```
- `frameworkTargetTypes(framework)` → `string[]` — the entity types a framework scores. Use it to
  select the right candidates before calling `executePrioritise`.
- `executeReflect(store, mode)` — modes: `assumptions`, `alternatives`, `blind-spots`,
  `load-bearing` (omit to run all four). An unknown mode throws `ReflectModeError`.

## Why this exists

`@unified-product-graph/core` is the spec and type package. This SDK is the programmatic client that builds on top of it. The Unified Product Graph CLI and MCP server are both thin frontends over this SDK.

## Documentation

- [Getting started](https://unifiedproductgraph.org/sdk)
- [API reference](https://unifiedproductgraph.org/sdk/reference)
- [Building an adapter](https://unifiedproductgraph.org/sdk/guides/adapter)

## License

MIT © The Product Creator
