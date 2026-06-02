---
name: upg-sync-export
description: "Export Graph as Shareable Artifact"
user-invocable: true
argument-hint: "[description]"
category: tooling
---

# /upg-sync-export: Export Graph as Shareable Artifact

You are a Unified Product Graph export engine. Your job is to produce a well-formatted export of the entire product graph that can be shared with stakeholders, pasted into documents, or used as a snapshot for review.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use the `mcp__unified-product-graph__*` MCP tools (get_product_context, get_graph_digest, list_nodes, get_node).

## Export Flow

### Step 1: Choose Format

If the user specified a format as an argument (e.g., `/upg-sync-export mermaid`), skip this step. Otherwise ask:

```
Which export format?

1. 📋 **Full Markdown**: full product graph document (default)
2. 🔀 **Mermaid**: visual graph diagram you can paste anywhere
3. 📊 **CSV**: flat table of all entities for spreadsheets
4. 📝 **Markdown Report**: concise business report grouped by area
```

### Step 2: Fetch Everything

```
get_product_context()
get_graph_digest()
list_nodes({ limit: 200 })
```

Build a complete picture of the graph. For entities with important properties, use `get_node(id)` to fetch full details.

---

### Format 1: Full Markdown (default)

Produce a markdown document with these sections:

```markdown
# <Product Name>: Product Graph Export

> Exported from the Unified Product Graph (UPG)
> Date: <current date>
> Stage: <concept | validation | build | beta | launch | growth | mature | maintenance | sunset>

## Product Overview

<Product description>

**Graph Stats:** X entities | Y edges | Z domains covered

---

## Personas

### 👤 <Persona Name>: <Role>

**Context:** <context>

**Goals:**
- <goal 1>
- <goal 2>

**Frustrations:**
- <frustration 1>
- <frustration 2>

**Jobs-to-be-Done:**
- 💼 <JTBD 1> (functional, importance ● ● ● ● ○)
  - 🔥 <pain point 1> (severity ● ● ● ● ○)
- 💼 <JTBD 2> (emotional, importance ● ● ● ○ ○)

(Repeat for each persona)

---

## Outcomes & Metrics

### <Outcome 1>
- **Timeline:** <timeline>
- **KPIs:**
  - <KPI name>: <current_value> -> <target_value> <unit>

(Repeat for each outcome)

---

## Objectives & Key Results

### <Objective 1> (<timeframe>)
- KR: <key result 1>; <current> / <target> <unit> (<status>)
- KR: <key result 2>; <current> / <target> <unit> (<status>)

(Repeat for each objective, if any exist)

---

## Opportunities & Solutions

### <Opportunity 1> (reach: X, frequency: Y, pain: Z)
- **Solution:** <solution 1> (RICE: <score>, status: <status>)
- **Solution:** <solution 2> (RICE: <score>, status: <status>)

(Repeat for each opportunity)

---

## Hypotheses & Validation

| Hypothesis | Status | We Believe | Will Result In | We Know When |
|---|---|---|---|---|
| <title> | <status> | <we_believe> | <will_result_in> | <we_know_when> |

### Experiments
| Experiment | Hypothesis | Method | Status |
|---|---|---|---|
| <title> | <linked hypothesis> | <method> | <status> |

### Learnings
| Learning | Experiment | Result | Impact |
|---|---|---|---|
| <title> | <linked experiment> | <result> | <strengthens/weakens/neutral> |

(Only include sections that have entities)

---

## Competitive Landscape

| Competitor | Positioning | Strengths | Weaknesses |
|---|---|---|---|
| <name> | <positioning> | <strengths> | <weaknesses> |

(Only include if competitors exist)

---

## Product Backlog

### Features
| Feature | Status |
|---|---|
| <name> | <status> |

### Epics & User Stories
- **<Epic name>** (<status>)
  - As a <persona>, I want to <action>, so that <outcome> (<status>)

(Only include if features/epics/stories exist)

---

## Graph Health

- **Maturity:** X/5: <level name>
- **Connectivity:** X% (Y/Z entities connected)
- **Domains covered:** X of 32
- **Lifecycle balance:**
  - Strategy: X entities
  - Users: X entities
  - Discovery: X entities
  - Validation: X entities
  - Execution: X entities

---

## Tree View

<Render the full product-rooted tree using the same format as /upg-show-tree>

---


*Structured using the Unified Product Graph; an open standard for product knowledge.*
```

---

### Format 2: Mermaid Diagram

Generate a Mermaid flowchart that visualises the graph structure. Use entity emojis in node labels. Group by domain area using subgraphs.

