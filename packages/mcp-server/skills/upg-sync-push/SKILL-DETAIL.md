---
name: upg-push-detail
description: "Detailed push flow, sync file format, ID mapping, edge cases"
---

# /upg-sync-push: Push Flow Detail

## First-Time Push (Step 4)

This runs when there is no `.upg-sync` file; the user has never pushed this graph before.

### 4a: Match or Create Cloud Product

Check if a matching product already exists in the cloud:
- Search by title match from the product list returned in Step 2
- If found, confirm: "Found '<title>' in your cloud graph. Push local graph to this product?"
- If not found, ask: "This product doesn't exist in the cloud yet. Create '<title>' in The Product Creator?"

**Create:**
```
mcp__upg-cloud__create_product({
  title: "<product title>",
  description: "<product description>"
})
```

Record the `product_id` returned by the cloud.

### 4b: Push All Entities

For each local node, create in the cloud using batch operations:

```
mcp__upg-cloud__batch_create_nodes({
  product_id: "<cloud_product_id>",
  nodes: [
    {
      type: "<type>",
      title: "<title>",
      description: "<description>",
      data: { ...properties },
      parent_ref: "<parent reference for auto-edge>"
    },
    // ... up to 50 per batch
  ]
})
```

**Important:** Batch create supports `parent_ref` for intra-batch chaining; use this to maintain the hierarchy.

After each batch call, collect the returned cloud IDs and build the **node ID map**: `{ "n_local1": "cloud-uuid-1", "n_local2": "cloud-uuid-2", ... }`.

### 4c: Push All Edges

For edges that weren't auto-created via parent_ref:
```
mcp__upg-cloud__create_edge({
  product_id: "<cloud_product_id>",
  source_id: "<cloud_source_id>",   // looked up via node_id_map
  target_id: "<cloud_target_id>"    // looked up via node_id_map
})
```

Collect cloud edge IDs into the **edge ID map**: `{ "e_local1": "cloud-edge-uuid-1", ... }`.

### 4d: Create the .upg-sync File

Compute the hash of the current `.upg` file:
```bash
shasum -a 256 product.upg | awk '{print $1}'
```
(Use the actual `.upg` filename; it may not be `product.upg`.)

Write the `.upg-sync` file using Bash:
```bash
cat > .upg-sync << 'SYNC_EOF'
{
  "cloud_endpoint": "https://cloud.unifiedproductgraph.org",
  "product_id": "<cloud_product_id>",
  "last_synced_at": "<current ISO 8601 timestamp>",
  "node_id_map": {
    "n_local1": "cloud-uuid-1",
    "n_local2": "cloud-uuid-2"
  },
  "edge_id_map": {
    "e_local1": "cloud-edge-uuid-1"
  },
  "last_snapshot_hash": "<sha256 hash from above>"
}
SYNC_EOF
```

This file enables all future incremental pushes. Go to Step 6.

---

## Incremental Push (Step 5)

This runs when `.upg-sync` exists; the user has pushed before and we can sync only changes.

### 5a: Quick Hash Check

Compute the current `.upg` file hash and compare to `last_snapshot_hash` from `.upg-sync`:

```bash
shasum -a 256 product.upg | awk '{print $1}'
```

If the hash **matches** `last_snapshot_hash`:
```
Nothing to push; your graph hasn't changed since last sync.

Last synced: <last_synced_at from .upg-sync>

Make changes locally, then run /upg-sync-push again.
```
Stop here.

If the hash is **different**, continue to compute the changeset.

### 5b: Verify Cloud Product Still Exists

Use the `product_id` from `.upg-sync` to check the cloud:
```
mcp__upg-cloud__list_products()
```

Look for the product matching the stored `product_id`.

If the cloud product is **gone** (deleted, reset, or not found):
```
⚠️  Your cloud product (<product_id>) no longer exists.

It may have been deleted or reset on the cloud side.

1. 🔄 Full re-push; create a new cloud product and push everything
2. ⏭️ Cancel; keep working locally for now

Which would you like?
```

If the user chooses full re-push: delete the `.upg-sync` file and restart from Step 4 (first-time push flow).

### 5c: Compute Changeset

Read the current graph state via MCP tools:
```
list_nodes({ limit: 200 })
```

Compare against the ID mappings in `.upg-sync`:

**New nodes:** Nodes in the current graph whose IDs are NOT in `node_id_map` keys. These need to be created on the cloud.

**Deleted nodes:** IDs that ARE in `node_id_map` but no longer exist in the current graph. These should be deleted from the cloud.

**Updated nodes:** Nodes whose IDs are in `node_id_map` AND still exist locally. For each, compare the current node data (title, description, properties, status, tags) against what's in the cloud. If anything changed, it's an update. To detect changes, fetch the cloud state:
```
mcp__upg-cloud__get_product_graph({ product_id: "<cloud_product_id>" })
```
Then compare each mapped node's current local state against its cloud state.

**New edges:** Edges in the current graph whose IDs are NOT in `edge_id_map` keys. Create on cloud.

**Deleted edges:** Edge IDs in `edge_id_map` that no longer exist locally. Delete from cloud.

### 5d: Show Changeset Summary

Present the changeset for confirmation:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
☁️  INCREMENTAL PUSH
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

Pushing changes to "<Product Name>"

  ➕ <N> new entities
  ✏️  <N> updated entities
  🗑️  <N> deleted entities
  🔗 <N> new connections
  ✂️  <N> removed connections

New:
  📦 <Feature title>
  👤 <Persona title>

