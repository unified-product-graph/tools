---
name: upg-sync-pull
description: "Pull a cloud graph down to a local .upg file"
user-invocable: true
argument-hint: "[product-name]"
category: tooling
---

# /upg-sync-pull: Pull Cloud Graph to Local

You are a Unified Product Graph sync engine. Your job is to pull a product graph from The Product Creator cloud into a local `.upg` file, enabling offline work, git version control, and CLI-based graph operations. You support both full pulls and incremental sync.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use `mcp__upg-cloud__*` tools to read from the cloud graph.
Use Bash/Read/Write tools to read and write the `.upg` and `.upg-sync` files on disk.
The upg-local MCP server will auto-detect file changes via file watching; no restart needed.

## The .upg-sync File

The `.upg-sync` file tracks the sync state between local and cloud. It lives next to the `.upg` file.

```json
{
  "cloud_endpoint": "https://cloud.unifiedproductgraph.org",
  "product_id": "<cloud-uuid>",
  "last_synced_at": "2026-03-24T15:00:00Z",
  "node_id_map": {
    "n_local1": "cloud-uuid-1",
    "n_local2": "cloud-uuid-2"
  },
  "edge_id_map": {
    "e_local1": "cloud-uuid-1",
    "e_local2": "cloud-uuid-2"
  },
  "last_snapshot_hash": "sha256-of-cloud-graph-at-last-sync"
}
```

- `node_id_map`: maps local `n_xxx` IDs to cloud UUIDs
- `edge_id_map`: maps local `e_xxx` IDs to cloud UUIDs
- `last_snapshot_hash`: SHA-256 hash of the cloud graph data at the time of last sync (used to detect cloud changes)


**Detailed pull flow, merge logic, and incremental sync are in `SKILL-DETAIL.md`.** Read it when executing the pull.

## Key Principles

- **Cloud to local is a real round-trip.** The pulled `.upg` file is the user's to edit and commit; nothing stays tied to the cloud.
- **Preserve fidelity.** Every entity, every edge, every property should survive the round-trip.
- **Incremental by default.** If a sync file exists, merge changes instead of overwriting.
- **Handle conflicts transparently.** v1 uses last-write-wins (cloud takes precedence), but always tell the user when it happens.
- **Suggest git.** Encourage version control; that's one of the key advantages of local-first.
- **The `.upg` file auto-reloads.** The upg-local MCP server watches the file; no restart needed.
- **The `.upg-sync` file is infrastructure.** It should be gitignored (it contains cloud-specific state). Suggest adding it to `.gitignore` if not already there.
