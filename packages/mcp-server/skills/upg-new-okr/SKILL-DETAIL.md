---
name: upg-okr-detail
description: "Detailed OKR builder discovery flow"
---

# /upg-new-okr: Discovery Flow Detail

> **MCP-first (applies to every create below).** Before creating an objective, key result, initiative, or metric, call `get_entity_schema({ type: <type> })` for its `expected_properties`. Set the node's top-level `status` from a phase id returned by `get_catalog_entry({ kind: 'lifecycle', id: <type> })` — that is where lifecycle phases live, NOT in `get_entity_schema` (objective phases are `draft`/`active`/`achieved`/`missed`/`deferred`). Note that a `*_status` PROPERTY (e.g. `objective_status`) is a distinct enum field inside `expected_properties` — it is NOT the node's lifecycle `status`; don't conflate the two. Pass any assessment property as `{ value, label }`. Before any edge, call `get_entity_schema({ type: source_type, resolve_edge_to: target_type }).resolve_edge` and let the server infer the edge type. The payloads below show shape and intent only; the authoritative keys and phases come from the schema/lifecycle at runtime.

## Discovery Flow

### Step 0: Check Existing State

First, check what already exists:

```
get_product_context()
list_nodes({ type: "objective" })
list_nodes({ type: "key_result" })
list_nodes({ type: "outcome" })
list_nodes({ type: "strategic_theme" })
list_nodes({ type: "initiative" })
```

If objectives already exist, show them and ask if they want to add another or review existing ones. If the user passed an argument (timeframe or objective text), use it to skip ahead.

If existing OKRs are found:

```
### OKRs in your graph

🎯 Deliver a world-class onboarding experience       Q2 2026
├─ 🎯 Day-7 retention: 47% → 65%                    ⚪ 0%
├─ 🎯 Time-to-value: 12min → 3min                   ⚪ 0%
└─ 🎯 Onboarding NPS: 32 → 55                       ⚪ 0%

Want to add a new objective, or work on key results for an existing one?
```

### Step 1: Timeframe

> **Phase 1 of 5: Setting the timeframe** (~8 minutes total)

Ask: **"What timeframe are these OKRs for?"**

```
1. Q1 (Jan-Mar)
2. Q2 (Apr-Jun)
3. Q3 (Jul-Sep)
4. Q4 (Oct-Dec)
5. H1 (Jan-Jun)
6. H2 (Jul-Dec)
7. Annual (full year)
8. Different timeframe; tell me
```

STOP. Wait for the answer.

### Step 2: The Objective

React to the timeframe, then ask: **"What's the objective? This should be qualitative and inspiring; the 'what' you want to achieve, not the number."**

Check the graph for context to make smart suggestions:

```
list_nodes({ type: "outcome" })
list_nodes({ type: "strategic_theme" })
list_nodes({ type: "opportunity" })
```

Offer objective options based on what's in the graph:

```
1. "<objective based on highest-priority outcome>"
2. "<objective based on a strategic theme>"
3. "<objective based on a top opportunity>"
4. "<objective based on product stage; e.g., 'Prove product-market fit'>"
5. Something else; what's the big goal?
```

