/**
 * Context tools: product overview, graph digest, lens-aware session state.
 * Read-only, except `update_session_context` (which can persist the lens to
 * the .upg file).
 */

import type { ToolContext, ToolHandler, ToolResult, UPGLens } from '../lib/server-context.js'
import { text } from '../lib/server-context.js'
import {
  UPG_DOMAINS,
  UPG_DOMAIN_GUIDES,
  UPG_LENSES,
  getDomainForType,
  resolveLabel,
} from '@unified-product-graph/core'
import { computeGraphDigest } from '@unified-product-graph/sdk'

/**
 * Lens-aware label resolver. Given an entity type and the active session lens,
 * return the user-facing label: lens-specific override → framework label →
 * canonical label → Title Case fallback.
 *
 * `get_product_context` previously emitted raw entity-type ids in its
 * "Entities by Type" block, ignoring the active lens. Routing through this
 * helper makes the rendering honest to the lens the user is actually in.
 */
function lensAwareLabel(entityType: string, lensId: string): string {
  const lens = UPG_LENSES.find((l) => l.id === lensId)
  if (lens?.label_overrides?.[entityType]) {
    return lens.label_overrides[entityType]
  }
  return resolveLabel(entityType, lens?.framework_id)
}

/**
 * Returns the product summary, entity counts by type, and a human-readable
 * overview of the graph. Lens-aware: surfaces engineering / design / growth
 * preambles when the active lens differs from `product`. Pair with
 * `get_graph_digest` for machine-readable counts.
 *
 * @example
 * // Get the product overview in the default product lens (no args required)
 * // Input:
 * {}
 * // Output (truncated):
 * "## Checkout Redesign\nAn e-commerce checkout optimisation product.\nStage: build\nLens: product\n\n### 🧭 Product Lens\n- Personas: 3\n- Outcomes: 5\n- Hypotheses: 8 (2 validated)\n\n### Graph Stats\n- Nodes: 42\n- Edges: 31\n- Entity types: 9\n...\n_hash: sha256-abc123"
 *
 * @returns Markdown string with product header, lens preamble, entity counts,
 *   active-domain creation sequences, and `_hash` footer for `if_changed_since`
 *   diffing.
 * @atomicity atomic (read-only)
 * @see get_graph_digest
 * @see get_entity_schema
 */
