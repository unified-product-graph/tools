---
name: upg-design-system
description: "UPG Visual Design System: shared reference for all /upg-* skills"
user-invocable: false
category: meta
---

# UPG Visual Design System

This is the shared design reference for all `/upg-*` skills. Every skill that produces visual output MUST follow these guidelines for consistency.

## Brand

- **Name:** Always write "Unified Product Graph" in full; never just "UPG" in user-facing text
- **Logo mark:** Use on key screens (`/upg`, `/upg-show-status`, `/upg-sync-export`)
- **Standard URL:** unifiedproductgraph.org

### Logo Mark

The dot cluster logo in a code block, followed by a bold H1 for the name:

```
  · ·
   ◉
  · ·
```
# Unified Product Graph

The logo is the dot cluster (renders in monospace). The name is a markdown H1 (renders large and bold). Use at the top of `/upg`, `/upg-show-status`, and `/upg-sync-export`. Other skills don't need the logo; keep it special.

## Section Dividers

Use dashed lines between major sections:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

These go between logical sections (header, lifecycle, metrics, actions, footer). Not between every paragraph.

## Entity Type Emojis

Always prefix entity names with their type emoji.

*This table is the canonical display reference for the types listed. It is also mirrored by the live `get_type_label({ entity_type }).emoji` field — use the live field for any type not in this table, or when you need to verify a specific emoji against the current spec.*

| Type | Emoji | Domain |
|---|---|---|
| product | 🎯 | Strategic |
| outcome | 🎯 | Strategic |
| objective | 🎯 | Strategic |
| key_result | 🎯 | Strategic |
| metric | 📊 | Strategic |
| persona | 👤 | User |
| job | 💼 | User |
| need | 🔥 | User |
| opportunity | 💡 | Discovery |
| solution | 🔧 | Discovery |
| competitor | ⚔️ | Discovery |
| hypothesis | ⚗️ | Validation |
| experiment | 🧪 | Validation |
| learning | 📝 | Validation |
| feature | 📦 | Execution |
| epic | 📋 | Execution |
| user_story | 📄 | Execution |
| release | 🚀 | Execution |
| research_study | 🔬 | Research |
| insight | 💎 | Research |

## Score Dots (1-5 Scales)

Use spaced filled/empty circles for any 1-5 rating:

```
● ● ● ● ●   5/5
● ● ● ● ○   4/5
● ● ● ○ ○   3/5
● ● ○ ○ ○   2/5
● ○ ○ ○ ○   1/5
○ ○ ○ ○ ○   0/5
```

Use for: reach, pain, frequency, severity, importance, satisfaction, confidence, effort, impact, tech comfort.

Display dimensions on a single line with labels:

```
reach ● ● ● ● ●   pain ● ● ● ● ○   freq ● ● ● ○ ○
```

For RICE breakdowns, use single-letter abbreviations:

```
R ● ● ● ● ●   I ● ● ● ● ●   C ● ● ● ○ ○   E ● ● ● ○ ○
```

## Filled Bars (Larger Scales)

Use `▓` (filled) and `░` (empty) for RICE totals, percentages, and health metrics:

```
RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 30
RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ 20
RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░ 15
```

Scale bars to max 30 characters. The highest value gets a full bar; others are proportional.

For percentages:

```
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░   85%
▓▓▓▓▓░░░░░░░░░░░░░░░   25%
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  100%
```

## Status Dots

Use colored emoji dots for entity state. One dot, inline or right-aligned:

| Status | Dot |
|---|---|
| shipped / validated / achieved | 🟢 |
| in_progress / active / testing | 🟡 |
| planned / proposed / drafted | 🔵 |
| untested / backlog | ⚪ |
| blocked / invalidated | 🔴 |
| deferred / deprecated / archived | ⚫ |

Display: `🟡 active` or right-aligned at end of a tree line.

> Hypothesis phases are `drafted` → `active` → `validated` / `invalidated` / `archived`. Derive valid phases live via `list_status_values({ entity_type })` or `get_lifecycle({ entity_type })`; never hard-code phase names.

## Nested Detail Blocks

Inside trees, use solid-border boxes for detail cards:

```
├─ 🔧 Personalized action checklist              🟡 proposed
│  ┌──────────────────────────────────────────┐
│  │  R ● ● ● ● ●   I ● ● ● ● ●            │
│  │  C ● ● ● ○ ○   E ● ● ● ○ ○            │
│  │  RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 30 │
│  └──────────────────────────────────────────┘
```

