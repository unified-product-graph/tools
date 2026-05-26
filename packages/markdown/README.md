# @unified-product-graph/markdown

```md
---
upg_product: acme-compass
entity_type: initiative
entity_id: onboarding-revamp
---

Targets [[persona:new-admin]] in activation.

The {{persona:new-admin → job:first-value|precedes}} edge anchors the journey.
```

That is a `.upg.md` document. Parser plus utilities for the format.

Two inline primitives extend CommonMark:

- `[[type:id]]` for typed entity references
- `{{type:id}}` for edge references

YAML frontmatter ties the document to a product graph by id. The parser is
regex-based and ships with zero required runtime dependencies. Pair it with
`@unified-product-graph/core` to resolve refs against a real graph.

Part of the [Unified Product Graph](https://unifiedproductgraph.org) open
standard.

## Install

```bash
npm install @unified-product-graph/markdown
# optional, for ref resolution against a typed graph
npm install @unified-product-graph/core
```

Requires Node.js 18+.

## Quick start

```ts
import { parse, buildIndex, validate, toPlainMarkdown } from '@unified-product-graph/markdown'

const result = parse(source)

result.frontmatter.entity_id   // 'onboarding-revamp'
result.entityRefs.length       // 1
result.edgeRefs.length         // 1

const index = buildIndex(result)

const validation = validate(index, {
  lookup: (type, id) => myGraph.find(type, id),
})

const plain = toPlainMarkdown(source, {
  resolveRef: (type, id) => ({ title: myGraph.title(type, id) }),
})
```

## API

| Export                  | What it does                                                              |
|-------------------------|---------------------------------------------------------------------------|
| `parse(source)`         | Extract frontmatter, entity refs, edge refs, inline properties            |
| `buildIndex(result)`    | Flatten refs into a typed lookup index                                    |
| `validate(index, opts)` | Resolve refs against a graph; collect missing-ref diagnostics             |
| `toPlainMarkdown(src)`  | Render to plain CommonMark, rewriting refs via a resolver                 |
| `updateRefs(src, fn)`   | Rewrite refs in-place (e.g. for id migrations)                            |
| `toTipTapJSON(result)`  | Convert a parse result to TipTap editor JSON                              |
| `fromTipTapJSON(doc)`   | Round-trip TipTap JSON back to `.upg.md` source                           |

Types: `UPGMarkdownFrontmatter`, `EntityReference`, `EdgeReference`,
`InlineProperty`, `ParseResult`, `ParseWarning`, `ParseError`,
`ReferenceIndex`, `IndexEntry`, `ValidationOptions`, `ValidationResult`,
`TipTapDocument`, `TipTapNode`.

## Specification

The `.upg.md` format is defined by the UPG specification at
[unifiedproductgraph.org](https://unifiedproductgraph.org).

## License

MIT. See [LICENSE](./LICENSE).
