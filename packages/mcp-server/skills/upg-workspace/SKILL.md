---
name: upg-workspace
description: "Manage your UPG workspace — list products, switch between them, add new ones"
user-invocable: true
argument-hint: "[list|switch|add|init]"
category: tooling
---

# /upg-workspace — Manage Your Product Workspace

Manage multiple product graphs. Fast, direct, sub-commands keep it tight. Read `/upg-context` before producing output.

**Tools:** `mcp__unified-product-graph__list_local_products`, `mcp__unified-product-graph__switch_product`, `mcp__unified-product-graph__get_product_context`, Bash for file ops.

**Parse argument:** no arg or `list` → list. `switch <N|name>` → switch. `add` → add. `init` → init.

---

## `list` (default)

Check if `.upg/workspace.json` exists (Bash). Call `list_local_products` for entity counts.

**Workspace mode** (workspace.json exists) — read `default_product` to mark active:
```
## Your UPG Workspace
  📁 .upg/ (workspace mode)
  1. ● My SaaS (active) — 42 entities, mvp stage
  2. ○ Client Project — 12 entities, idea stage
  3. ○ Internal Tools — 8 entities, idea stage
  Switch: /upg-workspace switch <number>
  Add:    /upg-workspace add
```

**Single-file mode** (no workspace.json, 1+ files):
```
## Your UPG Workspace
  📄 Single-file mode (product.upg)
  ● My SaaS — 42 entities, mvp stage
  Want multiple products? Run /upg-workspace init
```
If multiple loose files, number them and suggest `init`. If zero files, point to `/upg-init`.

---

## `switch <number|name>`

1. Call `list_local_products`. Match by 1-indexed position (number) or case-insensitive partial title match (name). If no match, show the list.
2. Call `switch_product` with the resolved file path.
3. Confirm: `● Switched to **Client Project** (12 entities, idea stage)`

---

## `add`

1. Ask: **"What's the name of the new product?"** — one question, STOP, wait.
2. Create blank .upg file via Bash. Path: `.upg/<kebab-slug>.upg` if workspace mode, else `<kebab-slug>.upg` in cwd. Generate id: `node -e "import('nanoid').then(m => console.log(m.nanoid(16)))"`. File structure:
   ```json
   { "upg_version": "0.5.0", "exported_at": "<now>",
     "source": { "tool": "upg-mcp-local", "tool_version": "0.5.0" },
     "product": { "id": "<nanoid>", "title": "<title>", "stage": "idea" },
     "nodes": [], "edges": [] }
   ```
3. If workspace mode, update workspace.json — add to `products` array.
4. Confirm: `✓ Created **Client Project** (.upg/client-project.upg)` — then ask "Switch to it now? [Y/n]". If yes, run switch logic.

---

## `init`

Upgrades loose .upg files to `.upg/` workspace mode.

- If workspace.json already exists: "You're already in workspace mode. Run `/upg-workspace` to see your products." Done.
- If no .upg files exist: "No .upg files found. Run `/upg-init` first." Done.

Otherwise:
1. `mkdir -p .upg` and `mv *.upg .upg/` for each file.
2. Create `.upg/workspace.json` with `default_product` set to the currently loaded product (from `get_product_context`) and a `products` array listing each file + title.
3. Call `switch_product` with the new path so the MCP server picks up the move.
4. Confirm:
```
  ✓ Workspace initialized
  📁 .upg/
  ├─ workspace.json
  ├─ my-saas.upg (active)
  └─ client-project.upg
  Your .upg files are now organized in .upg/. Git paths updated.
```

---

## Display Rules

- Active product = `●` filled dot. Others = `○` open dot.
- Number products starting at 1. Users switch by number, not file path.
- Show entity count (nodes) and stage for each product.
- No unnecessary questions — `list` and `switch` need zero extra input.
- Standard footer on every output:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your .upg file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org
```
