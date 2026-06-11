---
name: upg-walk-region-detail
description: "Full property schemas and edge type reference for /upg-walk-region"
---

# /upg-walk-region: Property Schemas & Edge Types (Detail)

This file is an **illustrative reference**, not the spec. It is loaded on demand by /upg-walk-region. The authoritative properties and valid children for any type come from **`get_entity_schema({ type: <type> })`** at runtime; the authoritative lifecycle phases (the top-level `status` enum) come from **`get_lifecycle({ entity_type: <type> })`** (not `get_entity_schema`); and the canonical edge for any pair comes from **`resolve_edge_for_pair({ source_type, target_type })`**. Where this file disagrees with those live calls, the live calls win. Use the blocks below to shape your questions, then confirm against the schema before writing.

## Full Property Schemas

When creating an entity, actively prompt for the key properties. Do not just set title and description.

> **Two conventions these schemas follow (and you must too):**
> 1. **Lifecycle `status` is a TOP-LEVEL field on the node, not a property.** Where a block below shows `status (top-level ...)`, pass it as a top-level `status:` argument to `create_node`, alongside (not inside) `properties`. The shown enum is illustrative — confirm the live phase set with `get_lifecycle({ entity_type: <type> })`, which is the source of truth (`get_entity_schema` does not return it). Note: a `*_status` PROPERTY (e.g. `objective_status`) is a SEPARATE enum field that lives inside `properties` and is distinct from the top-level lifecycle `status` — never copy one into the other.
> 2. **Assessments (`reach`, `frequency`, `pain`, `impact`, `confidence`, `effort`, `importance`, `current_satisfaction`) are `{ value, label }` objects on a 1-5 scale, NOT bare integers.** Where a block shows `1-5`, write `{ value: <1-5>, label: "<word>" }`.

### outcome
```json
{
  "timeline": "When this should be achieved"
}
```
Ask: "What's the timeline for this outcome?"

### metric (KPI)
```json
{
  "designation": "kpi",
  "current_value": 0,
  "target_value": 100,
  "unit": "%, users, seconds, etc.",
  "range_min": 0,
  "range_max": 100
}
```
Ask: "What's the current value? What's the target? What unit?" (KPIs are `metric` nodes with `designation: "kpi"`; the `kpi` type was consolidated into `metric` in v0.1.0.)

### objective
```json
{
  "timeframe": "Q1 2026, H2 2026, etc.",
  "objective_status": "active | achieved | deferred",
  "status (top-level lifecycle)": "draft | active | achieved | missed | deferred"
}
```

### key_result
```json
{
  "current_value": 0,
  "target_value": 100,
  "unit": "metric unit",
  "status (top-level lifecycle)": "on_track | at_risk | behind | achieved"
}
```

### opportunity
```json
{
  "status (top-level)": "identified | validated | deferred",
  "reach": "{ value: 1-5, label }",
  "frequency": "{ value: 1-5, label }",
  "pain": "{ value: 1-5, label }"
}
```
Ask: "How many people does this affect (reach 1-5)? How often (frequency 1-5)? How painful (1-5)?"

### solution
```json
{
  "status (top-level)": "proposed | in_progress | shipped | deferred",
  "reach": "{ value: 1-5, label }",
  "impact": "{ value: 1-5, label }",
  "confidence": "{ value: 1-5, label }",
  "effort": "{ value: 1-5, label }",
  "rice_score": "(reach x impact x confidence) / effort"
}
```
Ask: "Let's RICE-score this. Reach (1-5)? Impact (1-5)? Confidence (1-5)? Effort (1-5)?"

### experiment
```json
{
  "method": "Description of the test method",
  "status (top-level)": "planned | running | analysing | done",
  "start_date": "ISO date",
  "end_date": "ISO date"
}
```
(For the hypothesis test chain, prefer `experiment_plan` -> `experiment_run`; `experiment` is the standalone test unit. There is no canonical `hypothesis -> experiment` edge.)

### learning
```json
{
  "result": "What happened",
  "metric": "What was measured",
  "result_value": 0,
  "confidence_impact": "strengthens | weakens | neutral"
}
```

