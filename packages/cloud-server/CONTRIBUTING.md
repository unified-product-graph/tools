# Contributing to `@unified-product-graph/cloud-server`

Contributions are welcome. If you're fixing a bug, feel free to open a PR directly. For larger changes, open an issue first so we can discuss the approach.

## Local development

You need Node 20+ and either Docker (for the bundled Postgres) or an existing Postgres 14+ instance.

```bash
# Clone and install
git clone https://github.com/unified-product-graph/cloud-server.git
cd cloud-server
npm install

# Build
npm run build

# Type-check
npm run type-check

# Tests
npm test
```

## Docker compose flow

The fastest path to a running server is the bundled compose file:

```bash
cd docker
docker compose up -d
```

This starts Postgres on port `5433` with credentials `upg/upg` and applies the migrations automatically. To point the server at the running database:

```bash
UPG_DATABASE_URL=postgres://upg:upg@localhost:5433/upg npm run dev
```

Stop and remove the stack with `docker compose down -v` (the `-v` drops the volume so you start clean next time).

## Running against your own Postgres

```bash
# Apply migrations in order
psql $UPG_DATABASE_URL -f migrations/001_initial.sql
psql $UPG_DATABASE_URL -f migrations/002_collaboration.sql
psql $UPG_DATABASE_URL -f migrations/003_webhooks.sql
psql $UPG_DATABASE_URL -f migrations/004_cross_product_edges.sql

# Then run the server
UPG_DATABASE_URL=postgres://user:pass@host/db npm run dev
```

All tables live in the `upg.*` schema. The server confines its reads and writes to `upg.*`, leaving `public.*` and any other schema alone.

## Migration conventions

- Migrations are SQL files in `migrations/`, numbered with a zero-padded three-digit prefix (`001_`, `002_`, …).
- The filename slug after the prefix describes the change in `snake_case` (e.g. `004_cross_product_edges.sql`).
- Each migration is **append-only and idempotent where possible**. Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so re-running a migration on a partially-applied database doesn't fail.
- Destructive changes (DROP, type changes) need a new migration and a deprecation note in [CHANGELOG.md](./CHANGELOG.md). Published migrations stay frozen once shipped; revisions land as a follow-on migration.
- New tables belong in the `upg` schema. New columns on existing tables get an explicit `DEFAULT` so older clients keep working.

## Adding a tool

Tool handlers live in `src/tools/<domain>.ts` as exported `ToolHandler<CloudContext>` functions with JSDoc that describes the args, return shape, and atomicity. The handler is then registered in `src/lib/tool-registry.ts`. `npm run generate-tools` re-renders `TOOLS.md` from the JSDoc.

The cloud server and `@unified-product-graph/mcp-server` (local) share their catalog and schema build through `@unified-product-graph/mcp-tooling`. When a tool exists on both sides, keep the arg names, response shape, and atomicity contract identical; the parity test in `src/__tests__/parity.test.ts` enforces this.

## Filing issues

Open issues at <https://github.com/unified-product-graph/cloud-server/issues>. Helpful issues include:

- The version of `@unified-product-graph/cloud-server` you're running (`upg-cloud-server --version` or `npm ls @unified-product-graph/cloud-server`).
- Your Postgres version (`psql -V`).
- A minimal repro, ideally a sequence of MCP tool calls or SQL that reproduces the bug.
- For schema or migration issues, the output of `\d upg.*` against your database.

## Pull request flow

1. Fork the repo.
2. Create a branch: `git checkout -b feat/my-change`.
3. Make your changes. Add or update tests in `src/__tests__/` for any behaviour you change.
4. Run `npm run build && npm run type-check && npm test`.
5. Open a PR against `main` with a short description of what changed and why.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
