---
name: upg-sync-pull
description: "Pull a cloud graph down to a local .upg file"
user-invocable: true
argument-hint: "[product-name]"
category: tooling
---

# /upg-sync-pull: Pull Cloud Graph to Local

You are a Unified Product Graph sync engine. Your job is to pull a product graph from The Product Creator cloud into the local `.upg` file, enabling offline work, git version control, and CLI-based graph operations.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Three native tools own the entire pull round-trip. Do not hand-roll ID maps, SHA-256 hashes, or `.upg-sync` writes — those are handled by the server.

| Tool | Purpose |
|---|---|
| `get_sync_state` | Read current sync state from `.upg-sync` (returns `synced: true/false`, `product_id`, `last_synced_at`, counts) |
| `apply_pull_changeset` | Merge cloud nodes/edges into the local graph; updates `.upg-sync` automatically |
| Cloud `export_upg_document` | Fetch the full cloud graph document (called on the cloud MCP server) |

The cloud MCP server is configured separately (look for `upg-cloud` in `.mcp.json`). Its tools use the `mcp__upg-cloud__` prefix.

## Pull Flow

### Step 1: Check Sync State

```
get_sync_state()
```

Inspect the result:

- `synced: false` → no `.upg-sync` file; this will be a first-time pull.
- `synced: true` → an existing sync is set up; show `last_synced_at` and `product_id` to the user.

Also check that a `.upg` file is loaded:
```
get_workspace_info()
```

### Step 2: Connect to Cloud and Select Product

Call the cloud server to list available products:

```
mcp__upg-cloud__list_products()
```

If this fails (auth error, no API key):
```
To pull from The Product Creator, you need an API key configured.

1. Log in at cloud.unifiedproductgraph.org
2. Go to Settings → API Keys → Create New Key
3. Add to your .mcp.json config under the "upg-cloud" server entry

Once configured, run /upg-sync-pull again.
```

If the user specified a product name, match it. Otherwise, list available products:

```
Your products on The Product Creator:

  1. My SaaS App (42 entities, 38 edges)
  2. Side Project (12 entities, 8 edges)

Which one do you want to pull? (number or name)
```

### Step 3: Fetch Cloud Graph

Fetch the full graph document from the cloud:

```
mcp__upg-cloud__export_upg_document({ product_id: "<cloud_product_id>" })
```

This returns a document with `nodes` and `edges` arrays in UPG format.

### Step 4: Apply to Local Graph

Pass the cloud data to the local sync engine:

```
apply_pull_changeset({
  cloud_nodes: <nodes from export>,
  cloud_edges: <edges from export>,
  cloud_product_id: "<cloud_product_id>",
  cloud_endpoint: "https://cloud.unifiedproductgraph.org",
  strategy: "cloud_wins"   // or "local_wins" or "merge"
})
```

The tool automatically:
- Creates new local nodes/edges for anything new on the cloud
- Updates existing nodes/edges that changed
- Removes nodes/edges deleted on the cloud
- Updates `.upg-sync` with new ID mappings and sync timestamp
- Returns `{ nodes_created, nodes_updated, nodes_deleted, edges_created, edges_deleted, conflicts? }`

**If `synced: false` in Step 1 (first-time pull):** the changeset will be entirely `nodes_created` / `edges_created`. No existing local data to conflict with.

**If hashes match (nothing changed):** the cloud data will equal local data; all counts will be 0. Report:

```
Your local graph is already up to date with the cloud.

Last synced: <last_synced_at>
```

### Step 5: Handle Conflicts

If the result contains `conflicts` (only when `strategy: "merge"`):

```
⚠️  <N> conflicts detected between local and cloud versions.
Cloud takes precedence by default. Options:

1. Apply cloud version (recommended; cloud_wins)
2. Keep local version (local_wins)
3. Show conflicts to review manually

Which do you prefer?
```

If user chooses 1 or 2, re-run `apply_pull_changeset` with the chosen strategy.

### Step 6: Confirm and Guide

Show the pull results and what to do next:

```
## Pull Complete

Pulled "<Product Name>" from The Product Creator cloud.

  + <N> entities added
  ~ <N> entities updated
  - <N> entities removed
  + <N> connections added
  - <N> connections removed

Your graph is now local. You can edit, diff, and commit it.

### What You Can Do Now

  /upg-show-status — graph health dashboard
  /upg-show-tree — view through framework lenses
  /upg-check-gaps — strategic gap analysis
  /upg-sync-push — push local changes back to the cloud

### Version Control

  git add <product>.upg
  git commit -m "Pull <product name> from cloud"

  The .upg file is plain JSON. Branch, diff, review — it's just data.
```

## Key Principles

- **The server owns `.upg-sync`.** Never write or hash it manually. `apply_pull_changeset` handles all of that.
- **Cloud to local is a real round-trip.** The pulled `.upg` file is the user's to edit and commit; nothing stays tied to the cloud.
- **Preserve fidelity.** Every entity, every edge, every property should survive the round-trip.
- **Handle conflicts transparently.** v1 defaults `cloud_wins`; always tell the user when it happens.
- **Suggest git.** Version control is one of the key advantages of local-first.
- **Stamp current spec version.** Call `get_spec_version().upg_version` if you need to display the spec version anywhere; never hard-code it.
