---
name: upg-pull-detail
description: "Edge cases, conflict handling, and guidance notes for /upg-sync-pull"
---

# /upg-sync-pull: Detail and Edge Cases

The main flow in `SKILL.md` covers the happy path. This file covers edge cases.

## Edge Cases

### Cloud graph is empty

```
"<Product Name>" has no entities in the cloud yet.
Build it locally with /upg-new-graph, then /upg-sync-push when ready.
```

### Local .upg already exists (first-time pull)

If `get_sync_state()` returns `synced: false` but a `.upg` file is already loaded locally, warn before applying:

```
A local graph is already loaded: <product title> (<N> entities).
Pulling from the cloud will merge cloud changes in using cloud_wins strategy.

Any local entities not yet pushed will be unaffected (they have no cloud IDs to conflict with).

Proceed? (y/n)
```

If the user declines, suggest:
```
You can:
  - Push local first: /upg-sync-push
  - Or create a snapshot: /upg-sync-snapshot
  Then pull with /upg-sync-pull.
```

### Sync file points to a different product

If `get_sync_state()` shows a `product_id` that doesn't match the product the user wants to pull, warn:

```
Your sync file is linked to cloud product <existing_product_id>.
Pulling "<selected product name>" will replace the sync state.

Proceed? (y/n)
```

If confirmed: call `apply_pull_changeset` with the new `cloud_product_id`; the tool will update the `.upg-sync` file.

### Very large graph (200+ entities)

```
This is a large graph (<N> entities). The pull may take a moment...
```

The `export_upg_document` call fetches the full document in one request; no pagination needed.

### Conflict strategy guidance

| Strategy | When to use |
|---|---|
| `cloud_wins` (default) | Team collaboration; cloud is the shared source of truth |
| `local_wins` | Solo work; user has made intentional local edits they want to keep |
| `merge` | Review conflicts manually before committing to either side |

After a `merge` run, call `apply_pull_changeset` again with `cloud_wins` or `local_wins` to commit the resolution. The `merge` strategy does not mutate the graph — it only reports conflicts.

## The .upg-sync File

The `.upg-sync` file is written and maintained entirely by `push_to_cloud` and `apply_pull_changeset`. **Never write to it manually.** Its format:

```json
{
  "cloud_endpoint": "https://cloud.unifiedproductgraph.org",
  "product_id": "<cloud-uuid>",
  "last_synced_at": "2026-03-24T15:00:00Z",
  "node_id_map": {
    "n_local1": "cloud-uuid-1"
  },
  "edge_id_map": {
    "e_local1": "cloud-edge-uuid-1"
  },
  "last_snapshot_hash": "<sha256 managed by the server>"
}
```

**Gitignore note:** The `.upg-sync` file contains machine-local sync state; suggest adding it to `.gitignore` if the user version-controls their `.upg` file.
