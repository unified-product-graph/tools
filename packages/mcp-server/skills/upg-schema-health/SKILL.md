---
name: upg-schema-health
description: "Schema usage audit: dead types, empty properties, orphan patterns, real vs theoretical"
user-invocable: false
audience: advanced
argument-hint: "[path to .upg file] or [domain]"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-schema-health: Schema Usage Audit

You are a schema health auditor. Your job is to compare what the UPG schema defines against what real graphs actually contain; surfacing dead types, empty properties, unused edges, and patterns the schema didn't anticipate.

**This is the feedback loop for schema governance.** Without it, we add types speculatively and never learn if they were right.

## When to Use

- After adding new entity types; are they being used?
- Before a major schema evolution; what's dead weight?
- When a user reports confusion; is the schema matching their mental model?
- Periodically (quarterly): schema hygiene check
- When onboarding a new domain (e.g., Felix bringing engineering); what does their graph actually contain?

## Input Modes

**Mode 1: Audit a specific graph**
```
/upg-schema-health .upg/entopo.upg
```

**Mode 2: Audit all graphs in workspace**
```
/upg-schema-health
```

**Mode 3: Audit a specific domain against real data**
```
/upg-schema-health engineering
```

## Phase 1: Gather Data

### 1a. Load the Graph(s)

Use MCP tools to read the graph:
```
get_product_context(include_summary: true)
get_graph_digest()
list_nodes({ limit: 200 })
```

If auditing multiple graphs, repeat for each `.upg` file via `list_local_products()` and `switch_product()`.

### 1b. Load the Schema

Read the schema definition:
```
Read packages/upg-spec/src/domains.ts     → all domains and their types
Read packages/upg-spec/src/entity-meta.ts → all registered types with maturity
Read packages/upg-spec/src/index.ts       → all edge types
```

## Phase 2: Type Usage Analysis

### 2a. Used vs Defined

Compare types present in the graph against types defined in the schema:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
TYPE USAGE ANALYSIS

Schema defines: 310 entity types (across 36 atomic domains, 10 canonical regions)
Graph uses:     47 entity types
Coverage:       21%

BY DOMAIN:
| Domain | Defined | Used | Coverage | Status |
|--------|---------|------|----------|--------|
| Strategic | 14 | 8 | 57% | 🟢 Active |
| User | 6 | 4 | 67% | 🟢 Active |
| Engineering | 26 | 3 | 12% | 🟡 Sparse |
| Design | 22 | 0 | 0% | 🔴 Unused |
| Growth | 9 | 0 | 0% | 🔴 Unused |
```

### 2b. Dead Types

Types defined in the schema but with zero instances across all audited graphs:

```
DEAD TYPES (0 instances in any graph)

Engineering (23 of 26 unused):
  ⚪ aggregate, domain_entity, value_object, command, read_model,
     queue_topic, build_artifact, integration_pattern, ...

Design (22 of 22 unused):
  ⚪ user_journey, journey_step, design_question, design_concept, ...
```

**Classify each dead type:**
- **Too new**: added recently, hasn't had time to be used (check `since` in entity-meta)
- **Too specialised**: only relevant at scale-up/enterprise tier (check tier classification)
- **Wrong abstraction**: the concept exists in the user's world but the type doesn't match their mental model
- **Genuinely unnecessary**: deprecation candidate

### 2c. Surprise Types

Types present in the graph that aren't in the schema (via `source_type` or custom type strings):

```
SURPRISE TYPES (in graph but not in schema)

| Type String | Count | Source | Interpretation |
|-------------|-------|--------|----------------|
| "user_segment" | 3 | manual | → Should map to 'market_segment' or 'behavioral_segment' |
| "tech_spike" | 2 | upg-capture | → Candidate for new type? Or map to 'investigation'? |
```

These are gold; they tell you what users actually need that the schema doesn't provide.

## Phase 3: Property Usage Analysis

### 3a. Property Fill Rates

For each type that has instances, check how many of its defined properties are actually populated:

```
PROPERTY FILL RATES

| Type | Instances | Avg Properties Filled | Empty Properties |
|------|-----------|----------------------|------------------|
| persona | 5 | 8/12 (67%) | segment, recruit_source, consent_status, switching_costs |
| hypothesis | 8 | 3/7 (43%) | expected_outcome, timeframe, success_criteria, null_hypothesis |
| service | 3 | 2/8 (25%) | tech_stack, repo_url, ci_status, health_check, team_owner, status |
```

**Flag types with <30% fill rate**: the properties might be:
- Too granular for the user's stage
- Named confusingly (user doesn't recognise the field)
- Better suited as optional future enrichment than required at creation

### 3b. Properties Used But Not Defined

Check for properties in graph nodes that aren't in the schema's property interface:

```
UNSCHEMATISED PROPERTIES

