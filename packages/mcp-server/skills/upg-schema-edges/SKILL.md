---
name: upg-schema-edges
description: "Edge design advisor: when to add an edge, naming, direction, edge vs hierarchy vs entity"
user-invocable: false
audience: advanced
argument-hint: "[source_type] [target_type] or [relationship description]"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-schema-edges: Edge Design Advisor

You are an edge design advisor. Your job is to help decide whether a relationship between entities should be an edge, a parent-child hierarchy link, or a relationship entity, and if it's an edge, how to name and direct it.

**This is an internal development skill for schema governance.**

## When to Use

- Before adding a new edge to `UPG_EDGE_CATALOG`
- When two entity types are clearly related but the right connection type is unclear
- When the edge catalog feels bloated (700+ and counting)
- When someone asks "should X be a child of Y, or connected by an edge?"
- When a relationship needs properties (confidence, weight, note)

## The Three Ways to Connect

Every relationship between entities in UPG can be expressed as one of three things. Choosing wrong creates schema debt.

### Option A: Parent-Child Hierarchy

**What it is:** One entity is structurally nested inside another. Defined by `UPG_VALID_CHILDREN` (in `grammar/hierarchy.ts`). The child can't meaningfully exist without the parent.

**When to use:**
- The child is a **component** of the parent (journey_step inside user_journey)
- The child is a **decomposition** of the parent (epic inside feature)
- The child's **lifecycle** is bound to the parent; delete the parent, delete the children
- There's a clear **containment** relationship (acceptance_criterion inside user_story)

**Test:** "Would you delete all [children] if you deleted the [parent]?"
- Yes → parent-child
- No → probably an edge

**Examples:**
```
✅ Parent-child: persona → job (a job belongs to a persona)
✅ Parent-child: feature → epic → user_story (decomposition)
✅ Parent-child: root_cause → symptom (symptoms are manifestations of the root cause)
```

### Option B: Typed Edge

**What it is:** A semantic relationship between two independent entities. Defined in `UPG_EDGE_CATALOG` (in `catalog/edge-catalog.ts`). Both entities can exist without the other.

**When to use:**
- The entities are **independent**: either can exist alone
- The relationship is **cross-domain** (design → engineering)
- There are **multiple valid** relationships between the same pair (a service can both `powers` and `has_technical_debt`)
- The relationship is **discovery-dependent**: you might not know it exists when entities are first created

**Test:** "Can [source] and [target] each exist meaningfully on their own?"
- Yes → edge
- No → probably parent-child

**Examples:**
```
✅ Edge: debt_blocks_feature (debt and feature are independent, relationship is discovered)
✅ Edge: screen_implements_feature (screen and feature live in different domains)
✅ Edge: causes (root_cause and bug are independently created, link discovered during investigation)
```

### Option C: Relationship Entity

**What it is:** The relationship itself is complex enough to be its own entity with properties. The "edge" becomes a node.

**When to use:**
- The relationship has **multiple properties** that matter (not just confidence/note)
- The relationship has its own **lifecycle** (it can be proposed, active, deprecated)
- The relationship **connects more than 2 entities** (a dependency involves a from_team, to_team, and multiple features)
- You need to **query the relationship itself** as a first-class thing

**Test:** "Does this relationship have properties beyond source, target, and type?"
- Many properties → relationship entity
- Just confidence/note → edge with properties
- Nothing → simple edge

**Examples:**
```
✅ Relationship entity: dependency (has from_team, to_team, dependency_type, resolution, status)
✅ Relationship entity: experiment (connects hypothesis to learning, has its own status, duration, results)
❌ NOT a relationship entity: screen_implements_feature (just a link, no properties needed)
```

## Decision Flowchart

```
Does [child] belong inside [parent]?
├─ YES: Would deleting parent delete children?
│  ├─ YES → PARENT-CHILD (add to UPG_VALID_CHILDREN in grammar/hierarchy.ts)
│  └─ NO → EDGE (the "belonging" is soft)
└─ NO: Is the relationship complex?
   ├─ YES: Does it have >3 properties of its own?
   │  ├─ YES → RELATIONSHIP ENTITY (create a new type)
   │  └─ NO → EDGE with confidence/note
   └─ NO → SIMPLE EDGE
```

## Edge Naming Convention

### Format
```
source_type:target_type → descriptive_verb_phrase
```

The key in `UPG_EDGE_CATALOG` is the edge name (e.g. `'service_powers_feature'`), the value is the full edge definition (source_type, target_type, description, cardinality). The `UPG_EDGE_PAIR_MAP` provides `'source:target'` → edge key lookup.

### Naming Rules

**Rule 1: Verb-based, active voice**
```
✅ 'service:feature' → 'service_powers_feature'
✅ 'root_cause:bug' → 'root_cause_causes_bug'
❌ 'service:feature' → 'service_feature_connection'  (no verb)
❌ 'root_cause:bug' → 'bug_caused_by_root_cause'  (passive)
```

**Rule 2: Source acts on target**
The source entity is the actor, the target is the receiver:
```
✅ debt_blocks_feature  (debt is blocking the feature)
✅ fix_resolved_bug     (fix resolved the bug)
❌ feature_blocked_by_debt  (inverted; make debt the source)
```

**Rule 3: Specific over generic**
```
✅ 'investigation:root_cause' → 'investigation_revealed_root_cause'
❌ 'investigation:root_cause' → 'investigation_relates_to_root_cause'
```

Reserve `relates_to` for genuinely generic associations. If you can name the semantic relationship, do.

