# Contributing to `@unified-product-graph/mcp`

Three sections: file an issue, run locally, add a command.

## Filing issues

File at <https://github.com/unified-product-graph/cli/issues>. Include:

- The command and its full output.
- `upg --version` and `node --version`.
- A minimal `.upg` file that reproduces the problem.

For feature requests: describe the workflow. Concrete examples beat abstract proposals.

## Running locally

```bash
# From the package root
npm install

# Dev mode via tsx, no build step
npm run dev -- <command> [args]

# Type-check, lint, and test
npm run type-check
npm run lint
npm test

# Build the published artifact
npm run build
```

`npm run dev` runs `src/cli.ts` through `tsx`. Edits take effect immediately.

## Adding a command

1. Create `src/commands/<name>.ts` exporting a `commander` `Command`.
2. Register it in `src/cli.ts` next to the existing commands.
3. Add an entry to `printHelp()` so the command appears in `upg --help`.
4. Add a vitest spec under `src/commands/__tests__/` covering the happy path and 1 error case.

Keep commands focused. A growing sub-tree of options is a signal to split into sub-commands.

## Adding an import adapter

Import adapters live in `@unified-product-graph/adapters`. The CLI's `import` command dispatches to that package. Contribute the adapter there and the CLI picks it up.

## Bundled skills

`skills/` is regenerated at build and pack time from `@unified-product-graph/mcp-server` via `scripts/copy-skills.mjs`. Edit the canonical source in the MCP server package, then rebuild.

## Code style

- TypeScript strict mode.
- Use `any` only when the call site needs it. Add a comment explaining why.
- Prefer named exports.
- Terminal output stays readable on light and dark backgrounds.

## Pull requests

- Branch from `main`.
- 1 logical change per PR.
- Include a CHANGELOG entry under the next-version heading.
- Lint, type-check, and test must pass before review.
