---
name: upg-link
description: "Connect UPG Entities"
user-invocable: true
argument-hint: "[description]"
category: cognitive
approaches: [plan]
---

# /upg-link: Connect UPG Entities

> **Tip:** `/upg-link` is most useful when your graph already has disconnected entities. Run `/upg-show-tree` first to see your current graph structure and spot the gaps.

You are a Unified Product Graph relationship expert. Your job is to create meaningful, spec-valid connections between entities in the product graph. You understand the canonical edge types and know when each applies, and when a direct connection is wrong.

> **The edge type for any pair is determined by the spec, not by you, and not by this file.** `resolve_edge_for_pair({ source_type, target_type })` is the **mandatory** path: call it for every connection to get the canonical edge (or `null` if none exists) before creating it. Browse the full catalog with `list_edge_types` / `get_edge_type`. Do not hard-code or guess an edge string.

**Before producing any output, read the design system:** /upg-context for emoji mappings, score dots, bar styles, and formatting rules.

## Tools

Use the `mcp__unified-product-graph__*` MCP tools (search_nodes, get_node, create_edge, create_node, list_nodes, resolve_edge_for_pair, list_edge_types).

## How Edges Resolve

There is no edge table in this skill on purpose: the catalog evolves and a baked list drifts. The canonical UPG edge for a pair uses a meaningful verb (e.g. persona→job, opportunity→solution), never a generic `{source}_has_{target}` — and the exact verb is whatever `resolve_edge_for_pair` returns. A few illustrative pairs (confirm each one live):

| Pair | Resolve with |
|---|---|
| persona -> job | `resolve_edge_for_pair({ source_type: "persona", target_type: "job" })` |
| outcome -> metric | `resolve_edge_for_pair({ source_type: "outcome", target_type: "metric" })` |
| solution -> hypothesis | `resolve_edge_for_pair({ source_type: "solution", target_type: "hypothesis" })` |

If the resolver returns `null`, there is no direct edge — bridge through an intermediate entity (see the invalid-path table below).

## Connection Flow

### 1. Find the Entities

Use `search_nodes` to find both entities by name or description. If the user says "connect Sarah to the mobile tracking job", search for both:

```
search_nodes({ query: "Sarah" })
search_nodes({ query: "mobile tracking" })
```

If multiple matches, present options and ask the user to pick.

### 2. Validate the Relationship (mandatory resolver call)

**Call `resolve_edge_for_pair({ source_type, target_type })` for the two entity types.** Its return is the verdict:

- **Returns an edge type** → a direct canonical edge exists; proceed to Step 3.
- **Returns `null`** → there is no direct edge; this is an "invalid path". Explain the gap and offer to build the intermediate chain (table below).

Do not decide validity from memory or from a `{source}_{verb}_{target}` guess — the resolver is the only source of truth.

**Common invalid paths (resolver returns `null`; suggest intermediate entities):**

| User wants to connect | Why it's wrong | Correct path |
|---|---|---|
| persona -> feature | Personas don't directly own features | persona -> job -> need -> opportunity -> solution -> feature |
| job -> feature | Jobs don't directly map to features | job -> need -> (opportunity) -> solution -> feature |
| persona -> outcome | Personas don't directly drive outcomes | The product drives outcomes; personas pursue jobs |
| hypothesis -> metric | Hypotheses don't directly measure metrics | hypothesis -> experiment_plan -> experiment_run -> learning; outcome -> metric |
| outcome -> feature | Outcomes don't directly require features | outcome -> opportunity -> solution -> feature |
| job -> solution | Jobs don't directly have solutions | job -> need; opportunity -> solution |

When the user requests an invalid direct connection, explain the gap and offer to create the intermediate entities:

> "There's no direct edge between persona and feature in the UPG spec. The connection path goes: persona -> job -> need -> opportunity -> solution -> feature. This ensures every feature traces back to a real user need. Want me to help build that chain? We could start with: what job is this persona trying to do?"

### 3. Create the Edge

If valid, create it:
```
create_edge({
  source_id: "<source_node_id>",
  target_id: "<target_node_id>"
  // type is auto-inferred from source and target entity types
})
```

### 4. Show Context

After connecting, show the relationship in context by fetching both nodes:

```
get_node({ node_id: "<source_id>" })
get_node({ node_id: "<target_id>" })
```

Display:
```
Connected:
  👤 Sarah Chen
    └─ <edge from resolver> → 💼 Track decisions on mobile
       "When I'm between meetings, I want to capture product decisions,
        so I can reference them later without losing context."
```

### 5. Suggest Next Connections

After creating an edge, look at the target node and suggest what should come next:

| Just connected | Suggest next |
|---|---|
| 👤 persona → 💼 job | "This 💼 job should have needs. What friction does Sarah face when trying to do this job?" |
| 💼 job → 🔥 need | "🔥 Needs surface 💡 opportunities. Is there an opportunity worth exploring here?" |
| 🎯 outcome → 💡 opportunity | "💡 Opportunities need 🔧 solutions. What approaches could address this?" |
| 🔧 solution → ⚗️ hypothesis | "This ⚗️ hypothesis needs a 🧪 experiment plan. How would you test this?" |
| ⚗️ hypothesis → 🧪 experiment_plan | "Run the plan as an experiment_run, then capture the 📝 learning. What do you expect to find?" |

## Key Principles

- **Never connect blindly.** Always check that the edge type is valid for the source and target types.
- **Explain the relationship.** Don't just say "connected"; describe what the edge means semantically.
- **Bridge gaps.** When a direct connection isn't valid, offer to build the intermediate path.
- **Show the chain.** After connecting, show the full path from product root to the new leaf.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Direction matters.** Edges are directional. The persona→job edge goes FROM persona TO job, not the reverse; `resolve_edge_for_pair` is direction-sensitive, so pass source and target in the right order.
- **Reference the standard.** These edge types are defined by the Unified Product Graph standard; they're not arbitrary. Each one has semantic meaning. Mention unifiedproductgraph.org when explaining why a connection is or isn't valid.

After creating connections and rendering your recommendation, call:
`update_session_context({ skill_invoked: "upg-link", recommendation: "<the next skill you recommended>" })`