### competitor
```json
{
  "positioning": "How they position themselves",
  "pricing_model": "Their pricing approach",
  "strengths": ["What they do well"],
  "weaknesses": ["Where they fall short"],
  "website": "URL"
}
```

### feature
```json
{
  "status (top-level)": "proposed | in_progress | shipped | archived"
}
```

### user_story
```json
{
  "as_a": "persona name",
  "i_want_to": "action",
  "so_that": "outcome",
  "effort": 0
}
```
(`user_story` is lifecycle-free; it has no `status` phases. Track delivery state on the parent epic or via task entities, not a story `status`.)

### need
```json
{
  "valence": "pain | gap | constraint",
  "frequency": "{ value: 1-5, label }",
  "severity": "{ value: 1-5, label }"
}
```
Ask: "How often does this happen (1-5)? How bad is it (1-5)? Is this a pain, gap, or constraint?" (The old `pain_point` type was consolidated into `need` with `valence: "pain"` in v0.1.0. `frequency` and `severity` are assessments; pass `{ value, label }`.)

### research_study
```json
{
  "method": "interview | usability | survey | diary | analytics",
  "status (top-level)": "planned | in_progress | analysing | complete",
  "participant_count": 0
}
```

### insight (research insight)
```json
{
  "insight_level": "pattern | finding | actionable | strategic",
  "confidence": "{ value: 1-5, label }",
  "source_method": "method from the study",
  "evidence_count": 0,
  "status (top-level)": "proposed | validated | applied | retired"
}
```
(The old `research_insight`, `finding`, and `ux_insight` types were all consolidated into `insight` in v0.1.0.)

### business_model
```json
{
  "canvas_type": "lean | bmc | custom",
  "customer_segments": ["Who you serve"],
  "channels": ["How you reach them"],
  "key_activities": ["What you do"],
  "key_resources": ["What you need"],
  "key_partners": ["Who helps you"],
  "status (top-level)": "drafted | testing | validated | invalidated | pivoted"
}
```
Ask: "What type of canvas is this; lean, BMC, or custom? Who are the customer segments? What are the key activities?"

### value_proposition
```json
{
  "for_segment": "Which customer segment this serves",
  "gains": ["What gains you create"],
  "pain_relievers": ["What pains you relieve"],
  "products_and_services": ["What you offer"],
  "differentiator": "Why this is unique vs. alternatives",
  "status (top-level)": "drafted | testing | validated | invalidated"
}
```
Ask: "Which customer segment is this for? What gains does it create? What pains does it relieve? What makes it different from alternatives?"

### gtm_strategy
```json
{
  "target_market": "Primary market",
  "motion": "product_led | sales_led | community_led | hybrid",
  "channels": ["Distribution channels"],
  "timeline": "Launch timeline",
  "success_metrics": ["How you'll measure success"],
  "status (top-level)": "planning | active | paused | completed | sunset"
}
```
Ask: "What's the target market? Is this product-led, sales-led, or community-led? What channels will you use?"

### ideal_customer_profile
```json
{
  "company_size": "1-10 | 11-50 | 51-200 | 201-1000 | 1000+",
  "industry": "Target industry",
  "budget_range": "Typical budget",
  "buying_triggers": ["What causes them to look for a solution"],
  "disqualifiers": ["Red flags; who is NOT a fit"],
  "decision_makers": ["Roles involved in the buying decision"]
}
```
Ask: "What size company is the ideal fit? What industry? What triggers them to start looking for a solution like yours?"

### positioning
```json
{
  "for_whom": "Target audience",
  "who_need": "Their primary need",
  "our_product_is": "Category or frame",
  "that_provides": "Key benefit",
  "unlike": "Primary alternative",
  "we_differentiate_by": "Unique differentiator",
  "framework": "april_dunford | moore | custom"
}
```
Ask: "Let's use a positioning statement. For whom? Who need what? What category is your product? How do you differentiate?"

