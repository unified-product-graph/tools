---
name: upg-check-schema-merge
description: "Evaluate whether entity types should merge: shared properties, structural analysis, migration path"
user-invocable: false
audience: advanced
argument-hint: "[type_a] [type_b] or [domain]"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-check-schema-merge: Entity Type Consolidation

You are a schema analyst. Your job is to evaluate whether two or more entity types should be consolidated into a single type with a discriminator property, or kept separate. You do this through structured analysis, not gut feeling.

**This is an internal development skill for schema governance.**

## When to Use

- Someone notices two types that "feel the same" (e.g., `architecture_decision` and `design_decision`)
- Schema review reveals types with >70% property overlap
- User feedback suggests confusion between similar types
- Domain audit surfaces redundancy
- Before adding a new type that resembles an existing one

## Input Modes

**Mode 1: Compare specific types**
```
/upg-check-schema-merge architecture_decision design_decision
```

**Mode 2: Scan a domain for candidates**
```
/upg-check-schema-merge engineering
```

## Analysis Framework

### Step 1: Property Overlap Analysis

Read the property interfaces from `packages/upg-spec/src/properties/`. Compare field by field:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
PROPERTY OVERLAP: [type_a] vs [type_b]

| Property | type_a | type_b | Shared? |
|----------|--------|--------|---------|
| status   | ✓ (proposed/accepted/deprecated/superseded) | ✓ (proposed/accepted/deprecated/superseded) | ✓ identical |
| context  | ✓ string | ✓ string | ✓ identical |
| severity | ✓ UPGAssessment | ✗ | ✗ |

Overlap: X/Y properties shared (Z%)
```

**Threshold:** >70% overlap = consolidation candidate. <40% = keep separate. 40-70% = needs deeper analysis.

### Step 2: Structural Position Analysis

This is the critical test. Check 4 structural dimensions:

**2a. Parent types**: Do they have the same canonical parent?
```
Read UPG_VALID_CHILDREN in grammar/hierarchy.ts
- type_a parent: bounded_context
- type_b parent: design_system
→ DIFFERENT parents = structural divergence
```

**2b. Child types**: Do they have the same children?
```
Search UPG_VALID_CHILDREN for entries where value = type_a or type_b
- type_a children: technical_debt_item
- type_b children: (none)
→ DIFFERENT children = structural divergence
```

**2c. Edge types**: Do they participate in the same relationships?
```
Search UPG_EDGE_CATALOG in catalog/edge-catalog.ts for both types
- type_a edges: context_has_decision, decision_has_technical_debt_item
- type_b edges: decision_informs_decision, decision_affects_component
→ DIFFERENT edges = semantic divergence
```

**2d. Domain membership**: Are they in the same domain?
```
Check registry/domains.ts
- type_a: engineering
- type_b: design
→ DIFFERENT domains = role divergence
```

**Score the structural analysis:**
- 4/4 same → Strong consolidation candidate
- 3/4 same → Likely consolidation candidate
- 2/4 same → Probably keep separate, but discuss
- 0-1/4 same → Keep separate

### Step 3: Usage Context Analysis

Check how each type is used in practice:

**3a. Skill references**: Which skills create/reference each type?
```
grep -r "type_a\|type_b" packages/upg-mcp-server/skills/
```

**3b. Lens relevance**: Do they appear in different lenses?
If type_a is surfaced in the engineering lens and type_b in the design lens, consolidation would muddy lens clarity.

**3c. Real-world mental models**: Would users think of these as "the same thing with a label" or "fundamentally different activities"?

This is where you engage the human. Ask:

> When you think about [type_a] and [type_b], do they feel like:
> 1. The same thing in different contexts (like "meeting" whether it's a standup or a retro)
> 2. Related but distinct activities (like "writing" vs "editing")
> 3. Completely different things that happen to share some fields

### Step 4: Consolidation Decision

Present the verdict as a structured recommendation:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
VERDICT: [CONSOLIDATE | KEEP SEPARATE | NEEDS DISCUSSION]

Property overlap: X% [HIGH/MEDIUM/LOW]
Structural alignment: Y/4 [ALIGNED/DIVERGENT]
Usage context: [SAME/DIFFERENT]

Recommendation: [explanation]
```

### Step 5: If Consolidating: Migration Design

If the decision is to consolidate:

**5a. Define the unified type:**
```
Unified type: decision
Discriminator: layer: 'engineering' | 'design' | 'product'
Properties: union of both property sets
  - Shared properties remain as-is
  - Type-specific properties become optional (only relevant when discriminator matches)
```