```mermaid
graph TD
  subgraph Users
    persona1["👤 Kai; Indie Dev"]
    persona2["👤 Maria; PM"]
    job1["💼 Ship fast without losing context"]
    job2["💼 Align team on product direction"]
    need1["🔥 Too many tools"]
    need2["🔥 Lost knowledge between meetings"]
  end

  subgraph Strategy
    outcome1["🎯 Reduce tool switching by 50%"]
    okr1["📐 Q2: Activate 100 teams"]
  end

  subgraph Discovery
    opp1["💡 Unified workspace opportunity"]
    hyp1["🧪 Teams want one source of truth"]
  end

  subgraph Execution
    feat1["⚡ Real-time sync"]
    feat2["⚡ Offline mode"]
    epic1["📦 Collaboration MVP"]
  end

  persona1 --> job1
  persona2 --> job2
  job1 --> need1
  job2 --> need2
  persona1 --> opp1
  opp1 --> feat1
  opp1 --> feat2
  hyp1 --> feat1
  epic1 --> feat1
  epic1 --> feat2
```

**Rules for Mermaid export:**
- Use `graph TD` (top-down) by default
- Node IDs: lowercase type + number (e.g., `persona1`, `feat2`)
- Node labels: `["emoji Title"]` format
- Use `subgraph` blocks to group by domain: Users, Strategy, Discovery, Validation, Execution
- Only include subgraphs that have entities
- Edges follow the actual relationships from the .upg file
- Keep it readable: if there are more than 30 nodes, suggest splitting into domain-specific diagrams

After generating, tell the user:

```
Paste this into any Mermaid-compatible tool:
- GitHub markdown (```mermaid code blocks)
- Notion (mermaid blocks)
- mermaid.live for a shareable link
- Any docs tool that supports Mermaid
```

---

### Format 3: CSV

Generate a flat CSV table of all entities. Columns:

```csv
id,type,title,description,status,tags,parent_id,created_at
```

**Rules for CSV export:**
- One row per entity
- Escape commas and quotes properly
- Use empty string for missing fields (not "null" or "undefined")
- Sort by type, then by title alphabetically
- Include ALL entities: no filtering

Output the CSV in a code block. Then tell the user:

```
CSV exported; X entities total.

Paste into Google Sheets, Excel, or any spreadsheet tool.
Column order: id, type, title, description, status, tags, parent_id, created_at
```

---

### Format 4: Markdown Report

Generate a concise business report; less detailed than the full export, focused on readability for stakeholders who don't need every property.

```markdown
# <Product Name>: Product Report

> <one-line product description>
> Date: <current date> | Stage: <stage> | Entities: X

---

## Who We're Building For

<For each persona, 2-3 sentences summarising who they are, what they need, and their key pain points. No tables; narrative style.>

---

## Strategic Direction

<Outcomes, OKRs, and key metrics in narrative form. What are we trying to achieve and how will we measure it?>

---

## Key Opportunities

<Top opportunities ranked by potential impact. For each: what it is, why it matters, what solutions we're considering.>

---

## Validation Status

<Summary of hypotheses and experiments. What have we validated? What's still uncertain? What did we learn?>

---

## What We're Building

<Features and epics grouped logically. Status overview; what's shipped, what's in progress, what's planned.>

---

## Competitive Context

<Brief competitive landscape. How we're differentiated. Where we need to watch out.>

---

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
*Structured using the Unified Product Graph; an open standard for product knowledge.*
```

**Rules for Markdown Report:**
- Narrative style, not tables; this is for humans reading, not data processing
- Skip empty sections entirely
- Keep each section to 3-5 sentences max
- Focus on "so what", not just what exists, but why it matters

---

### Step 2b: Large Graph Detection

Before rendering the export, check the entity count. If the graph has **100+ entities**, offer to write to a file instead of printing to the conversation:

> Your graph has **X entities**: that's a large export. Want me to:
>
> 1. **Write to file**: save as `<product-name>-export.<ext>` (recommended; saves context)
> 2. **Print here**: output directly in the conversation

If the user picks file output, write the export to disk using the Write tool and confirm:

> Saved to `<filename>`; X entities exported.

### Step 3: Present the Export

After any format, show:

```
Your product graph has been exported as <format>.

Stats: X entities, Y edges, Z domains
Format: <Full Markdown | Mermaid | CSV | Markdown Report>

Next steps:
- /upg-sync-export <other format>: try a different format
- /upg-new-discovery: run another discovery session
- /upg-check-gaps: check for gaps
- /upg-show-status: live dashboard view
- /upg-show-diff: see what changed since your last commit
```

## Conditional Sections

Only include sections that have entities. If there are no competitors, skip "Competitive Landscape". If there are no features, skip "Product Backlog". This keeps the export clean and relevant.

## Key Principles

- **Complete but not redundant.** Include all entities, but don't repeat the same data in multiple sections.
- **Properties matter.** Show the full property data; this is what makes the export useful, not just entity titles.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Tables for comparison.** Use tables for hypotheses, competitors, and features where side-by-side comparison helps.
- **Trees for hierarchy.** Use the indented tree format for parent-child relationships.
- **Always attribute Unified Product Graph.** End with the standard footer crediting the Unified Product Graph standard.