### user_journey
```json
{
  "persona": "Which persona takes this journey",
  "scenario": "The specific context or trigger",
  "stages": ["awareness", "consideration", "decision", "onboarding", "retention"],
  "emotional_arc": "How feelings change across stages",
  "status (top-level)": "draft | review | published | archived"
}
```
Ask: "Which persona takes this journey? What's the scenario? What stages does it cover?"

### decision (architecture / design / product)
```json
{
  "layer": "engineering | design | product",
  "context": "Why this decision was needed",
  "decision": "What was decided",
  "alternatives_considered": ["What else was evaluated"],
  "consequences": ["Trade-offs and implications"],
  "status (top-level)": "proposed | reviewing | approved | rejected | deprecated",
  "decided_by": "Who made the decision",
  "decided_on": "ISO date"
}
```
Ask: "What's the context; why was this decision needed? What was decided? What alternatives were considered? Which layer does this belong to; engineering, design, or product?" (`architecture_decision`, `design_decision`, and `product_decision` were consolidated into the single `decision` type with a `layer` property in v0.2.0.)

### growth_loop
```json
{
  "loop_type": "viral | content | paid | product",
  "trigger": "What starts the loop",
  "action": "What the user does",
  "output": "What the action produces",
  "reinvestment": "How the output feeds back into the trigger",
  "time_to_complete": "How long one cycle takes"
}
```
Ask: "What type of loop; viral, content, paid, or product? What triggers it? What action does the user take? How does the output feed back into the trigger?" (`growth_loop` is lifecycle-free; no `status` phases.)

### pricing_strategy
```json
{
  "model": "freemium | free_trial | usage_based | flat_rate | per_seat | tiered | custom",
  "anchor_price": "Primary price point",
  "willingness_to_pay": "Researched WTP range",
  "competitive_position": "cheaper | parity | premium",
  "tiers": ["Tier names"],
  "status (top-level)": "planning | active | paused | completed | sunset"
}
```
Ask: "What pricing model; freemium, usage-based, per-seat, etc.? What's the anchor price? How does this compare to competitors; cheaper, parity, or premium?"

### ai_model
```json
{
  "model_type": "llm | classifier | recommender | generative | embedding | custom",
  "provider": "openai | anthropic | google | huggingface | self_hosted | other",
  "use_case": "What this model does in the product",
  "input_type": "text | image | audio | structured | multimodal",
  "output_type": "text | classification | embedding | structured | multimodal",
  "latency_target": "Target response time",
  "cost_per_call": "Estimated cost",
  "status (top-level)": "evaluating | staging | production | deprecated | retired"
}
```
Ask: "What type of model; LLM, classifier, recommender? Which provider? What's its use case in the product?"

## Edge Types: Valid Connections

After creating an entity, search for related entities and suggest connections.

**The canonical edge for any pair is determined by the spec, not by a `{source}_has_{target}` pattern.** Most UPG edges use a meaningful verb (e.g. `product_pursues_outcome`, `job_surfaces_need`), and a `{source}_has_{target}` name is almost always wrong. Before you create an edge:

1. Call `resolve_edge_for_pair({ source_type, target_type })` to get the canonical edge type (or `null` if no direct edge exists — then bridge through an intermediate entity).
2. Or browse the full catalog with `list_edge_types` / `get_edge_type`.

When you pass `parent_id` to `create_node`, the server auto-infers the correct canonical edge for you, so you usually don't need to name the edge type at all.

### How the core discovery chain connects

The canonical OST/discovery chain runs product → persona → job → need, and outcome → opportunity → solution → hypothesis → experiment, with research feeding it (research study → insight → opportunity). **Don't memorise the edge names** — each link resolves via `resolve_edge_for_pair({ source_type, target_type })`, and most are auto-inferred when you pass `parent_id` to `create_node`. A couple of illustrative resolutions (confirm everything else with the resolver):

| From -> To | Resolve with |
|---|---|
| persona -> job | `resolve_edge_for_pair({ source_type: "persona", target_type: "job" })` |
| opportunity -> solution | `resolve_edge_for_pair({ source_type: "opportunity", target_type: "solution" })` |

Pairs with NO direct canonical edge resolve to `null` and must be bridged through an intermediate entity — model the relationship through the canonical chain instead of inventing an edge.

