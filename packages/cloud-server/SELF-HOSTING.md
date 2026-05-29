# Self-hosting the UPG Cloud Server

The cloud server is a **Postgres-backed MCP server**. Unlike the local server
(`@unified-product-graph/mcp-server`), which reads and writes a single `.upg`
file, the cloud server stores the graph in Postgres, so a team can share one
source of truth with concurrent, transactional writes, multiple products, an
audit log, comments, and webhooks.

> **Mental model:** the local server is to Git as the cloud server is to a
> shared database. Same tools, same UPG semantics; different substrate.

This guide covers three deployment tiers, from "ready today" to "real SaaS."

| Tier | What you host | Auth model | Effort | Use when |
|------|---------------|-----------|--------|----------|
| **Tier 1: Shared DB** | Just Postgres; each client runs the server locally | Connection string = full access | Minutes | A small, trusting team |
| **Tier 2: Central endpoint** | The server behind a stdio→HTTP bridge + auth proxy | One shared identity, gated by a proxy | A day of ops | One shared endpoint, still one trust domain |
| **Tier 3: Multi-tenant SaaS** | The server with auth + per-user identity + RLS | Per-user, per-product RBAC | A real build | External / untrusted users |

---

## What you should know first

- **Transport is stdio.** The server speaks MCP over stdin/stdout to a single
  trusted client (Claude Code, Cursor, etc.). There is **no built-in network
  endpoint** (Tiers 2 and 3 add one).
- **One config knob:** `UPG_DATABASE_URL` (or `--database-url`). The server
  opens a default `pg.Pool` against it and runs `SELECT 1` at startup; **it
  exits immediately if the database is unreachable.**
- **Postgres 13+** is required (the schema uses `gen_random_uuid()`).
- **RBAC is recorded, not yet enforced.** The schema has an `access` table
  (`owner` / `editor` / `viewer` roles) and `grant_access` / `list_collaborators`
  tools, but there are **no RLS policies** and the stdio server threads **no
  per-user identity**. Today, whoever holds the connection string has full
  access. Per-user enforcement is Tier 3 (see the roadmap below).

---

## Tier 1: Shared managed Postgres (recommended starting point)

Host the **database**; every team member runs the server **locally** against it.
Production-ready today for a team inside one trust boundary.

### 1. Provision Postgres

Any Postgres 13+ works: [Neon](https://neon.tech), [Supabase](https://supabase.com),
[Railway](https://railway.app), RDS, or a VM. Grab the connection string:

```
postgres://USER:PASS@HOST:5432/upg?sslmode=require
```

### 2. Apply the migrations (once, from any machine)

```bash
export UPG_DATABASE_URL='postgres://…?sslmode=require'
for f in migrations/*.sql; do
  psql "$UPG_DATABASE_URL" -f "$f"   # applies 001 → 004 in order
done
```

The four migrations create the `upg` schema: `products`, `nodes`, `edges`,
`cross_product_edges` (001 + 004), `access` / `comments` / `audit_log`
(002), and `webhooks` (003).

### 3. Point each member's client at the shared DB

Add an MCP server entry to each member's client config. Keep the connection
string in **personal / local** config, never a committed file.

```jsonc
// If installed from npm (the package ships a `upg-cloud-server` bin):
{
  "mcpServers": {
    "unified-product-graph-cloud": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@unified-product-graph/cloud-server"],
      "env": { "UPG_DATABASE_URL": "postgres://…shared…?sslmode=require" }
    }
  }
}

// From a monorepo checkout instead:
//   "command": "node",
//   "args": ["./packages/upg-cloud-server/dist/index.js"]
```

Restart the client. The tools appear namespaced as
`mcp__unified-product-graph-cloud__*`.

### 4. Work against a shared graph

The cloud server is **multi-product**, so every tool is scoped by `product_id`:

1. `create_product` → returns a product UUID.
2. Pass that `product_id` to `create_node`, `create_edge`, `query`, etc.

Concurrent writes from different members land as atomic Postgres transactions
with foreign-key integrity; no `.upg` merge conflicts.

### Local Postgres for development

A `docker-compose.yml` is included for a throwaway local database (Postgres on
`:5433`, migrations auto-applied on first boot):

```bash
cd docker
docker compose up -d postgres
# UPG_DATABASE_URL=postgres://upg:upg@localhost:5433/upg
```

---

## Tier 2: A single shared endpoint (stdio → HTTP bridge)

Centralize the **process** so clients don't run anything locally. Wrap the
stdio server in an MCP HTTP bridge (e.g. [`supergateway`](https://github.com/supercorp-ai/supergateway)
or `mcp-proxy`, or swap in the SDK's StreamableHTTP transport) and put an
**auth proxy in front** (the server itself has no authentication).

```
[client] --HTTPS--> [auth proxy] --> [bridge + upg-cloud-server (stdio)] --> [managed Postgres]
```

Clients then use a remote entry instead of spawning a process:

```jsonc
{
  "mcpServers": {
    "unified-product-graph-cloud": {
      "type": "http",
      "url": "https://upg.your-company.com/mcp",
      "headers": { "Authorization": "Bearer <team-token>" }
    }
  }
}
```

**Caveat:** this centralizes the process, **not the permissions**. Every
client through the bridge still shares one database identity. Use Tier 2 when
you want one managed endpoint inside a single trust domain; use Tier 3 when
clients must be isolated from one another.

---

## Tier 3: Multi-tenant SaaS (the enforcement tier)

The data model is already built for this: `products`, `access` roles,
`audit_log`, `webhooks`, `cross_product_edges`. What's missing is the
**enforcement layer**. Reaching genuine per-user multi-tenancy requires:

1. **An HTTP transport** (replace/augment `StdioServerTransport`) that
   authenticates each request and resolves it to a `user_id`.
2. **Identity propagation** into the store, so every query carries the calling
   user (e.g. `SET LOCAL app.user_id = …` per transaction).
3. **RLS policies** on `upg.*` keyed off that identity and the `access` table,
   so reads/writes are gated at the database, not by convention.
4. **Operational scale:** stateless server replicas behind a load balancer,
   connection pooling (e.g. PgBouncer; the server currently opens an untuned
   default `pg.Pool`), and the existing webhook/audit machinery wired to fire
   on mutations.

Until those land, treat the `access` roles as **advisory metadata**, not a
security boundary.

> Tracked as a roadmap item; see the UPG issue tracker for "Tier-3 enforcement:
> HTTP transport + per-user identity + RLS."

---

## Choosing a tier

- **Small trusting team →** Tier 1. Host the DB, done.
- **Want one shared endpoint →** Tier 2. Bridge + auth proxy.
- **External / untrusted users →** Tier 3. Auth + identity + RLS + replicas.

## Environment reference

| Variable | Required | Description |
|----------|----------|-------------|
| `UPG_DATABASE_URL` | Yes | Postgres connection string. Also accepted as `--database-url`. |

The server is intentionally minimal in configuration; everything else lives
in the database.
