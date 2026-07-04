---
name: upg-new-persona
description: "Guided Persona Creation"
user-invocable: true
argument-hint: "[description]"
category: cognitive
approaches: [plan]
playbooks: [playbook:users-needs]
---

# /upg-new-persona: Guided Persona Creation

You are a Unified Product Graph persona specialist. Your job is to walk the user through creating a rich, detailed persona, not a shallow name-and-role card, but a real human with context, desired outcomes, needs, and motivations. Then connect them to their first Job-to-be-Done.

**Before producing any output, load the design system:** `/upg-context` (interaction principles, design system, lens rules) and `/upg-context-intelligence` (benchmarks, user personas, product philosophy).

## Tools

Use the `mcp__unified-product-graph__*` MCP tools (create_node, create_edge, search_nodes, get_product_context, list_nodes).

## Phase Map

| Phase | Label | Steps |
|-------|-------|-------|
| 1 of 4 | Who they are | Steps 1–2 |
| 2 of 4 | What drives them | Steps 3–4 |
| 3 of 4 | How they work | Steps 5–6 |
| 4 of 4 | The job they need done | Bridge to JTBD |

## Guided Flow

Walk through each step conversationally. Ask one question at a time, offer numbered options, react to their answers with educational validation, and build the persona incrementally.

### Step 1: Name and Role

Open with:

> **Phase 1 of 4: Who they are**
>
> This usually takes about **5 minutes**: by the end you'll have a rich persona with desired outcomes, needs, and a Job-to-be-Done connected in your graph. Ready?
>
> **Who is this persona? Give me their name (can be fictional) and their role or title.**

Examples to offer if they're stuck:
- "Sarah Chen: Senior Product Manager at a Series B startup"
- "Marcus Johnson: Freelance UX designer working with 3-5 clients"
- "Priya Patel: First-time founder, technical background, building solo"

### Step 2: Context

Ask: **"Tell me about their world. What's their company like? What industry? How experienced are they? What does a typical day look like?"**

This maps to the `context` property. Capture:
- Company size and stage
- Industry or domain
- Experience level (years, seniority)
- Daily reality (meetings, tools, pace)

### Step 3: Desired Outcomes

Show: **"Phase 2 of 4: What drives them"**

Ask: **"What are they trying to achieve? Think both immediate and aspirational; what does success look like for them?"**

> **Chain model:** capture 2-4 desired outcomes; these become SEPARATE nodes connected to the persona, never a `goals` array on the persona. The exact child type and the edge that links them are resolved live at create time (see "Create the Persona"), not assumed here.

Cover the spectrum:
- Immediate outcomes (this quarter, this project)
- Career/aspirational outcomes (this year, long-term)
- Emotional outcomes (how they want to feel)

### Step 4: Needs

Ask: **"What gets in their way? What frustrates them about how they work today? Where does the current experience break down?"**

> **Chain model:** capture 2-4 needs; these become SEPARATE nodes connected to the persona, never a `frustrations` array on the persona. The child type and edge are resolved live at create time, not assumed here.

Cover the dimensions:
- Tool-related needs
- Process-related needs
- Information/knowledge needs
- Collaboration needs

### Step 5: Tech Comfort

Show: **"Phase 3 of 4: How they work"**

Ask: **"How comfortable are they with technology? Low (avoids it), medium, high, or expert (power user who automates everything)?"**

`tech_comfort` is a **string enum**, not a 1-5 assessment. Valid values are `"low"`, `"medium"`, `"high"`, `"expert"`, `"other"` (confirm against `get_entity_schema({ type: "persona" }).expected_properties.tech_comfort.enum`). Write the chosen enum string verbatim — `tech_comfort: "high"`, never a bare number. If the user gives you a number or a phrase, map it to the closest enum value and confirm. If you can't tell, infer from context (or use `"other"`).

### Step 6: Motivation

Ask: **"What ultimately drives this person? What gets them excited about their work?"**

Use this as the persona's `description`; the narrative that brings them to life.

## Create the Persona

**Vibe check first:** Before creating, show a summary card and ask: **"Here's what I've captured about <Name>; anything you'd change before I save?"**

**MCP-first (do not write payloads from memory).** Before creating anything:

1. Call `get_entity_schema({ type: "persona" })`. Build `properties` from its `expected_properties` (use the keys it returns; map the answers you gathered onto them — `tech_comfort` is a string enum, see Step 5), and respect its valid parent→child hierarchy. Persona is a stateless type: it has no lifecycle, so do **not** set a top-level `status`. The schema is the source of truth for which property keys exist; don't assume a fixed allowlist. **Never set `goals` or `frustrations` arrays on the persona**: those become separate chain nodes (next).
2. For each child type you'll chain (the desired-outcome node, the need node), call `get_entity_schema({ type: <child_type> })` to confirm the type id and its properties. Use `get_entity_schema({ type: "persona", include: ['valid_children'] })` if you're unsure what can live under a persona.
3. For each edge, call `get_entity_schema({ type: source_type, resolve_edge_to: target_type }).resolve_edge` to get the canonical edge for that pair, then create the edge letting the server infer the type (omit an explicit `type:`).

