# portfolio-saturated fixture

A real, recognisable multi-product company — **Atlassian** — modelled to
battle-test every portfolio-level feature the UPG spec supports. The shape
mirrors a working `.upg` portfolio: `products/`, `competitors/`,
`design-system/`, `web-ecosystem/`, an org-rollup graph at the workspace root,
and a `portfolio.upg` holding portfolios, areas, and the canonical registry.
Content is a simplified public-knowledge model of the real ecosystem; the
*structure* is engineered for coverage.

This is the companion to the **single-graph** `notion-saturated` fixture
(`packages/test-utils/src/notion-saturated/`), which saturates entity /
property / edge-type coverage inside one product. This one saturates the
**portfolio** layer: multi-product structure, cross-edges, the registry tier,
and per-`member_kind` grading.

## It is also an MCP E2E test for portfolio creation

The fixture is not hand-written JSON. It is authored by driving the **real MCP
tool handlers end-to-end** — the authentic portfolio-creation path a user or
agent follows:

```
init_workspace → create_product ×12 → create_area / create_portfolio →
attach_product_to_portfolio / assign_product_to_area →
batch_create_nodes / batch_create_edges → create_cross_product_edge /
register_instance / promote_to_canonical / create_parity_edge /
create_classification_edge → portfolio_validate / _digest / _census / tree
```

Because `create_product` **seeds a real `product` node** (id === product id),
product-to-product cross-edges (`depends_on_product`, `succeeds`, …) reference
an actual node — there are **no hand-written skeleton graphs** and **no
cross-edges pointing at fabricated ids**. Every write is schema-validated by the
handler at author time.

The build logic lives in one exported function, `buildPortfolioSaturated()`, so
it does double duty:

- `scripts/build-portfolio-saturated.ts` calls it to emit **this committed fixture**.
- `src/__tests__/portfolio-creation-e2e.test.ts` calls it against a **tmp
  workspace** and asserts on the live `portfolio_validate` / digest / tree
  output — a green run proves the portfolio write path composes correctly, not
  merely that a JSON blob has the right shape.
- `src/__tests__/portfolio-saturated-fixture.test.ts` guards the **committed
  output** against silent drift.

## Regenerating

```
cd packages/upg-mcp-server
npx tsx scripts/build-portfolio-saturated.ts
```

Deterministic content-wise, but node/product/edge ids are minted by the store on
each run (not user-supplied), so diff-based regeneration checks should compare
structure / counts, not exact ids. Re-run after any spec change, then run the
two tests above.

## What's in it

**13 members across 4 `member_kind`s:**

| Product | member_kind | stage | Portfolio (kind) | Area | Role it exercises |
|---|---|---|---|---|---|
| **Jira** | product | growth | Atlassian Cloud (owned) | Product Engineering | rich spine: OKR ladder, `strategic_question`, dual-origin constraints, research provenance (study→participant→observation/quote→insight) |
| **Confluence** | product | mature | Atlassian Cloud | Product Engineering | peer-overlap cross-edges to Jira (`shares_persona`/`_job`/`_need`/`_metric`) |
| **Bitbucket** | product | mature | Atlassian Cloud | Product Engineering | foundations edges (Git `specification` + `Repository` primitive) |
| **Rovo** | product | validation | **Point A** (strategic, nested under Atlassian Cloud) | AI & Intelligence (nested under Product Eng.) | deliberately thin — demonstrates thin-graph softening |
| **Hipchat** | product | sunset | Atlassian Cloud | Product Engineering | deliberately messy — see caveat below |
| **Atlassian Design System** | product | mature | Brand & Web (internal) | Design & Brand | design-system + brand entities |
| **atlassian.com** | product | growth | Brand & Web (internal) | Design & Brand | screen/brand/marketing cross-edges |
| **Revenue Operations** | **operating_function** | mature | Go-to-Market (gtm) | Go-to-Market Org | compliant: north-star (NRR) + org-link |
| **Support Operations** | **operating_function** | mature | Go-to-Market (gtm) | Go-to-Market Org | deliberately non-compliant: no north-star, no org-link |
| **GitLab — Competitor Intel** | **watched** | growth | Competitive Landscape (watched) | — | classification + reclassification signal |
| **Linear — Competitor Intel** | **watched** | growth | Competitive Landscape (watched) | — | parity edge (property-carrying) |
| **Notion — Competitor Intel** | **watched** | growth | Competitive Landscape (watched) | — | competitor-signal edges |
| **Atlassian (Corporate Rollup)** | **org_rollup** | mature | — (org-level, outside any portfolio) | — (org-level) | vision/mission/OKR ladder, teams, department. The founding graph the workspace was `init_workspace`'d around. |

The three watched graphs are Atlassian's real per-surface rivals (Jira/Linear,
Confluence/Notion, Bitbucket/GitLab). **Point A** is Atlassian's real internal
incubator (it shipped Rovo). GitLab's reclassification models its real
self-managed → SaaS-first pivot.

**Structure:**
- 5 portfolios covering all 5 `kind`s (`owned`, `strategic`, `watched`, `internal`, `gtm`), one nested (Point A under Atlassian Cloud)
- 4 product areas, one nested (AI & Intelligence under Product Engineering)
- A canonical registry with 9 entities (persona, metric, market_segment, specification, primitive, classification_axis, 2 classification_values, 1 promoted competitor) — including one `instance_of` link with a sanctioned `alias: true` title divergence
- 42 distinct cross-product edge types exercised (see gaps below)
- 1 reclassification signal (GitLab moves from Data Center → Cloud-Native on the Deployment Model axis; the prior edge is retired automatically on the second classify)

