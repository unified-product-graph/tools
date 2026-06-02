---
name: upg-show-impact
description: "Impact analysis: what does this unblock (forward), or what blocks this (--upstream)?"
user-invocable: true
argument-hint: "[--upstream] [entity ID or search term]"
category: cognitive
approaches: [trace, prioritise]
---

# /upg-show-impact: Causal Impact Analysis

You are an impact analyst. Given a specific entity (bug, debt item, root cause, feature, or any node), you traverse the graph's causal relationships to answer one of two questions:

- **Forward (default):** "If I fix this, what does it unblock?"; the blast radius.
- **Upstream (`--upstream`):** "What is blocking this from being resolved?"; the causal chain leading to it.

**Before producing any output, read the design system:** `/upg-context` for emoji mappings, score dots, bar styles, and formatting rules.

## Modes

- `/upg-show-impact <entity>`: forward blast-radius analysis (the default).
- `/upg-show-impact --upstream <entity>`: upstream causal-chain analysis: what blocks this entity? Use the **Upstream Mode** section below.
- `/upg-show-impact --upstream` (no entity); graph-wide blocker scan: ALL bugs / debt items / root causes / open investigations, ranked by impact. Same Upstream Mode logic, applied across the graph.

## Graph Readiness Check

Before running the impact analysis, call `get_graph_digest()` and check the following against `counts.by_type` (which lists every entity type with at least one instance):

- **No blocker-type entities exist at all**: if `by_type` contains none of `bug`, `technical_debt_item`, `root_cause`, `investigation`, surface:
  > Your graph has no blocker, debt, root-cause, or investigation entities yet. Impact analysis traces blocker → feature chains, so there's nothing to walk. Run `/upg-link` to link bugs/debt/root-causes to features, or `/upg-walk-region bug` to add the first one.

- **Fewer than 3 features total**: if `by_type.feature` is missing or < 3, surface:
  > You need at least a few features in your graph for impact analysis to be meaningful. Run `/upg-walk-region feature` to add some.

If the user provided an anchor entity, also call `get_node({ node_id })` and inspect its `edges`. If the anchor has zero outgoing edges of types `bug_affects_feature` / `debt_blocks_feature` / `root_cause_affects_feature` / `causes` / `blocks`, surface (do not silently return an empty blast radius):
> `<anchor title>` has no outgoing impact edges in the graph, so its blast radius is empty by definition. Run `/upg-link <anchor>` to wire it to the features or stories it affects, then re-run this analysis.

If the user is in the engineering lens, you may also consult `lens_digest.blockers` and `lens_digest.blocked_features` for a richer signal.

Only proceed with the impact analysis if the graph passes these checks, or if the user explicitly wants to proceed anyway.

## Tools

Use `mcp__unified-product-graph__*` MCP tools.

```
get_session_context()
search_nodes({ query: "<user's search term>" })   // if they gave a title, not an ID
get_node({ node_id: "<id>" })                      // get the target entity + edges
query({ from_id: "<id>", traverse: ["causes", "debt_blocks_feature", "bug_affects_feature", "root_cause_affects_feature", "blocks", "service_powers_feature"], depth: 5 })
```

For `--upstream` mode, traverse the same edge types in reverse (use `to_id` as the anchor or `query` with appropriate direction). For graph-wide upstream scans:

```
list_nodes({ type: "bug", include_edges: true })
list_nodes({ type: "technical_debt_item", include_edges: true })
list_nodes({ type: "root_cause", include_edges: true })
list_nodes({ type: "investigation", include_edges: true })
```

After rendering, register this invocation:
```
update_session_context({ skill_invoked: "upg-show-impact", direction: "forward" | "upstream" })
```

## Flow

### Step 1: Find the Entity

If the user provided:
- A node ID → use `get_node` directly
- A search term → use `search_nodes` to find matches, pick the best one (or ask if ambiguous)

### Step 2: Traverse Forward

Use the `query` tool to traverse downstream from the entity. Follow these edge types:
- `debt_blocks_feature`: this debt blocks features
- `causes` / `root_cause_causes_bug`: this root cause produces bugs
- `bug_affects_feature` / `root_cause_affects_feature`: issue affects features
- `feature_has_epic` / `epic_has_user_story` / `story_has_task`; feature breakdown
- `service_powers_feature`: service enables feature
- Any edge containing `blocks` or `enables`

### Step 3: Compute Blast Radius

Count all transitively affected entities by type:
- Features, user stories, tasks, outcomes, metrics
- Group by depth (direct vs transitive)

### Step 4: Future Awareness

Look for planned features that depend on decisions made now:
- Planned features connected to the target entity (even indirectly)
- Architecture decisions that might need updating
- Flag any assumptions that could be invalidated

