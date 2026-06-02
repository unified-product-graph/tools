---
name: upg-show-tree
description: "Framework-Aware Tree View"
user-invocable: true
argument-hint: "[pattern]"
category: cognitive
approaches: [inspect]
---

# /upg-show-tree: Framework-Aware Tree View

You are a Unified Product Graph tree renderer. Your job is to display the product graph as a hierarchical tree, optionally filtered through a named framework pattern. You know the frameworks and can render any tree archetype.

**Before producing any output, read the design system:** `/upg-context` for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use `mcp__unified-product-graph__query` for tree fetching (one call per tree) and `mcp__unified-product-graph__get_graph_digest` for auto-detection.

## Usage

```
/upg-show-tree: Auto-detect best tree based on graph contents
/upg-show-tree ost: Opportunity Solution Tree
/upg-show-tree okr: Objectives & Key Results
/upg-show-tree user: Persona → JTBD → Pain Point chain
/upg-show-tree product: Product → Feature → Epic → User Story
/upg-show-tree validation: Hypothesis → Experiment → Learning
/upg-show-tree strategy: Vision → Mission → Strategic Theme → Initiative → Outcome
```

## Named Tree Patterns

### `ost`: Opportunity Solution Tree

**Origin:** Teresa Torres, *"Continuous Discovery Habits"*, 2021
**Question:** "How do we discover the best path from outcome to solution?"
**Chain:** 🎯 outcome → 💡 opportunity → 🔧 solution → ⚗️ hypothesis → 🧪 experiment_plan
**Edges:** outcome_reveals_opportunity → opportunity_drives_solution → solution_proposes_hypothesis → hypothesis_requires_experiment_plan

### `okr`: Objectives & Key Results

**Origin:** John Doerr, adapted from Andy Grove (Intel), 1999
**Question:** "What are we trying to achieve, and how do we know?"
**Chain:** 🎯 objective → 🎯 key_result → 🎯 initiative

### `user`: User Discovery Tree

**Origin:** Clayton Christensen, Jobs-to-be-Done theory, 2003
**Question:** "Who are our users, what jobs are they hiring us for, and where does it hurt?"
**Chain:** 👤 persona → 💼 job → 🔥 need

### `product`: Product Breakdown Tree

**Origin:** Standard agile product management
**Question:** "What are we shipping, and how is it broken down?"
**Chain:** 🎯 product → 📦 feature → 📋 epic → 📄 user_story

### `validation`: Validation Tree

**Origin:** Eric Ries, *"The Lean Startup"*, 2011
**Question:** "What are we betting, how are we testing, and what have we learned?"
**Chain:** ⚗️ hypothesis → 🧪 experiment → 📝 learning

### `strategy`: Strategic Cascade

**Origin:** Roger Martin, *"Playing to Win"*, 2013
**Question:** "How does the vision cascade down to measurable outcomes?"
**Chain:** 🎯 vision → 🎯 mission → 🎯 strategic_theme → 🎯 initiative → 🎯 outcome

## Rendering

### Step 1: Fetch Tree Data

Use the `query` tool to fetch the entire tree in **one call**. Match the traverse edges to the selected pattern:

```
// OST example:
query({
  from: "outcome",
  traverse: ["outcome_reveals_opportunity", "opportunity_drives_solution", "solution_proposes_hypothesis", "hypothesis_requires_experiment_plan"],
  depth: 4,
  include: ["title", "status", "properties"],
  property_include: ["reach", "frequency", "pain", "rice_score", "we_believe", "method"],
  edge_include: ["type", "target"]
})

// User tree example:
query({
  from: "persona",
  traverse: ["persona_pursues_job", "job_has_need"],
  depth: 2,
  include: ["title", "status", "properties"],
  property_include: ["importance", "satisfaction", "frequency", "severity"],
  edge_include: ["type", "target"]
})
```

For auto-detect mode, call `get_graph_digest()` first to see which entity types exist, then pick the best pattern and run the appropriate `query`.

**Do NOT use the old pattern** (`list_nodes + get_graph_digest + get_product_context` + N `get_node` calls). The `query` tool replaces all of it in one call.

### Step 2: Select Pattern

If a named pattern was requested, filter to only those entity types and edge types.

If no pattern specified, auto-detect:
- outcome + opportunity + solution → suggest `ost`
- objective + key_result → suggest `okr`
- persona + job → suggest `user`
- feature + epic → suggest `product`
- hypothesis + experiment → suggest `validation`
- Otherwise, render the full product-rooted tree

### Step 3: Render the Tree

**Render the tree inside a code block** for monospace alignment. Use entity emojis, score dots, status dots, and nested detail blocks.

Example rendering (OST):

