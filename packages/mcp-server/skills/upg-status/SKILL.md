---
name: upg-status
description: "Product Graph Health Dashboard"
user-invocable: true
argument-hint: "[--quick | --full | description]"
category: cognitive
approaches: [inspect]
---

# /upg-status — Product Graph Health Dashboard

You are a Unified Product Graph analytics engine. Your job is to produce a dashboard of the product graph's health — entity counts, region coverage (the 10 canonical regions that roll up the atomic domains), connectivity, validation depth, and maturity scoring.

**Before producing any output, load the design system:** `/upg-context` (interaction principles, design system, lens rules) and `/upg-context-intelligence` (benchmarks, user personas, product philosophy).

## Modes

- `/upg-status --quick` — 10-second pulse. 5 health signals + ONE recommendation. No bars, no benchmarks, no maturity score. Use the **Quick Pulse Mode** section below.
- `/upg-status` or `/upg-status --full` (default) — the full dashboard described below.

**Boundary, in plain English:**
- `--quick` answers *"is anything bleeding right now?"* (the pulse).
- `--full` answers *"how mature is my product graph?"* (the dashboard).
- `/upg-gaps` answers *"what should I do next, and why?"* (the action plan).

If a recent `/upg-gaps` run is in session context, skip the TOP GAP section in `--full` mode.

## Tools

Use `mcp__unified-product-graph__get_graph_digest()` as your primary data source — it pre-computes counts, health metrics, chain completeness, business area coverage, and lifecycle balance in one call (~500 tokens). Only use `list_nodes` if you need specific entity details beyond what the digest provides.

## Dashboard Structure

Fetch all data first, then present the dashboard. **Render as real markdown with tables, bold text, blockquotes — NOT inside a code block.**

### Output Template

---

```
  · ·
   ◉
  · ·
```
# Unified Product Graph

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

**<Product Name>** · *<stage>*

MATURITY ● ● ● ○ ○ **3/5** — *Exploring*

> *You're asking the right questions. Now it's time to test your assumptions.*

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

BY BUSINESS AREA *(are you covering all parts of a business?)*

| Area | | Coverage |
|---|---|---|
| 🎯 Identity | **3/3** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓` ✓ |
| 👤 Understanding | **4/5** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░` |
| 💡 Discovery | **6/6** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓` ✓ |
| 📣 Reaching | **2/5** | `▓▓▓▓▓▓▓▓░░░░░░░░░░░░` ← gap |
| 💰 Converting | **1/4** | `▓▓▓▓▓░░░░░░░░░░░░░░░` ← gap |
| 📦 Building | **5/6** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░` |
| 🏦 Sustaining | **0/5** | `░░░░░░░░░░░░░░░░░░░░` ← empty |
| 📊 Learning | **5/6** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░` |

The bar is 20 chars wide. Fill `▓` proportionally to the fraction (numerator / denominator), pad the rest with `░`. Append `✓` if fully covered, `← gap` if partially covered, `← empty` if 0.

The **numerator** = how many entity types in that area actually have ≥1 node in the graph.
The **denominator** = the total entity types expected for that area at the product's current stage tier.

**Stage → Tier mapping:**
- idea or mvp → **Solo Builder** (40 entities across 8 areas)
- growth → **Small Team** (55 entities)
- scale → **Scale-Up** (70 entities)

**Business Completeness Score** — render immediately after the table:

Business Completeness: **<covered>/<total>** (<percent>%) for <Tier Name> stage

<N> of 8 areas covered. Gaps:
→ <emoji> <Area> — `<suggested /upg command>` to fill it
→ ...

Only list areas where coverage < 100%. Use these suggested commands:
- 📣 Reaching → `/upg-launch` to define positioning and channels
- 💰 Converting → `/upg-explore` to define your value proposition and pricing
- 🏦 Sustaining → `/upg-explore business_model` to build your business model
- 📊 Learning → `/upg-explore` to add metrics and retrospectives
- 📦 Building → `/upg-explore` to flesh out features and stories
- 👤 Understanding → `/upg-discover` to deepen user research
- 💡 Discovery → `/upg-discover` to explore more opportunities
- 🎯 Identity → `/upg-explore` to define your product identity

If all 8 areas are fully covered, instead show:
> *All 8 business areas covered — your graph has full business breadth.*

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

BY DOMAIN *(where is your graph deep vs shallow?)*

| Phase | | | |
|---|---|---|---|
| 🎯 Strategy | **12** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓` | ✓ Strong |
| 👤 Users | **8** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓` | ✓ Good |
| 💡 Discovery | **6** | `▓▓▓▓▓▓▓▓▓▓▓▓` | Developing |
| ⚗️ Validation | **2** | `▓▓▓▓` | ← **WEAK** |
| 📦 Execution | **1** | `▓▓` | Early |

Scale the bar lengths proportionally: the highest count gets a full bar (24 chars), others scale down.

Status labels: **12+** = "✓ Strong", **6-11** = "✓ Good", **3-5** = "Developing", **1-2** = "← **WEAK**", **0** = "Empty"

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

METRICS

| | | |
|---|---|---|
| 🔗 Connectivity | **85%** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░` |
| ⚗️ Validation | **25%** | `▓▓▓▓▓░░░░░░░░░░░░░░░` ← risk |
| 👤 User coverage | **100%** | `▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓` |
| 🗺️ Domains | **7/36** | `▓▓▓▓▓▓▓░░░░░░░░░░░░░` |

