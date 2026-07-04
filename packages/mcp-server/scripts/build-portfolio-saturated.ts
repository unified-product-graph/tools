/**
 * Builds the `portfolio-saturated` fixture: a fictional company ("Meridian
 * Flight Systems") modelled on the real Sanity `.upg` portfolio structurally
 * (products / competitors / design-system / web-ecosystem / org rollup / a
 * portfolio.upg with nested portfolios + areas + registry), but authored to
 * saturate every portfolio-level feature the spec (0.17.8) supports: all 4
 * `member_kind`s, all 5 portfolio `kind`s, nested portfolios and areas, the
 * canonical registry tier (with a sanctioned `alias` divergence), the
 * reclassification signal stream, and broad coverage of the 59 cross-product
 * edge types.
 *
 * Drives the real MCP tool handlers directly (the same harness
 * `__tests__/portfolio-read.test.ts` uses) rather than hand-writing JSON, so
 * generating this fixture is itself an exercise of the portfolio write
 * surface. One product (`legacy-console`) is deliberately messy — orphan
 * nodes, evidence-free insights, missing provenance — so `portfolio_validate`
 * has real violations to catch. One operating_function (`success-ops`) is
 * deliberately non-compliant (no north-star metric, no org-link) to exercise
 * the 0.17.0 operating-function anti-pattern trio.
 *
 * Run: npx tsx scripts/build-portfolio-saturated.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'

import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
  type ToolResult,
} from '../src/lib/server-context.js'

import { batchCreateNodes } from '../src/tools/nodes.js'
import { batchCreateEdges } from '../src/tools/edges.js'
import {
  createArea,
  createPortfolio,
  assignProductToAreaTool,
} from '../src/tools/areas.js'
import {
  attachProductToPortfolioTool,
  createCrossProductEdge,
  batchCreateCrossProductEdges,
  createParityEdge,
  createClassificationEdge,
  linkAreaToAudience,
} from '../src/tools/workspace.js'
import { createNode } from '../src/tools/nodes.js'
import {
  defineCanonicalEntity,
  registerInstance,
  promoteToCanonical,
  createRegistryEdge,
} from '../src/tools/registry.js'
import {
  portfolioValidate,
  portfolioDigest,
  portfolioCensus,
  getPortfolioTree,
} from '../src/tools/portfolio-read.js'

// ─── setup ──────────────────────────────────────────────────────────────────

const TARGET = realpathSync(
  join(new URL('.', import.meta.url).pathname, '..', 'test-fixtures', 'portfolio-saturated'),
)
const UPG_DIR = join(TARGET, '.upg')

if (existsSync(UPG_DIR)) rmSync(UPG_DIR, { recursive: true, force: true })
mkdirSync(join(UPG_DIR, 'products'), { recursive: true })
mkdirSync(join(UPG_DIR, 'competitors'), { recursive: true })
mkdirSync(join(UPG_DIR, 'design-system'), { recursive: true })
mkdirSync(join(UPG_DIR, 'web-ecosystem'), { recursive: true })

const prevCwd = process.cwd()
process.chdir(TARGET)

function bodyOf(result: ToolResult): any {
  if (result.isError) throw new Error(`Tool call failed: ${result.content[0].text}`)
  return JSON.parse(result.content[0].text)
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

interface ProductSpec {
  file: string // workspace-relative, e.g. 'products/helm.upg'
  id: string
  title: string
  description: string
  stage: string
  member_kind?: 'product' | 'org_rollup' | 'watched' | 'operating_function'
}

const idCounter = { n: 0 }
function nid(prefix: string): string {
  idCounter.n += 1
  return `${prefix}_${idCounter.n.toString(36).padStart(4, '0')}`
}

const stores = new Map<string, UPGFileStore>()

/** Write a skeleton product file to disk and open a live store on it. */
async function bootstrapProduct(spec: ProductSpec): Promise<UPGFileStore> {
  const filePath = join(UPG_DIR, spec.file)
  mkdirSync(join(filePath, '..'), { recursive: true })
  const skeleton = {
    upg_version: '0.2',
    exported_at: new Date(0).toISOString(),
    source: { tool: 'build-portfolio-saturated' },
    product: { id: spec.id, title: spec.title, description: spec.description, stage: spec.stage },
    nodes: [],
    edges: [],
    ...(spec.member_kind ? { member_kind: spec.member_kind } : {}),
  }
  writeFileSync(filePath, JSON.stringify(skeleton, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  stores.set(spec.id, store)
  return store
}

async function flushAll() {
  for (const store of stores.values()) await store.flush()
}

/**
 * Create nodes (in batches of <=50) in a product's own graph. `batch_create_nodes`
 * always mints its own ids (ignores any `id` field on the input) — so this
 * mutates each input node object in place, overwriting the placeholder `id`
 * with the real minted one, index-aligned with the `created` result array.
 * Callers keep holding the same object references and read `.id` afterwards.
 */
async function addNodes(
  productId: string,
  nodes: Array<{ id: string; type: string; title: string; [k: string]: unknown }>,
): Promise<void> {
  const store = stores.get(productId)!
  const ctx = makeCtx(store)
  for (let i = 0; i < nodes.length; i += 50) {
    const chunk = nodes.slice(i, i + 50)
    const result = bodyOf(batchCreateNodes({ nodes: chunk.map(({ id: _drop, ...rest }) => rest) }, ctx))
    const created: Array<{ id: string }> = result.created
    chunk.forEach((n, idx) => { n.id = created[idx].id })
  }
}

async function addEdges(productId: string, edges: Array<Record<string, unknown>>): Promise<void> {
  const store = stores.get(productId)!
  const ctx = makeCtx(store)
  for (let i = 0; i < edges.length; i += 50) {
    const chunk = edges.slice(i, i + 50)
    bodyOf(batchCreateEdges({ edges: chunk }, ctx))
  }
}

// A throwaway ctx for portfolio-scoped handlers (areas/portfolios/cross-edges/
// registry) — these all resolve their own fresh store off process.cwd() and
// never touch ctx.store, but the handler signature requires one.
let scratchCtx: ToolContext

async function main() {
  console.log(`Building portfolio-saturated fixture at ${TARGET}`)

  // ── 1. Products: bootstrap all 13 skeleton files ──────────────────────────
  const HELM: ProductSpec = { file: 'products/helm.upg', id: 'p_helm', title: 'Helm', stage: 'growth', description: 'Flagship fleet-operations command centre — dispatch, routing, live fleet status.' }
  const HELM_MOBILE: ProductSpec = { file: 'products/helm-mobile.upg', id: 'p_helmmobile', title: 'Helm Mobile', stage: 'beta', description: 'Mobile companion for pilots and dispatchers — on-the-go assignment and status updates.' }
  const CONDUIT: ProductSpec = { file: 'products/conduit-sdk.upg', id: 'p_conduit', title: 'Conduit SDK', stage: 'launch', description: 'Developer SDK implementing the Conduit Protocol for third-party fleet integrations.' }
  const BEACON: ProductSpec = { file: 'products/beacon.upg', id: 'p_beacon', title: 'Beacon', stage: 'validation', description: 'Early-stage bet: autonomous drone-relay positioning. Validating demand.' }
  const LEGACY: ProductSpec = { file: 'products/legacy-console.upg', id: 'p_legacy', title: 'Legacy Console', stage: 'sunset', description: 'The original desktop dispatch console, being sunset in favour of Helm.' }
  const REVENUE_OPS: ProductSpec = { file: 'products/revenue-ops.upg', id: 'p_revops', title: 'Revenue Ops', stage: 'mature', description: 'Revenue operating function — pipeline, forecasting, deal desk.', member_kind: 'operating_function' }
  const SUCCESS_OPS: ProductSpec = { file: 'products/success-ops.upg', id: 'p_successops', title: 'Success Ops', stage: 'mature', description: 'Customer success operating function — health scoring, renewals playbooks.', member_kind: 'operating_function' }
  const DESIGN_SYSTEM: ProductSpec = { file: 'design-system/meridian-design-system.upg', id: 'p_designsys', title: 'Meridian Design System', stage: 'mature', description: 'Shared design system: components, tokens, brand identity.' }
  const WEBSITE: ProductSpec = { file: 'web-ecosystem/meridian-website.upg', id: 'p_website', title: 'Meridian Website', stage: 'growth', description: 'Marketing site — product pages, competitor comparisons.' }
  const SKYWIRE: ProductSpec = { file: 'competitors/competitor-skywire.upg', id: 'p_skywire', title: 'SkyWire Ops — Competitor Intel', stage: 'growth', description: 'Competitive intelligence graph for SkyWire Ops.', member_kind: 'watched' }
  const ALTIPLANE: ProductSpec = { file: 'competitors/competitor-altiplane.upg', id: 'p_altiplane', title: 'Altiplane — Competitor Intel', stage: 'growth', description: 'Competitive intelligence graph for Altiplane.', member_kind: 'watched' }
  const NORTHSTAR: ProductSpec = { file: 'competitors/competitor-northstar-ops.upg', id: 'p_northstar', title: 'Northstar Ops — Competitor Intel', stage: 'growth', description: 'Competitive intelligence graph for Northstar Ops.', member_kind: 'watched' }
  const ORG: ProductSpec = { file: 'meridian-org.upg', id: 'p_org', title: 'Meridian Flight Systems (Org)', stage: 'mature', description: 'Company umbrella graph — vision, mission, OKR ladder, org structure.', member_kind: 'org_rollup' }

  const ALL_PRODUCTS = [HELM, HELM_MOBILE, CONDUIT, BEACON, LEGACY, REVENUE_OPS, SUCCESS_OPS, DESIGN_SYSTEM, WEBSITE, SKYWIRE, ALTIPLANE, NORTHSTAR, ORG]
  for (const spec of ALL_PRODUCTS) await bootstrapProduct(spec)

  // Hand-author workspace.json (mirrors the-product-creator's own convention:
  // subfolders + member_kind cached per entry).
  writeFileSync(
    join(UPG_DIR, 'workspace.json'),
    JSON.stringify(
      {
        version: '1.0',
        default_product: HELM.file,
        products: ALL_PRODUCTS.map((p) => ({
          file: p.file,
          title: p.title,
          ...(p.member_kind ? { member_kind: p.member_kind } : {}),
        })),
      },
      null,
      2,
    ) + '\n',
  )

  scratchCtx = makeCtx(stores.get(HELM.id)!)

  // ── 2. Organization (via create_node, sets portfolio.upg's org) ───────────
  bodyOf(
    await createNode(
      {
        type: 'organization',
        title: 'Meridian Flight Systems',
        description:
          'Fictional fleet-operations SaaS company — the UPG portfolio-saturated fixture. Not a real company; structurally modelled on the Sanity .upg portfolio to battle-test portfolio features (nested portfolios/areas, registry, cross-edges, all member_kinds, reclassification signals).',
        properties: { industry: 'Fleet operations software (SaaS)' },
        overwrite_organization: true,
      },
      scratchCtx,
    ),
  )

  // ── 3. Areas (organisational axis, nested) ─────────────────────────────────
  const areaPlatform = bodyOf(await createArea({ title: 'Platform & Engineering', strategic_priority: 'critical' }, scratchCtx)).node
  const areaMobile = bodyOf(await createArea({ title: 'Mobile', parent_area_id: areaPlatform.id, strategic_priority: 'high' }, scratchCtx)).node
  const areaGtm = bodyOf(await createArea({ title: 'Go-to-Market Org', strategic_priority: 'high' }, scratchCtx)).node
  const areaDesign = bodyOf(await createArea({ title: 'Design & Brand', strategic_priority: 'medium' }, scratchCtx)).node

  // ── 4. Portfolios (strategic axis, nested, all 5 kinds) ────────────────────
  const pfCore = bodyOf(await createPortfolio({ title: 'Core Platform', kind: 'owned', hierarchy_model: 'nested' }, scratchCtx)).node
  const pfNewBets = bodyOf(await createPortfolio({ title: 'New Bets', kind: 'strategic', parent_portfolio_id: pfCore.id }, scratchCtx)).node
  const pfGtm = bodyOf(await createPortfolio({ title: 'Go-to-Market', kind: 'gtm' }, scratchCtx)).node
  const pfInternal = bodyOf(await createPortfolio({ title: 'Internal Surfaces', kind: 'internal' }, scratchCtx)).node
  const pfCompetitive = bodyOf(await createPortfolio({ title: 'Competitive Landscape', kind: 'watched' }, scratchCtx)).node

  // ── 5. Attach products to portfolios + assign to areas ─────────────────────
  const attachments: Array<[ProductSpec, { id: string }, { id: string } | null]> = [
    [HELM, pfCore, areaPlatform],
    [HELM_MOBILE, pfCore, areaMobile],
    [CONDUIT, pfCore, areaPlatform],
    [BEACON, pfNewBets, areaPlatform],
    [LEGACY, pfCore, areaPlatform],
    [REVENUE_OPS, pfGtm, areaGtm],
    [SUCCESS_OPS, pfGtm, areaGtm],
    [DESIGN_SYSTEM, pfInternal, areaDesign],
    [WEBSITE, pfInternal, areaDesign],
    [SKYWIRE, pfCompetitive, null],
    [ALTIPLANE, pfCompetitive, null],
    [NORTHSTAR, pfCompetitive, null],
  ]
  for (const [spec, pf, area] of attachments) {
    bodyOf(await attachProductToPortfolioTool({ product_id: spec.id, portfolio_id: pf.id }, scratchCtx))
    if (area) bodyOf(await assignProductToAreaTool({ product_id: spec.id, area_id: area.id }, scratchCtx))
  }
  // ORG (org_rollup) deliberately left outside any portfolio/area — org-level,
  // matching the-product-creator's own convention.

  console.log('Structure done: org, 4 areas (1 nested), 5 portfolios (1 nested), 13 products attached.')

  // ── 6. Registry (canonical shared-vocabulary tier) ─────────────────────────
  const canonPersona = bodyOf(await defineCanonicalEntity({ type: 'persona', title: 'Fleet Dispatcher', description: 'Coordinates flight assignments and monitors live fleet status.', properties: { audience_role: 'user' } }, scratchCtx)).canonical
  const canonMetric = bodyOf(await defineCanonicalEntity({ type: 'metric', title: 'On-Time Performance', description: 'Percentage of flights departing within 15 minutes of scheduled time.', properties: { designation: 'kpi', unit: '%' } }, scratchCtx)).canonical
  const canonSegment = bodyOf(await defineCanonicalEntity({ type: 'market_segment', title: 'Regional Carriers', description: 'Small-to-mid fleet operators, 5-50 aircraft, regional routes.' }, scratchCtx)).canonical
  const canonSpec = bodyOf(await defineCanonicalEntity({ type: 'specification', title: 'Conduit Protocol', description: 'The open wire protocol for third-party fleet-data integrations.' }, scratchCtx)).canonical
  const canonPrimitive = bodyOf(await defineCanonicalEntity({ type: 'primitive', title: 'Flight Manifest', description: 'The canonical data primitive representing a single flight crew, cargo, and routing manifest.' }, scratchCtx)).canonical
  // Classification axis + values MUST live in the registry (not a product-local
  // graph): `buildValueAxisMap` — the reclassification-signal detector — only
  // ever reads `portfolio.upg`'s registry.nodes/registry.edges, never product
  // files. A product-local classification_axis is syntactically valid but
  // invisible to the signal chokepoint.
  const canonAxis = bodyOf(await defineCanonicalEntity({ type: 'classification_axis', title: 'Deployment Model' }, scratchCtx)).canonical
  const canonValueCloud = bodyOf(await defineCanonicalEntity({ type: 'classification_value', title: 'Cloud-Native', properties: { rationale: 'Multi-tenant SaaS, no on-prem option.' } }, scratchCtx)).canonical
  const canonValueOnPrem = bodyOf(await defineCanonicalEntity({ type: 'classification_value', title: 'On-Prem Legacy', properties: { rationale: 'Requires customer-hosted servers; SkyWire is migrating away from this.' } }, scratchCtx)).canonical
  bodyOf(await createRegistryEdge({ source_id: canonAxis.id, target_id: canonValueCloud.id, type: 'classification_axis_includes_classification_value' }, scratchCtx))
  bodyOf(await createRegistryEdge({ source_id: canonAxis.id, target_id: canonValueOnPrem.id, type: 'classification_axis_includes_classification_value' }, scratchCtx))

  console.log('Registry done: 8 canonical entities (persona, metric, market_segment, specification, primitive, classification axis + 2 values).')

  // ── 7. Product content: HELM (rich) ────────────────────────────────────────
  const helmPersonaDispatcher = { id: nid('n'), type: 'persona', title: 'Fleet Dispatcher', description: 'Coordinates daily flight assignments across the fleet.', properties: { audience_role: 'user' } }
  const helmPersonaOpsManager = { id: nid('n'), type: 'persona', title: 'Ops Manager', description: 'Oversees dispatchers, escalation point for schedule conflicts.', properties: { audience_role: 'buyer' } }
  const helmJob = { id: nid('n'), type: 'job', title: 'Coordinate daily flight assignments', description: 'Assign aircraft and crew to routes each morning.' }
  const helmNeed = { id: nid('n'), type: 'need', title: 'Real-time visibility into fleet position' }
  const helmVision = { id: nid('n'), type: 'vision', title: 'A fleet that never guesses where it is.' }
  const helmMission = { id: nid('n'), type: 'mission', title: 'Give every dispatcher live, trustworthy fleet state.' }
  const helmOutcome = { id: nid('n'), type: 'outcome', title: 'Dispatchers resolve schedule conflicts in minutes, not hours.' }
  const helmObjective = { id: nid('n'), type: 'objective', title: 'Cut average dispatch resolution time by 50%' }
  const helmKeyResult = { id: nid('n'), type: 'key_result', title: 'Median resolution time drops from 40min to 20min' }
  const helmMetric = { id: nid('n'), type: 'metric', title: 'Weekly Active Fleets', properties: { designation: 'driver', statistical_function: 'count', metric_category: 'engagement' } }
  const helmStrategicTheme = { id: nid('n'), type: 'strategic_theme', title: 'Real-time Operations' }
  const helmStrategicPillar = { id: nid('n'), type: 'strategic_pillar', title: 'Live data over stale reports' }
  const helmInitiative = { id: nid('n'), type: 'initiative', title: 'Live Fleet Position Rollout' }
  const helmConstraintInternal = { id: nid('n'), type: 'constraint', title: 'No dispatcher screen may block on network latency', properties: { constraint_kind: 'technical', constraint_origin: 'internal', constraint_status: 'binding', rule_strength: 'must' } }
  const helmConstraintExternal = { id: nid('n'), type: 'constraint', title: 'FAA Part 121 dispatch record retention', properties: { constraint_kind: 'regulatory', constraint_origin: 'external', constraint_status: 'binding', rule_strength: 'must', source: 'FAA Part 121' } }
  const helmStrategicQuestion = { id: nid('n'), type: 'strategic_question', title: 'Should dispatch resolution time be measured per-dispatcher or per-fleet?', properties: { question: 'Should dispatch resolution time be measured per-dispatcher or per-fleet?', priority: 'high' } }
  const helmFeature1 = { id: nid('n'), type: 'feature', title: 'Live Fleet Map', description: 'Real-time map of all aircraft positions.' }
  const helmFeature2 = { id: nid('n'), type: 'feature', title: 'AI Dispatch Copilot', description: 'Suggests optimal reassignments during disruptions.' }
  const helmApiContract = { id: nid('n'), type: 'api_contract', title: 'Fleet Position API', properties: { protocol: 'websocket', version: 'v2' } }
  const helmScreen = { id: nid('n'), type: 'screen', title: 'Dispatch Board' }
  const helmCapability = { id: nid('n'), type: 'capability', title: 'Autonomous Reassignment' }
  const helmDependency = { id: nid('n'), type: 'dependency', title: 'Waiting on Conduit SDK v2 for third-party telemetry ingestion' }
  const helmOperatingLifecycle = { id: nid('n'), type: 'operating_lifecycle', title: 'Flight Dispatch Lifecycle' }
  const helmOperatingStage = { id: nid('n'), type: 'operating_stage', title: 'In-Flight Monitoring' }
  const helmJourneyPhase = { id: nid('n'), type: 'journey_phase', title: 'Live Monitoring Phase' }
  const helmCompetitorStub = { id: nid('n'), type: 'competitor', title: 'SkyWire Ops (as tracked by Helm)', description: 'Lightweight local mention; canonicalised into the registry via promote_to_canonical.' }

  // Research provenance
  const helmResearchStudy = { id: nid('n'), type: 'research_study', title: 'Dispatch Workflow Study — W12 2026' }
  const helmResearchQuestion = { id: nid('n'), type: 'research_question', title: 'Where do dispatchers lose the most time during disruptions?' }
  const helmParticipant = { id: nid('n'), type: 'participant', title: 'P07 — Senior Dispatcher, 6yr tenure' }
  const helmObservation = { id: nid('n'), type: 'observation', title: 'P07 manually cross-referenced 3 spreadsheets during a weather delay.', properties: { source_url: 'https://research.meridianflight.internal/studies/w12-2026/obs-04' } }
  const helmQuote = { id: nid('n'), type: 'quote', title: '"I basically rebuild the whole board from memory when the map lags."', properties: { source_url: 'https://research.meridianflight.internal/studies/w12-2026/quote-11' } }
  const helmInsight = { id: nid('n'), type: 'insight', title: 'Dispatchers fall back to manual cross-referencing when live data lags.' }
  const helmNodes = [
    helmPersonaDispatcher, helmPersonaOpsManager, helmJob, helmNeed, helmVision, helmMission, helmOutcome,
    helmObjective, helmKeyResult, helmMetric, helmStrategicTheme, helmStrategicPillar, helmInitiative,
    helmConstraintInternal, helmConstraintExternal, helmStrategicQuestion, helmFeature1, helmFeature2,
    helmApiContract, helmScreen, helmCapability, helmDependency, helmOperatingLifecycle, helmOperatingStage,
    helmJourneyPhase, helmCompetitorStub, helmResearchStudy, helmResearchQuestion, helmParticipant,
    helmObservation, helmQuote, helmInsight,
  ]
  await addNodes(HELM.id, helmNodes)

  await addEdges(HELM.id, [
    { source_id: helmPersonaDispatcher.id, target_id: helmJob.id, type: 'persona_pursues_job' },
    { source_id: helmPersonaDispatcher.id, target_id: helmNeed.id, type: 'persona_experiences_need' },
    { source_id: helmObjective.id, target_id: helmKeyResult.id, type: 'objective_achieved_through_key_result' },
    { source_id: helmObjective.id, target_id: helmMetric.id, type: 'objective_measured_by_metric' },
    { source_id: helmKeyResult.id, target_id: helmMetric.id, type: 'key_result_quantified_by_metric' },
    { source_id: helmOutcome.id, target_id: helmMetric.id, type: 'outcome_measured_by_metric' },
    { source_id: helmStrategicTheme.id, target_id: helmObjective.id, type: 'strategic_theme_contains_objective' },
    { source_id: helmStrategicTheme.id, target_id: helmInitiative.id, type: 'strategic_theme_pursues_initiative' },
    { source_id: helmStrategicTheme.id, target_id: helmOutcome.id, type: 'strategic_theme_delivers_outcome' },
    { source_id: helmInitiative.id, target_id: helmOutcome.id, type: 'initiative_drives_outcome' },
    { source_id: helmObjective.id, target_id: helmOutcome.id, type: 'objective_advances_outcome' },
    { source_id: helmObjective.id, target_id: helmStrategicQuestion.id, type: 'objective_raises_strategic_question' },
    { source_id: helmObjective.id, target_id: helmDependency.id, type: 'objective_depends_on_dependency' },
    { source_id: helmJourneyPhase.id, target_id: helmOperatingStage.id, type: 'journey_phase_realises_operating_stage' },
    { source_id: helmOperatingLifecycle.id, target_id: helmOperatingStage.id, type: 'operating_lifecycle_contains_operating_stage' },
    { source_id: helmResearchStudy.id, target_id: helmResearchQuestion.id, type: 'research_study_investigates_research_question' },
    { source_id: helmResearchStudy.id, target_id: helmParticipant.id, type: 'research_study_enrolls_participant' },
    { source_id: helmResearchStudy.id, target_id: helmObservation.id, type: 'research_study_captures_observation' },
    { source_id: helmParticipant.id, target_id: helmQuote.id, type: 'participant_voiced_quote' },
    { source_id: helmObservation.id, target_id: helmInsight.id, type: 'observation_yields_insight' },
    { source_id: helmInsight.id, target_id: helmQuote.id, type: 'insight_evidenced_by_quote' },
    { source_id: helmObservation.id, target_id: helmQuote.id, type: 'observation_evidenced_by_quote' },
  ])

  // ── 8. Product content: HELM MOBILE (medium) ───────────────────────────────
  const hmPersona = { id: nid('n'), type: 'persona', title: 'Mobile Dispatcher View', description: 'Same dispatcher persona, viewed on a phone between gate walks.' }
  const hmJob = { id: nid('n'), type: 'job', title: 'Coordinate daily flight assignments' }
  const hmNeed = { id: nid('n'), type: 'need', title: 'Real-time visibility into fleet position' }
  const hmFeature = { id: nid('n'), type: 'feature', title: 'Push Alerts for Reassignments' }
  const hmMetric = { id: nid('n'), type: 'metric', title: 'Weekly Active Fleets', properties: { designation: 'driver' } }
  await addNodes(HELM_MOBILE.id, [hmPersona, hmJob, hmNeed, hmFeature, hmMetric])
  await addEdges(HELM_MOBILE.id, [
    { source_id: hmPersona.id, target_id: hmJob.id, type: 'persona_pursues_job' },
    { source_id: hmPersona.id, target_id: hmNeed.id, type: 'persona_experiences_need' },
  ])

  // ── 9. Product content: CONDUIT SDK ─────────────────────────────────────────
  const cdApiContract = { id: nid('n'), type: 'api_contract', title: 'Conduit Ingestion API', properties: { protocol: 'REST', version: 'v2' } }
  const cdFeature = { id: nid('n'), type: 'feature', title: 'Third-Party Telemetry Ingestion' }
  await addNodes(CONDUIT.id, [cdApiContract, cdFeature])

  // ── 10. Product content: BEACON (deliberately thin, early-stage) ───────────
  const bcPersona = { id: nid('n'), type: 'persona', title: 'Drone Relay Operator' }
  const bcHypothesis = { id: nid('n'), type: 'hypothesis', title: 'Operators will pay for autonomous relay positioning over manual dispatch.' }
  await addNodes(BEACON.id, [bcPersona, bcHypothesis])

  // ── 11. Product content: LEGACY CONSOLE (deliberately messy) ────────────────
  // NOTE: insights-without-evidence and feature-requests-without-provenance are
  // both stage-gated to concept..mature (they exclude `sunset`) — a real spec
  // nuance discovered while building this fixture: a sunset-stage product is
  // exempt from active-content-quality checks. Legacy Console still carries the
  // evidence-free insight and provenance-free feature_request (left in place as
  // an honest record of the gap), but the only anti-pattern that actually GATES
  // here is the stage-agnostic `orphan-loose-thoughts` (>5 disconnected nodes).
  const lcInsightNoEvidence = { id: nid('n'), type: 'insight', title: 'Users complain the console is slow.' } // no evidence edge — anti-pattern exempted by sunset stage
  const lcFeatureRequestNoProvenance = { id: nid('n'), type: 'feature_request', title: 'Add dark mode' } // no source/provenance edge — anti-pattern exempted by sunset stage
  const lcOrphan1 = { id: nid('n'), type: 'assumption', title: 'Orphaned assumption nobody connected to anything.' }
  const lcOrphan2 = { id: nid('n'), type: 'decision', title: 'Decided to freeze feature work — never linked to anything downstream.' }
  const lcOrphan3 = { id: nid('n'), type: 'learning', title: 'Learned users hate the old nav — nobody wired it to a hypothesis.' }
  const lcOrphan4 = { id: nid('n'), type: 'market_trend', title: 'Stray market-trend note from an old QBR deck.' }
  await addNodes(LEGACY.id, [lcInsightNoEvidence, lcFeatureRequestNoProvenance, lcOrphan1, lcOrphan2, lcOrphan3, lcOrphan4])

  // ── 12. Product content: REVENUE OPS (operating_function, COMPLIANT) ───────
  const roNorthStar = { id: nid('n'), type: 'metric', title: 'Net Revenue Retention', properties: { designation: 'north_star', statistical_function: 'percentage', metric_category: 'revenue' } }
  const roPipeline = { id: nid('n'), type: 'pipeline_sales', title: 'Enterprise Fleet Pipeline' }
  const roGtmStrategy = { id: nid('n'), type: 'gtm_strategy', title: 'Regional Carrier Expansion' }
  await addNodes(REVENUE_OPS.id, [roNorthStar, roPipeline, roGtmStrategy])

  // ── 13. Product content: SUCCESS OPS (operating_function, VIOLATING) ───────
  // Deliberately: has operating content (customer_success domain, >3 total
  // entities so the check actually evaluates) but NO north_star metric and NO
  // org-link cross-edge — exercises both operating-function-without-north-star
  // (single-graph) and operating-function-without-org-link (portfolio-scoped).
  const soHealthScore = { id: nid('n'), type: 'customer_health_score', title: 'Fleet Health Score' }
  const soPlaybook = { id: nid('n'), type: 'playbook', title: 'At-Risk Fleet Renewal Playbook' }
  const soChurnReason = { id: nid('n'), type: 'churn_reason', title: 'Switched to in-house tooling' }
  const soTouchpoint = { id: nid('n'), type: 'touchpoint', title: 'Quarterly Business Review' }
  await addNodes(SUCCESS_OPS.id, [soHealthScore, soPlaybook, soChurnReason, soTouchpoint])

  // ── 14. Product content: DESIGN SYSTEM ──────────────────────────────────────
  const dsDesignSystem = { id: nid('n'), type: 'design_system', title: 'Meridian Design System' }
  const dsComponent1 = { id: nid('n'), type: 'design_component', title: 'Fleet Status Badge' }
  const dsComponent2 = { id: nid('n'), type: 'design_component', title: 'Route Card' }
  const dsBrandIdentity = { id: nid('n'), type: 'brand_identity', title: 'Meridian Brand Identity' }
  await addNodes(DESIGN_SYSTEM.id, [dsDesignSystem, dsComponent1, dsComponent2, dsBrandIdentity])
  await addEdges(DESIGN_SYSTEM.id, [
    { source_id: dsDesignSystem.id, target_id: dsComponent1.id, type: 'design_system_contains_design_component' },
    { source_id: dsDesignSystem.id, target_id: dsComponent2.id, type: 'design_system_contains_design_component' },
  ])

  // ── 15. Product content: WEBSITE ────────────────────────────────────────────
  const wbScreenHome = { id: nid('n'), type: 'screen', title: 'Homepage' }
  const wbScreenCompare = { id: nid('n'), type: 'screen', title: 'Helm vs SkyWire Comparison' }
  const wbFeatureShowcase = { id: nid('n'), type: 'feature', title: 'Product Showcase Block' }
  await addNodes(WEBSITE.id, [wbScreenHome, wbScreenCompare, wbFeatureShowcase])

  // ── 16. Competitors (watched) ───────────────────────────────────────────────
  const swCompetitor = { id: nid('n'), type: 'competitor', title: 'SkyWire Ops' }
  const swFeature1 = { id: nid('n'), type: 'competitor_feature', title: 'SkyWire Live Map' }
  await addNodes(SKYWIRE.id, [swCompetitor, swFeature1])

  const apCompetitor = { id: nid('n'), type: 'competitor', title: 'Altiplane' }
  const apFeature1 = { id: nid('n'), type: 'competitor_feature', title: 'Altiplane Auto-Reassign' }
  await addNodes(ALTIPLANE.id, [apCompetitor, apFeature1])

  const nsCompetitor = { id: nid('n'), type: 'competitor', title: 'Northstar Ops' }
  const nsSignal = { id: nid('n'), type: 'competitor_signal', title: 'Northstar launched an AI dispatch copilot', properties: { signal_type: 'feature_launch' } }
  const nsOpportunity = { id: nid('n'), type: 'opportunity', title: 'Ship AI-assisted reassignment before Northstar captures the narrative' }
  await addNodes(NORTHSTAR.id, [nsCompetitor, nsSignal, nsOpportunity])

  // ── 17. Org rollup (org_rollup): vision/mission/OKR ladder + org structure ──
  const orgVision = { id: nid('n'), type: 'vision', title: 'Every fleet operator flies on live, trustworthy data.' }
  const orgMission = { id: nid('n'), type: 'mission', title: 'Build the operating system for fleet dispatch.' }
  const orgOutcome = { id: nid('n'), type: 'outcome', title: 'Meridian is the default dispatch platform for regional carriers.' }
  const orgObjective = { id: nid('n'), type: 'objective', title: 'Grow regional-carrier fleet share to 25%' }
  const orgKeyResult = { id: nid('n'), type: 'key_result', title: 'Regional carrier fleet share: 12% -> 25%' }
  const orgMetric = { id: nid('n'), type: 'metric', title: 'Company-wide Fleet Share', properties: { designation: 'north_star', statistical_function: 'percentage' } }
  const orgStrategicTheme = { id: nid('n'), type: 'strategic_theme', title: 'Win Regional Carriers' }
  const orgTeamPlatform = { id: nid('n'), type: 'team', title: 'Platform Team' }
  const orgTeamRevenue = { id: nid('n'), type: 'team', title: 'Revenue Team' }
  const orgDeptRevenue = { id: nid('n'), type: 'department', title: 'Revenue Org' }
  const orgDependency = { id: nid('n'), type: 'dependency', title: 'Company OKR waiting on Helm dispatch-time objective' }
  const orgCapability = { id: nid('n'), type: 'capability', title: 'Cross-Fleet Benchmarking' }
  const orgMetricOtp = { id: nid('n'), type: 'metric', title: 'On-Time Performance', properties: { designation: 'kpi', unit: '%' } }
  await addNodes(ORG.id, [
    orgVision, orgMission, orgOutcome, orgObjective, orgKeyResult, orgMetric, orgStrategicTheme,
    orgTeamPlatform, orgTeamRevenue, orgDeptRevenue, orgDependency, orgCapability, orgMetricOtp,
  ])
  await addEdges(ORG.id, [
    { source_id: orgObjective.id, target_id: orgKeyResult.id, type: 'objective_achieved_through_key_result' },
    { source_id: orgKeyResult.id, target_id: orgMetric.id, type: 'key_result_quantified_by_metric' },
    { source_id: orgOutcome.id, target_id: orgMetric.id, type: 'outcome_measured_by_metric' },
    { source_id: orgStrategicTheme.id, target_id: orgObjective.id, type: 'strategic_theme_contains_objective' },
    { source_id: orgDeptRevenue.id, target_id: orgTeamRevenue.id, type: 'department_contains_team' },
    { source_id: orgMetric.id, target_id: orgMetricOtp.id, type: 'metric_decomposes_into_metric' },
  ])

  await flushAll()
  console.log('Product content authored for all 13 products; flushed to disk.')

  // ── 18. Cross-product edges: peer overlap ──────────────────────────────────
  await batchXEdges([
    { source_id: `${HELM.id}/${helmPersonaDispatcher.id}`, target_id: `${HELM_MOBILE.id}/${hmPersona.id}`, type: 'shares_persona' },
    { source_id: `${HELM.id}/${helmJob.id}`, target_id: `${HELM_MOBILE.id}/${hmJob.id}`, type: 'shares_job' },
    { source_id: `${HELM.id}/${helmNeed.id}`, target_id: `${HELM_MOBILE.id}/${hmNeed.id}`, type: 'shares_need' },
    { source_id: `${HELM.id}/${helmMetric.id}`, target_id: `${HELM_MOBILE.id}/${hmMetric.id}`, type: 'shares_metric' },
    { source_id: `${HELM.id}/${helmCompetitorStub.id}`, target_id: `${SKYWIRE.id}/${swCompetitor.id}`, type: 'shares_competitor' },
  ])

  // ── 19. Cross-product edges: product-to-product ────────────────────────────
  await batchXEdges([
    { source_id: prod(HELM_MOBILE.id), target_id: prod(HELM.id), type: 'depends_on_product' },
    { source_id: prod(BEACON.id), target_id: prod(HELM.id), type: 'cannibalises' },
    { source_id: prod(HELM.id), target_id: prod(LEGACY.id), type: 'succeeds' },
    { source_id: prod(HELM.id), target_id: prod(CONDUIT.id), type: 'hosts' },
  ])

  // ── 20. Cross-product edges: OKR / measurement rollup ──────────────────────
  await batchXEdges([
    { source_id: `${HELM.id}/${helmObjective.id}`, target_id: `${ORG.id}/${orgKeyResult.id}`, type: 'objective_achieved_through_key_result' },
    { source_id: `${HELM.id}/${helmMetric.id}`, target_id: `${ORG.id}/${orgMetric.id}`, type: 'rolls_up_to' },
    { source_id: `${REVENUE_OPS.id}/${roNorthStar.id}`, target_id: `${ORG.id}/${orgOutcome.id}`, type: 'contributes_to' },
  ])
  await batchXEdges([
    { source_id: prod(HELM.id), target_id: `${ORG.id}/${orgObjective.id}`, type: 'product_targets_objective' },
    { source_id: prod(REVENUE_OPS.id), target_id: `${ORG.id}/${orgOutcome.id}`, type: 'product_pursues_outcome' },
    { source_id: `${ORG.id}/${orgStrategicTheme.id}`, target_id: `${HELM.id}/${helmObjective.id}`, type: 'strategic_theme_contains_objective' },
  ])

  // ── 21. Cross-product edges: foundations (specification/primitive) ─────────
  await batchXEdges([
    { source_id: prod(CONDUIT.id), target_id: `registry/${canonSpec.id}`, type: 'product_implements_specification' },
    { source_id: prod(CONDUIT.id), target_id: `registry/${canonSpec.id}`, type: 'product_exposes_specification' },
    { source_id: `${CONDUIT.id}/${cdFeature.id}`, target_id: `registry/${canonSpec.id}`, type: 'feature_conforms_to_specification' },
    { source_id: `${CONDUIT.id}/${cdApiContract.id}`, target_id: `registry/${canonSpec.id}`, type: 'api_contract_speaks_specification' },
    { source_id: prod(CONDUIT.id), target_id: `registry/${canonPrimitive.id}`, type: 'product_exposes_primitive' },
    { source_id: `${CONDUIT.id}/${cdFeature.id}`, target_id: `registry/${canonPrimitive.id}`, type: 'feature_manipulates_primitive' },
  ])
  // Note: primitive_stored_as_data_type NOT exercised — spec 0.17.8 has no
  // `data_type` entity type, so there is no valid target for this cross-only
  // edge type in the current catalog. See README coverage table.

  // ── 22. Cross-product edges: persona/brand/marketing ────────────────────────
  await batchXEdges([
    { source_id: `${HELM.id}/${helmPersonaDispatcher.id}`, target_id: `${HELM.id}/${helmPersonaOpsManager.id}`, type: 'persona_delegates_to_persona' },
    { source_id: prod(WEBSITE.id), target_id: `registry/${canonPersona.id}`, type: 'product_expresses_brand_identity' },
  ])
  await batchXEdges([
    { source_id: `${WEBSITE.id}/${wbScreenHome.id}`, target_id: `${DESIGN_SYSTEM.id}/${dsComponent1.id}`, type: 'screen_renders_design_component' },
    { source_id: `${WEBSITE.id}/${wbScreenHome.id}`, target_id: prod(HELM.id), type: 'screen_markets_product' },
    { source_id: `${WEBSITE.id}/${wbScreenCompare.id}`, target_id: `${SKYWIRE.id}/${swCompetitor.id}`, type: 'screen_targets_competitor' },
    { source_id: `${WEBSITE.id}/${wbFeatureShowcase.id}`, target_id: prod(HELM.id), type: 'feature_surfaces_product' },
    { source_id: `${HELM.id}/${helmFeature1.id}`, target_id: `${DESIGN_SYSTEM.id}/${dsComponent2.id}`, type: 'feature_uses_design_component' },
    { source_id: prod(HELM.id), target_id: `${DESIGN_SYSTEM.id}/${dsDesignSystem.id}`, type: 'product_implements_design_system' },
  ])

  // ── 23. Cross-product edges: org ownership + dependency ─────────────────────
  await batchXEdges([
    { source_id: prod(REVENUE_OPS.id), target_id: `${ORG.id}/${orgDeptRevenue.id}`, type: 'node_owned_by_department' },
    { source_id: prod(HELM.id), target_id: `${ORG.id}/${orgTeamPlatform.id}`, type: 'node_owned_by_team' },
    // success-ops deliberately gets NO node_owned_by_* edge (org-link violation).
  ])
  await batchXEdges([
    { source_id: `${HELM.id}/${helmObjective.id}`, target_id: `${ORG.id}/${orgDependency.id}`, type: 'objective_depends_on_dependency' },
    { source_id: `${ORG.id}/${orgDependency.id}`, target_id: `${HELM.id}/${helmObjective.id}`, type: 'dependency_blocks_objective' },
  ])

  // ── 24. Cross-product edges: defer (property-carrying, deliberate_only) ─────
  await batchXEdges([
    {
      source_id: `${HELM.id}/${helmObjective.id}`,
      target_id: `${BEACON.id}/${bcHypothesis.id}`,
      type: 'objective_defers_capability',
      properties: { deferred_to: '2027-Q1' },
    },
  ])
  bodyOf(
    await createCrossProductEdge(
      {
        source_id: `${HELM.id}/${helmObjective.id}`,
        target_id: `${ORG.id}/${orgCapability.id}`,
        type: 'objective_defers_capability',
        properties: { deferred_to: '2026-Q4' },
      },
      scratchCtx,
    ),
  )

  console.log('Cross-product edges: peer-overlap, product-to-product, OKR rollup, foundations, brand/marketing, org-ownership, defer — done.')

  // ── 25. Registry: instance_of (with one sanctioned alias divergence) ───────
  bodyOf(await registerInstance({ node_id: `${HELM.id}/${helmPersonaDispatcher.id}`, canonical_id: canonPersona.id, source_product_id: HELM.id }, scratchCtx))
  bodyOf(await registerInstance({ node_id: `${HELM_MOBILE.id}/${hmPersona.id}`, canonical_id: canonPersona.id, source_product_id: HELM_MOBILE.id, alias: true }, scratchCtx))
  bodyOf(await registerInstance({ node_id: `${ORG.id}/${orgMetricOtp.id}`, canonical_id: canonMetric.id, source_product_id: ORG.id }, scratchCtx))
  bodyOf(await promoteToCanonical({ node_id: helmCompetitorStub.id, source_product_id: HELM.id, canonical_id: 'canon_skywire_competitor' }, scratchCtx))

  // ── 26. Area-to-audience matrix ──────────────────────────────────────────────
  bodyOf(await linkAreaToAudience({ area_id: areaPlatform.id, canonical_id: canonPersona.id, relevance: 'primary', audience_role: 'user' }, scratchCtx))
  bodyOf(await linkAreaToAudience({ area_id: areaGtm.id, canonical_id: canonSegment.id, relevance: 'primary' }, scratchCtx))

  // ── 27. Parity edge (property-carrying) ─────────────────────────────────────
  bodyOf(
    await createParityEdge(
      {
        feature_id: `${HELM.id}/${helmFeature1.id}`,
        competitor_feature_id: `${ALTIPLANE.id}/${apFeature1.id}`,
        parity_status: 'behind',
        quality: 'worse',
        evidence: 'Altiplane auto-reassigns within 8s; Helm dispatch copilot averages 45s (Q2 2026 bakeoff).',
        confidence: 'medium',
        assessed_on: '2026-06-01',
      },
      scratchCtx,
    ),
  )

  // ── 28. Classification edges (twice, same axis, to emit a reclassification
  //        signal — the write path retires the first edge automatically) ────
  bodyOf(
    await createClassificationEdge(
      { node_id: `${SKYWIRE.id}/${swCompetitor.id}`, classification_value_id: `registry/${canonValueOnPrem.id}`, node_product_id: SKYWIRE.id, confidence: 'medium', rationale: 'SkyWire shipped primarily on-prem through 2025.' },
      scratchCtx,
    ),
  )
  bodyOf(
    await createClassificationEdge(
      { node_id: `${SKYWIRE.id}/${swCompetitor.id}`, classification_value_id: `registry/${canonValueCloud.id}`, node_product_id: SKYWIRE.id, confidence: 'high', rationale: 'SkyWire completed cloud migration in Q1 2026 — reclassifying.', evidence: 'SkyWire changelog, 2026-03-14: "Cloud-only GA."' },
      scratchCtx,
    ),
  )

  // Node-level (non-competitor) classification, for polymorphic coverage.
  bodyOf(
    await createClassificationEdge(
      { node_id: prod(LEGACY.id), classification_value_id: `registry/${canonValueOnPrem.id}`, node_product_id: LEGACY.id, rationale: 'Legacy Console is our own on-prem-era product, kept for classification-axis coverage.' },
      scratchCtx,
    ),
  )

  // ── 29. Competitor signal edges ─────────────────────────────────────────────
  await batchXEdges([
    { source_id: `${NORTHSTAR.id}/${nsSignal.id}`, target_id: `${HELM.id}/${helmFeature2.id}`, type: 'competitor_signal_maps_to_feature' },
    { source_id: `${NORTHSTAR.id}/${nsSignal.id}`, target_id: `${NORTHSTAR.id}/${nsOpportunity.id}`, type: 'competitor_signal_surfaces_opportunity' },
  ])

  await flushAll()
  console.log('Registry links, area-audience matrix, parity, classification (+signal), competitor-signal edges — done.')

  // ── 30. Verify: run the actual portfolio read/validate handlers ────────────
  const digest = bodyOf(await portfolioDigest({}, scratchCtx))
  const personaCensus = bodyOf(await portfolioCensus({ type: 'persona', group_by: 'product' }, scratchCtx))
  const validation = bodyOf(await portfolioValidate({ include_violations: true, violation_limit: 25 }, scratchCtx))
  const tree = bodyOf(await getPortfolioTree({ shape: 'structure' }, scratchCtx))

  const summary = {
    generated_at: new Date().toISOString(),
    digest_rollup: digest.rollup,
    persona_census_total: personaCensus.total ?? null,
    validation_rollup: validation.rollup,
    validation_by_product: validation.products.map((p: any) => ({
      product_id: p.product_id,
      title: p.title,
      valid: p.valid,
      anti_patterns: p.anti_patterns,
      top_violations: (p.top_violations ?? []).map((v: any) => v.anti_pattern_id),
    })),
    registry_drift: validation.registry_drift,
    portfolio_anti_patterns: validation.portfolio_anti_patterns,
    tree_stats: tree.stats,
  }
  writeFileSync(join(TARGET, 'GENERATED-SUMMARY.json'), JSON.stringify(summary, null, 2))
  console.log('\n=== Verification ===')
  console.log(JSON.stringify(summary, null, 2))

  process.chdir(prevCwd)
  console.log(`\nDone. Fixture at ${TARGET}`)
}

/**
 * Cross-product edges require both sides pre-qualified as `{product_id}/{node_id}`
 * (createCrossProductEdge rejects a bare id with no `source_product_id`/
 * `target_product_id`, and does NOT verify the node actually exists in that
 * product's graph — it only derives `source_product_id`/`target_product_id`
 * from the qualified string). For a product-to-product edge (depends_on_product,
 * cannibalises, succeeds, hosts, product_targets_objective, ...) where the
 * "node" IS the product itself, qualify it as the product id referencing itself.
 */
function prod(id: string): string {
  return `${id}/${id}`
}

async function batchXEdges(edges: Array<Record<string, unknown>>) {
  for (let i = 0; i < edges.length; i += 50) {
    const chunk = edges.slice(i, i + 50)
    bodyOf(await batchCreateCrossProductEdges({ edges: chunk, auto_create_portfolio: false }, scratchCtx))
  }
}

main().catch((err) => {
  process.chdir(prevCwd)
  console.error(err)
  process.exit(1)
})