## Validation state (honest, not scrubbed clean)

`portfolio_validate` gives **8 valid / 5 invalid** products, `registry_drift.clean: true`,
and one portfolio-scoped violation. Deliberate — a uniformly `valid: true`
fixture doesn't exercise the read/report surface. Full detail in
`GENERATED-SUMMARY.json` (regenerated each run); highlights:

- **Support Operations** (operating_function) — the intended demo: fails
  `operating-function-without-north-star` (single-graph) *and* the
  portfolio-scoped `operating-function-without-org-link`. Revenue Operations is
  its compliant sibling (north-star NRR + `node_owned_by_department`).
- **Rovo** — fails only `personas-without-jobs`, and correctly *escapes*
  `persona-count-below-stage-benchmark` / `competitors-missing-past-validation`
  despite being thin, because those two demote to advisory under the `< 8`
  total-entity threshold. A clean demonstration of thin-graph softening.
- **Jira / atlassian.com** — fail on organic product-spine gaps
  (`features-without-hypotheses`, `building-without-validating`,
  `roadmap-feature-without-outcome-link`) incidental to authoring a
  portfolio-focused fixture, not hand-placed. Left as-is: real graphs carry this
  noise, and it's useful coverage of `validate_graph`'s product-spine gate.
- **Atlassian (Corporate Rollup)** — invalid on `orphan-loose-thoughts` (its
  seeded product node plus the vision/mission/capability nodes are in-graph
  orphans; the OKR ladder is connected but those are not). Note it does **not**
  trip any product-spine anti-pattern (`building-without-validating` etc.) — the
  `org_rollup` profile suppresses those. So the lenient-profile split still
  holds: the rollup is graded only on hygiene/advisory patterns, not product
  spine. It honestly shows that `org_rollup` does **not** exempt the
  stage-agnostic orphan check.
- **Watched competitors (GitLab / Linear / Notion)** — carry the same
  medium-severity advisory findings as everyone else but stay `valid: true`,
  because `watched` has an empty `gating_concerns` set. Confirms the
  per-`member_kind` validation-profile split works end to end.

### Caveat: Hipchat is deliberately messy but validates clean — and that's a real spec finding

Hipchat (`stage: sunset`) carries an evidence-free `insight`, a
provenance-free `feature_request`, and 4 disconnected orphan nodes
(`assumption` / `decision` / `learning` / `market_trend`) — authored to trip
`insights-without-evidence`, `feature-requests-without-provenance`, and
`orphan-loose-thoughts`. **None of them fire; Hipchat is `valid: true` with zero
violations.** The sunset stage exempts it from active content-quality *and*
orphan grading. The messy content is left in place as an honest record of the
gap rather than "fixed" by changing the stage, since the exemption is worth a
live example. Set `stage` to `mature` if you need these patterns to fire on a
messy graph. (`orphan-loose-thoughts` is still exercised elsewhere — Jira and
the org rollup both trip it on incidental orphans.)

## Coverage gaps (documented, not silent)

- **`primitive_stored_as_data_type`** is not exercised — the current catalog has
  no `data_type` entity type, so there is no valid target for this cross-only
  edge type.
- Most strategy-ladder catalog edges (`outcome_measured_by_metric`,
  `objective_measured_by_metric`, `key_result_quantified_by_metric`,
  `strategic_theme_pursues_initiative`, `strategic_theme_delivers_outcome`,
  `initiative_drives_outcome`, `objective_advances_outcome`, …) are exercised
  **within** Jira's and the org's own graphs (they're valid there too —
  `cross_product_eligible` just means they're *also* valid across products)
  rather than as literal cross-product edges. `objective_achieved_through_key_result`,
  `product_targets_objective`, `product_pursues_outcome`,
  `strategic_theme_contains_objective`, `rolls_up_to`, and `contributes_to` are
  exercised as actual cross-product edges (Jira / Revenue Ops → the org rollup)
  to prove the cross-eligible mechanic works.
- `journey_phase_realises_operating_stage` is exercised in-graph (Jira), not cross-product.

## Feature checklist

- [x] All 4 `member_kind`s (`product`, `watched`, `org_rollup`, `operating_function`)
- [x] All 5 portfolio `kind`s (`owned`, `watched`, `strategic`, `internal`, `gtm`)
- [x] Nested portfolios (`parent_portfolio_id`) + nested areas (`parent_area_id`)
- [x] Authored via the real write surface: `init_workspace` + `create_product` (no hand-rolled skeletons)
- [x] Canonical registry: `define_canonical_entity`, `register_instance` (incl. sanctioned `alias`), `promote_to_canonical`, `create_registry_edge`
- [x] `link_area_to_audience` (both `area_serves_persona` and `area_targets_market_segment`)
- [x] `create_parity_edge` (property-carrying: parity_status/quality/evidence/confidence)
- [x] `create_classification_edge` on both a `competitor` and a plain product node (polymorphic target)
- [x] Reclassification signal + automatic prior-edge retirement + `diff_classification` readability
- [x] `objective_defers_capability` (property-carrying, `deliberate_only`)
- [x] Per-`member_kind` validation-profile gating differences (`portfolio_validate`)
- [x] Portfolio-scoped anti-pattern (`operating-function-without-org-link`)
- [x] `get_portfolio_tree({shape:'structure'})`, `portfolio_digest`, `portfolio_census`
- [ ] `primitive_stored_as_data_type` — no valid target type in current spec (documented above)