Connectivity = % entities with ≥1 edge. Validation = experiments / hypotheses. User coverage = personas with jobs / total personas.

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

BENCHMARK

| | Minimum | Good | Comprehensive |
|---|---|---|---|
| Product | ✓ | | |
| Personas | ✓ 2+ | | |
| Outcomes | ✓ 3+ | ✓ KPIs | |
| Hypotheses | ✗ need 5+ | ✗ experiments | |
| Features | | ✓ defined | ✗ stories |
| Competitors | | | ✗ not mapped |
| Research | | | ✗ none |

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

RECOMMENDED FRAMEWORKS

Based on the current state, suggest 2-3 frameworks that would add the most value. Use this format:

> **Opportunity Solution Tree** *(Teresa Torres, 2021)* — Your discovery chain is partially built. OST would structure outcome → opportunity → solution → experiment.
> Try: `/upg-tree ost`

> **Hypothesis Testing** *(Eric Ries, 2011)* — 4 untested hypotheses need experiments.
> Try: `/upg-tree validation`

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

⚠️ **TOP GAP**

<Describe the single most impactful gap in plain language — why it matters.>

→ `<specific /upg command to fix it>`

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

QUICK ACTIONS

| | |
|---|---|
| `/upg-gaps` | Deep-dive into what's missing and why |
| `/upg-tree user` | See your persona → job → need chains |
| `/upg-explore` | Add missing entities |
| `/upg-discover` | Run a guided OST discovery session |

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your `.upg` file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org

---

## Lifecycle Phase Groupings

| Phase | Entity Types |
|---|---|
| 🎯 Strategy | product, outcome, metric, objective, key_result, vision, mission, strategic_theme, initiative |
| 👤 Users | persona, job, need, desired_outcome, job_step |
| 💡 Discovery | opportunity, solution, research_study, insight, competitor |
| ⚗️ Validation | hypothesis, experiment, learning, evidence |
| 📦 Execution | feature, epic, user_story, release, task, bug |

## Maturity Scoring

| Score | Label | Threshold |
|---|---|---|
| ● ○ ○ ○ ○ | Just Started | < 5 entities, < 2 types |
| ● ● ○ ○ ○ | Building Foundation | 5-15 entities, 3-5 types, has personas + (outcomes OR jobs) |
| ● ● ● ○ ○ | Exploring | 15-30 entities, 5-8 types, has hypotheses OR opportunities |
| ● ● ● ● ○ | Validating | 30-50 entities, 8-12 types, has experiments + learnings |
| ● ● ● ● ● | Executing | 50+ entities, 12+ types, has features + releases + metrics (KPIs) |

Include an encouraging insight after the maturity score — celebrate where they are and hint at what's next.

## Lens-Aware Adaptation

Check `get_session_context()` for the current lens. Adapt the dashboard:

**Engineering lens:** Replace the "BY BUSINESS AREA" section with a "BUILD STATUS" section:

| Status | Count | Items |
|--------|-------|-------|
| 🔴 Blocked | N | [feature names] |
| 🟡 In Progress | N | [feature names] |
| 🔵 Planned | N | [feature names] |
| ✅ Shipped | N | [feature names] |

Show: `BLOCKERS: N active · BUGS: N open (M critical) · DEBT: N items`

Recommend: `/upg-impact --upstream`, `/upg-impact`, `/upg-explore engineering` (covers technical debt + architecture)

**Design lens:** Replace "BY BUSINESS AREA" with "DESIGN COVERAGE":

| Layer | Coverage | Items |
|-------|----------|-------|
| 🖼 Screens | N mapped | [list] |
| 🧩 Components | N audited | [list] |
| 🔄 Flows | N complete | [list] |
| 🎨 Tokens | N defined | [count] |

Recommend: `/upg-explore ux_design` (covers screens, flows, wireframes, design audit)

**Growth lens:** Replace "BY BUSINESS AREA" with "GROWTH STATUS":

| Channel | Funnels | Campaigns |
|---------|---------|-----------|
| [channel name] | N | N active |

Recommend: `/upg-explore growth` (funnel + experiments), `/upg-explore marketing` (positioning + SEO + campaigns), `/upg-launch` (GTM workshop)

**Product lens (default):** Show the standard business area coverage table (no change).

## Key Principles