export const getProductContext: ToolHandler = (args, ctx): ToolResult => {
  const { store, sessionContext } = ctx
  const ifChangedCtx = args.if_changed_since as string | undefined
  const currentHashCtx = store.getContentHash()
  if (ifChangedCtx && ifChangedCtx === currentHashCtx) {
    return text(JSON.stringify({ changed: false, _hash: currentHashCtx }, null, 2))
  }

  const doc = store.getDocument()
  const product = doc.product
  const nodes = store.getAllNodes()
  const edges = store.getAllEdges()
  const includeSummary = (args.include_summary as boolean) ?? false

  const countsByType: Record<string, number> = {}
  for (const n of nodes) {
    countsByType[n.type] = (countsByType[n.type] ?? 0) + 1
  }

  const lines: string[] = [
    `## ${product.title}`,
    product.description ? `\n${product.description}` : '',
    product.stage ? `\nStage: ${product.stage}` : '',
    `\nLens: ${sessionContext.lens}`,
  ]

  if (sessionContext.lens === 'engineering') {
    const bugs = nodes.filter((n) => n.type === 'bug' && n.status !== 'closed' && n.status !== 'fixed')
    const inFlight = nodes.filter((n) => n.type === 'feature' && n.status === 'in_progress')
    const debtItems = nodes.filter((n) => n.type === 'technical_debt_item')
    const blockingEdges = edges.filter((e) => e.type.includes('blocks') || e.type.includes('causes'))
    const investigations = nodes.filter((n) => n.type === 'investigation' && n.status !== 'resolved')
    lines.push(
      `\n### 🔨 Engineering Lens`,
      `- Open bugs: ${bugs.length}${bugs.filter((b) => (b.properties as Record<string, unknown>)?.bug_severity === 'critical').length > 0 ? ` (${bugs.filter((b) => (b.properties as Record<string, unknown>)?.bug_severity === 'critical').length} critical)` : ''}`,
      `- In-flight features: ${inFlight.length}`,
      `- Technical debt: ${debtItems.length}`,
      `- Active blockers: ${blockingEdges.length}`,
      `- Open investigations: ${investigations.length}`,
    )
    if (bugs.length > 0) {
      lines.push(`\n**Bugs:**`)
      for (const b of bugs.slice(0, 5)) {
        const sev = (b.properties as Record<string, unknown>)?.bug_severity ?? 'unknown'
        lines.push(`  - [${sev}] ${b.title}`)
      }
    }
  } else if (sessionContext.lens === 'design') {
    const screens = nodes.filter((n) => n.type === 'screen')
    const components = nodes.filter((n) => n.type === 'design_component')
    const flows = nodes.filter((n) => n.type === 'user_flow')
    const tokens = nodes.filter((n) => n.type === 'design_token')
    const designSystems = nodes.filter((n) => n.type === 'design_system')
    const designDecisions = nodes.filter((n) => n.type === 'decision')
    lines.push(
      `\n### 🎨 Design Lens`,
      `- Screens: ${screens.length}`,
      `- Components: ${components.length}`,
      `- User flows: ${flows.length}`,
      `- Design tokens: ${tokens.length}`,
      `- Design systems: ${designSystems.length}`,
      `- Design decisions: ${designDecisions.length}`,
    )
  } else if (sessionContext.lens === 'growth') {
    const funnels = nodes.filter((n) => n.type === 'funnel')
    const channels = nodes.filter((n) => n.type === 'acquisition_channel')
    const campaigns = nodes.filter((n) => n.type === 'growth_campaign')
    const segments = nodes.filter((n) => n.type === 'behavioral_segment')
    lines.push(
      `\n### 📈 Growth Lens`,
      `- Funnels: ${funnels.length}`,
      `- Channels: ${channels.length}`,
      `- Campaigns: ${campaigns.length}`,
      `- Segments: ${segments.length}`,
    )
  } else {
    const personas = nodes.filter((n) => n.type === 'persona')
    const outcomes = nodes.filter((n) => n.type === 'outcome')
    const hypotheses = nodes.filter((n) => n.type === 'hypothesis')
    const validated = hypotheses.filter((h) => h.status === 'validated')
    lines.push(
      `\n### 🧭 Product Lens`,
      `- Personas: ${personas.length}`,
      `- Outcomes: ${outcomes.length}`,
      `- Hypotheses: ${hypotheses.length} (${validated.length} validated)`,
    )
  }

  lines.push(
    `\n### Graph Stats`,
    `- Nodes: ${nodes.length}`,
    `- Edges: ${edges.length}`,
    `- Entity types: ${Object.keys(countsByType).length}`,
    `\n### Entities by Type`,
    ...Object.entries(countsByType)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `- ${lensAwareLabel(type, sessionContext.lens)} (\`${type}\`): ${count}`),
  )

  if (includeSummary) {
    const edgesByType: Record<string, number> = {}
    for (const e of edges)
      edgesByType[e.type] = (edgesByType[e.type] ?? 0) + 1

    const connectedNodes = new Set<string>()
    for (const e of edges) {
      connectedNodes.add(e.source)
      connectedNodes.add(e.target)
    }
    const orphanCount = nodes.filter((n) => !connectedNodes.has(n.id)).length

    lines.push(
      `\n### Graph Summary`,
      `- Orphan nodes: ${orphanCount}`,
      `\n### Edges by Type`,
      ...Object.entries(edgesByType)
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `- ${type}: ${count}`),
    )
  }

  // domain guides for every domain the product has entities in.
  const activeDomains = new Set<string>()
  for (const n of nodes) {
    const d = getDomainForType(n.type)
    if (d) activeDomains.add(d.id)
  }
  const guideLines: string[] = []
  for (const guide of UPG_DOMAIN_GUIDES) {
    if (!activeDomains.has(guide.domain_id)) continue
    const domainLabel = UPG_DOMAINS.find((d) => d.id === guide.domain_id)?.label ?? guide.domain_id
    guideLines.push(
      `- **${domainLabel}** anchor: \`${guide.anchor_entity}\`; sequence: ${guide.creation_sequence.map((t) => `\`${t}\``).join(' → ')}`,
    )
  }
  if (guideLines.length > 0) {
    lines.push(`\n### Domain Guides (active domains)`)
    lines.push(...guideLines)
    lines.push(`_Use \`get_entity_schema\` on a specific type for its full domain guidance (anti-patterns, bridges)._`)
  }

  lines.push(`\n_hash: ${currentHashCtx}`)
  return text(lines.filter(Boolean).join('\n'))
}

