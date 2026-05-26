---
name: upg-pull-detail
description: "Detailed pull flow, merge logic, incremental sync"
---

# /upg-pull — Pull Flow Detail

## Pull Flow

### Step 1: Connect to Cloud

```
mcp__upg-cloud__list_products()
```

If this fails (auth error):
```
To pull from The Product Creator, you need an API key configured.

1. Log in at cloud.unifiedproductgraph.org
2. Go to Settings → API Keys → Create New Key
3. Add to your .mcp.json config

Once configured, run /upg-pull again.
```

### Step 2: Select Product

If the user specified a product name, search for it. Otherwise, list all products:

```
Your products on The Product Creator:

  1. My SaaS App (42 entities, 38 edges)
  2. Side Project (12 entities, 8 edges)
  3. Client Engagement (67 entities, 55 edges)

Which one do you want to pull down? (number or name)
```

### Step 3: Determine Sync Mode

Once the user selects a product, check the local state to determine which pull flow to use:

1. **Read the `.upg-sync` file** from the current directory using the Read tool.
2. **Read the `.upg` file** if it exists.

**Decision matrix:**

| .upg-sync exists? | Matches selected product_id? | .upg exists? | Flow |
|---|---|---|---|
| No | — | No | **First-time pull** (Step 4A) |
| No | — | Yes | **Overwrite warning** (Step 4B) |
| Yes | Yes | Yes | **Incremental pull** (Step 4C) |
| Yes | No | Yes | **Different product warning** (Step 4B) |
| Yes | Yes | No | **First-time pull** — sync file is stale, treat as fresh (Step 4A) |

---

### Step 4A: First-Time Pull (Full)

No sync file exists and no local `.upg` file, or the sync file is stale. This is a clean pull.

#### Fetch the full graph:

```
mcp__upg-cloud__get_product_graph({
  product_id: "<selected_product_id>"
})
```

#### Transform to .upg format:

For each cloud node, generate a local `n_xxx` ID (nanoid-style short ID). For each cloud edge, generate a local `e_xxx` ID. Build the ID maps as you go.

```json
{
  "upg_version": "0.1.0",
  "exported_at": "<current ISO 8601 timestamp>",
  "source": {
    "tool": "upg-cloud-cloud",
    "tool_version": "1.0.0"
  },
  "product": {
    "id": "p_<nanoid>",
    "title": "<product title>",
    "description": "<product description>",
    "stage": "<stage if available>"
  },
  "nodes": [
    {
      "id": "n_<nanoid>",
      "type": "<entity type>",
      "title": "<title>",
      "description": "<description>",
      "tags": [],
      "status": "<status>",
      "properties": { ... }
    }
  ],
  "edges": [
    {
      "id": "e_<nanoid>",
      "source": "n_<source local id>",
      "target": "n_<target local id>",
      "type": "<edge type>"
    }
  ]
}
```

**Important:** Edge source/target must reference the LOCAL IDs you generated, not the cloud UUIDs. Use the node_id_map you're building to translate.

#### Write both files:

1. Write the `.upg` file using the Write tool.
2. **Create the `.upg-sync` file** with the full ID mapping:

```json
{
  "cloud_endpoint": "https://cloud.unifiedproductgraph.org",
  "product_id": "<cloud-product-uuid>",
  "last_synced_at": "<current ISO 8601 timestamp>",
  "node_id_map": {
    "n_local1": "cloud-uuid-1",
    "n_local2": "cloud-uuid-2"
  },
  "edge_id_map": {
    "e_local1": "cloud-uuid-1",
    "e_local2": "cloud-uuid-2"
  },
  "last_snapshot_hash": "<sha256 of the cloud graph JSON>"
}
```

To compute `last_snapshot_hash`: take the cloud graph response (nodes + edges, sorted by ID for determinism), JSON-stringify it, and compute a SHA-256 hash via Bash:
```bash
echo -n '<sorted-json-string>' | shasum -a 256 | cut -d' ' -f1
```

#### Confirm:

```
## Pull Complete

Pulled "<Product Name>" from The Product Creator cloud.

  File: product.upg
  Sync: .upg-sync (ID mapping + sync state created)
  Entities: <N> (<breakdown by type>)
  Connections: <N>
  Domains: <N> covered

Your graph is now local. It's a .upg file — portable, git-friendly, yours.
```

Then show the "What You Can Do Now" section (Step 6).

---

### Step 4B: Overwrite Warning

A local `.upg` file exists but there's no matching sync file (either no sync file at all, or the sync file points to a different product).

```
A local .upg file already exists: product.upg (<N> entities)
```

If no sync file:
```
There's no sync file (.upg-sync), so I can't merge incrementally.
Pulling will overwrite your local graph with the cloud version.

Want to proceed? (This is not reversible unless you have a git commit)
```

If sync file points to different product:
```
Your sync file is linked to a different cloud product ("<other product name>").
Pulling "<selected product name>" will replace your local graph and sync state.

Want to proceed?
```

If user confirms, proceed with Step 4A (full pull, overwriting both files).
If user declines, suggest:
```
You can:
  - Save your current .upg file first: cp product.upg product-backup.upg
  - Or commit it to git: git add product.upg && git commit -m "Backup before pull"
  - Then run /upg-pull again
```

---

### Step 4C: Incremental Pull (Sync File Exists and Matches)

This is the core incremental sync flow. The sync file exists, matches the selected product, and a local `.upg` file is present.

#### 1. Read current state

Read three things:
- The local `.upg` file (via Read tool)
- The `.upg-sync` file (via Read tool)
- The cloud graph (via `mcp__upg-cloud__get_product_graph()`)

#### 2. Compute the cloud snapshot hash

Hash the cloud graph response the same way as during full pull. Compare against `last_snapshot_hash` from the sync file.