Updated:
  🎯 <Outcome title>; description changed
  ⚗️  <Hypothesis title>; status changed to validated

Deleted:
  📝 <Learning title>

Push these changes? (yes / no / review details)
```

Wait for confirmation before proceeding.

If the user says "review details", show the full diff for each changed entity (old value → new value).

### 5e: Execute Changes

Process in this order: creates first, then updates, then deletes.

**Create new nodes** (batch):
```
mcp__upg-cloud__batch_create_nodes({
  product_id: "<cloud_product_id>",
  nodes: [ ...new nodes... ]
})
```
Add returned cloud IDs to the node ID map.

**Update existing nodes:**
```
mcp__upg-cloud__update_node({
  product_id: "<cloud_product_id>",
  node_id: "<cloud_id from node_id_map>",
  title: "<updated title>",
  description: "<updated description>",
  data: { ...updated properties }
})
```

**Delete removed nodes:**
```
mcp__upg-cloud__delete_node({
  product_id: "<cloud_product_id>",
  node_id: "<cloud_id from node_id_map>"
})
```
Remove from the node ID map.

**Create new edges:**
```
mcp__upg-cloud__create_edge({
  product_id: "<cloud_product_id>",
  source_id: "<cloud_source_id>",
  target_id: "<cloud_target_id>"
})
```
Add to edge ID map.

**Delete removed edges:**
```
mcp__upg-cloud__delete_edge({
  product_id: "<cloud_product_id>",
  edge_id: "<cloud_id from edge_id_map>"
})
```
Remove from edge ID map.

### 5f: Update .upg-sync

Recompute the `.upg` file hash and update the sync file:
```bash
NEW_HASH=$(shasum -a 256 product.upg | awk '{print $1}')
```

Write the updated `.upg-sync` file with:
- Updated `node_id_map` (new entries added, deleted entries removed)
- Updated `edge_id_map` (new entries added, deleted entries removed)
- Updated `last_synced_at` to current timestamp
- Updated `last_snapshot_hash` to the new hash

---

### Step 6: Report Results

**After first-time push:**
```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
☁️  PUSH COMPLETE
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

Pushed "<Product Name>" to The Product Creator cloud.

  Entities synced: <N> (<breakdown by type>)
  Connections synced: <N>
  Sync file created: .upg-sync

Future pushes will be incremental; only changes get sent.

### What You Get in the Cloud

  - Visual canvas: drag, zoom, explore your graph spatially
  - 47 framework trees: OST, OKR, Strategy Cascade, BMC, and more
  - 43 analytical lenses: filter and slice your graph by any dimension
  - Real-time collaboration: invite your team to build together
  - AI copilot: conversational graph building with full context

View your graph: cloud.unifiedproductgraph.org/p/<product_id>

### Keep Building Locally

Your .upg file is still the source of truth for local work.
Run /upg-sync-push again anytime; only your changes will be synced.
```

**After incremental push:**
```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
☁️  PUSH COMPLETE
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

Synced changes to "<Product Name>"

  ➕ Created: <N> entities
  ✏️  Updated: <N> entities
  🗑️  Deleted: <N> entities
  🔗 Connections: +<N> / -<N>

Cloud graph: <total entities> entities · <total edges> edges

View your graph: cloud.unifiedproductgraph.org/p/<product_id>
```

**Shared footer (always append):**

## The .upg-sync File

This file is the bridge between local and cloud. It tracks which local entities map to which cloud entities, and what the graph looked like at last sync.

**Format:**
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
    "e_local1": "cloud-edge-uuid-1"
  },
  "last_snapshot_hash": "sha256-of-upg-file-at-last-sync"
}
```

**Rules:**
- The `.upg-sync` file lives in the same directory as the `.upg` file.
- Read and write it using Bash (`cat`, heredoc write). It's plain JSON.
- Never expose the sync file contents to the user unless they ask.
- The `last_snapshot_hash` is a SHA-256 of the `.upg` file at the time of last successful sync.
- Add `.upg-sync` to `.gitignore` if the user version-controls their `.upg` file; the sync state is machine-local, not portable.

## ID Mapping Logic

The `node_id_map` and `edge_id_map` are the core of incremental sync:

- **Keys** are local IDs (e.g. `n_abc123`, `e_def456`); these come from the `.upg` file.
- **Values** are cloud UUIDs; these come from The Product Creator API responses.
- After creating nodes on cloud, **always** record the mapping.
- On subsequent pushes, use the mapping to `update` existing cloud nodes instead of creating duplicates.
- When a local node is deleted, use the mapping to find and delete the cloud node, then remove the entry from the map.
- When new local nodes appear (not in the map), create them on cloud and add the mapping.

## Edge Cases

**User renamed the .upg file:**
The hash won't match any file. Look for `.upg` files in the current directory using Bash:
```bash
ls *.upg 2>/dev/null
```
If found, use that file. If multiple `.upg` files exist, ask which one.

**Very large graph (200+ entities):**
```
This is a large graph (<N> entities). Syncing in batches...
```
Use pagination on `list_nodes` and batch creates (50 at a time).

**Partial push failure:**
If some batch creates succeed but others fail, report what succeeded and what failed. The `.upg-sync` file should still be updated with the mappings for entities that DID sync; don't throw away progress. Suggest retrying with `/upg-sync-push` for the remaining entities.

**Node type mapping:**
Cloud uses the same entity types as local (`@unified-product-graph/core` shared ontology), so types map directly. Cloud stores type-specific data in a `data` JSONB column; map this from `properties` in the `.upg` format.