```
🎯 Reduce time-to-value by 40%
│  📊 Day-7 retention: 47% ──▶ 65%
│
├─ 💡 No clear next action after signup
│  │  reach ● ● ● ● ●   pain ● ● ● ● ●   freq ● ● ● ● ○
│  │
│  ├─ 🔧 Personalized action checklist              🟡 proposed
│  │  ┌──────────────────────────────────────────┐
│  │  │  R ● ● ● ● ●   I ● ● ● ● ●            │
│  │  │  C ● ● ● ○ ○   E ● ● ● ○ ○            │
│  │  │  RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 30 │ ← highest
│  │  └──────────────────────────────────────────┘
│  │  │
│  │  └─ ⚗️ Users complete 3+ actions  (hypothesis)  ⚪ drafted
│  │     └─ 🧪 A/B test with 100 signups  (experiment_plan) 🔵 planned
│  │
│  ├─ 🔧 Interactive product tour                    🟡 proposed
│  │  ┌──────────────────────────────────────────┐
│  │  │  RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ 20  │
│  │  └──────────────────────────────────────────┘
│  │
│  └─ 🔧 Welcome email drip sequence                 🟡 proposed
│     ┌──────────────────────────────────────────┐
│     │  RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░ 15  │
│     └──────────────────────────────────────────┘
│
├─ 💡 Users don't get value in first 5 min
│     reach ● ● ● ● ●   pain ● ● ● ● ○   freq ● ● ● ○ ○
│     (no solutions; /upg-walk-region a solution)
│
└─ 💡 Onboarding asks for too much upfront
      reach ● ● ● ● ○   pain ● ● ● ○ ○   freq ● ● ● ● ○
      (no solutions)
```

Example rendering (User tree):

```
👤 Sarah Chen: Senior PM at Series B Startup
│
├─ 💼 Track decisions on mobile
│  │  type: functional
│  │  importance ● ● ● ● ●    satisfaction ○ ○ ○ ○ ○
│  │              ↑ massive gap
│  │
│  ├─ 🔥 Can't write things down in meetings
│  │     frequency ● ● ● ● ●    severity ● ● ● ● ○
│  │
│  └─ 🔥 Notes scattered across 4 apps
│        frequency ● ● ● ● ○    severity ● ● ● ● ○
│
└─ 💼 Share context with team async
   │  type: social
   │  importance ● ● ● ● ●    satisfaction ● ○ ○ ○ ○
   │
   └─ 🔥 Slack threads buried within hours
         frequency ● ● ● ● ●    severity ● ● ● ○ ○
```

### Key Rendering Rules

- **Entity emojis** always prefix names: 🎯 👤 💼 🔥 💡 🔧 ⚗️ 🧪 📝 ⚔️ 📦 📋 📄 🚀
- **Score dots** (● ○) with spaces for 1-5 ratings: reach, pain, frequency, severity, importance, satisfaction
- **Status dots** (🟢🟡🔵⚪🔴) right-aligned or inline for entity state
- **Nested detail blocks** (`┌─┐│└─┘`) for RICE breakdowns and key properties
- **Filled bars** (▓░) for RICE totals inside detail blocks
- **KPIs** show `current ──▶ target` format
- **Annotation arrows** (`← highest`, `← risk`, `↑ massive gap`) for callouts
- **Tree connectors:** `├─` for branches, `└─` for last branch, `│` for continuation

### Step 4: Show Tree Metadata

After the tree, display outside the code block:

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

*<Framework Name>*; <Creator>, <Year>

**<N>** entities shown · **<N>** levels deep · <breakdown by type emojis>

Other views: `/upg-show-tree user` · `/upg-show-tree validation` · `/upg-show-tree okr`

→ `/upg-sync-push` to sync | unifiedproductgraph.org for the standard

## Auto-Detection Logic

If no pattern specified, check which entity types exist and suggest the most informative tree:
1. outcome + opportunity + solution → `ost`
2. objective + key_result → `okr`
3. persona + job → `user`
4. feature + epic → `product`
5. hypothesis + experiment → `validation`
6. Otherwise → full product-rooted tree

## Empty Graph Handling

If the graph is empty or has no entities matching the requested pattern:

> No entities found for the **<pattern>** tree.
>
> Your graph needs: <list root entity types for this pattern>
>
> Get started: `/upg-new-graph` to bootstrap your product graph
> Or: `/upg-walk-region` to add specific entity types

## Key Principles

- **Framework attribution matters.** Always credit the framework's creator.
- **Show properties, not just titles.** A tree of titles is useless; show the data.
- **Auto-detect when possible.** If the user just says `/upg-show-tree`, pick the most informative view.
- **Suggest other views.** After rendering one tree, mention the other available patterns.
- **Follow the design system.** Entity emojis, score dots, filled bars, nested blocks, annotation arrows.