**If hashes match:**
```
Your local graph is up to date with the cloud.

No changes detected on The Product Creator since your last sync
(<last_synced_at formatted nicely>).
```
Stop here. No changes needed.

**If hashes differ:** Continue to compute the changeset.

#### 3. Compute changeset

Compare the current cloud graph against what was synced last time. Use the `node_id_map` and `edge_id_map` from the sync file to correlate cloud and local entities.

**Cloud nodes — categorise each one:**

- **New on cloud:** Cloud node ID is NOT in any value of `node_id_map` — this entity was created on the cloud since last sync.
- **Updated on cloud:** Cloud node ID IS in `node_id_map`, and the node's content (title, description, type, properties, status, tags) differs from the corresponding local node.
- **Deleted on cloud:** A cloud ID exists in `node_id_map` values, but that cloud node no longer exists in the cloud graph response — it was deleted on the cloud since last sync.
- **Unchanged:** Cloud node ID is in `node_id_map` and content matches local. No action needed.

Do the same for edges using `edge_id_map`.

#### 4. Detect conflicts

Check if any node that is "updated on cloud" was ALSO modified locally since last sync. To detect local modifications:

- Compare the current local `.upg` file against the state that was synced (you can infer this from the sync file's hash — if the local file has diverged from what was pulled, there may be local changes).
- A pragmatic v1 approach: if a node appears in the "updated on cloud" set, check if the local version of that same node (via ID map) differs from what the cloud had at last sync time. If you can't determine the exact last-synced local state, assume any local node that differs from the incoming cloud version is a conflict.

**Conflict resolution (v1 — last write wins, cloud takes precedence):**
- Apply the cloud version.
- But track and report the conflict count to the user.

#### 5. Show summary and ask for confirmation

```
## Incoming Changes from Cloud

Pulling "<Product Name>" — changes since <last_synced_at>:

  + <N> new entities (<breakdown>)
  ~ <N> updated entities
  - <N> deleted entities
  + <N> new connections
  ~ <N> updated connections
  - <N> deleted connections
```

If there are conflicts:
```
  !! <N> entities were modified both locally and on the cloud.
     Cloud version will be kept (last-write-wins).
```

```
Apply these changes to your local graph? (y/n)
```

If no changes in any category:
```
Your local graph is up to date with the cloud.
```

#### 6. Apply changes to local .upg file

Read the current `.upg` file, then apply each change:

**New cloud nodes:**
- Generate a new local `n_xxx` ID for each
- Add the node to the `.upg` nodes array
- Add the mapping to `node_id_map`

**Updated cloud nodes:**
- Find the local node via `node_id_map` (reverse lookup: find the local ID whose mapped cloud ID matches)
- Update its title, description, type, properties, status, tags from the cloud version

**Deleted cloud nodes:**
- Find the local node via `node_id_map`
- Remove it from the `.upg` nodes array
- Remove the mapping from `node_id_map`
- Remove any edges that reference the deleted node

**New cloud edges:**
- Generate a new local `e_xxx` ID
- Translate source/target from cloud IDs to local IDs via `node_id_map`
- Add to the `.upg` edges array
- Add the mapping to `edge_id_map`

**Updated cloud edges:**
- Find the local edge via `edge_id_map`
- Update its source, target, type (translating cloud IDs to local IDs)

**Deleted cloud edges:**
- Find the local edge via `edge_id_map`
- Remove from `.upg` edges array
- Remove from `edge_id_map`

#### 7. Write updated files

1. Write the updated `.upg` file
2. Update the `.upg-sync` file:
   - `last_synced_at` → current timestamp
   - `node_id_map` → updated with new/removed mappings
   - `edge_id_map` → updated with new/removed mappings
   - `last_snapshot_hash` → hash of the current cloud graph

#### 8. Report results

```
## Pull Complete — Incremental Sync

Merged cloud changes into "<Product Name>".

  + <N> entities added
  ~ <N> entities updated
  - <N> entities removed
  + <N> connections added
  ~ <N> connections updated
  - <N> connections removed

  Local graph: <total N> entities, <total N> connections
  Synced at: <timestamp>
```

If there were conflicts:
```
  !! <N> conflicts resolved (cloud version kept)
     Future: /upg-resolve will let you review conflicts manually.
```

Then show the "What You Can Do Now" section (Step 6 below).

---

### Step 5: Handle Edge Cases

**Cloud graph is empty:**
```
"<Product Name>" has no entities in the cloud yet.
Build it locally with /upg-init, then /upg-push when ready.
```

**Very large graph (200+ entities):**
```
This is a large graph (<N> entities). The pull may take a moment...
```
Use pagination if needed from the cloud API.

**Node type mapping:**
Cloud uses the same entity types as local (`@unified-product-graph/core` shared ontology), so types map directly. Cloud stores type-specific data in a `data` JSONB column — map this to `properties` in the `.upg` format.

---

### Step 6: What You Can Do Now

Show this section after every successful pull (full or incremental):

```
### What You Can Do Now

  /upg-status     — See your graph health dashboard
  /upg-tree       — View through framework lenses (ost, user, validation...)
  /upg-gaps       — Find strategic gaps and get action plans
  /upg-explore     — Add new entities locally
  /upg-discover   — Run a guided discovery session
  /upg-push       — Push local changes back to the cloud

### Version Control

  git add product.upg
  git commit -m "Pull <product name> graph from cloud"

  Now you have full git history of your product thinking.
  Branch, diff, review — your graph is just data.

### Stay in Sync

  Edit locally, then /upg-push to sync back to the cloud.
  Pull again with /upg-pull to get the latest from your team.
  The .upg file is your source of truth for local work.

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your .upg file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org
```

