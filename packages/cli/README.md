# @unified-product-graph/mcp

The `upg` CLI. 22 commands across 6 groups: setup, workspace, governance, explore, create/edit, cloud.

```
   •  ·  •
   ·  ●  ·
   •  ·  •

   Unified Product Graph
```

## Get started in 60 seconds

```bash
npm install -g @unified-product-graph/mcp
upg init --title "My Product"    # create a .upg file in the current directory
upg install-skills               # install UPG skills into Claude Code
# wire the MCP server (see "MCP server setup" below)
# open Claude Code, then type /upg
```

Or run without installing:

```bash
npx @unified-product-graph/mcp health
```

## Two surfaces

The package ships two surfaces against the same `.upg` file.

**CLI (`upg <command>`)** governs the file: CI gates, CRUD, cloud sync, scripts, pre-commit hooks.

**MCP server** surfaces the file to Claude Code as AI-native tools: exploration, entity creation, strategic analysis, playbooks.

## MCP server setup

Wire the MCP server once per project. 1 file, 1 entry.

### Add to `.claude/settings.json`

```json
{
  "mcpServers": {
    "upg-local": {
      "command": "npx",
      "args": ["@unified-product-graph/mcp", "mcp", "run"],
      "env": {
        "UPG_FILE": ".upg/product.upg"
      }
    }
  }
}
```

Point `UPG_FILE` at your `.upg` file. Commit `.claude/settings.json` so the team shares the config.

Or let the CLI write it:

```bash
upg mcp setup --scope project   # writes .claude/settings.json
upg mcp status                  # confirm the entry landed
```

### Verify

Open Claude Code. The MCP status indicator shows `unified-product-graph` connected. Type `/upg` to confirm skills loaded.

`upg install-skills` and `upg mcp setup` are 2 separate steps. Skills register the slash commands; the MCP server connects them to your graph. Run both.

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `upg mcp setup` | Write the MCP server entry into `.claude/settings.json`. `--scope user`, `--force` |
| `upg mcp status` | Report MCP server config across scopes |
| `upg install-skills` | Install UPG skills into Claude Code. See [Install skills](#install-skills) |

### Workspace

| Command | Description |
|---------|-------------|
| `upg init` | Create a `.upg` file. `--title`, `--workspace` |
| `upg workspace` | List products. `workspace switch <name>` to change active |
| `upg export` | Export as JSON, Markdown, or CSV. `--format=md --type=persona` |

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

### Cloud

| Command | Description |
|---------|-------------|
| `upg login` | Browser OAuth or `--key` |
| `upg logout` | Remove stored credentials |
| `upg push` | Push to cloud. `--dry-run`, `--strategy=merge` |
| `upg pull` | Pull cloud changes. `--force` overwrites local |
| `upg products` | List your cloud products |
| `upg log` | Activity log: who changed what, when |

## Install skills

The package ships UPG skills as a `skills/` directory. `upg install-skills` links each one into `.claude/skills/`.

Symlinks are the default, so updates to `@unified-product-graph/mcp` propagate automatically. Windows falls back to copy. A `.upg-manifest.json` records UPG-owned skills, so `--remove` only touches them.

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
      - run: npx @unified-product-graph/mcp health --min-score=50
      - run: npx @unified-product-graph/mcp verify --no-orphans --max-orphan-rate=0.15
      - run: npx @unified-product-graph/mcp diff --since=origin/main --summary
```

Governance commands read the `.upg` file directly. CI runs skip MCP setup.

### Git hook (pre-commit)

```bash
#!/bin/sh
if git diff --cached --name-only | grep -q '\.upg$'; then
  npx @unified-product-graph/mcp verify --no-orphans || exit 1
fi
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success / pass |
| 1 | Failure / below threshold / violations found |
| 2 | Error (file not found, invalid JSON, etc.) |

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

## Authentication

Cloud commands (`push`, `pull`, `products`) need credentials:

```bash
# Browser OAuth (opens login page, receives key via callback)
upg login

# Manual API key
upg login --key upg_YOUR_KEY

# Environment variable (for CI)
UPG_API_KEY=xxx upg push
```

Credentials live in `~/.upg/credentials.json` at 0600.

## Positioning

`@unified-product-graph/mcp` ships the **UPG open standard** (MIT). The CLI runs offline against `.upg` files; cloud commands connect to UPG cloud. `git` (open tool) → hosted Git provider (product).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
