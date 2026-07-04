# portfolio-saturated fixture

A fictional company — **Meridian Flight Systems** (fleet-operations SaaS) —
built to battle-test every portfolio-level feature the UPG spec supports.
Structurally modelled on the real Sanity `.upg` portfolio (`_Sanity/.upg`):
`products/`, `competitors/`, `design-system/`, `web-ecosystem/`, an org-rollup
file at the workspace root, and a `portfolio.upg` holding portfolios, areas,
and the canonical registry. Content is fictional; only the *shape* is
borrowed. This is a companion to the `notion-saturated` fixture
(`packages/test-utils/src/notion-saturated/`), which saturates single-graph
entity/property coverage — this one saturates the **portfolio** layer:
multi-product structure, cross-edges, the registry tier, and member-kind
grading.

## Regenerating

```
cd packages/upg-mcp-server
npx tsx scripts/build-portfolio-saturated.ts
```

The script drives the real MCP tool handlers (`create_portfolio`,
`create_area`, `create_cross_product_edge`, `register_instance`,
`create_classification_edge`, …) against a real `.upg/` workspace on disk —
the same harness `__tests__/portfolio-read.test.ts` uses. Generating this
fixture is itself an exercise of the portfolio write surface. It is
deterministic content-wise but re-mints node/edge ids each run (they're
minted by the store, not user-supplied), so diff-based regeneration checks
should compare structure/counts, not exact ids.

## What's in it

**13 products across 4 `member_kind`s:**

| Product | member_kind | stage | Portfolio | Area | Purpose |
|---|---|---|---|---|---|
| Helm | product | growth | Core Platform (owned) | Platform & Engineering | rich spine: OKR ladder, `strategic_question`, dual-origin constraints, research provenance (study→participant→observation/quote→insight) |
| Helm Mobile | product | beta | Core Platform | Mobile (nested under Platform & Eng.) | peer-overlap cross-edges to Helm |
| Conduit SDK | product | launch | Core Platform | Platform & Engineering | foundations edges (specification + primitive) |
| Beacon | product | validation | New Bets (strategic, nested under Core Platform) | Platform & Engineering | deliberately thin — demonstrates thin-graph softening |
| Legacy Console | product | sunset | Core Platform | Platform & Engineering | deliberately messy — see caveat below |
| Revenue Ops | **operating_function** | mature | Go-to-Market (gtm) | Go-to-Market Org | compliant: north-star metric + sales/GTM content |
| Success Ops | **operating_function** | mature | Go-to-Market (gtm) | Go-to-Market Org | deliberately non-compliant: no north-star, no org-link |
| Meridian Design System | product | mature | Internal Surfaces (internal) | Design & Brand | design-system + brand entities |
| Meridian Website | product | growth | Internal Surfaces (internal) | Design & Brand | screen/brand/marketing cross-edges |
| SkyWire Ops | **watched** | growth | Competitive Landscape (watched) | — | classification + reclassification signal |
| Altiplane | **watched** | growth | Competitive Landscape (watched) | — | parity edge (property-carrying) |
| Northstar Ops | **watched** | growth | Competitive Landscape (watched) | — | competitor-signal edges |
| Meridian Flight Systems (Org) | **org_rollup** | mature | — (org-level, outside any portfolio) | — (org-level) | vision/mission/OKR ladder, teams, department |

**Structure:**
- 5 portfolios covering all 5 `kind`s (`owned`, `strategic`, `watched`, `internal`, `gtm`), one nested (New Bets under Core Platform)
- 4 product areas, one nested (Mobile under Platform & Engineering)
- A canonical registry with 9 entities (persona, metric, market_segment, specification, primitive, classification_axis, 2 classification_values, 1 promoted competitor) — including one `instance_of` link with a sanctioned `alias: true` title divergence
- 42 distinct cross-product edge types exercised (of the 59 in the catalog — see gaps below)
- 1 reclassification signal (SkyWire moves from On-Prem Legacy → Cloud-Native on the Deployment Model axis; the prior edge is retired via `supersede`)

## Validation state (honest, not scrubbed clean)

Running `portfolio_validate` gives **7 valid / 6 invalid** products, `registry_drift.clean: true`, and one portfolio-scoped violation. This is deliberate — a fixture that's uniformly `valid: true` doesn't exercise the read/report surface. Full detail in `GENERATED-SUMMARY.json` (regenerated each run); highlights:

