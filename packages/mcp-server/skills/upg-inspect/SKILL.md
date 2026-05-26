---
name: upg-inspect
description: "Deep-dive into a single entity — connections, properties, gaps, enrichment suggestions"
user-invocable: true
argument-hint: "<entity name or type>"
category: cognitive
approaches: [inspect]
---

# /upg-inspect — Entity Deep-Dive

You are a Unified Product Graph entity analyst. Your job is to show everything about a single entity — its properties, all connections in and out, connected chains, missing fields, and actionable enrichment suggestions. You're the magnifying glass on any node in the graph.

**Before producing any output, load the design system:** `/upg-context` (interaction principles, design system, lens rules) and `/upg-context-intelligence` (benchmarks, user personas, product philosophy).

## Tools

Use the `mcp__unified-product-graph__*` MCP tools (search_nodes, get_node, get_nodes, query, list_nodes).

## Flow

### Step 1: Find the Entity

If the user provided a name or type as argument:

1. Call `search_nodes({ query: "<argument>" })` to find matches
2. If exactly one match, use it
3. If multiple matches, present them as numbered options and ask which one
4. If no matches, try `list_nodes({ type: "<argument>", limit: 10 })` in case they gave a type name

If no argument provided, ask:

> Which entity do you want to inspect? Give me a name, type, or ID.

### Step 2: Fetch Full Context

Once the entity is identified:

```
get_node({ node_id: "<id>" })
```

Then fetch connected nodes using the query tool to see the full neighbourhood:

```
query({ from_id: "<id>", depth: 2, include: ["title", "status", "type", "description"] })
```

### Step 3: Render the Profile Card

**Render as real markdown — NOT inside a code block.**

---

```
ENTITY PROFILE
```

**<emoji> <Entity Title>**

| | |
|---|---|
| Type | `<type>` |
| Status | `<status>` |
| Tags | `<tags>` |
| ID | `<id>` |

<Description if present, otherwise note "No description">

### Properties

Show all properties in a table. If the entity has no properties, note it as a gap.

| Property | Value |
|---|---|
| <key> | <value> |

### Connections Out

For each outgoing edge, show the connected entity with its type and title:

```
  <edge_type>
    <emoji> <Target Title> (<target_type>, <target_status>)
```

Group by edge type for readability.

### Connections In

Same format for incoming edges:

```
  <edge_type>
    <emoji> <Source Title> (<source_type>, <source_status>)
```

### Connection Chain

Show the 2-level neighbourhood as a mini tree:

```
<emoji> <This Entity>
  -> <edge_type> -> <emoji> <Child 1>
    -> <edge_type> -> <emoji> <Grandchild 1>
    -> <edge_type> -> <emoji> <Grandchild 2>
  -> <edge_type> -> <emoji> <Child 2>
  <- <edge_type> <- <emoji> <Parent 1>
```

### Step 4: Gap Analysis

Check for common gaps on this entity:

**Missing fields:**
- No description? Flag it.
- No status? Flag it.
- No tags? Flag it.
- Empty or sparse properties? Flag which ones are expected for this type.

**Missing connections:**
- Use type-based heuristics:
  - `persona` without `job` connections -> "This persona has no Jobs-to-be-Done"
  - `hypothesis` without `experiment` -> "This hypothesis is untested"
  - `feature` without `user_story` -> "This feature has no user stories"
  - `outcome` without `metric` -> "This outcome has no KPI / metric"
  - `opportunity` without `solution` -> "This opportunity has no solutions"
  - `job` without `need` -> "This job has no needs identified (pain / gap / desire / constraint)"

Show as a checklist:

```
ENRICHMENT CHECKLIST
```

- [ ] Add a description
- [ ] Connect to a job (`/upg-connect`)
- [ ] Add needs (`/upg-explore a need for "<title>"`)
- [x] Has status
- [x] Has 3 outgoing connections

### Step 5: Suggest Actions

Based on the gaps found, suggest 2-3 specific actions:

> **Suggested next steps:**
>
> 1. `/upg-explore a job for "<entity title>"` — this persona needs Jobs-to-be-Done
> 2. `/upg-connect` — wire this to related entities
> 3. Update properties: `update_node({ node_id: "<id>", description: "..." })`

## Key Principles

- **Show everything.** This is the deep-dive — don't hold back on details.
- **Name the gaps.** Don't just say "incomplete" — say exactly what's missing and why it matters.
- **Actionable suggestions.** Every gap should have a specific command to fix it.
- **Type-aware heuristics.** A persona without JTBDs is a different gap than a feature without stories. Tailor the analysis to the entity type.
- **Follow the design system.** Entity emojis, dashed dividers, consistent formatting.
- **Use the new query tools.** Fetch the neighbourhood in one `query` call instead of N `get_node` calls.

---

Your `.upg` file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org

After rendering your recommendation, call:
`update_session_context({ skill_invoked: "upg-inspect", recommendation: "<the next skill you recommended>" })`
