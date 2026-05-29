---
name: upg-explore-detail
description: "Full property schemas and edge type reference for /upg-explore"
---

# /upg-explore: Property Schemas & Edge Types (Detail)

This file contains the full property schemas and edge type reference for entity creation. It is loaded on demand by /upg-explore when the agent needs to know the specific properties or valid connections for an entity type.

## Full Property Schemas

When creating an entity, actively prompt for the key properties. Do not just set title and description.

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
  "status": "active | achieved | deferred"
}
```

### key_result
```json
{
  "current_value": 0,
  "target_value": 100,
  "unit": "metric unit",
  "status": "on_track | at_risk | behind | achieved"
}
```

### opportunity
```json
{
  "status": "identified | validated | deferred | closed",
  "reach": 1-5,
  "frequency": 1-5,
  "pain": 1-5
}
```
Ask: "How many people does this affect (reach 1-5)? How often (frequency 1-5)? How painful (1-5)?"

### solution
```json
{
  "status": "proposed | in_progress | shipped | deferred",
  "reach": 1-5,
  "impact": 1-5,
  "confidence": 1-5,
  "effort": 1-5,
  "rice_score": "(reach x impact x confidence) / effort"
}
```
Ask: "Let's RICE-score this. Reach (1-5)? Impact (1-5)? Confidence (1-5)? Effort (1-5)?"

### experiment
```json
{
  "method": "Description of the test method",
  "status": "planned | running | analysing | complete",
  "start_date": "ISO date",
  "end_date": "ISO date"
}
```

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
  "status": "planned | in_progress | shipped | deprecated"
}
```

### user_story
```json
{
  "as_a": "persona name",
  "i_want_to": "action",
  "so_that": "outcome",
  "status": "backlog | in_progress | done",
  "effort": 0
}
```

### need
```json
{
  "valence": "pain | gap | desire | constraint",
  "frequency": 1-5,
  "severity": 1-5
}
```
Ask: "How often does this happen (1-5)? How bad is it (1-5)? Is this a pain, gap, desire, or constraint?" (The old `pain_point` type was consolidated into `need` with `valence: "pain"` in v0.1.0.)

### research_study
```json
{
  "method": "interview | usability_test | survey | diary_study | field_study | other",
  "status": "planned | in_progress | analysing | complete",
  "participant_count": 0
}
```

### insight (research insight)
```json
{
  "source_domain": "research | ux | product | support",
  "insight_level": "observation | finding | insight",
  "confidence": "low | medium | high",
  "evidence_count": 0
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
  "status": "draft | validated | active | pivoting"
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
  "status": "draft | testing | validated"
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
  "status": "draft | in_progress | launched | iterating"
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
  "status": "draft | mapped | validated"
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
  "status": "proposed | accepted | deprecated | superseded",
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
  "time_to_complete": "How long one cycle takes",
  "status": "theoretical | testing | proven | scaling"
}
```
Ask: "What type of loop; viral, content, paid, or product? What triggers it? What action does the user take? How does the output feed back into the trigger?"

### pricing_strategy
```json
{
  "model": "freemium | free_trial | usage_based | flat_rate | per_seat | tiered | custom",
  "anchor_price": "Primary price point",
  "willingness_to_pay": "Researched WTP range",
  "competitive_position": "cheaper | parity | premium",
  "tiers": ["Tier names"],
  "status": "research | testing | launched | iterating"
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
  "status": "prototyping | evaluating | staging | production | deprecated"
}
```
Ask: "What type of model; LLM, classifier, recommender? Which provider? What's its use case in the product?"

## Edge Types: Valid Connections

After creating an entity, search for related entities and suggest connections. Use these valid edge types:

### Core Product Graph

| Edge Type | From | To |
|---|---|---|
| `product_has_outcome` | product | outcome |
| `product_has_objective` | product | objective |
| `product_has_competitor` | product | competitor |
| `product_has_feature` | product | feature |
| `product_has_release` | product | release |
| `product_has_research_study` | product | research_study |
| `product_has_persona` | product | persona |
| `product_has_business_model` | product | business_model |
| `product_has_gtm_strategy` | product | gtm_strategy |
| `product_has_pricing_strategy` | product | pricing_strategy |
| `product_has_ai_model` | product | ai_model |
| `outcome_has_metric` | outcome | metric |
| `outcome_has_opportunity` | outcome | opportunity |
| `objective_has_key_result` | objective | key_result |
| `persona_pursues_job` | persona | job |
| `job_has_need` | job | need |
| `opportunity_has_solution` | opportunity | solution |
| `solution_has_hypothesis` | solution | hypothesis |
| `hypothesis_has_experiment` | hypothesis | experiment |
| `experiment_produces_learning` | experiment | learning |
| `feature_has_epic` | feature | epic |
| `epic_has_user_story` | epic | user_story |
| `research_study_has_insight` | research_study | insight |
| `insight_informs_opportunity` | insight | opportunity |

### Market Intelligence

| Edge Type | From | To |
|---|---|---|
| `competitor_has_competitor_feature` | competitor | competitor_feature |
| `market_segment_has_persona` | market_segment | persona |
| `competitive_analysis_has_competitor` | competitive_analysis | competitor |
| `market_trend_informs_opportunity` | market_trend | opportunity |

### UX Research

| Edge Type | From | To |
|---|---|---|
| `research_study_has_participant` | research_study | participant |
| `research_study_has_interview_guide` | research_study | interview_guide |
| `participant_has_observation` | participant | observation |
| `observation_yields_insight` | observation | insight |
| `insight_refines_insight` | insight | insight |

