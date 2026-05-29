---
name: upg-schema-changelog
description: "Generate a schema changelog: what changed between versions, migration notes, breaking changes"
user-invocable: false
audience: advanced
argument-hint: "[from_version] [to_version] or 'latest'"
category: schema
---

> ⚠️ **Advanced skill**: intended for UPG contributors and power users who understand the spec internals. Not for general use. Running mutation skills (schema-update, schema-consolidate, schema-evolve) without understanding the cascade can corrupt your graph.

# /upg-schema-changelog: Schema Changelog Generator

You are a schema changelog generator. Your job is to diff the UPG schema between versions and produce a human-readable changelog that tells adopters what changed, why, and how to migrate.

**This is an internal development skill for schema governance and external communication.**

## When to Use

- After a batch of schema changes; before cutting a release
- When preparing documentation for external adopters
- When someone asks "what changed in v0.2.0?"
- Before merging a PR that touches `packages/upg-spec/src/`

## Input Modes

**Mode 1: Diff against git**
```
/upg-schema-changelog latest
```
Compares current working state against the last tagged version.

**Mode 2: Between specific versions**
```
/upg-schema-changelog 0.1.0 0.2.0
```

**Mode 3: Current PR changes**
```
/upg-schema-changelog pr
```
Compares current branch against `origin/dev`.

## Data Sources

### Entity Types
```bash
# Current state
grep "name:" packages/upg-spec/src/registry/entity-meta.ts

# Previous state (from git)
git show origin/dev:packages/upg-spec/src/registry/entity-meta.ts | grep "name:"
```

### Edge Types
```bash
# Current edge catalog entries
grep -cE "^  [a-z_]+: \{" packages/upg-spec/src/catalog/edge-catalog.ts
git show origin/dev:packages/upg-spec/src/catalog/edge-catalog.ts | grep -cE "^  [a-z_]+: \{"
```

### Properties
```bash
# Current property interfaces
grep "export interface.*Properties" packages/upg-spec/src/properties/domains/*.ts
```

### UPGEdge / UPGBaseNode
```bash
# Check for structural shape changes
git diff origin/dev -- packages/upg-spec/src/shapes/
```

## Analysis Steps

### Step 1: Diff Entity Types

Compare `entity-meta.ts` between versions:

**Added types:** New entries (new `type_id` values)
**Deprecated types:** Entries where `maturity` changed to `'deprecated'`
**Removed types:** Entries where `maturity` changed to `'removed'`
**Renamed types:** Entries where `name` changed but `type_id` stayed the same

### Step 2: Diff Edge Types

Compare the `UPG_EDGE_CATALOG` in `catalog/edge-catalog.ts` (and the derived `UPG_EDGE_PAIR_MAP`):

**Added edges:** New key-value pairs
**Removed edges:** Pairs that existed before but don't now
**Renamed edges:** Same key, different value (semantic rename)

### Step 3: Diff Properties

Compare property interfaces in `properties/*.ts`:

**New interfaces:** New `export interface XxxProperties`
**Modified interfaces:** Changed fields in existing interfaces
**New base fields:** Changes to `UPGBaseNode` or `UPGEdge` in `schema.ts` / `types.ts`

### Step 4: Diff Domains

Compare `domains.ts`:

**New domains:** New entries in `UPG_DOMAINS`
**Modified domains:** Types added or removed from existing domains
**Domain renames:** Same types, different domain id/label

### Step 5: Classify Changes

For each change, classify as:

| Classification | Meaning | Migration impact |
|----------------|---------|-----------------|
| **Additive** | New types, edges, properties, or domains | None; old files still valid |
| **Deprecation** | Type marked deprecated with replacement | Warn on load, auto-migrate if possible |
| **Breaking** | Type removed, property renamed, edge direction changed | Old files need migration |
| **Enhancement** | New optional fields on existing interfaces | None; backwards compatible |

## Output Format

Generate a markdown changelog:

