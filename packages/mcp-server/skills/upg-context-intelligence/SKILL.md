---
name: upg-context-intelligence
description: "Deep analytical context for UPG cognitive skills: benchmarks, personas, philosophy, sync. Load alongside /upg-context."
user-invocable: false
category: meta
---

# UPG Context: Intelligence Extension

This file extends `/upg-context` with deep analytical context. Load it **in addition to** `/upg-context`, not instead of it.

**Load when:** your skill does analysis, coaching, benchmarking, guided discovery, or introduces UPG to new users.
**Skip when:** your skill is tooling-only (push, pull, snapshot, diff, tree, connect, impact).

---

## Why Does This Exist?

Product thinking is scattered. A persona lives in one doc. The business model is in a spreadsheet. User research is in Dovetail. Tickets are in Linear. Strategy is in a slide deck. None of these things know about each other.

The Unified Product Graph connects them. A persona pursues jobs. Jobs surface needs. Needs surface opportunities. Opportunities have solutions. Solutions have hypotheses. Hypotheses have experiments. Experiments produce learnings. Everything traces back to users and outcomes.

When thinking is connected, decisions get better. When decisions are structured, products get better.

---

## Who Is This For?

### Primary: Solo Builders in Claude Code

**Kai: The Technical Solo Founder.** Senior engineer building their first product. Deep code skills, shallow strategic vocabulary. Wants to validate ideas fast and make confident decisions without slowing down the build. Lives in VS Code and the terminal.

**Jordan: The Vibe Coder.** Builds with AI tools and no-code platforms. Has a real idea and genuine motivation but no framework vocabulary. Needs to feel capable, not talked down to. Uses Claude and Cursor daily.

These people are already in the terminal. They don't need another app; they need their thinking structured where they already work.

### Secondary: Designers and Multi-Hatters

**Leah: The Designer Exploring Product.** Knows users better than anyone but can't translate that into strategic arguments. Wants to own outcomes, not outputs.

**Sam: The Overwhelmed Multi-Hatter.** Juggling multiple products. Knows what good looks like but has no time or structure. Needs a command center.

**Noor Hassan: Recent CS Grad Building Solo**
- Building a first real product; background in engineering, new to product thinking
- Needs: a structured way to think about users before jumping to code; validation before build
- Fears: building the wrong thing, shipping features nobody asked for
- UPG entry point: `/upg-new-graph` → `/upg-new-research` → `/upg-new-hypothesis`
- Language: responds to frameworks and structure; likes "the canonical way to do X"

These users often discover UPG through visual tools rather than the CLI.

---

## Core Beliefs

These aren't rules. They're beliefs that shape every decision in the UPG experience.

### 1. Structured thinking beats scattered notes

A persona in a graph is worth more than a persona in a Google Doc. Not because the content is different, but because the graph knows that persona connects to jobs-to-be-done, which connect to pain points, which connect to opportunities. A doc doesn't know that.

### 2. Every product is a business (or should be)

A product must answer 8 questions to be real:
- **Identity**: What is this? Where is it going?
- **Understanding**: Who needs this? What's their world?
- **Discovery**: What should we build? What's worth solving?
- **Reaching**: How do people find out about this?
- **Converting**: How does money come in?
- **Building**: What does the user actually get?
- **Sustaining**: Is this financially viable?
- **Learning**: Is it working? How do we improve?

If any of these are empty, there's a blind spot. The graph makes blind spots visible.

### 3. Don't guess. Test.

Every assumption is a hypothesis. Every hypothesis needs an experiment. Every experiment produces a learning. This isn't academic; it's the difference between building something people want and building something you think they want.

### 4. The graph compounds over time.

Every entity you add makes the next decision easier. A persona without connections is a note. A persona connected to jobs, needs, and outcomes is a lens. The graph gets more valuable the more it reflects how your product actually thinks.

### 5. Collaborate, don't interrogate

Every question should feel like brainstorming with a partner, not filling out a form. Offer options. Suggest. React. Build on what the user says. One question at a time; never dump a wall of prompts.

### 6. Start simple, scale when ready

The graph grows with the product. A solo builder at the `concept` stage uses a small fraction of the entity catalogue; most types surface only when the product is mature enough to need them. Don't overwhelm an early-stage builder with concepts that belong at scale.

---

## Skill Patterns

Every UPG skill follows one of three patterns:

### Pattern 1: Discovery (guided conversation)
Ask → discuss → create entities → connect. The user provides the thinking, you structure it. One question at a time, numbered options, vibe check before creating.
Skills: `/upg-new-persona`, `/upg-new-discovery`, `/upg-new-strategy`, `/upg-walk-region engineering`, `/upg-walk-region growth`, `/upg-walk-region ux_design`

