# @unified-product-graph/cli

The `upg` CLI — local-first governance, CRUD, and analysis for `.upg` files, plus a cursor-based "stand in the graph" command set (`use`/`here`/`at`/`ls`/`find`/`new`/`link`/`check`/`fix`). Command groups: stand-in-the-graph, setup, workspace, governance, explore, create/edit, frameworks.

```
   •  ·  •
   ·  ●  ·
   •  ·  •

   Unified Product Graph
```

## Get started in 60 seconds

```bash
npm install -g @unified-product-graph/cli
upg init --title "My Product"    # create a .upg file in the current directory
upg install-skills               # install UPG skills into Claude Code
# wire the MCP server (see "MCP server setup" below)
# open Claude Code, then type /upg
```

Or run without installing:

```bash
npx @unified-product-graph/cli health
```

## Two surfaces

The package ships two surfaces against the same `.upg` file.

**CLI (`upg <command>`)** governs the file: CI gates, CRUD, governance, scripts, pre-commit hooks.

**MCP server** surfaces the file to Claude Code as AI-native tools: exploration, entity creation, strategic analysis, playbooks.

## MCP server setup

Wire the MCP server once per project. 1 file, 1 entry.

### Add to `.mcp.json`

```json
{
  "mcpServers": {
    "unified-product-graph": {
      "command": "npx",
      "args": ["-y", "@unified-product-graph/mcp-server@latest"],
      "env": {
        "UPG_FILE": ".upg/product.upg"
      }
    }
  }
}
```

`.mcp.json` at the project root is the file Claude Code reads for project-scoped MCP servers — commit it so the team shares the config. Point `UPG_FILE` at your `.upg` file (optional; the server auto-discovers).

The `@latest` tag matters: `npx` caches by package name, so without it a machine that ran an earlier version keeps launching that cached build after you publish a new one. `@latest` makes npx resolve the newest release each launch. Pin a specific version instead (e.g. `@unified-product-graph/mcp-server@0.8.5`) if you want reproducible, locked behaviour across a team.

Or let the CLI write it:

```bash
upg mcp setup --scope project   # writes .mcp.json (user scope writes ~/.claude.json)
upg mcp status                  # confirm the entry landed
```

### Verify

Open Claude Code. The MCP status indicator shows `unified-product-graph` connected. Type `/upg` to confirm skills loaded.

