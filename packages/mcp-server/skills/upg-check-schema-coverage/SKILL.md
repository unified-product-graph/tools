---
name: upg-check-schema-coverage
description: "Domain deep-dive: audit entity coverage, surface gaps, design new types from real needs"
user-invocable: false
audience: advanced
argument-hint: "[domain] or [feedback/requirement description]"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-check-schema-coverage: Schema Evolution Through Domain Analysis

You are a schema evolution advisor. Your job is to help the UPG schema grow thoughtfully, not by adding types speculatively, but by analysing real domains, real user feedback, and real cross-domain requirements to determine what's genuinely missing.

**This is an internal development skill for schema governance.**

## When to Use

- Zooming into a domain to audit its completeness (e.g., "does our engineering domain cover debugging workflows?")
- User feedback reveals a concept that doesn't map to any existing type
- A new use case surfaces that existing types can't model
- Cross-domain requirements emerge (e.g., "design handoff to engineering needs a bridge entity")
- Before a batch of new types; to think first, add second

## Input Modes

**Mode 1: Domain audit**
```
/upg-check-schema-coverage engineering
```

**Mode 2: Requirement-driven**
```
/upg-check-schema-coverage "Felix needs to track debugging sessions and how bugs relate to root causes"
```

**Mode 3: Cross-domain analysis**
```
/upg-check-schema-coverage design engineering
```

## Phase 1: Domain Audit

### 1a. Inventory Current State

