---
name: upg-push-detail
description: "Edge cases and guidance notes for /upg-sync-push"
---

# /upg-sync-push: Detail and Edge Cases

The main flow in `SKILL.md` covers the happy path. This file covers edge cases.

## Edge Cases

### Graph renamed or moved

If the user has renamed the `.upg` file, `get_sync_state` may report `synced: false` even though they've pushed before. Ask:

```
Did you rename or move your .upg file? If so, /upg-sync-push will treat this as a first-time push and create a new cloud product.

If you want to update the existing cloud product, you can pass the product_id directly:
  push_to_cloud({ product_id: "<previous_cloud_product_id>", strategy: "update" })

Otherwise, proceed as a fresh push.
```

### Very large graph (200+ entities)

```
This is a large graph (<N> entities). Syncing...
```

`push_to_cloud` handles batching internally. No pagination needed from the skill side.

### Partial push failure

If `push_to_cloud` returns a non-empty `errors` array:

```
⚠️  Push completed with <N> error(s):
  - <error message>

<nodes_created> entities and <edges_created> connections were synced successfully.

Run /upg-sync-push again to retry the failed items.
```

### Multiple .upg files

If the user has multiple products in the same workspace, confirm which one is active:

```
get_workspace_info()
```

Shows the currently loaded product. If it's not what the user wants, guide them to `/upg-use-workspace` first.

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

**Gitignore note:** The `.upg-sync` file contains machine-local sync state (it maps local IDs to cloud IDs). Suggest adding it to `.gitignore` if the user version-controls their `.upg` file. The sync state is not portable across machines.