/**
 * Pre-computed graph analytics in one call: counts, health metrics, chain
 * completeness, business area coverage, lifecycle balance. Lens-aware: the
 * `lens_digest` block reflects the active lens (open bugs for engineering,
 * screens-mapped for design, etc.).
 *
 * Coverage is stage-aware ( / Finding 9). The `coverage` block lists
 * every business-area region with `types_present` / `types_missing` for
 * awareness, but `counted_toward_stage` flags only the regions that should
 * be graded against the product's current `UPGProductStage`. The
 * `coverage.stage_summary` aggregate (regions_counted / regions_complete /
 * regions_partial / overall_pct) computes only across the counted regions,
 * so a concept-stage product is no longer marked behind for missing
 * Sustaining + Learning entities it doesn't need yet.
 *
 * @example
 * // Fetch machine-readable graph health metrics (no args required)
 * // Input:
 * {}
 * // Output (truncated):
 * {
 *   "counts": { "total": 42, "by_type": { "persona": 3, "job": 7, "feature": 12, "hypothesis": 8 } },
 *   "health": { "orphan_rate": 0.05, "edge_density": 0.74 },
 *   "chains": { "hypothesis_total": 8, "hypothesis_untested": 6, "hypothesis_validated": 2 },
 *   "coverage": {
 *     "identity":      { "covered": 1, "total": 3, "counted_toward_stage": true,  "types_present": ["product"], "types_missing": ["vision", "mission"] },
 *     "sustaining":    { "covered": 0, "total": 5, "counted_toward_stage": false, "types_present": [], "types_missing": ["business_model", "revenue_stream", "cost_structure", "unit_economics", "pricing_strategy"] },
 *     "stage_summary": { "stage": "concept", "regions_counted": 3, "regions_complete": 0, "regions_partial": 1, "overall_pct": 11 }
 *   },
 *   "lens": "product",
 *   "lens_digest": { "personas": 3, "outcomes": 5, "hypotheses_validated": 2 },
 *   "_hash": "sha256-abc123"
 * }
 *
 * @returns JSON object: `{ counts, health, chains, coverage, lifecycle,
 *   lens, lens_digest, _hash }`. ~500 tokens vs ~5-8K for equivalent manual
 *   fetches.
 * @atomicity atomic (read-only)
 * @see get_product_context
 */
export const getGraphDigest: ToolHandler = (args, ctx): ToolResult => {
  const { store, sessionContext } = ctx
  const ifChanged = args.if_changed_since as string | undefined
  const currentHash = store.getContentHash()
  if (ifChanged && ifChanged === currentHash) {
    return text(JSON.stringify({ changed: false, _hash: currentHash }, null, 2))
  }

  const digest = computeGraphDigest(store)
  const allNodes = store.getAllNodes()
  const allEdges = store.getAllEdges()
  let lensDigest: Record<string, unknown> = {}

  if (sessionContext.lens === 'engineering') {
    const openBugs = allNodes.filter((n) => n.type === 'bug' && n.status !== 'closed' && n.status !== 'fixed').length
    const inFlightFeatures = allNodes.filter((n) => n.type === 'feature' && n.status === 'in_progress').length
    const activeDebt = allNodes.filter((n) => n.type === 'technical_debt_item').length
    const blockerEdges = allEdges.filter((e) => e.type.includes('blocks') || e.type.includes('causes'))
    const blockedFeatureIds = new Set(blockerEdges.map((e) => e.target))
    const blockedFeatures = allNodes.filter((n) => blockedFeatureIds.has(n.id)).map((n) => n.title)
    const openInvestigations = allNodes.filter((n) => n.type === 'investigation' && n.status !== 'resolved').length
    lensDigest = { open_bugs: openBugs, blockers: blockerEdges.length, in_flight_features: inFlightFeatures, active_debt: activeDebt, blocked_features: blockedFeatures, open_investigations: openInvestigations }
  } else if (sessionContext.lens === 'design') {
    const screens = allNodes.filter((n) => n.type === 'screen').length
    const components = allNodes.filter((n) => n.type === 'design_component').length
    const flows = allNodes.filter((n) => n.type === 'user_flow').length
    const tokens = allNodes.filter((n) => n.type === 'design_token').length
    const designDecisions = allNodes.filter((n) => n.type === 'decision').length
    lensDigest = { screens_mapped: screens, components_audited: components, flows_complete: flows, tokens_defined: tokens, design_decisions: designDecisions }
  } else if (sessionContext.lens === 'growth') {
    const funnels = allNodes.filter((n) => n.type === 'funnel').length
    const channels = allNodes.filter((n) => n.type === 'acquisition_channel').length
    const campaigns = allNodes.filter((n) => n.type === 'growth_campaign').length
    lensDigest = { funnels_defined: funnels, channels_active: channels, campaigns_running: campaigns }
  } else {
    lensDigest = { personas: digest.counts.by_type['persona'] ?? 0, outcomes: digest.counts.by_type['outcome'] ?? 0, hypotheses_validated: digest.chains.hypothesis_total - digest.chains.hypothesis_untested }
  }

  return text(JSON.stringify({ ...digest, lens: sessionContext.lens, lens_digest: lensDigest, _hash: currentHash }, null, 2))
}

