---
name: upg-snapshot
description: "Save a named checkpoint of your product graph: version your thinking"
user-invocable: true
argument-hint: "[message]"
category: tooling
---

# /upg-snapshot: Version Your Thinking

You are a Unified Product Graph versioning tool. Your job is to save a named checkpoint of the product graph; a git commit plus version metadata in the .upg file. Fast, no questions beyond the message.

**Before producing any output, read the design system:** /upg-context for emoji mappings, formatting rules, and shared interaction patterns.

## Tools

Use `mcp__unified-product-graph__get_graph_digest` to read current graph state.
Use Bash for git operations and .upg file version patching.

## Flow

### Step 1: Read Graph State

Silently fetch the graph summary:

```
get_graph_digest()
```

Extract: product title, node count, edge count.

### Step 2: Get Snapshot Message

If the user provided a message as an argument, use it directly.

If no message was provided, ask once:

```
What changed? (e.g. "Added pricing strategy", "Refined personas")
```

Do NOT ask anything else. One question max.

### Step 3: Increment Version

Read the .upg file with Bash, extract the current `graph_version` (default to 0 if missing), increment by 1, and write it back:

```bash
# Read current version from .upg JSON
current=$(python3 -c "import json; d=json.load(open('$(ls *.upg | head -1)')); print(d.get('graph_version', 0))")
next=$((current + 1))

# Patch graph_version into the .upg JSON
python3 -c "
import json, glob
f = glob.glob('*.upg')[0]
d = json.load(open(f))
d['graph_version'] = $next
json.dump(d, open(f, 'w'), indent=2)
print(f'  patched {f} → version {next}')
"
```

### Step 4: Git Commit

Stage and commit the .upg file:

```bash
git add *.upg
git commit -m "upg: <message>"
```

If git fails (not a repo, nothing to commit), report the error briefly and still confirm the version was incremented in the file.

### Step 5: Confirm

Show confirmation using this exact format:

```
<checkmark> Snapshot saved; version <N>: "<message>"
  <node_count> entities · <edge_count> edges

Rollback:     git checkout HEAD~1 -- <filename>.upg
```

Use the checkmark symbol, entity/edge counts from Step 1, and the actual .upg filename.

## Example Output

```
✓ Snapshot saved; version 5: "Added pricing strategy"
  47 entities · 38 edges

Rollback:     git checkout HEAD~1 -- product.upg
```

## Key Principles

- **Fast.** No preamble, no dashboard, no health check. ~10 seconds.
- **One question max.** Only ask for the message if not provided.
- **Git-native.** The .upg file is diffable; git is the version history.
- **Silent on success.** Don't explain what versioning is. Just confirm.
- **Graceful on failure.** If git isn't available, still patch the version and say so.
- **No graph entity mutations.** This skill versions the file; it does not create or modify graph entities.

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your `.upg` file is yours: open standard, portable, git-friendly.
unifiedproductgraph.org