```markdown
# UPG Schema Changelog

## [0.2.0]: YYYY-MM-DD

### Summary
One paragraph describing the theme of this release (e.g., "Engineering lens support;
four new entity types for debugging workflows, causal edge vocabulary, and edge confidence.")

### Added

#### Entity Types
- `investigation` (Engineering): Active thread of inquiry for debugging and architecture exploration
- `root_cause` (Engineering): Underlying architectural or systemic issue
- `symptom` (Engineering): Observable behavior produced by a root cause
- `fix` (Engineering): Specific change that resolved an issue
- (Note: v0.2.0 consolidated `design_decision`, `architecture_decision`, and `product_decision` into the single `decision` type with a `layer` property; see 0.2.0 migration entry.)

#### Edge Types
- `causes`: root_cause → symptom/bug (causal production)
- `revealed_by`: investigation/fix → bug/root_cause (discovery)
- `same_root_cause`: symptom ↔ symptom (shared cause)
- `subsumes`: root_cause → bug (architectural fix eliminates quick-fix)
- `affects`: bug/root_cause → service/feature (impact)
- `screen_implements_feature`: screen → feature (design-to-spec bridge)
  [... and others]

#### Properties
- `InvestigationProperties`: investigation_status, hypothesis, findings, session_id, category
- `RootCauseProperties`: severity, category, affected_area, verified
- `SymptomProperties`: reproducibility, frequency, steps_to_reproduce
- `FixProperties`: commit, files_changed, verified, fixed_date
- `DecisionProperties`: layer ('engineering' | 'design' | 'product'), status, context, decision, consequences

#### Edge Interface
- `UPGEdge.confidence`: Optional causal confidence: `'verified' | 'likely' | 'speculative'`
- `UPGEdge.note`: Optional note explaining why this relationship exists

### Changed
- Engineering domain expanded from 22 to 26 entity types
- Design domain expanded from 21 to 22 entity types

### Deprecated
(none in this release)

### Breaking Changes
(none in this release)

### Migration Guide
No migration needed; all changes are additive. Existing .upg files are fully compatible.
Old tools that don't recognise new types will preserve them as opaque nodes (type stored as string).

### Cascade Status
| Layer | Status |
|-------|--------|
| @unified-product-graph/core | ✅ Updated |
| upg-mcp-server | ✅ Updated (lens-aware context) |
| apps/graph | ✅ Updated (all registries) |
| upg-cloud-server | 🟡 Edge confidence/note not persisted yet |
| apps/upg-site | ⏸️ Docs update deferred |
```

## Where to Save

Save the changelog in two places:

1. **`packages/upg-spec/CHANGELOG.md`**: Cumulative, all versions. Append new version at the top.
2. **PR description**: Include the summary section in the PR body for review.

If the file doesn't exist yet, create it with a header:

```markdown
# UPG Schema Changelog

All notable changes to the UPG specification are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

---
```

## Automation Hooks

### Pre-release Check

Before tagging a release, run this skill to ensure the changelog is up to date:

```bash
# Compare current vs last tag
git diff $(git describe --tags --abbrev=0) -- packages/upg-spec/src/
```

If there are schema changes not reflected in CHANGELOG.md, flag them.

### PR Template Integration

When a PR touches `packages/upg-spec/src/`, the changelog section should be included in the PR description. The skill can generate this automatically.

## Key Principles

- **Theme over list.** Start with a one-paragraph summary that tells the story ("Engineering lens support"), not just a list of changes.
- **Migration is the most important section.** External adopters care most about "will my files break?"
- **Cascade status shows completeness.** A schema change isn't done until all layers are updated.
- **Additive changes are safe.** Any change that only adds new types, edges, or optional properties is backwards compatible. Say so explicitly.
- **Breaking changes need a migration guide.** Step-by-step instructions, not just "things changed."
- **Keep it diffable.** The changelog should itself be git-friendly. Each version is a section with clear headers.

---
Internal development skill for UPG schema governance.