| Type | Property | Count | Values Seen |
|------|----------|-------|-------------|
| feature | "priority" | 12 | "high", "medium", "low" |
| bug | "browser" | 4 | "chrome", "firefox", "safari" |
| persona | "company_size" | 3 | "startup", "enterprise" |
```

These are candidates for adding to the property interfaces; the user is already using them.

## Phase 4: Edge Usage Analysis

### 4a. Used vs Defined Edges

```
EDGE USAGE

Schema defines: 800+ edge types
Graph uses:     23 edge types
Coverage:       3%

MOST USED EDGES:
| Edge Type | Count | Between |
|-----------|-------|---------|
| persona_pursues_job | 15 | persona → job |
| job_has_need | 12 | job → need |
| feature_has_epic | 8 | feature → epic |

NEVER-USED EDGES (in defined domains that ARE used):
| Edge Type | Source Domain | Target Domain | Status |
|-----------|-------------|---------------|--------|
| evidence_supports_hypothesis | validation | validation | ⚪ Available but unused |
| insight_informs_opportunity | ux_research | discovery | ⚪ Available but unused |
```

### 4b. Implicit Relationships

Look for nodes that are semantically related but not connected by edges. These suggest missing edges or edges the user doesn't know about:

```
IMPLICIT RELATIONSHIPS (nodes likely related but unconnected)

| Node A | Node B | Why related | Missing edge? |
|--------|--------|-------------|--------------|
| "Auth redesign" (feature) | "OAuth migration" (tech_debt) | Same domain keywords | debt_blocks_feature? |
| "Mobile persona" (persona) | "App Store channel" (acquisition_channel) | channel_targets_persona? |
```

## Phase 5: Structural Health

### 5a. Orphan Rate by Type

```
ORPHAN ANALYSIS

| Type | Total | Orphaned | Orphan Rate | Concern |
|------|-------|----------|-------------|---------|
| feature | 12 | 2 | 17% | 🟡 2 features with no parent or children |
| hypothesis | 8 | 5 | 63% | 🔴 Most hypotheses disconnected |
| task | 6 | 6 | 100% | 🔴 All tasks are orphans; wrong parent? |
```

**High orphan rates suggest:**
- Parent-child hierarchy doesn't match user's mental model
- The creation flow (skill) doesn't prompt for connections
- The type is being used as a standalone note, not a graph entity

### 5b. Chain Completeness

Check the key chains that make the graph useful:

```
CHAIN HEALTH

persona → job → need → opportunity → solution → hypothesis → experiment → learning
  5/5      4/5    3/5     2/5           1/5         1/5          0/5         0/5

Chain breaks at: opportunity → solution (only 1 of 2 opportunities has solutions)
Chain dies at: experiment (no experiments exist)

→ Discovery is strong, validation is absent
```

## Phase 6: Recommendations

Synthesise findings into actionable recommendations:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
SCHEMA HEALTH SUMMARY

Graph: [name] · [N] nodes · [M] edges · [T] types used

🟢 HEALTHY
- [list what's working well]

🟡 ATTENTION
- [list things that need review]

🔴 ACTION NEEDED
- [list things that need fixing]

RECOMMENDATIONS:
1. [Most impactful action]; /upg-schema-evolve [domain]
2. [Second action]; /upg-schema-consolidate [types]
3. [Third action]; consider deprecating [types]

DEAD TYPE CANDIDATES FOR DEPRECATION:
- [types with 0 usage across all audited graphs AND >6 months old]

PROPERTY ENRICHMENT CANDIDATES:
- [unschematised properties that appear in >3 instances]

SURPRISE TYPES TO INVESTIGATE:
- [custom types that might warrant schema addition]
```

## Key Principles

- **Real data over theory.** A type with 0 instances isn't wrong; it might be too new, too specialised, or genuinely unnecessary. The data tells you which.
- **Surprise types are the most valuable signal.** When users create types the schema doesn't have, that's direct feedback on what's missing.
- **Property fill rates reveal UX problems.** A 25% fill rate doesn't mean the properties are wrong; it might mean the creation skill doesn't ask for them.
- **Orphan rate reveals hierarchy problems.** 100% orphan rate on a type means the parent-child model is wrong for how users think about that concept.
- **Run this before and after schema changes.** The "before" establishes a baseline; the "after" tells you if the change helped.
- **Cross-graph analysis is more valuable than single-graph.** One graph's habits aren't representative. Compare multiple graphs to separate user preference from schema design issues.

---
Internal development skill for UPG schema governance.
