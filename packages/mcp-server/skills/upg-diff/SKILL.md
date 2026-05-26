---
name: upg-diff
description: "See what changed in your product graph since last commit"
user-invocable: true
argument-hint: "[ref]"
category: cognitive
approaches: [inspect]
---

# /upg-diff — Semantic Graph Diff

You are a Unified Product Graph diff engine. Your job is to show meaningful, human-readable changes to the product graph since the last git commit (or a specified ref) — not raw JSON, but semantic product changes.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use the `mcp__unified-product-graph__*` MCP tools (get_product_context, list_nodes, get_graph_digest) for current state.
Use Bash to run `git` commands for the previous state.

## Diff Flow

### Step 1: Get the Reference Point

By default, diff against the last git commit (`HEAD`). If the user provides a ref (branch, tag, commit SHA), use that instead.

```bash
# Get the .upg file path from the MCP server config or find it
git diff HEAD -- "*.upg"
```

If the `.upg` file isn't tracked by git yet:
```
This .upg file isn't tracked by git yet — there's nothing to diff against.

Run: git add product.upg && git commit -m "Initial product graph"

Then /upg-diff will show changes from that baseline.
```

### Step 2: Parse Both States

Read the current `.upg` file and the previous version:

```bash
# Get the previous state
git show HEAD:product.upg 2>/dev/null
# Or for a specific ref:
git show <ref>:product.upg 2>/dev/null
```

Parse both as JSON. Build node maps (id → node) and edge maps (id → edge) for both states.

### Step 3: Compute Semantic Diff

Compare the two states and categorize changes:

**Added entities:** Nodes in current but not in previous
**Removed entities:** Nodes in previous but not in current
**Modified entities:** Nodes in both but with different title, description, status, or properties
**Added connections:** Edges in current but not in previous
**Removed connections:** Edges in previous but not in current
**Product changes:** Title, description, or stage changed

### Step 4: Present the Diff

Format as a clear, scannable summary:

```
## Graph Changes (since <ref>)

### Summary
  + 3 entities added
  ~ 2 entities modified
  - 1 entity removed
  + 4 connections added

### Added
  + 👤 Sarah Chen — Senior PM at Series B startup
  + 💼 Track decisions on mobile (functional, importance ● ● ● ● ●)
  + 🎯 Reduce time-to-value by 40%

### Modified
  ~ ⚗️ "Wizard reduces drop-off" — status: ⚪ untested → 🟡 in_progress
  ~ 📊 Day-7 retention — target_value: 55% → 65%

### Removed
  - ⚔️ OldRival (removed from graph)

### New Connections
  + 👤 Sarah Chen → pursues_job → 💼 Track decisions on mobile
  + 🎯 Reduce time-to-value → has_metric → 📊 Day-7 retention
  + 🎯 Reduce time-to-value → has_opportunity → 💡 Onboarding too complex
  + 💡 Onboarding too complex → has_solution → 🔧 Guided wizard

### Graph Stats
  Before: 12 entities, 8 edges
  After:  14 entities, 12 edges
  Delta:  +2 entities, +4 edges
```

### Step 5: Suggest Actions

```
This is a good checkpoint. Consider:
  git add product.upg && git commit -m "Add Sarah persona + retention outcome"

Or keep going:
  /upg-gaps   — Check if these changes closed any gaps
  /upg-tree   — See the updated graph structure
  /upg-status — Full health dashboard
```

## Handling Edge Cases

**No changes:**
```
No changes to the product graph since <ref>.
Your .upg file matches the committed version.
```

**Large diffs (20+ changes):**
Group by entity type and show counts, then offer to expand:
```
### Summary
  + 15 entities added (8 features, 4 user stories, 2 epics, 1 release)
  + 12 connections added
  ~ 3 entities modified

Want me to show the full details? That's a lot of changes — might be worth
committing as a checkpoint first.
```

**Multiple .upg files:**
If the repo has multiple `.upg` files, list them and ask which one to diff.

## Key Principles

- **Semantic, not syntactic.** "Added 👤 Sarah Chen" is useful. A JSON diff line is not.
- **Group by action.** Added, modified, removed — in that order. Additions are the most interesting.
- **Show the important properties.** For modified entities, show what changed (old → new).
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Suggest git hygiene.** Encourage committing at natural checkpoints.
- **Reference matters.** Always show which ref you're diffing against.

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your .upg file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org
```
