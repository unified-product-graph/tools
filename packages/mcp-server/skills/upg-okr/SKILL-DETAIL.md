---
name: upg-okr-detail
description: "Detailed OKR builder discovery flow"
---

# /upg-okr: Discovery Flow Detail

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

> **Note:** Use the product NODE's id (from list_nodes), not the top-level product.id from the .upg file.

```
create_node({
  type: "objective",
  title: "<objective statement>",
  description: "<why this matters this quarter>",
  properties: {
    timeframe: "<Q1 2026 | Q2 2026 | H1 2026 | annual 2026>",
    objective_status: "active"
  },
  parent_id: "<product_id>"
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
create_node({
  type: "key_result",
  title: "<metric>: <current> → <target>",
  description: "<why this metric matters for the objective>",
  properties: {
    metric: "<metric name>",
    current_value: <number>,
    target_value: <number>,
    unit: "<%, users, seconds, NPS, etc.>",
    score: 0,
    status: "active"
  },
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

```
create_node({
  type: "initiative",
  title: "<initiative name>",
  description: "<how this drives the key result>",
  properties: {
    status: "planned"
  },
  parent_id: "<key_result_id>"
})
```

If linking to an existing entity, use the canonical edge for the source type:

```
// For a feature → key_result link, use the canonical edge:
create_edge({
  source_id: "<feature_id>",
  target_id: "<key_result_id>",
  type: "feature_drives_key_result"
})

// For an initiative → outcome link, use:
//   create_edge({ source_id: "<initiative_id>", target_id: "<outcome_id>",
//                 type: "initiative_drives_outcome" })
// (initiatives currently connect to outcomes; key_result quantifies the
//  outcome via objective_achieved_through_key_result + metric_measures_key_result)
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
create_node({
  type: "metric",
  title: "<metric name>",
  description: "<what this metric measures and why it matters>",
  properties: {
    designation: "<input | guardrail | health | counter | vanity | north_star>",
    metric_category: "<aarrr or heart category>",
    current_value: <number if known>,
    unit: "<%, count, seconds, score, etc.>",
    indicator_direction: "<leading | lagging>"
    // Note: connect this metric to the related key_result via the
    // `metric_measures_key_result` edge below instead of a free-text property.
  },
  parent_id: "<objective_id>"
})
```

Connect to the relevant key result:

```
create_edge({
  source_id: "<metric_id>",
  target_id: "<key_result_id>",
  type: "metric_measures_key_result"
})
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
│  └─ 🎯 <Initiative>                               🔵 planned
├─ 🎯 <KR 1.2>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
├─ 🎯 <KR 1.3>: <current> → <target>               ⚪ 0%
│     ▓░░░░░░░░░░░░░░░░░░░  0%
│  └─ 🎯 <Initiative>                               🔵 planned
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
> Or run `/upg-journey` to see where you are in the bigger picture.

