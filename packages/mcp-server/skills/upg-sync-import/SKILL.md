---
name: upg-sync-import
description: "Import product knowledge from external tools into your .upg graph: Markdown, GitHub, Linear, Jira, Dovetail, Vistaly, Notion, and 30+ more adapters"
user-invocable: true
argument-hint: "[tool]"
category: tooling
---

# /upg-sync-import: Import Product Knowledge

You are a UPG import engine. Pull structured product knowledge from external tools into the user's .upg graph.

**Before producing any output, read context:** /upg-context for entity types, formatting rules, and interaction patterns.

## Tools

`mcp__unified-product-graph__*`; create_node, create_edge, list_nodes, get_product_context.

## Time Estimate

**2–5 minutes** for CLI imports. MCP-guided flows take 5–10 minutes.

---

## Step 1: Choose Source

Skip if the user provided an argument (e.g. `/upg-sync-import github`). Otherwise present the menu:

```
Where do you want to import from?

── Fully wired (live API import today) ─────────────────

  1. 📄 Markdown       upg import --from markdown
  2. 🐙 GitHub         upg import --from github        GITHUB_TOKEN + GITHUB_REPO
  3. 📋 Linear         upg import --from linear         LINEAR_API_KEY
  4. 🗂️  Jira           upg import --from jira           JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN
  5. 🔬 Dovetail        upg import --from dovetail       DOVETAIL_API_KEY
  6. 🌲 Vistaly         upg import --from vistaly        VISTALY_API_KEY

── MCP-guided (agent-driven, no CLI yet) ───────────────

  7. 📝 Notion: uses Notion MCP + upg-notion-sync
  8. 🔀 Other (37 adapters available; see /integrations)
```

---

## Step 2a: Markdown (fully implemented, no API key)

```bash
upg import --from markdown                    # scans current directory
upg import --from markdown --file ./docs/     # specific folder
upg import --from markdown --dry-run          # preview without writing
```

Parses headings and content. Infers entity types from keywords:
- "persona/user/audience" → `persona`
- "feature/capability" → `feature`
- "pain point/problem/frustration" → `need`
- "hypothesis/assumption" → `hypothesis_claim`
- "metric/KPI/measure" → `metric`
- "objective/OKR/goal" → `objective`
- "opportunity/gap" → `opportunity`
- "competitor/alternative" → `competitor`
- "solution/approach" → `solution`
- "epic/story" → `epic` / `story_statement`
- "experiment/validation" → `experiment`
- "insight/learning" → `insight`

---

## Step 2b: Live API tools (GitHub, Linear, Jira, Dovetail, Vistaly)

All five use the same CLI flow:

```bash
upg import --from github      # prompts for GITHUB_TOKEN + repo if not in env
upg import --from linear      # prompts for LINEAR_API_KEY if not in env
upg import --from jira        # prompts for base URL + email + API token
upg import --from dovetail    # prompts for DOVETAIL_API_KEY
upg import --from vistaly     # prompts for VISTALY_API_KEY
```

**Env vars (set these to skip prompts):**

| Tool | Env vars |
|------|----------|
| GitHub | `GITHUB_TOKEN`, `GITHUB_REPO` (owner/repo) |
| Linear | `LINEAR_API_KEY` |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| Dovetail | `DOVETAIL_API_KEY` |
| Vistaly | `VISTALY_API_KEY`, `VISTALY_WORKSPACE_ID` (optional) |

**All five show the same flow:**
1. Connects to the API (spinner)
2. Fetches all entities
3. Shows a preview: entity counts by type + any warnings
4. Asks for confirmation before writing
5. Writes to your `.upg` file (creates or appends)

**Dry-run mode (preview without writing):**
```bash
upg import --from github --dry-run
upg import --from linear --dry-run --yes     # skip confirmation
```

---

## Step 2c: Notion (MCP-guided, bidirectional sync available)

Notion uses a different path; the Notion MCP server + the `upg-notion-sync` package.

**Import (Notion → UPG):**
```bash
# Option A: via the MCP (recommended)
# Ensure Notion MCP is configured in .claude/settings.json, then:
# The NotionAdapter classifies your databases by name and maps them to UPG types

# Option B: via Notion export
# 1. In Notion: Settings → Export → Markdown & CSV
# 2. upg import --from markdown --file ./notion-export/
```

**Bidirectional sync (UPG ↔ Notion; LIVE TODAY):**
```bash
npx @unified-product-graph/notion-sync push    # UPG → Notion
npx @unified-product-graph/notion-sync pull    # Notion → UPG
```

The sync package creates one Notion database per UPG entity type and maps edges to Notion relation properties.

---

## Step 2d: 30+ other adapters (convert() works for pre-fetched data)

The following adapters have a working `convert()` method; you can pass pre-fetched data:

**Strategy & Discovery:** Productboard, Aha!, Quantive, Shortcut, Chisel, Craft.io, Airfocus, ProdPad, Coda  
**Delivery:** GitLab, Jira (via CLI above)  
**Research:** Dovetail (via CLI above), Condens, Lookback, Sprig, Maze  
**Analytics:** Amplitude, PostHog, Pendo  
**Feedback:** Canny, Intercom, Zendesk  
**CRM / CS:** HubSpot, Salesforce, Gainsight  
**Design:** Figma, Miro, Storybook  
**Docs:** Confluence, Slack  
**OKR:** Lattice  

For these, use the adapter directly in code:
```typescript
import { ProductboardAdapter } from '@unified-product-graph/adapters'
const adapter = new ProductboardAdapter()
const result = await adapter.convert(prefetchedItems)
```

Or see `/integrations` on unifiedproductgraph.org for the full schema mapping for each tool.

Live CLI support for all adapters is in active development.

---

## Step 3: Post-import suggestions

After any successful import:

```
Your graph just grew! Suggested next steps:
- /upg-show-tree: see the full structure
- /upg-check-gaps: check what's still missing
- /upg-show-status: health dashboard with completeness scores
- /upg-new-discovery: AI-powered entity discovery from what you just imported
```

---

## Key Principles

- **Preview before creating.** Never silently add entities; show counts and warnings, get confirmation.
- **Infer conservatively.** Only create when content clearly maps to a UPG type. When uncertain, ask.
- **Preserve source context.** Store `source_id`, `source_type`, `external_tool` on every imported node.
- **Deduplicate.** Check existing nodes with `search_nodes` before creating. Flag potential matches.
- **Respect mapping_confidence.** Adapters set `'high'` / `'medium'` / `'low'`; surface `'low'` items for human review.
- **Never auto-emit `insight_informs_opportunity`.** This edge always requires PM judgment. Emit a warning instead.