**5b. Define the migration:**
```
Deprecated types: architecture_decision → decision (layer: 'engineering')
                  design_decision      → decision (layer: 'design')
                  product_decision     → decision (layer: 'product')

Edge migrations (v0.2.0):
  context_has_architecture_decision           → context_has_decision
  design_decision_informs_architecture_decision → decision_informs_decision

Parent migration:
  architecture_decision parent=bounded_context → decision parent=bounded_context (when layer='engineering')
  design_decision       parent=design_system   → decision parent=design_system   (when layer='design')
```

**5c. Backwards compatibility:**
- Old types stay in `DeprecatedUPGEntityType` in types.ts
- `entity-meta.ts` marks them as `deprecated` with `replacement: 'decision'`
- `upg-migrate` skill handles the retyping
- Old `.upg` files with `architecture_decision` still parse and auto-migrate

**5d. Cascade the change** using `/upg-new-schema-type`

### Step 5 (Alternative): If Keeping Separate: Document Why

If the decision is to keep separate, create a brief decision record:

```
## Schema Decision: [type_a] vs [type_b]

**Date:** YYYY-MM-DD
**Decision:** Keep separate
**Why:** [structural divergence explanation]
**Revisit when:** [conditions that would change this decision]
```

Save to a decisions log in your project (wherever your team keeps ADRs) for future reference.

## Domain Scan Mode

When called with a domain name instead of specific types:

1. List all types in the domain (from `domains.ts`)
2. For each pair, compute property overlap percentage
3. Flag pairs with >60% overlap as candidates
4. Present a summary table:

```
CONSOLIDATION CANDIDATES IN [DOMAIN]

| Pair | Overlap | Parents | Verdict |
|------|---------|---------|---------|
| type_a ↔ type_b | 85% | Same | 🟡 Review |
| type_c ↔ type_d | 45% | Different | ✅ Keep |
| type_e ↔ type_f | 92% | Same | 🔴 Consolidate |
```

Then deep-dive into any pair the user wants to investigate.

## Known Consolidation Precedents

These consolidations have already happened in UPG and can be referenced as patterns:

| Old Types | Unified As | Discriminator | Version |
|-----------|-----------|---------------|---------|
| `pain_point`, `user_need` | `need` | `valence: 'pain' \| 'gap' \| 'desire' \| 'constraint'` | 0.1.0 |
| `north_star_metric`, `input_metric`, `kpi`, `metric_definition` | `metric` | `designation` property | 0.1.0 |
| `research_insight`, `finding`, `ux_insight` | `insight` | `source_domain` / `insight_level` | 0.1.0 |
| `ab_test`, `growth_experiment`, `pricing_experiment` | `experiment` | `experiment_type` | 0.1.0 |
| `security_incident` | `incident` | `incident_type: 'security'` | 0.1.0 |
| `defect_report` | `support_ticket` | `ticket_designation: 'defect'` | 0.1.0 |
| `onboarding_flow` | `user_flow` | `flow_type: 'onboarding'` | 0.1.0 |
| `risk_item` | `risk` | `risk_domain: 'program'` | 0.1.0 |
| `architecture_decision`, `design_decision`, `product_decision` | `decision` | `layer: 'engineering' \| 'design' \| 'product'` | 0.2.0 |
| `jtbd` | `job` | (renamed, no discriminator) | 0.2.0 |
| `how_might_we` | `design_question` | (renamed; framework-neutral) | 0.2.0 |
| `sli`, `slo`, `sla` | `service_level_indicator`, `service_level_objective`, `service_level_agreement` | (acronyms expanded) | 0.2.0 |
| `customer_segment_bm`, `target_customer_segment` | `market_segment` | | 0.2.0 |
| `channel_bm` | `distribution_channel` | | 0.2.0 |
| `campaign` | `growth_campaign` | (disambiguated from marketing_campaign_plan) | 0.2.0 |
| `segment` | `behavioral_segment` | (disambiguated from market_segment) | 0.2.0 |
| `package` | `pricing_tier` | | 0.2.0 |
| `internal_doc` | `document` | `document_type`; audience=internal | 0.2.0 |

## Key Principles

- **Structure trumps semantics.** Two types with the same name but different parents, children, and edges are genuinely different. Two types with different names but identical structural positions should merge.
- **The discriminator must be a property, not a tag.** Tags are freeform; properties are typed. Use an enum property (e.g., `decision_domain: 'architecture' | 'design'`).
- **Migration is non-negotiable.** Every consolidation must preserve existing data. Old types become deprecated, not deleted.
- **Ask the user.** The mental model test (Step 3c) can't be automated. Engage.
- **Document the decision either way.** Whether you consolidate or keep separate, record why.

---
Internal development skill for UPG schema governance.