/**
 * Read the session context: which skills ran, what was recommended, current
 * focus area, and the active lens. Use at skill start to avoid repeating
 * recommendations and to pick up where another skill left off.
 *
 * @returns JSON: `{ lens, skills_invoked, recommendations_given,
 *   recommendations_to_avoid, focus_area, custom, skills_count, last_skill,
 *   last_recommendation }`. `recommendations_to_avoid` is the deduped list of
 *   every recommendation given this session; runners should filter their
 *   next recommendation against this array rather than re-deriving the
 *   dedup rule from prose.
 * @atomicity atomic (read-only)
 * @see update_session_context
 */
export const getSessionContext: ToolHandler = (_args, ctx): ToolResult => {
  const { sessionContext } = ctx
  const recommendationsToAvoid = Array.from(
    new Set(sessionContext.recommendations_given.map((r) => r.recommendation)),
  )
  return text(
    JSON.stringify(
      {
        lens: sessionContext.lens,
        skills_invoked: sessionContext.skills_invoked,
        recommendations_given: sessionContext.recommendations_given,
        recommendations_to_avoid: recommendationsToAvoid,
        focus_area: sessionContext.focus_area,
        custom: sessionContext.custom,
        skills_count: sessionContext.skills_invoked.length,
        last_skill: sessionContext.skills_invoked.length > 0
          ? sessionContext.skills_invoked[sessionContext.skills_invoked.length - 1].skill
          : null,
        last_recommendation: sessionContext.recommendations_given.length > 0
          ? sessionContext.recommendations_given[sessionContext.recommendations_given.length - 1].recommendation
          : null,
      },
      null,
      2,
    ),
  )
}

/**
 * Update the session context: register a skill invocation, record a
 * recommendation, set focus area, switch lens, or store custom state for
 * cross-skill coordination. Optionally persists the new lens to the .upg file
 * so it survives restarts.
 *
 * @returns JSON: `{ updated: true, session: SessionContext }` reflecting the
 *   new state.
 * @atomicity non-atomic. Session mutates in-memory immediately; lens
 *   persistence flushes the .upg file as a separate side-effect that may
 *   succeed or fail independently of the session update.
 * @see get_session_context
 */
export const updateSessionContext: ToolHandler = (args, ctx): ToolResult => {
  const { sessionContext, store } = ctx
  const now = new Date().toISOString()
  const skillInvoked = args.skill_invoked as string | undefined
  const recommendation = args.recommendation as string | undefined
  const focusArea = args.focus_area as string | undefined
  const lensArg = args.lens as UPGLens | undefined
  const persistLens = args.persist_lens as boolean | undefined
  const custom = args.custom as Record<string, unknown> | undefined

  if (skillInvoked) {
    sessionContext.skills_invoked.push({ skill: skillInvoked, timestamp: now })
  }
  if (recommendation && skillInvoked) {
    sessionContext.recommendations_given.push({
      skill: skillInvoked ?? 'unknown',
      recommendation,
      timestamp: now,
    })
  }
  if (focusArea !== undefined) {
    sessionContext.focus_area = focusArea
  }
  if (lensArg && ['product', 'engineering', 'design', 'growth'].includes(lensArg)) {
    sessionContext.lens = lensArg
    if (persistLens && store) {
      const doc = store.getDocument()
      if (doc.product) {
        ;(doc.product as unknown as Record<string, unknown>).lens = lensArg
        store.flush()
      }
    }
  }
  if (custom) {
    sessionContext.custom = { ...sessionContext.custom, ...custom }
  }

  return text(JSON.stringify({ updated: true, session: sessionContext }, null, 2))
}

// Allow `void` parameters to silence unused-variable lint; re-export type
// to keep the registry import surface tidy.
export type { ToolContext }