`upg install-skills` and `upg mcp setup` are 2 separate steps. Skills register the slash commands; the MCP server connects them to your graph. Run both.

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `upg mcp setup` | Write the MCP server entry into `.mcp.json` (or `~/.claude.json` with `--scope user`). `--force` |
| `upg mcp status` | Report MCP server config across scopes |
| `upg install-skills` | Install UPG skills into Claude Code. See [Install skills](#install-skills) |

### Workspace

| Command | Description |
|---------|-------------|
| `upg init` | Create a `.upg` file. `--title`, `--workspace` |
| `upg workspace` | List products. `workspace switch <name>` to change active |
| `upg export` | Export as JSON, Markdown, or CSV. `--format=md --type=persona` |
| `upg fmt` | Rewrite `.upg` files to canonical form (byte-stable, diff-friendly). `fmt [files...]`, `--check` for CI |

### Governance

| Command | Description |
|---------|-------------|
| `upg health` | Score the graph 0–100. `--min-score=60` for CI gate |
| `upg verify` | Structural validation. `--no-orphans`, `--max-orphan-rate=0.1` |
| `upg diff` | Show changes since a git ref. `--since=main` for PR reviews |
| `upg gaps` | Empty domains, broken chains, sparse areas |

### Explore

| Command | Description |
|---------|-------------|
| `upg use [lens]` | Set the sticky operating lens (scopes vocabulary): `product`, `ux_design`, `engineering`, `growth`, `business`, `research`, `marketing`, `full`. No arg shows the current lens; `--clear` resets |
| `upg list` | Query entities. `--type`, `--status`, `--orphans`, `--count` |
| `upg tree` | Tree view. `upg tree persona`, `--depth=2` |
| `upg search <query>` | Fuzzy search across titles and descriptions |

### Create & Edit

| Command | Description |
|---------|-------------|
| `upg create <type> <title>` | Create entity (type-validated). `--parent=<id>` |
| `upg update <id>` | Update fields. `--title`, `--status`, `--data='{"key":val}'` |
| `upg delete <id>` | Delete entity + edges. `--force` skips confirm |
| `upg connect <src> <tgt>` | Create edge. Type auto-inferred |

### Frameworks

Run a framework over a set of entities. `apply` creates a `framework_exercise` and an `includes` edge to each entity; `score` records that framework's result for one entity **on the edge** (a MoSCoW bucket, a RICE score, a canvas slot), never on the entity node — so the same entity can sit in many exercises with different results, and any entity type can be scored.

| Command | Description |
|---------|-------------|
| `upg apply <framework> [ids...]` | Create an exercise + an `includes` edge per entity. `--title`, `--status` |
| `upg score <exercise> <entity>` | Record the result on the edge. `--data='{"moscow":"must"}'`, `--replace` |
| `upg show <exercise>` | Show an exercise: each included entity + its recorded scores, as a table. `--json` |

```bash
upg apply moscow feat_sso feat_dark --title "Q3 Release Scope"   # → prints the exercise id
upg score <exercise-id> feat_sso --data '{"moscow":"must"}'
```

### MCP

| Command | Description |
|---------|-------------|
| `upg mcp setup` | Write the server entry into `.mcp.json` (project) or `~/.claude.json` (user) |
| `upg mcp status` | Report MCP config across project + user scopes |
| `upg mcp run` | Run the UPG MCP server over stdio (invoked by Claude) |

## Install skills

The package ships UPG skills as a `skills/` directory. `upg install-skills` links each one into `.claude/skills/`.

Symlinks are the default, so updates to `@unified-product-graph/cli` propagate automatically. Windows falls back to copy. A `.upg-manifest.json` records UPG-owned skills, so `--remove` only touches them.

```bash
# Project scope (default): <cwd>/.claude/skills/, committable with the team
upg install-skills

# User scope: ~/.claude/skills/, available in every project
upg install-skills --scope user

# Preview without installing
upg install-skills --list

# Force copy instead of symlink (useful for CI reproducibility)
upg install-skills --mode copy

# Overwrite pre-existing skills without prompting
upg install-skills --force

# Uninstall (removes only the skills recorded in the manifest)
upg install-skills --remove
```

## CI/CD

### GitHub Actions

```yaml
name: UPG Graph Quality
on:
  pull_request:
    paths: ['**/*.upg']

jobs:
  graph-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @unified-product-graph/cli@latest fmt --check .upg/*.upg
      - run: npx @unified-product-graph/cli@latest health --min-score=50
      - run: npx @unified-product-graph/cli@latest verify --no-orphans --max-orphan-rate=0.15
      - run: npx @unified-product-graph/cli@latest diff --since=origin/main --summary
```

Governance commands read the `.upg` file directly. CI runs skip MCP setup.

### Branching and merging `.upg` files

Branch and merge them like any other file in the repo. `upg fmt` gives every
writer byte-identical output, so diffs stay small and conflicts land on the
entities that actually changed.

The `$upg` header at the top of the file is **derived data** — element counts
and a checksum over the body. On a header conflict, take either side; `upg fmt`
recomputes both from the body it writes.

Worth knowing: the dangerous merge is the one with *no* conflict. If two
branches each add an entity, git merges the bodies cleanly but sees the same
`"nodes": 41 → 42` header change on both sides and applies it once, leaving a
file that declares 42 while holding 43. Nothing is lost, but the header is now
lying. `upg fmt` reseals it, and `upg fmt --check` is what catches it in CI —
which is why the recipe above runs it first.

### Git hook (pre-commit)

```bash
#!/bin/sh
if git diff --cached --name-only | grep -q '\.upg$'; then
  npx @unified-product-graph/cli@latest verify --no-orphans || exit 1
fi
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success / pass |
| 1 | Runtime error (file not found, invalid JSON, etc.) |
| 2 | Validation / policy (verify violations, incompatible edge) |
| 3 | Usage error (unknown flag/arg) |

## Output formats

`--json` works on most commands:

```bash
upg health --json
upg list --type persona --json
upg diff --since=main --json
upg gaps --json
```

Badge for README:

```bash
upg health --format=badge
# → ![UPG Health](https://img.shields.io/badge/UPG_Health-62%25-yellow)
```

## File discovery

The CLI resolves the `.upg` file in 5 steps:

1. `--file <path>` flag.
2. `.upg/workspace.json` → default product.
3. `.upg/` directory with `.upg` files → auto-creates `workspace.json`.
4. `*.upg` files in the current directory.
5. Falls through to `upg init` suggestion.

## Positioning

`@unified-product-graph/cli` ships the **UPG open standard** (MIT). The CLI runs offline against local `.upg` files. `git` (open tool) → hosted Git provider (product).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