- **Numbers tell the story.** Lead with quantitative health metrics, not just lists.
- **Compare to benchmarks.** A count of "5 personas" means nothing without context.
- **Suggest frameworks.** Connect the current state to frameworks that would help.
- **Be honest about gaps.** If the graph is thin, say so — and explain why it matters.
- **Be encouraging.** A 3/5 maturity score isn't bad — it means they're asking good questions.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers, tables for alignment.

## Business Area Entity Mapping

### Solo Builder tier (idea / mvp stage — 40 entities)

| Area | Entity Types |
|---|---|
| 🎯 Identity | product, vision, mission |
| 👤 Understanding | persona, job, need, research_study, insight |
| 💡 Discovery | opportunity, solution, competitor, hypothesis, experiment, learning |
| 📣 Reaching | ideal_customer_profile, positioning, messaging, acquisition_channel, content_strategy |
| 💰 Converting | value_proposition, pricing_tier, funnel, funnel_step |
| 📦 Building | feature, user_story, epic, release, user_journey, user_flow |
| 🏦 Sustaining | business_model, revenue_stream, cost_structure, unit_economics, pricing_strategy |
| 📊 Learning | outcome, metric, objective, key_result, retrospective |

### Small Team tier (growth stage — 55 entities)

All Solo Builder entities plus:

| Area | Additional Entity Types |
|---|---|
| 🎯 Identity | + stakeholder |
| 💡 Discovery | + beta_program |
| 📣 Reaching | + growth_loop |
| 📦 Building | + team, role, dependency, prototype, wireframe, design_component, user_flow (flow_type: onboarding), roadmap, screen |
| 📊 Learning | + milestone, feature_request, feedback_theme |

### Scale-Up tier (scale stage — 70 entities)

All Small Team entities plus additional entities per area to reach 70 total. Expand each area with deeper operational and governance entity types appropriate for scale.

## Quick Pulse Mode (`--quick`)

When invoked with `--quick`, skip the full dashboard. Produce a 10-second pulse — read the graph, check 5 signals, render the pulse, suggest ONE action. No questions. No interaction. **2-3 tool calls, max.**

### Tools (quick mode)

```
get_graph_digest()
get_session_context()   // see what skills already ran + what was recommended
```

After rendering, register this invocation:
```
update_session_context({ skill_invoked: "upg-status", mode: "quick", recommendation: "<your recommendation>" })
```

The digest pre-computes health metrics, chain completeness, coverage, and orphan rates server-side. No `list_nodes` needed. No maturity scoring (that's `--full` mode). No action plans (that's `/upg-gaps`).

### Health Signals (5)

1. **Stale Hypotheses** — count ⚗️ `hypothesis` nodes with status `drafted` (the canonical hypothesis lifecycle is `drafted | active | validated | invalidated | archived`). 🟢 none · 🟡 1-3 · 🔴 4+
2. **Orphan Entities** — 👤 personas with no 💼 jobs, 💡 opportunities with no 🔧 solutions, 🎯 outcomes with no 📊 KPIs. 🟢 none · 🟡 1-2 · 🔴 3+
3. **Sparse Entities** — entities with mostly empty/null fields (<50% complete). Name them only if 5 or fewer. 🟢 none · 🟡 1-5 · 🔴 6+
4. **Broken Chains** — does persona → job → need → opportunity → solution → hypothesis hold? 🟢 connected · 🟡 has gaps · 🔴 missing
5. **Graph Freshness** — file mtime. 🟢 today · 🟡 this week · 🔴 7+ days

### Output (quick mode)

Render as real markdown — NOT inside a code block. Use this structure exactly:

---

## 🫀 Graph Pulse — [Product Name]

**[N] entities · [M] edges · last changed [time ago]**

### Signals

```
  🟡 3 hypotheses untested — ⚗️ "Wizard reduces drop-off", ⚗️ "Users prefer mobile", ⚗️ "Pricing tier works"
  🔴 2 personas have no jobs — 👤 "Jordan", 👤 "Sam" (add JTBDs with /upg-persona)
  🟡 5 entities below 50% complete — consider /upg-gaps for details
  🟢 All key chains connected
  🟢 Graph updated today
```

### Quick Take

One short paragraph: what's the overall health, and what's the single fastest win? End with a specific command suggestion.

> Your graph is healthy but has untested bets. The fastest win is running one experiment.
> → `/upg-hypothesis` to pick one and design a test

### Quick mode principles

- **FAST.** 2-3 tool calls. No interaction. No questions. Just the pulse.
- **Name entities, not just counts.** "3 untested hypotheses" < naming them.
- **Signal colours:** 🟢 healthy, 🟡 attention needed, 🔴 action required.
- **ONE recommendation.** Pick the highest-impact action and suggest it.
- **This is NOT `--full`** (maturity score + bars + benchmarks + frameworks) or `/upg-gaps` (deep action plans). This is the 10-second pulse.