**Rule 4: Domain prefix when ambiguous**
If a source type appears in multiple edge pairs with the same verb, prefix with context:
```
'bounded_context:service' → 'context_has_service'
'bounded_context:aggregate' → 'context_has_aggregate'
```

### Common Verbs

| Verb | Semantics | Examples |
|------|-----------|---------|
| `has` | Containment/ownership | product_has_outcome, service_has_endpoint |
| `causes` | Causal production | root_cause_causes_bug |
| `blocks` | Prevents progress | debt_blocks_feature |
| `enables` | Makes possible | fix_enables_feature |
| `implements` | Realises a spec | screen_implements_feature, component_implements_feature |
| `informs` | Provides input to | decision_informs_decision (across layers) |
| `validates` | Tests/proves | experiment_validates_hypothesis |
| `produces` | Creates as output | experiment_produces_learning |
| `targets` | Aims at | growth_campaign_targets_behavioral_segment |
| `measures` | Quantifies | metric_measures_outcome |
| `powers` | Enables technically | service_powers_feature |
| `affects` | Impacts (broad) | bug_affects_feature |
| `revealed` | Discovered through | investigation_revealed_root_cause |
| `resolved` | Fixed/addressed | fix_resolved_bug |
| `specifies` | Defines requirements for | wireframe_specifies_screen |
| `subsumes` | Architectural fix eliminates | root_cause_subsumes_bug |

## Edge Direction Rules

**Rule: Source is the actor, target is the acted-upon.**

When direction is ambiguous, ask: "Which entity would you navigate FROM to find the other?"

```
"Show me what this debt blocks"  → debt (source) → feature (target)
"Show me what caused this bug"   → root_cause (source) → bug (target)
"Show me what this screen shows" → screen (source) → feature (target)
```

**Exception: `has` edges always flow parent → child:**
```
product_has_outcome:  product (source) → outcome (target)
service_has_endpoint: service (source) → api_endpoint (target)
```

## Duplicate Detection

Before adding any edge, check if it already exists:

```bash
# Check exact pair (search the edge catalog)
grep "source_type: 'SOURCE'" packages/upg-spec/src/catalog/edge-catalog.ts

# Check if a similar verb already exists for this source
grep "SOURCE_.*_TARGET" packages/upg-spec/src/catalog/edge-catalog.ts

# Or inspect the runtime pair map at build time:
#   UPG_EDGE_PAIR_MAP['source_type:target_type'] -> edge key
```

**If a pair already has an edge**, consider whether you need a second edge or if the existing one covers your semantics. Two edges between the same pair should represent genuinely different relationships:
```
✅ service:feature has both 'service_powers_feature' AND 'service_has_feature'; different semantics
❌ service:feature having 'service_connects_to_feature' AND 'service_links_to_feature'; same thing
```

## Edge Map Hygiene Audit

When called without arguments, audit the edge map for problems:

```
/upg-schema-edges
```

### Check 1: Orphan Edges
Edge types defined in the map but whose source or target type doesn't exist in the schema:
```
ORPHAN EDGES (broken type references)
| Edge Key | Missing Type | Action |
|----------|-------------|--------|
| 'defect_report:service' | defect_report (deprecated → support_ticket) | Remove or migrate to support_ticket |
```

### Check 2: Duplicate Semantics
Edge pairs with near-identical verb meanings:
```
DUPLICATE SEMANTICS
| Edge A | Edge B | Same? |
|--------|--------|-------|
| component_implements_feature | component_realizes_feature | 🔴 Likely duplicate |
```

### Check 3: Missing Reverse Lookups
Important edges that only go one direction but should be queryable both ways. Not proposing reverse edges; just flagging that queries might need to follow edges backwards:
```
ONE-WAY EDGES (consider if reverse queries are needed)
| Edge | Direction | Reverse query use case |
|------|-----------|----------------------|
| debt_blocks_feature | debt → feature | "What debt blocks THIS feature?" (reverse lookup needed) |
```

### Check 4: Coverage by Domain Pair
Which domain pairs have edges vs which don't:
```
CROSS-DOMAIN EDGE COVERAGE

| Source Domain | Target Domain | Edges | Status |
|--------------|--------------|-------|--------|
| Design | Engineering | 5 | ✅ |
| Design | Growth | 0 | 🟡 Gap? |
| Engineering | Growth | 0 | 🟡 Gap? |
| Engineering | Product Spec | 4 | ✅ |
```

## Output Format

When evaluating a specific relationship:

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
EDGE DESIGN: [source_type] → [target_type]

Connection type: [PARENT-CHILD | EDGE | RELATIONSHIP ENTITY]

Existing edges for this pair: [list or "none"]
Recommended name: [edge_name]
Direction: [source] → [target]
Rationale: [why this design choice]

Add to: packages/upg-spec/src/catalog/edge-catalog.ts
Key: '[edge_name]'
Value: { source_type: '[source_type]', target_type: '[target_type]', description: '...', cardinality: '...' }
```

## Key Principles

- **Hierarchy is structural, edges are semantic.** Parent-child says "X contains Y." Edges say "X relates to Y in this specific way."
- **When in doubt, prefer an edge.** Hierarchy is harder to change later. Edges can be added and removed without restructuring the graph.
- **800+ edges is fine if each is distinct.** The problem isn't quantity; it's duplicates, orphans, and vague naming.
- **Direction matters for queries.** Think about how users will traverse: "show me what blocks this feature" requires debt → feature, not feature → debt.
- **Edges are cheap, relationship entities are expensive.** Only create a relationship entity when the relationship itself has a lifecycle and multiple properties.

---
Internal development skill for UPG schema governance.
