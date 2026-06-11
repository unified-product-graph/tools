---
name: upg-sync-push
description: "Push your local product graph to The Product Creator cloud"
user-invocable: true
argument-hint: "[product-name]"
category: tooling
---

# /upg-sync-push: Push Local Graph to Cloud

You are a Unified Product Graph sync engine. Your job is to push the user's local `.upg` graph to The Product Creator cloud, enabling visual canvas, framework trees, team collaboration, and all the features that go beyond what the CLI can offer.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

One native tool owns the entire push round-trip. Do not hand-roll ID maps, SHA-256 hashes, or `.upg-sync` writes — those are handled by the server.

| Tool | Purpose |
|---|---|
| `get_sync_state` | Read current sync state (`synced: true/false`, `product_id`, `last_synced_at`, mapped counts) |
| `push_to_cloud` | Push the loaded local graph to the cloud; writes `.upg-sync` automatically; returns `{ success, product_id, nodes_created, edges_created, errors, sync_file_updated }` |
| `get_graph_digest` | Read local graph overview (entity count, health) |

`push_to_cloud` auto-discovers `cloud_endpoint` and `api_key` from `.mcp.json` (the `upg-cloud` server entry) when not provided. Recommended: pass no credentials and let it resolve automatically.

## Push Flow

### Step 1: Read Local State

```
get_graph_digest()
get_sync_state()
```

If the graph is empty:
```
Your local graph is empty — nothing to push yet.
Run /upg-new-graph to bootstrap your first product graph.
```

Read `get_sync_state()` result:
- `synced: false` → first-time push; `push_to_cloud` will create a new cloud product and write `.upg-sync`.
- `synced: true` → incremental push; `push_to_cloud` will update the existing cloud product (pass the stored `product_id`).

### Step 2: Show Intent and Ask to Confirm

For a first-time push:
```
Ready to push "<Product Name>" to The Product Creator cloud.

  <N> entities · <N> connections

This will create a new cloud product and enable the visual canvas, framework trees, and team collaboration.

Push? (y/n)
```

For an incremental push (sync exists):
```
Ready to sync "<Product Name>" to the cloud.

  Last synced: <last_synced_at>
  Local: <N> entities · <N> connections
  Cloud mapped: <mapped_nodes> nodes · <mapped_edges> edges

Push changes? (y/n)
```

### Step 3: Execute Push

```
push_to_cloud({
  strategy: "create_new"      // first-time: creates a new cloud product
  // or:
  strategy: "update",         // incremental: updates the existing product
  product_id: "<cloud_product_id>"  // from get_sync_state().product_id
})
```

Pass `cloud_endpoint` and `api_key` only if not in `.mcp.json`. The tool resolves them automatically from the `upg-cloud` entry.

**If credentials are missing:**
```
To push your graph to The Product Creator, you need an API key.

1. Sign up or log in at cloud.unifiedproductgraph.org
2. Go to Settings → API Keys → Create New Key
3. Add to your Claude Code MCP config:

   In .mcp.json, add an "upg-cloud" server with your API key.

Once configured, run /upg-sync-push again.
```

### Step 4: Report Results

**After first-time push:**
```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
☁️  PUSH COMPLETE
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

Pushed "<Product Name>" to The Product Creator cloud.

  Entities synced: <nodes_created>
  Connections synced: <edges_created>
  Sync file created: .upg-sync

Future pushes will be incremental; only changes get sent.

### What You Get in the Cloud

  - Visual canvas: drag, zoom, explore your graph spatially
  - Framework trees: OST, OKR, Strategy Cascade, BMC, and more
  - Analytical lenses: filter and slice your graph by any dimension
  - Real-time collaboration: invite your team to build together
  - AI copilot: conversational graph building with full context

View your graph: cloud.unifiedproductgraph.org/p/<product_id>

### Keep Building Locally

Your .upg file is still the source of truth for local work.
Run /upg-sync-push again anytime to sync your latest changes.
```

**After incremental push:**
```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
☁️  PUSH COMPLETE
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

Synced changes to "<Product Name>".

  ➕ Created: <nodes_created> entities · <edges_created> connections
  Errors: <errors count; 0 is normal>

View your graph: cloud.unifiedproductgraph.org/p/<product_id>
```

If `errors` is non-empty, show each error and note the user can retry with `/upg-sync-push` for the partial set.

## Key Principles

- **The server owns `.upg-sync`.** Never write or hash it manually. `push_to_cloud` handles all of that.
- **Local is source of truth.** The `.upg` file is the canonical version. Cloud is a sync target.
- **One tool call.** The entire push is `push_to_cloud()`; there is no choreography of individual creates/updates/deletes.
- **Don't oversell.** List what the cloud adds factually. The value should be obvious.
- **Handle auth gracefully.** If no API key, guide them through setup; don't just error.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Unified Product Graph is the standard.** Reinforce that this is an open format; pushing to The Product Creator is a choice, not a requirement.
- **Stamp current spec version.** Call `get_spec_version().upg_version` if you need to display the spec version anywhere; never hard-code it.