- **Success Ops** (operating_function) — the intended demo: fails `operating-function-without-north-star` (single-graph) *and* the portfolio-scoped `operating-function-without-org-link`. Revenue Ops is its compliant sibling.
- **Beacon** — fails only `personas-without-jobs`; correctly *escapes* `persona-count-below-stage-benchmark` / `competitors-missing-past-validation` despite being thin, because those two are demoted to advisory under the `< 8` total-entity threshold. A clean demonstration of thin-graph softening.
- **Helm / Helm Mobile / Conduit SDK / Website** — fail on organic product-spine gaps (`features-without-hypotheses`, `building-without-validating`, `roadmap-feature-without-outcome-link`) that are incidental to authoring a portfolio-focused fixture, not hand-placed. Left as-is: real graphs have this noise too, and it's useful coverage of `validate_graph`'s product-spine gate.
- **Watched competitors + org_rollup** — carry the same medium-severity findings as everyone else but stay `valid: true`, because `watched` has an empty `gating_concerns` set and `org_rollup` doesn't gate on `product_spine`. Confirms the per-`member_kind` validation-profile split works end to end.

### Caveat: Legacy Console doesn't validate as messy — and that's a real spec finding

Legacy Console (`stage: sunset`) carries an evidence-free `insight`, a
provenance-free `feature_request`, and 6 fully disconnected orphan nodes —
authored to trip `insights-without-evidence`, `feature-requests-without-provenance`,
and `orphan-loose-thoughts`. **None of them fire.** All three anti-patterns
declare a `stages` allow-list that stops at `mature` and excludes `sunset`
(and `maintenance`) — a sunset-stage product is exempt from active
content-quality grading by design. This surfaced while building this fixture,
not from reading docs; the messy content is left in place as an honest record
of the gap rather than "fixed" by changing the stage, since the exemption
itself is worth having a live example of. Set `stage` to `mature` if you need
these three anti-patterns to fire on a sunset-shaped graph.

## Coverage gaps (documented, not silent)

- **`primitive_stored_as_data_type`** (1 of the 21 cross-only edge types) is not exercised — UPG 0.17.8 has no `data_type` entity type in the catalog, so there is no valid target for it.
- Most of the strategy-ladder catalog edges (`product_measures_with_metric`, `outcome_measured_by_metric`, `objective_measured_by_metric`, `key_result_quantified_by_metric`, `strategic_theme_pursues_initiative`, `strategic_theme_delivers_outcome`, `initiative_drives_outcome`, `objective_advances_outcome`, etc.) are exercised **within** Helm's and the org's own graphs (they're valid there too — `cross_product_eligible` just means they're *also* valid across products) rather than as literal cross-product edges. `objective_achieved_through_key_result`, `product_targets_objective`, `product_pursues_outcome`, `strategic_theme_contains_objective`, `rolls_up_to`, and `contributes_to` are exercised as actual cross-product edges (Helm/Revenue Ops → the org rollup) to prove the cross-eligible mechanic works.
- `journey_phase_realises_operating_stage` is exercised in-graph (Helm), not cross-product.

## Feature checklist

- [x] All 4 `member_kind`s (`product`, `watched`, `org_rollup`, `operating_function`)
- [x] All 5 portfolio `kind`s (`owned`, `watched`, `strategic`, `internal`, `gtm`)
- [x] Nested portfolios (parent_portfolio_id)
- [x] Nested areas (parent_area_id)
- [x] Canonical registry: `define_canonical_entity`, `register_instance` (incl. sanctioned `alias`), `promote_to_canonical`, `create_registry_edge`
- [x] `link_area_to_audience` (both `area_serves_persona` and `area_targets_market_segment`)
- [x] `create_parity_edge` (property-carrying: parity_status/quality/evidence/confidence)
- [x] `create_classification_edge` on both a `competitor` and a plain `node` (polymorphic target)
- [x] Reclassification signal + `supersede` retirement + `diff_classification` readability
- [x] `objective_defers_capability` (property-carrying, `deliberate_only`)
- [x] Per-`member_kind` validation-profile gating differences (`portfolio_validate`)
- [x] Portfolio-scoped anti-pattern (`operating-function-without-org-link`)
- [x] `get_portfolio_tree({shape:'structure'})`, `portfolio_digest`, `portfolio_census`
- [ ] `primitive_stored_as_data_type` — no valid target type in current spec (documented above)