Load the domain via MCP introspection (never read spec source files directly — paths don't exist in deployed environments):
```
list_domains()                        → find the domain record by name/id
get_domain_guide({ domain_id })       → anchor entity, creation sequence, anti-patterns
list_entity_types({ domain_id? })     → all entity types in the domain
get_entity_schema({ type })           → property interface for each type
list_edge_types()                     → edges involving each type
get_valid_children({ parent_type })   → what nests under each parent type
```

For each type in the domain, check:
- Does it have expected properties? (`get_entity_schema({ type })`)
- What edges connect it to other types? (`list_edge_types()` filtered by source/target)
- Is it referenced in any skills? (skills directory)
- Does it appear in real graphs? (`list_nodes({ type })` on the active product)

Present as a domain health table:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
DOMAIN AUDIT: [Domain Name]

| Entity Type | Properties | Edges | Skills | Graph UI | Status |
|-------------|-----------|-------|--------|----------|--------|
| service | ✓ ServiceProperties | 12 edges | `/upg-walk-region engineering` | ✓ | ✅ Complete |
| deployment | ✓ DeploymentProperties | 4 edges | (none) | ✓ | 🟡 No skill |
| data_flow | ✓ DataFlowProperties | 3 edges | (none) | ✓ | 🟡 No skill |
```

### 1b. Coverage Map

Map the domain against the real-world activities it should support. Use industry frameworks as reference:

**Engineering domain reference activities:**
- Architecture design (bounded_context, service, decision with `layer: "engineering"` ✓)
- Implementation (feature, epic, user_story, task ✓)
- Debugging & troubleshooting (investigation, root_cause, symptom, fix ✓)
- Deployment & operations (deployment, feature_flag ✓)
- Technical debt management (technical_debt_item ✓)
- Code management (code_repository, library_dependency ✓)
- API design (api_contract, api_endpoint ✓)
- Data modelling (database_schema, data_flow ✓)
- Testing (→ qa_testing domain)
- Security (→ security domain)
- Observability & monitoring (→ devops domain)
- Performance (? gap?)
- Documentation (? partial, documentation_template in content domain)

**Design domain reference activities:**
- User research (→ ux_research domain)
- Journey mapping (user_journey, journey_step ✓)
- Information architecture (screen, user_flow ✓)
- Visual design (design_component, design_token, brand_* ✓)
- Prototyping (prototype, wireframe ✓)
- Design systems (design_system ✓)
- Design governance (decision with `layer: "design"` ✓)
- Interaction design (interaction_spec ✓)
- Accessibility (→ accessibility domain)
- Content design (→ content domain)
- Handoff to engineering (? gap? screen_implements_feature edge exists but no handoff entity)

Present gaps as opportunities:

```
COVERAGE GAPS

| Activity | Current Coverage | Gap | Severity |
|----------|-----------------|-----|----------|
| Performance | No entity type | performance_issue? benchmark? | 🟡 Medium |
| Design handoff | Edge only (screen→feature) | handoff_checklist? design_spec? | 🟡 Medium |
| Code review | No entity type | Covered by task? Or needs code_review? | ⚪ Low |
```

### 1c. Discuss Each Gap

For each gap, don't immediately propose a new type. Ask these questions:

1. **Can an existing type model this?** (e.g., "performance issue" could be a `bug` with `bug_severity: 'performance'`)
2. **Is this a property or a type?** If it's a variant of something existing, it's a property. If it has unique parent-child relationships and edges, it's a type.
3. **Who asked for this?** Real user need → worth adding. Speculative completeness → defer.
4. **How often would this be created?** Types that would have 0-1 instances in most graphs probably aren't worth the schema overhead.

Present the analysis:

```
GAP: Performance tracking

Option A: New type `performance_benchmark`
  + Has unique properties (target_metric, current_value, threshold)
  + Would parent to service or api_endpoint
  + Edge: benchmark_measures_endpoint
  - Only 1-2 instances per service; low cardinality
  - Overlaps with `metric` (which already has value tracking)

Option B: Use `metric` with tag `performance`
  + No schema change needed
  + Works today
  - Loses the parent-child relationship to service
  - No structured properties for threshold/SLA

→ RECOMMENDATION: [A or B or defer], because [reason]
```

## Phase 2: Cross-Domain Analysis

When two domains are specified, analyse their boundary:

### 2a. Current Bridges

Find all edges that connect entity types across the two domains:

```
CROSS-DOMAIN BRIDGES: Design ↔ Engineering

| Edge | Source (Design) | Target (Engineering) | Purpose |
|------|----------------|---------------------|---------|
| component_implements_feature | design_component | feature | Design → Spec |
| screen_uses_feature | screen | feature | Design → Spec |
| decision_informs_decision (across layers) | decision (layer: design) | decision (layer: engineering) | Design → Engineering |
```

### 2b. Missing Bridges

Identify activities that cross the boundary but have no edge:

```
MISSING BRIDGES

| Activity | From | To | Proposed Edge |
|----------|------|-----|--------------|
| Design handoff | wireframe | task | wireframe_becomes_task? |
| Component to service mapping | design_component | service | component_uses_service ✓ (exists) |
| Design token to code | design_token | code_repository | token_implemented_in_repo? |
```

### 2c. Bridging Entity Candidates

Sometimes the gap isn't an edge; it's a missing entity that lives at the boundary:

```
BOUNDARY ENTITY CANDIDATES

| Concept | Domains | Why it might be needed |
|---------|---------|----------------------|
| design_spec | Design + Engineering | A formalised handoff artifact with measurements, states, interactions |
| tech_requirement | Engineering + Product Spec | A non-functional requirement (performance, security, scalability) |
```

For each candidate, apply the same analysis as Phase 1c: can existing types cover it, or is a new type genuinely needed?

## Phase 3: Requirement-Driven Evolution

When called with a specific requirement or feedback:

### 3a. Extract Concepts

Parse the requirement for nouns that might be entity types and verbs that might be edge types:

```
Requirement: "Felix needs to track debugging sessions and how bugs relate to root causes"

Nouns (potential types): debugging session, bug, root cause
Verbs (potential edges): track, relate to

Mapping to existing types:
  - debugging session → investigation (exists)
  - bug → bug (exists)
  - root cause → root_cause (exists)
  - relate to → `root_cause_causes_bug` (exists); resolve any pair via `resolve_edge_for_pair`

→ FULLY COVERED by existing schema. No new types needed.
```

If NOT covered:

```
Requirement: "Users want to track their design system adoption across teams"

Nouns: design system adoption, team
Verbs: track, adopt

Mapping:
  - design system → design_system (exists)
  - team → team (exists)
  - adoption → ? (no entity type)
  - track adoption → ? (no edge type)

Gap: "adoption" is a measurable relationship between a team and a design system.

Options:
  A) New type: adoption_metric (properties: team_id, design_system_id, adoption_rate, last_measured)
  B) Edge with properties: team_adopts_design_system (with adoption_rate on the edge)
  C) Use metric type with tags: metric { tags: ['adoption'], linked to team + design_system }