### Design

| Edge Type | From | To |
|---|---|---|
| `persona_has_user_journey` | persona | user_journey |
| `user_journey_has_journey_step` | user_journey | journey_step |
| `user_flow_has_screen` | user_flow | screen |
| `screen_has_design_component` | screen | design_component |
| `design_component_has_design_token` | design_component | design_token |
| `feature_has_wireframe` | feature | wireframe |
| `wireframe_has_prototype` | wireframe | prototype |
| `feature_has_user_flow` | feature | user_flow |

### Engineering

| Edge Type | From | To |
|---|---|---|
| `feature_has_service` | feature | service |
| `service_has_api_contract` | service | api_contract |
| `service_has_database_schema` | service | database_schema |
| `service_has_library_dependency` | service | library_dependency |
| `feature_has_feature_flag` | feature | feature_flag |
| `service_has_decision` | service | decision (with `layer: "engineering"`) |
| `service_has_technical_debt_item` | service | technical_debt_item |

### Growth

| Edge Type | From | To |
|---|---|---|
| `funnel_has_funnel_step` | funnel | funnel_step |
| `acquisition_channel_feeds_funnel` | acquisition_channel | funnel |
| `growth_campaign_targets_acquisition_channel` | growth_campaign | acquisition_channel |
| `cohort_measured_by_metric` | cohort | metric |
| `growth_loop_has_experiment` | growth_loop | experiment (with `experiment_type: "growth"`) |
| `experiment_produces_learning` | experiment | learning |

### Business Model

| Edge Type | From | To |
|---|---|---|
| `business_model_has_value_proposition` | business_model | value_proposition |
| `business_model_has_revenue_stream` | business_model | revenue_stream |
| `business_model_has_cost_structure` | business_model | cost_structure |
| `business_model_has_partnership` | business_model | partnership |
| `value_proposition_targets_persona` | value_proposition | persona |
| `revenue_stream_has_pricing_tier` | revenue_stream | pricing_tier |
| `pricing_tier_has_unit_economics` | pricing_tier | unit_economics |

### Go-To-Market

| Edge Type | From | To |
|---|---|---|
| `gtm_strategy_has_ideal_customer_profile` | gtm_strategy | ideal_customer_profile |
| `gtm_strategy_has_positioning` | gtm_strategy | positioning |
| `gtm_strategy_has_messaging` | gtm_strategy | messaging |
| `gtm_strategy_has_launch` | gtm_strategy | launch |
| `launch_has_release` | launch | release |
| `positioning_has_competitive_battle_card` | positioning | competitive_battle_card |
| `competitive_battle_card_references_competitor` | competitive_battle_card | competitor |

### Team & Organisation

| Edge Type | From | To |
|---|---|---|
| `team_has_role` | team | role |
| `team_has_stakeholder` | team | stakeholder |
| `team_has_retrospective` | team | retrospective |
| `team_has_dependency` | team | dependency |

### Data & Analytics

| Edge Type | From | To |
|---|---|---|
| `metric_drives_metric` | metric (KPI) | metric (definition) |
| `data_source_defines_metric` | data_source | metric |
| `metric_has_event_schema` | metric | event_schema |
| `dashboard_tracks_metric` | dashboard | metric |
| `experiment_produces_learning` | experiment (with `experiment_type: "ab_test"`) | learning |

### DevOps & Platform

| Edge Type | From | To |
|---|---|---|
| `service_has_service_level_indicator` | service | service_level_indicator |
| `service_level_objective_measured_by_service_level_indicator` | service_level_objective | service_level_indicator |
| `service_has_monitor` | service | monitor |
| `incident_has_postmortem` | incident | postmortem |
| `postmortem_produces_runbook` | postmortem | runbook |

### Security

| Edge Type | From | To |
|---|---|---|
| `service_has_threat_model` | service | threat_model |
| `threat_model_has_vulnerability` | threat_model | vulnerability |
| `vulnerability_has_security_control` | vulnerability | security_control |

### QA & Testing

| Edge Type | From | To |
|---|---|---|
| `feature_has_test_suite` | feature | test_suite |
| `test_suite_has_test_case` | test_suite | test_case |
| `release_has_qa_session` | release | qa_session |

### Feedback & VoC

| Edge Type | From | To |
|---|---|---|
| `feature_request_informs_opportunity` | feature_request | opportunity |
| `feedback_theme_has_feature_request` | feedback_theme | feature_request |
| `nps_campaign_produces_feedback_theme` | nps_campaign | feedback_theme |
| `beta_program_produces_learning` | beta_program | learning |

### Pricing & Packaging

| Edge Type | From | To |
|---|---|---|
| `pricing_strategy_has_experiment` | pricing_strategy | experiment (with `experiment_type: "pricing"`) |
| `pricing_strategy_has_pricing_tier` | pricing_strategy | pricing_tier |
| `pricing_tier_has_trial_config` | pricing_tier | trial_config |

### AI/ML Operations

| Edge Type | From | To |
|---|---|---|
| `ai_model_has_prompt_version` | ai_model | prompt_version |
| `ai_model_has_eval_benchmark` | ai_model | eval_benchmark |
| `eval_benchmark_produces_learning` | eval_benchmark | learning |

### Portfolio

| Edge Type | From | To |
|---|---|---|
| `organization_has_portfolio` | organization | portfolio |
| `portfolio_has_product_area` | portfolio | product_area |
| `product_area_has_product` | product_area | product |

