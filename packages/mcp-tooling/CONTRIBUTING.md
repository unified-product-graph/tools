# Contributing

Thanks for contributing to `@unified-product-graph/mcp-tooling`.

Changes here affect every UPG MCP server in lockstep. Most contributions
are small, focused, test-anchored.

## Where to file issues

- Bugs and feature requests: <https://github.com/unified-product-graph/mcp-tooling/issues>
- Spec questions (entity types, edges, properties): the spec repo.

## Local setup

```bash
npm install
npm run build
npm test
```

`@unified-product-graph/core` is a runtime dependency. Developing
against an unreleased core version? Link it locally.

## Extending the tool registry

Two rules of thumb:

- **Belongs here:** anything every server (or embedder) needs in order
  to answer a canonical tool the same way. Example: a new envelope type
  for a migration tool.
- **Belongs in a server:** anything tied to a specific runtime (file
  store, Postgres pool, framework request object).

When you add an envelope to `src/atomicity-contracts.ts`, add a fixture
test in `__tests__/atomicity-contracts.test.ts` too. A future field
rename then trips TypeScript before the consuming servers rebuild.

## JSDoc and the audit gate

Every handler the reference generator walks documents three things:

- A description (one character or more).
- `@returns`, describing the resolved shape.
- `@atomicity` (write tools): one of `atomic`, `atomic-with-rollback`,
  `non-atomic`, `atomic (read-only)`.

Run the generator in your downstream server before opening a PR here.
The audit gate (`src/generator/audit.ts`) is the enforcement point.

## Pull requests

- One contract change per PR.
- Tests for any behaviour change.
- Run `npm run lint`, `npm run type-check`, `npm test` before opening.
- Call out breaking changes in the PR description so the changelog
  captures them.

## License

MIT. See [LICENSE](./LICENSE).