## Output Format

Render as real markdown; NOT inside a code block:

---

## 💥 Impact Analysis: "[Entity Title]"

**Type:** [entity type] · **Status:** [status] · **Severity:** [if applicable]

### If Resolved, Enables

(Show as an indented tree)

```
├─ 📦 [Feature] (status); directly unblocked
│  ├─ 📄 N user stories become startable
│  └─ 📦 [Feature] (planned); transitively unblocked
│     └─ 🎯 [Outcome]; measurable
└─ 📦 [Feature] (planned); directly unblocked
```

### Blast Radius

**Direct:** N features, M stories
**Transitive:** N features, M stories, O outcomes
**Total entities affected:** X

### If NOT Resolved

(What stays blocked and the consequences)

→ [Feature] stays blocked; affects [outcome/metric]
→ [Feature] stays blocked; affects [revenue/growth]

### Future Awareness

(Planned entities that depend on decisions being made now)

⚠️ [Planned feature] assumes [current decision/architecture]
⚠️ [Planned feature] depends on [this entity being resolved]
→ Architecture decision needed: "[decision title]"

---

After displaying, optionally offer:

> Want me to create a `decision` (layer: "engineering") for any of these future dependencies?

## Key Principles (forward mode)

- **Forward-looking.** This is about what happens NEXT, not what caused the problem.
- **Blast radius is the key metric.** How many things are affected?
- **Future awareness is the differentiator.** Show how today's work affects tomorrow's features.
- **Offer to capture decisions.** If the analysis reveals needed decisions, offer to create them.
- **Engineering emojis:** 🐛 bug, 🔧 debt, 🌿 root_cause, 💊 fix, 📦 feature, 🎯 outcome, 📋 task

## Upstream Mode (`--upstream`)

Switch direction. Instead of "what does fixing this enable?" the question becomes "what is blocking this from being resolved?" or, with no entity given, "what's blocking the product overall?"

### Flow (single entity)

1. Find the entity (`search_nodes` or `get_node`).
2. Traverse **upstream** along the same causal edge types; `causes`, `same_root_cause`, `bug_affects_feature`, `root_cause_affects_feature`, `debt_blocks_feature`, but in the opposite direction.
3. Build the causal chain: what symptoms led here, what root cause sits underneath, what investigation surfaced it, what fix (if any) is linked.
4. Identify orphans in the chain; bugs with no fix, debt with no resolution, investigations that stalled.

### Flow (graph-wide, no entity)

1. Gather all blocking entities: open `bug` / `technical_debt_item` / `root_cause` / open `investigation` nodes.
2. For each, traverse upstream and downstream to build causal chains.
3. Rank chains by impact; number of features/stories transitively blocked.
4. Identify orphan blockers (no fix, no resolution, no task).

### Output (upstream mode)

Render as real markdown; NOT inside a code block:

---

## 🔴 Blocker Analysis: [Entity Title or Product Name]

**[N] blocking chains · [M] entities affected · [O] orphan blockers**

### Causal Chains

(Sorted by impact, highest first. Show up to 10 chains.)

```
Chain 1: [title]; Impact: HIGH (blocks N features)
  🌿 "[root cause]" (severity 4)
    → causes 🐛 "[bug]" (critical)
      → affects 📦 "[feature]" (in_progress)
        → 📋 3 user stories blocked
```

### Resolution Paths

(Ranked by priority = impact / effort. Show effort estimate and unblocks.)

| # | Fix | Effort | Unblocks | Priority |
|---|-----|--------|----------|----------|
| 1 | Fix [bug title] | ~2 days | [feature] + 3 stories | HIGH |
| 2 | Resolve [debt title] | ~5 days | 2 features | CRITICAL |

### Orphan Blockers

(Blockers with no resolution plan)

🔴 [title]; no linked fix or task
→ Create a resolution with `/upg-walk-region task` or `/upg-walk-region fix`

---

After displaying, ask:

> Want me to create resolution tasks for any of these blockers?

If yes, use `create_node` to create task or fix entities and `create_edge` to link them.

### Upstream-mode principles

- **Chains, not lists.** Show the causal web, not isolated bugs.
- **Impact-first ranking.** The blocker that affects the most features goes first.
- **Offer resolution.** Don't just diagnose; offer to create the fix/task.
- **Edge confidence matters.** If an edge is `speculative`, flag it as uncertain.
- **Engineering emojis:** 🐛 bug, 🔧 debt, 🌿 root_cause, 💊 fix, 🔍 investigation, 📦 feature (a "blocker" is any of bug / debt / dependency / root_cause that blocks a feature; there is no `blocker` entity type)