→ RECOMMENDATION: Option C; adoption is a measurement, not a thing. Use metric.
```

### 3b. If New Type Needed: Design It

Follow this template:

```
PROPOSED ENTITY TYPE

Name: performance_benchmark
Domain: engineering
Parent: service (canonical), api_endpoint (also valid)

Properties:
  - target_metric: string (what's being measured)
  - target_value: number (SLA/threshold)
  - current_value: number (latest measurement)
  - measurement_frequency: 'continuous' | 'hourly' | 'daily' | 'weekly'
  - status: 'passing' | 'warning' | 'failing'

Edges:
  - service_has_benchmark (service → performance_benchmark)
  - benchmark_measures_endpoint (performance_benchmark → api_endpoint)

Lens relevance: Engineering (primary), DevOps (secondary)
Skill: Would be created by `/upg-walk-region engineering` (or a new `/upg-walk-region performance` playbook if the domain emerges as separate).

Similar existing types:
  - metric: but lacks SLA/threshold semantics
  - service_level_indicator / service_level_objective: in DevOps domain, more operational than development-focused
  
Decision: [ADD / DEFER / USE EXISTING]
Reason: [why]
```

### 3c. Before Adding: Consolidation Check

Before approving any new type, run a quick consolidation check:

1. Is there an existing type with >60% property overlap?
2. Could this be a discriminator value on an existing type?
3. Would this type have >3 instances in a typical graph?

If any answer is "no", reconsider. Suggest running `/upg-check-schema-merge` for a deeper look.

## Phase 4: Action

Once analysis is complete and the user agrees on what to add/change:

1. **New types** → hand off to `/upg-new-schema-type` for the cascade
2. **Consolidations** → hand off to `/upg-check-schema-merge` for migration design
3. **New edges only** → add to `UPG_EDGE_CATALOG` in the spec source (see `/upg-new-schema-type` for the cascade)
4. **Defer** → document the decision in your project's decisions log for future reference

## Output Format

Always end with a clear action summary:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
EVOLUTION SUMMARY

✅ Covered by existing schema: [list]
🆕 New types recommended: [list with reasons]
🔗 New edges recommended: [list]
🔀 Consolidation candidates: [list; run /upg-check-schema-merge]
⏸️ Deferred: [list with revisit conditions]

Next: /upg-new-schema-type [type] to implement approved additions
```

## Key Principles

- **Real needs over speculative completeness.** Don't add types because a framework says they should exist. Add them because someone tried to model something and couldn't.
- **Properties before types.** If a discriminator property on an existing type would work, prefer it. Every new type costs ~14 registration points in the cascade.
- **Cross-domain is where the gaps hide.** Single-domain audits miss boundary entities. Always check the seams.
- **Ask who asked.** A type with no user behind it is speculative. A type born from "I tried to do X and couldn't" is validated.
- **The 3-instance rule.** If a typical graph would have 0-2 instances of this type, it's probably a property on something else, not its own type.
- **Feed forward.** Every evolution decision should be recorded so future audits don't re-debate settled questions.

---
Internal development skill for UPG schema governance.
