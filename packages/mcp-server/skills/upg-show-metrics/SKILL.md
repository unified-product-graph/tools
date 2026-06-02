---
name: upg-show-metrics
description: "Product thinking metrics: hypothesis velocity, coverage ratio, evidence density"
user-invocable: true
argument-hint: ""
category: cognitive
approaches: [inspect]
---

# /upg-show-metrics: Product Thinking Metrics

You are a fast analytics dashboard. Your job: fetch metrics, render a dashboard, suggest ONE action. No questions. No interaction. Just the numbers and what they mean.

**Before producing any output, load the design system:** `/upg-context` (interaction principles, design system, lens rules) and `/upg-context-intelligence` (benchmarks, user personas, product philosophy).

## Data Quality Notes

Call `get_graph_digest()` first. Check for these conditions before rendering metrics:

- **Hypothesis type mismatch**: If `by_type` shows `hypothesis_claim` nodes but zero `hypothesis` nodes, surface: "Your graph has deprecated `hypothesis_claim` entities. Run `/upg-fix-types` to convert them to `hypothesis` before this analysis is accurate."
- **Hypothesis velocity**: The "Hypothesis Velocity" metric shows a point-in-time status distribution (untested vs. tested), not a rate of change. Label it clearly: "Hypothesis status (not a velocity measure)" when local-only.
- **Stage benchmarks are canonical**: `product.stage` is a canonical `UPGProductStage` (`concept | validation | build | beta | launch | growth | mature | maintenance | sunset`), and the count/relationship benchmarks are keyed on those same canonical stages. Compare directly; do NOT translate to legacy `idea`/`mvp`/`scale` labels.

## Tools

Try the cloud tool first. Fall back to local if unavailable.

**Cloud path (preferred):**
```
mcp__upg-cloud__get_graph_analytics({ product_id })
mcp__upg-cloud__get_product_context({ product_id })
```

**Local fallback:**
```
mcp__unified-product-graph__get_graph_digest()
```

The digest pre-computes all metrics in one call (~500 tokens):
- **hypothesis_velocity:** Use `chains.hypothesis_untested` / `chains.hypothesis_total`
- **coverage_ratio:** Use `chains.persona_with_job` / `chains.persona_total` + deeper chain stats
- **evidence_density:** Use `counts.by_type` to compute (learning + insight) / hypothesis
- **orphan_rate:** Use `health.orphan_rate` directly
- **stale_entity_rate:** Not available locally; skip or note "cloud only"

**1 tool call. This must be fast.**

## Output Format

Render as real markdown, NOT inside a code block. Use this structure:

---

## 📐 Graph Analytics: [Product Name]

### Hypothesis Velocity

Show each status with its status dot and count, then a filled bar for % resolved (validated + invalidated out of total):

```
  ⚪ Untested: 4    🟡 Testing: 2    🟢 Validated: 5    🔴 Invalidated: 1
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 58% resolved
```

If zero hypotheses exist, show: "No hypotheses yet; run `/upg-new-hypothesis` to start testing your riskiest assumptions."

### Coverage Ratio

Show persona count with complete chains out of total, plus a filled bar:

```
  👤 3/4 personas have complete chains (persona -> job -> need -> opportunity -> solution)
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ 75%
```

If zero personas, show: "No personas yet; run `/upg-new-persona` to define who you're building for."

### Evidence Density

Show evidence counts and ratio:

```
  📝 8 learnings + 💎 5 insights across ⚗️ 12 hypotheses
  Ratio: 1.08 evidence per hypothesis ← healthy
```

Interpret the ratio:
- 0.0 = "no evidence yet"
- < 0.5 = "thin; most hypotheses lack evidence"
- 0.5–1.0 = "growing"
- 1.0+ = "healthy"
- 2.0+ = "evidence-rich"

### Freshness

Show stale entity rate as three bands. If cloud data is available, compute from stale_entity_rate. Otherwise note "cloud only":

```
  🟢 45% updated this week · 🟡 30% this month · 🔴 25% stale (14+ days)
```

If stale rate is 0: "🟢 All entities recently updated"
If stale rate > 50: "🔴 Most of your graph is gathering dust"

### Connectivity

Show orphan rate as a filled bar:

```
  🟢 85% of entities connected · 🔴 15% orphans (7 entities)
```

### Quick Take

One short paragraph: what stands out, and what's the single fastest win? End with a specific command suggestion.

Example:
> Your hypothesis pipeline is moving: 58% resolved. But 4 are still untested. The fastest win is picking one and designing an experiment.
> → `/upg-new-hypothesis` to test your riskiest assumption

## Key Principles

- **FAST.** 2-3 tool calls. No interaction. No questions. Just the dashboard.
- **Filled bars** for all percentages; max 22 characters (▓ for filled, ░ for empty).
- **Interpret, don't just report.** "1.08 evidence per hypothesis <- healthy" beats "ratio: 1.08".
- **ONE recommendation.** Pick the metric that needs the most attention and suggest the matching skill.
- **This is NOT `/upg-show-status --quick`** (5 quick signals) or **/upg-check-gaps** (deep maturity scoring + action plan). This is the quantitative dashboard.
- **Follow the design system.** Entity emojis, status dots, dashed dividers, consistent formatting from `/upg-context`.


After rendering your recommendation, call:
`update_session_context({ skill_invoked: "upg-show-metrics", recommendation: "<the next skill you recommended>" })`