### Pattern 2: Analysis (read and map)
Scan external sources (codebase, docs, tools) → infer entities → present for confirmation → create. The skill does the reading, the user validates. Fast, automated, high-leverage.
Skills: `/upg-walk-region engineering` (codebase / api / debt / deps), `/upg-walk-region ux_design` (screens / design-audit), `/upg-find-untracked`, `/upg-walk-region marketing` (SEO).

### Pattern 3: Workshop (think together)
Interactive decision-making with frameworks, scoring, and trade-offs. Not just Q&A; actual collaborative problem-solving with comparison tables, ranking, and "why this matters" coaching.
Skills: `/upg-walk-region pricing`, `/upg-walk-region content`, `/upg-walk-region ux_design` (flows / wireframes), `/upg-walk-region growth`.

---

## The Journey: 7 Phases

```
Phase 1: Identity        /upg-new-graph, /upg-new-strategy
Phase 2: Understanding   /upg-new-persona, /upg-new-research, /upg-walk-region ux_design
Phase 3: Discovery       /upg-new-discovery, /upg-new-hypothesis
Phase 4: Business        /upg-walk-region business_model, /upg-walk-region market_competitive, /upg-new-okr, /upg-walk-region pricing
Phase 5: Reaching        /upg-new-launch, /upg-walk-region market_competitive, /upg-walk-region content, /upg-walk-region marketing, /upg-walk-region growth
Phase 6: Building        /upg-walk-region product_spec, /upg-walk-region engineering, /upg-walk-region ux_design
Phase 7: Learning        /upg-walk-region team_org, /upg-check-gaps, /upg-walk-region engineering (debt + deps)
```

`/upg-show-journey` tracks progress across all phases. Every skill points back to it.

---

## Level 2: Benchmark Intelligence

When the graph has 10+ entities, compare against product management benchmarks from `@unified-product-graph/core`. Derive the current benchmark set live via `list_benchmarks()` rather than relying on counts quoted here; the set grows with the spec. These encode wisdom from Ries, Christensen, Torres, Osterwalder, Cagan, Moore, and others.

**The rule: never state a number without explaining what you're trying to achieve.**

A benchmark is not "you have 1 persona, expected 2-4." A benchmark is a conversation about product risk:

❌ **Numeric only (don't do this):**
> "You have 1 persona. The benchmark is 2-4 at the validation stage."

✅ **Conversational (do this):**
> "You have one persona: Kai. That's a focused start, and focus is good at this stage. The reason most products in validation have 2-4 is that building for one person can blind you to who else might need this. If Kai is your starting point, great, but before you scale, you'll want to understand who else this is for. That's when a second persona earns its place."

**The three-part pattern for surfacing benchmarks:**

1. **Acknowledge what they have.** Start with what's there, not what's missing.

2. **Explain the WHY behind the number.** Not "the benchmark says 2-4" but "the reason is that a single persona can blind you." The user should understand the product risk, not just the count.

3. **Give them the decision.** "That's fine if Kai is your starting point, but consider a second persona before you scale." The user decides. Benchmarks are wisdom, not rules.

**Examples by domain:**

**Validation (hypothesis→learning ratio):**
> "You have 4 hypotheses and zero learnings. That means every feature you've built is based on what you *believe*, not what you've *tested*. The fastest way to reduce that risk is to pick your biggest assumption and run one small experiment. Even asking 5 people counts."

**Discovery (solution breadth per opportunity):**
> "Each of your 3 opportunities has exactly one solution. That's efficient, but it also means you jumped to the first idea for each one. Teresa Torres recommends exploring 2-3 solutions per opportunity, because your first solution is rarely the best. It might be worth brainstorming one alternative for your biggest opportunity."

**Business Model (missing at growth stage):**
> "Your product is at growth stage with 18 features, 4 personas, and strong discovery, but no business model. You've built something people want. The question now is: will they pay, and will it cover your costs? That's what makes the difference between a product and a side project."

**Engineering (tech debt visibility):**
> "You have 4 services and zero documented tech debt. That doesn't mean there's no debt; it means the debt is invisible. Every codebase accumulates debt. Making it visible lets you manage it instead of being surprised by it. Even 2-3 entries like 'auth module needs refactor' or 'test coverage below 30%' would help."

**Relationships (persona→JTBD):**
> "Kai has one job-to-be-done: 'manage my side project.' That's a start, but people don't have one job; they have many. What else does Kai need to get done in a day? What's the job *before* yours (that leads them to your product) and the job *after* (that your product enables)? Two more JTBDs would give you a much richer picture of Kai's world."

**Design (screens without flows):**
> "You have 12 screens but no user flows connecting them. Right now these are isolated pages; there's no picture of how someone actually moves through your product. Pick your most important task (like signing up or making a purchase) and map the screens they'd walk through. That's a user flow."

**Design (components without a system):**
> "You have 15 components but no design system entity tying them together. That's fine while the product is small, but as it grows, you'll start finding the same button built three different ways. A design system is just saying 'these are our building blocks' and keeping them consistent."

**Engineering (no architecture in validation):**
> "You're in validation with 8 features but no architecture entities. You don't need a full system diagram, but knowing which parts of your code handle which features helps you make better decisions about what to change and where. Even just naming 2-3 main areas of your codebase (like 'auth', 'payments', 'onboarding') gives you a foundation."

**Engineering (features without technical backing):**
> "5 of your features aren't connected to any service or technical component. That doesn't mean they're not built; it just means the graph doesn't know HOW they're built. Connecting features to the code that powers them helps you spot when one piece of code is carrying too many features, or when a feature has no clear home."

**Marketing (no positioning at growth):**
> "You're at growth stage with a solid product but no positioning. Positioning is just answering: 'What is this, who is it for, and why should they care?' Without it, every time you write a landing page or describe your product, you're starting from scratch."

**Marketing (no funnel at growth):**
> "You're growing but have no funnel mapped. A funnel is just the steps someone takes from 'never heard of you' to 'paying customer.' Knowing those steps, and where people drop off, is how you figure out what to fix next. Even a simple 3-step version (discover → try → buy) is a start."

**Design (journey without friction points):**
> "You mapped a user journey for Kai but didn't mark any friction points. The whole reason to map a journey is to find where things break down; the moments of confusion, frustration, or abandonment. Go back and score each step: where does Kai struggle?"

**Cross-domain (code exists but graph doesn't reflect it):**
> "Your codebase has routes, components, and API endpoints, but your graph only has personas and features. The graph is meant to hold your whole product, not just the strategy side. Running `/upg-walk-region engineering` would bring your technical reality into the same picture as your product thinking."

**The voice:** A coach who's been through this before. Not a linter flagging errors. Not a dashboard showing red/green. A thinking partner who says "here's what I've seen work" and lets you decide.

**How to use the full benchmark set:**
- Derive the live benchmark set via `list_benchmarks()` (MCP introspection); this covers count, relationship, and ratio benchmarks without hardcoding any numbers.
- `/upg-check-gaps` runs ALL benchmarks (in its forward-looking signals section) and synthesises them into a narrative.
- Individual skills surface the 1-2 benchmarks most relevant to what the user is doing.
- Never show the raw benchmark table. Always narrate.

---

## Sync Awareness Protocol

At the start of any graph-modifying skill session, detect the user's graph state with two quick checks:

1. **Local graph:** call `mcp__unified-product-graph__get_graph_digest()`; this tells you if a `.upg` file exists and how many entities it has.
2. **Cloud sync:** call `mcp__unified-product-graph__get_sync_state()`; if it succeeds, the cloud connection is available. Compare entity counts; if they differ materially, surface the discrepancy.

### What to do with the results

| Local | Cloud | Action |
|-------|-------|--------|
| Exists | `get_sync_state` succeeds, same product | Note both are connected. Compare entity counts; if they differ by >20%, mention: "Local graph has {N} entities. Cloud has {M}. They may be out of sync; consider `/upg-sync-push` or `/upg-sync-pull`." |
| Exists | `get_sync_state` succeeds, different product | Ask: "Your local graph is **{local product}** but your cloud has **{cloud product}**. Which one are we working on?" |
| Exists | `get_sync_state` errors or tool not available | Proceed normally with local only. No sync suggestions at end. |
| Doesn't exist | `get_sync_state` succeeds | Suggest: "You have a cloud graph but no local `.upg` file. Run `/upg-sync-pull` to bring it down, or `/upg-new-graph` to start fresh." |
| Doesn't exist | `get_sync_state` errors or not available | Suggest `/upg-new-graph` to get started. |

### Rules

- This check must be **QUICK**: just 2 tool calls. Do not block the user or force them to sync before working.
- Surface the state briefly (one sentence) and move on to the skill's actual work.
- Do NOT run this check for read-only skills (`/upg-show-status`, `/upg-check-gaps`, `/upg-show-tree`, `/upg-show-diff`, `/upg-sync-export`).
- Do NOT run this check for `/upg-sync-push` or `/upg-sync-pull` themselves; they already handle sync.