> A great objective is qualitative and inspiring. Not "Increase retention to 65%" (that's a key result). Instead: "Deliver an onboarding experience users love." The objective is the *why*, the key results are the *how we measure*.

Coach if they give a metric as an objective: **"That sounds like a key result; a measurable number. What's the bigger, qualitative goal that number supports?"**

STOP. Wait for the answer. Then create the objective:

> **Note:** The product is a top-level `.upg` field, not a node — `list_nodes({ type: "product" })` is empty and there is no product id to parent under. Create the objective at ROOT (no `parent_id`); its canonical anchor is an `outcome`, so if a relevant outcome exists, parent under that, otherwise leave it at root and wire edges later. Don't invent a `product_id`.

```
// Read get_entity_schema({ type: "objective" }) for properties; read
// get_catalog_entry({ kind: 'lifecycle', id: "objective" }) for the status phases. Then:
create_node({
  type: "objective",
  title: "<objective statement>",
  description: "<why this matters this quarter>",
  status: "active",  // a phase id from get_catalog_entry({ kind: 'lifecycle', id: "objective" }): draft|active|achieved|missed|deferred
  properties: { /* keys from get_entity_schema objective: timeframe, etc. */ }
  // no parent_id — objective is created at root (or under an outcome if one exists)
})
```

Confirm: "**Your objective is set.** Now let's make it measurable."

### Step 3: Key Results: One at a Time

Ask: **"How will you know you achieved '<Objective>'? Give me the first key result; a specific metric with a target."**

Offer key result options based on the objective and graph context:

```
1. "<metric> from <current> to <target>"; <why this measures the objective>
2. "<another metric> from <current> to <target>"
3. "<a leading indicator> from <current> to <target>"
4. Different metric; tell me what you'd measure
```

STOP. Wait for the answer.

### Step 3b: Current and Target Values

If the user didn't provide specific numbers, ask: **"What's the current value, and what's the target?"**

```
1. Current: <best guess> → Target: <ambitious but achievable>
2. I don't know the current value yet
3. Let me give you the numbers
```

> OKR scoring guide: if you achieve 70% of a key result, that's a good outcome. Set targets that are a stretch; if you hit 100% every quarter, your OKRs aren't ambitious enough.

STOP. Wait for the answer.

**Vibe check:** Show the user a summary of what you've captured and ask: "Anything you'd change before I save this?"

Then create the key result:

```
// Read get_entity_schema({ type: "key_result" }) for properties and
// get_catalog_entry({ kind: 'lifecycle', id: "key_result" }) for its status phases, then:
create_node({
  type: "key_result",
  title: "<metric>: <current> → <target>",
  description: "<why this metric matters for the objective>",
  status: "<a phase id from get_catalog_entry({ kind: 'lifecycle', id: 'key_result' })>",
  properties: { /* keys from the schema: current_value, target_value, unit, etc. Delivery health lives on the top-level lifecycle `status`, not a property. */ },
  parent_id: "<objective_id>"
})
```

Confirm with a progress bar:

```
🎯 **<Metric>: <current> → <target>**
   ▓░░░░░░░░░░░░░░░░░░░  0%
```

Then ask: **"What's the next key result? Most objectives have 2-4."**

If they want to add another, loop back to Step 3. If not, move to Step 4.

After all key results for an objective, show the OKR:

```
🎯 <Objective>                                       <Timeframe>
├─ 🎯 <KR1>: <current> → <target>                   ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
├─ 🎯 <KR2>: <current> → <target>                   ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
└─ 🎯 <KR3>: <current> → <target>                   ⚪ 0%
      ▓░░░░░░░░░░░░░░░░░░░  0%
```

### Step 4: Link Initiatives

Ask: **"What initiatives will drive '<Key Result>'? These are the projects, features, or efforts that move the needle."**

Check for existing initiatives and features:

```
list_nodes({ type: "initiative" })
list_nodes({ type: "feature" })
```

If related entities exist:

```
You have initiatives and features in your graph that might drive this:

1. 🎯 <Existing initiative>; link it to this key result
2. 📦 <Existing feature>; link it to this key result
3. Create a new initiative
4. Skip; I'll connect initiatives later
```

If creating a new initiative:

> **`initiative` is not a containment child of `key_result`** — verify with `get_entity_schema({ type: "key_result", include: ['valid_children'] })`. Create the initiative at root (no `parent_id`) and wire the lateral relationship using `get_entity_schema({ type: "initiative", resolve_edge_to: "key_result" }).resolve_edge`.

```
// Read get_entity_schema({ type: "initiative" }) for properties and
// get_catalog_entry({ kind: 'lifecycle', id: "initiative" }) for its status phases, then:
create_node({
  type: "initiative",
  title: "<initiative name>",
  description: "<how this drives the key result>",
  status: "<a phase id from get_catalog_entry({ kind: 'lifecycle', id: 'initiative' })>"
  // No parent_id — initiative is not a containment child of key_result
})
// Wire the lateral relationship:
// edge = get_entity_schema({ type: "initiative", resolve_edge_to: "key_result" }).resolve_edge
// create_edge({ source_id: "<initiative_id>", target_id: "<key_result_id>" })  // server infers type
```

If linking to an existing entity, resolve the canonical edge for the pair and let the server infer the type:

```
// feature → key_result: edge = get_entity_schema({ type: "feature", resolve_edge_to: "key_result" }).resolve_edge
create_edge({ source_id: "<feature_id>", target_id: "<key_result_id>" })  // server infers type

// initiative → its driven entity: get_entity_schema({ type: "initiative", resolve_edge_to: <that type> }).resolve_edge
// then create_edge without an explicit type:. Use get_entity_schema({ type, resolve_edge_to }).resolve_edge to discover
// what an initiative validly drives rather than assuming a fixed target type.
```

### Step 5: Additional Metrics (optional)

After all key results and initiatives are linked for an objective, ask: **"Any other metrics you want to track alongside these KRs? Think input metrics, guardrail metrics, or health metrics that aren't key results but are important to watch."**

```
1. Yes; I have metrics to add
2. No; the key results cover it
```

STOP. Wait for the answer. If they say no, skip to Step 6.

If yes, ask: **"What metric do you want to track?"**

Offer metric options based on the objective and key results:

```
1. 📊 <input metric>; a leading indicator that feeds into <KR>
2. 📊 <guardrail metric>; guardrail metrics (things that should NOT get worse while you pursue the objective)
3. 📊 <health metric>; overall product/team health signal
4. 📊 <counter-metric>; counter-metrics (the opposite signal; if this moves, something went wrong)
5. Different metric; tell me what you want to track
```

STOP. Wait for the answer.

Create the `metric` entity:

```
// Read get_entity_schema({ type: "metric" }) first, then:
create_node({
  type: "metric",
  title: "<metric name>",
  description: "<what this metric measures and why it matters>",
  properties: { /* keys from the schema: designation, metric_category, current_value, unit, indicator_direction */ },
  parent_id: "<objective_id>"
})
```

Connect to the relevant key result; resolve the edge first:

```
// edge = get_entity_schema({ type: "metric", resolve_edge_to: "key_result" }).resolve_edge
create_edge({ source_id: "<metric_id>", target_id: "<key_result_id>" })  // server infers type
```

Confirm: "📊 **<Metric Name>** added as a <metric type> metric."

Ask: **"Any more metrics to track?"** If yes, repeat. If no, move to Step 6.

### Step 6: Another Objective?

Ask: **"Want to add another objective for <timeframe>? Most teams have 2-4 per quarter."**

```
1. Yes; I have another objective
2. That's enough; show me the full OKR set
```

If yes, loop back to Step 2. If no, proceed to the summary.

### Step 7: Show the Full OKR Tree

Display the complete OKR set with grade-ability assessment:

```
### OKRs: <Timeframe> <Year>

🎯 <Objective 1>
├─ 🎯 <KR 1.1>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
│  └─ 🎯 <Initiative>                               🔵 proposed
├─ 🎯 <KR 1.2>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
├─ 🎯 <KR 1.3>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
│  └─ 🎯 <Initiative>                               🔵 proposed
│
└─ 📊 Tracked Metrics                                (if created)
   ├─ 📊 <input metric>; <direction> <unit>         (input)
   └─ 📊 <guardrail metric>; <direction> <unit>     (guardrail)

🎯 <Objective 2>
├─ 🎯 <KR 2.1>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
└─ 🎯 <KR 2.2>: <current> → <target>               ⚪ 0%
      ▓░░░░░░░░░░░░░░░░░░░  0%
```

### Grade-ability Assessment

Show how well-formed the OKRs are:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
### Grade-ability Check

✓ Objectives are qualitative and inspiring
✓ Key results have current + target values
<check: unit specified, baseline known, stretch target>
✓ Each objective has 2-4 key results
<check: initiatives linked>
<check: supporting/guardrail metrics tracked>

Overall: X of Y key results are fully grade-able
```

### Step 8: Close with Smart Ending

Check the graph for the biggest gap across the 8 business areas. Recommend ONE next skill:

> Based on what we built, your biggest gap is **[area]**. I'd suggest running `/upg-[skill]` next to [reason].
>
> Or run `/upg-show-journey` to see where you are in the bigger picture.