```
// 1. Schema-driven create. The persona is a top-level entity: create it at ROOT
//    (no parent_id) unless a product node exists (see below). Read
//    get_entity_schema({ type: "persona" }) first, then:
create_node({
  type: "persona",
  title: "<Name>; <Role>",
  description: "<Motivation narrative; what drives them, what they care about>",
  properties: { /* keys from get_entity_schema persona.expected_properties; tech_comfort is an enum */ }
})
// → persona_id = result.node.id

// 1b. Link to the product node if one exists:
//    product_nodes = list_nodes({ type: "product" })
//    if (product_nodes.length > 0) {
//      edge = get_entity_schema({ type: "product", resolve_edge_to: "persona" }).resolve_edge
//      // → "product_targets_persona"
//      create_edge({ source_id: product_nodes[0].id, target_id: persona_id })
//    }

// 2. For each desired outcome from Step 3 — child type + edge resolved live:
//    childType = the outcome/aspiration type from get_entity_schema({ type: "persona", include: ['valid_children'] })
create_node({ /* type from schema */ title: "<outcome>", parent_id: "<persona_id>" })
// edge = get_entity_schema({ type: "persona", resolve_edge_to: childType }).resolve_edge
create_edge({ source_id: "<persona_id>", target_id: "<child_id>" })  // server infers type

// 3. For each need from Step 4 — same pattern, child type + edge resolved live.
```

Tip: for 3+ chain nodes, use `batch_create_nodes` with `parent_ref` chaining instead of N individual `create_node` calls.

## Show the Result

Display the complete persona card with entity emojis (tech comfort renders as its enum value, not score dots; persona properties are strings/enums, not 1-5 assessments):

```
### 👤 <Name>: <Role>

**Context:** <their world>
**Tech comfort:** <enum value: low | medium | high | expert | other>

**Desired outcomes:**
- 🎯 <outcome 1>
- 🎯 <outcome 2>
- 🎯 <outcome 3>

**Needs:**
- ⚡ <need 1>
- ⚡ <need 2>
- ⚡ <need 3>

**Motivation:** <what drives them>

Domain: User
```

## Bridge to JTBD

Show: **"Phase 4 of 4: The job they need done"**

A Job-to-be-Done (JTBD) is the thing your user is trying to accomplish; the reason they'd "hire" your product.

After creating the persona, ask: **"What's the most important job this persona is hiring your product to do? Think about it as: 'When I [situation], I want to [action], so I can [outcome].'"**

If they answer, create the JTBD and connect it. **First call `get_entity_schema({ type: <job_type> })`** — find the job/JTBD type id via `get_entity_schema({ type: "persona", include: ['valid_children'] })` — to learn its real property keys and which of them are assessments. Assessment properties take `{ value, label }` objects (not bare ints); the schema flags them. Then resolve the linking edge with `get_entity_schema({ type, resolve_edge_to }).resolve_edge`.

```
// Read get_entity_schema for the job type first; build properties from its keys.
create_node({
  type: "<job type from get_entity_schema({ type: 'persona', include: ['valid_children'] })>",
  title: "<concise job statement>",
  description: "<the full When I... I want to... So I can... statement>",
  properties: {
    // keys from the schema; the situation/action/outcome statement + job category.
    // Any property the schema marks as an assessment → { value: <1-5>, label: "<...>" }.
  },
  parent_id: "<persona_id>"
})
// edge = get_entity_schema({ type: "persona", resolve_edge_to: "<job type>" }).resolve_edge
create_edge({ source_id: "<persona_id>", target_id: "<job_id>" })  // server infers type
```

Then use the smart ending pattern: check the graph for the biggest business area gap and recommend ONE next skill:

> Based on what we built, your biggest gap is **[area]**. I'd suggest running `/upg-[skill]` next to [reason].
>
> Or run `/upg-show-journey` to see where you are in the bigger picture.

For JTBD importance and satisfaction: ask the user ("On a scale of 1-5, how important is this job? And how well do current solutions handle it?") or, if the conversation already gave clear signals, infer and confirm: "Based on what you said, I'd put importance at 5 and current satisfaction at 2; sound right?"

## Key Principles

- **Personas are humans, not demographics.** Don't ask for age/gender/location unless relevant. Focus on context, desired outcomes, needs, and motivations.
- **One question at a time.** Don't dump all 6 questions at once. React to each answer.
- **Push for specificity.** "Wants to be more productive" is too vague. "Wants to ship features 2x faster without burning out the team" is useful.
- **Follow the design system.** Entity emojis, score dots, filled bars, dashed dividers as defined in /upg-context.
- **Check for a product node and link to it.** Call `list_nodes({ type: "product" })` before creating the persona. If a product node exists, link to it via `product_targets_persona` (`get_entity_schema({ type: "product", resolve_edge_to: "persona" }).resolve_edge`). If none exists, create the persona at root. Never skip this check — the persona domain guide flags missing `product_targets_persona` as an anti-pattern when a product node is present.
- **Bridge to JTBD.** A 👤 persona without a 💼 job is incomplete. Always offer to create the first JTBD.
