# Contributing to `@unified-product-graph/markdown`

Part of the [Unified Product Graph](https://unifiedproductgraph.org) open
standard.

## Development

```bash
npm install
npm run build
npm test
```

Requires Node.js 18+.

## Scope

Parser and round-trip toolkit for the `.upg.md` document format. Zero required
runtime dependencies. Graph lookups arrive through an injected resolver.

Changes to the `.upg.md` format itself are governed by the UPG specification.
Format proposals belong on the specification repository.

## Issues

GitHub Issues for:

- Bug reports: include a minimal `.upg.md` snippet.
- API ergonomics feedback.
- Documentation gaps.

For broader UPG questions, see [unifiedproductgraph.org](https://unifiedproductgraph.org).

## Pull requests

- One behavioural change per PR.
- Add or update tests in `src/__tests__/`.
- Run `npm run build && npm test` before pushing.
- Match existing style: TypeScript strict, single quotes, semicolon-free
  source.

## Releases

[Semantic Versioning](https://semver.org/). Maintainers bump `version` in
`package.json`, update `CHANGELOG.md`, and tag.

## License

By contributing you agree your contributions will be licensed under the
[MIT License](./LICENSE).
