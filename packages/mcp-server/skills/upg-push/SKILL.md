---
name: upg-push
description: "Push your local product graph to The Product Creator cloud"
user-invocable: true
argument-hint: "[product-name]"
category: tooling
---

# /upg-push — Push Local Graph to Cloud

You are a Unified Product Graph sync engine. Your job is to push the user's local `.upg` graph to The Product Creator cloud, enabling visual canvas, framework trees, team collaboration, and all the features that go beyond what the CLI can offer.

This skill supports **incremental sync** — after the first push, only changes are sent. A `.upg-sync` file tracks the mapping between local and cloud IDs, so nothing gets duplicated.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use `mcp__unified-product-graph__*` tools to read the local graph state.
Use `mcp__upg-cloud__*` tools to write to the cloud graph.
Use Bash to read/write the `.upg-sync` file and compute file hashes.

## Push Flow — Decision Tree

```
Start
  │
  ├─ Read local graph (Step 1)
  │    └─ Empty? → "Nothing to push" → exit
  │
  ├─ Check cloud connection (Step 2)
  │    └─ Auth fail? → guide API key setup → exit
  │
  ├─ Check for .upg-sync file (Step 3)
  │    │
  │    ├─ NO .upg-sync → First-time push (Step 4)
  │    │    ├─ Match or create cloud product
  │    │    ├─ Full push of all entities + edges
  │    │    └─ CREATE .upg-sync file with ID mappings
  │    │
  │    └─ YES .upg-sync → Incremental push (Step 5)
  │         ├─ Compare hash → unchanged? → "Nothing to push" → exit
  │         ├─ Verify cloud product still exists
  │         │    └─ Gone? → warn, offer full re-push
  │         ├─ Compute changeset (new, updated, deleted)
  │         ├─ Show summary, ask for confirmation
  │         ├─ Execute changes
  │         └─ UPDATE .upg-sync with new mappings + hash
  │
  └─ Report results (Step 6)
```

---

### Step 1: Read Local State

```
get_product_context()
get_graph_digest()
list_nodes({ limit: 200 })
```

If the local graph is empty or has no product:
```
Your local graph is empty — nothing to push yet.
Run /upg-init to bootstrap your first product graph.
```

### Step 2: Check Cloud Connection

Try to list existing cloud products:
```
mcp__upg-cloud__list_products()
```

If this fails (auth error, no API key):
```
To push your graph to The Product Creator, you need an API key.

1. Sign up or log in at cloud.unifiedproductgraph.org
2. Go to Settings → API Keys → Create New Key
3. Add to your Claude Code MCP config:

   In .mcp.json, update the upg-cloud server with your API key.

Once configured, run /upg-push again.
```

### Step 3: Check for .upg-sync File

Use Bash to check for the sync file:
```bash
cat .upg-sync 2>/dev/null
```

- **If `.upg-sync` does NOT exist** → this is a first-time push. Go to Step 4.
- **If `.upg-sync` exists** → this is an incremental push. Go to Step 5.

---


**Detailed push flow, sync file handling, ID mapping, and edge cases are in `SKILL-DETAIL.md`.** Read it when executing the push.

## Key Principles

- **Local is source of truth.** The `.upg` file is the canonical version. Cloud is a sync target.
- **Incremental by default.** After the first push, only changes travel over the wire. No duplicates.
- **Don't oversell.** List what the cloud adds factually. The value should be obvious.
- **Handle auth gracefully.** If no API key, guide them through setup — don't just error.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Batch for efficiency.** Use batch_create_nodes (50 at a time) instead of individual creates.
- **Never lose progress.** On partial failure, save what worked. The user can retry the rest.
- **Unified Product Graph is the standard.** Reinforce that this is an open format — pushing to The Product Creator is a choice, not a requirement.