Use `┌─┐│└─┘` (solid lines). Boxes always close. Keep content inside aligned.

## Tables

Use markdown tables for structured comparisons (metrics, benchmarks, RICE breakdowns, entity lists). Tables auto-align and handle emoji width well.

| Solution | Reach | Impact | Confidence | Effort | RICE |
|---|---|---|---|---|---|
| **Personalized checklist** | ● ● ● ● ● | ● ● ● ● ● | ● ● ● ○ ○ | ● ● ● ○ ○ | **30** |
| Interactive tour | ● ● ● ● ○ | ● ● ● ● ○ | ● ● ● ○ ○ | ● ● ● ● ○ | **20** |

## Text Formatting

- **Bold** for key values: names, scores, percentages, important labels
- *Italic* for quotes, attributions, framework names, insights
- `code` for file names, commands, specific values like `47%`
- > Blockquotes for human insights, motivations, callouts, and coaching

## Annotation Arrows

Use `←` for inline callouts:

```
RICE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 30   ← highest
Validation  25%  ▓▓▓▓▓░░░░░░░░░░░░░░░      ← risk
```

## Benchmark Checks

Use `✓` and `✗` for checklists and benchmarks:

```
✓ product   ✓ personas   ✓ outcomes   ✗ 5+ hypotheses
```

## Tree Connectors

Standard tree hierarchy characters:

```
├─   branch with siblings below
└─   last branch
│    vertical continuation
```

## Smart Ending Pattern (CRITICAL)

**Every cognitive skill that creates entities MUST end with a smart recommendation, not a menu.**

After creating entities, the skill should:

1. Call `get_graph_digest()` to check the current state
2. Determine which of the 8 business areas has the biggest gap
3. Recommend ONE specific next skill based on that gap
4. Always offer `/upg-show-journey` as the "see full picture" fallback

**Good ending (smart, contextual):**
```
✓ Added business model to your graph.

Your graph now covers 6 of 8 business areas.
The biggest gap: 📣 Reaching; you haven't thought about how people find your product.

→ Run /upg-new-launch to define your positioning and channels.

Or /upg-show-journey to see your full progress across all 7 phases.
```

**Bad ending (menu dump; DON'T DO THIS):**
```
Next steps:
- /upg-new-persona: Add more personas
- /upg-new-discovery: Run a discovery session
- /upg-new-hypothesis: Structure a bet
- /upg-check-gaps: Check for gaps
- /upg-show-status: Health dashboard
```

The business areas to check (in priority order):
1. 🎯 **Identity**: product, vision, mission
2. 👤 **Understanding**: persona, job, need, research_study, insight
3. 💡 **Discovery**: opportunity, solution, competitor, hypothesis, experiment, learning
4. 📣 **Reaching**: ideal_customer_profile, positioning, messaging, acquisition_channel, content_strategy
5. 💰 **Converting**: value_proposition, pricing_tier, funnel, funnel_step
6. 📦 **Building**: feature, user_story, epic, release, user_journey, user_flow
7. 🏦 **Sustaining**: business_model, revenue_stream, cost_structure, unit_economics, pricing_strategy
8. 📊 **Learning**: outcome, metric, objective, key_result, retrospective

Map each empty/thin area to a skill:
- Identity → `/upg-new-strategy`
- Understanding → `/upg-new-persona`
- Discovery → `/upg-new-discovery`
- Reaching → `/upg-new-launch` or `/upg-walk-region marketing`
- Converting → `/upg-walk-region business_model`
- Building → `/upg-walk-region product_spec`
- Sustaining → `/upg-walk-region business_model`
- Learning → `/upg-new-okr` or `/upg-walk-region team_org`

If ALL areas are covered, celebrate and point to `/upg-show-journey`.

## Footer Pattern

After the smart ending, add the standard footer with a dashed divider:


On `/upg-show-status` and `/upg-check-gaps` (where maturity is 3+), the footer can be slightly more direct:

```
can show patterns the CLI can't. → /upg-sync-push to sync
```

## Tone

- Warm, encouraging, exciting: never dry or clinical
- Product coach voice: direct, specific, actionable
- "You're asking the right questions" not "Your graph is incomplete"
- Celebrate progress, highlight gaps as opportunities
- The CLI should feel like a delightful tool, not a spreadsheet
