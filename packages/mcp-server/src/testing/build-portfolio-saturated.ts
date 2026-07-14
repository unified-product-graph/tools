/**
 * Builds the `portfolio-saturated` fixture: a real, recognisable multi-product
 * company - **Atlassian** - authored to saturate every portfolio-level feature
 * the spec supports: all 4 `member_kind`s, all 5 portfolio `kind`s, nested
 * portfolios and areas, the canonical registry tier (with a sanctioned `alias`
 * divergence), the reclassification signal stream, and broad coverage of the
 * cross-product edge types.
 *
 * The portfolio: Atlassian's real product surface - Jira (flagship), Confluence,
 * Bitbucket, Rovo (AI, incubated in Point A), Hipchat (sunset), the Atlassian
 * Design System, and atlassian.com; Revenue & Support Operations as operating
 * functions; GitLab / Linear / Notion as watched competitors; and the Atlassian
 * corporate rollup. Content is a faithful-but-simplified model of the real
 * ecosystem; the *shape* is engineered for coverage.
 *
 * ── Why this is an E2E test, not a hand-rolled fixture ──────────────────────
 * The build drives the real MCP tool handlers end-to-end - the authentic
 * portfolio-creation path a user/agent follows:
 *
 *     init_workspace → create_product ×N → create_area / create_portfolio →
 *     attach / assign → batch_create_nodes / batch_create_edges →
 *     create_cross_product_edge / register_instance / create_parity_edge /
 *     create_classification_edge → portfolio_validate / _digest / _census
 *
 * `create_product` seeds a real `product` node (id === product id), so
 * product-to-product cross-edges reference an actual node rather than a
 * fabricated `{id}/{id}` - there are NO hand-written skeleton graphs and NO
 * cross-edges pointing at non-existent nodes. Every write is schema-validated
 * by the handler at author time. `buildPortfolioSaturated()` is exported so a
 * vitest can run the whole sequence against a tmp workspace and assert on the
 * portfolio read/validate output (see __tests__/portfolio-creation-e2e.test.ts).
 *
 * One product (`hipchat`, sunset) is deliberately messy - orphan nodes,
 * evidence-free insight, missing provenance - so `portfolio_validate` has real
 * violations to catch. One operating_function (`support-ops`) is deliberately
 * non-compliant (no north-star metric, no org-link) to exercise the
 * operating-function anti-pattern trio.
 *
 * Entry point: scripts/build-portfolio-saturated.ts (thin CLI wrapper).
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
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
} from '../lib/server-context.js'

import { batchCreateNodes } from '../tools/nodes.js'
import { batchCreateEdges } from '../tools/edges.js'
import {
  createArea,
  createPortfolio,
  assignProductToAreaTool,
} from '../tools/areas.js'
import {
  initWorkspaceTool,
  createProductTool,
  attachProductToPortfolioTool,
  createCrossProductEdge,
  batchCreateCrossProductEdges,
  createParityEdge,
  createClassificationEdge,
  linkAreaToAudience,
} from '../tools/workspace.js'
import { createNode } from '../tools/nodes.js'
import {
  defineCanonicalEntity,
  registerInstance,
  promoteToCanonical,
  createRegistryEdge,
} from '../tools/registry.js'
import {
  portfolioValidate,
  portfolioDigest,
  portfolioCensus,
  getPortfolioTree,
} from '../tools/portfolio-read.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

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

const idCounter = { n: 0 }
function nid(prefix: string): string {
  idCounter.n += 1
  return `${prefix}_${idCounter.n.toString(36).padStart(4, '0')}`
}

/**
 * A live handle on one product's graph. `id`/`file` come back from
 * `create_product` (the real minted id + workspace-relative path); `store` is a
 * fresh store opened on that file so content is authored through the real
 * node/edge handlers.
 */
interface Product {
  key: string
  id: string
  file: string
  store: UPGFileStore
  member_kind: 'product' | 'org_rollup' | 'watched' | 'operating_function'
}

/**
 * Cross-product edges qualify both sides as `{product_id}/{node_id}`. For a
 * product-to-product edge (depends_on_product, succeeds, …) where the "node" IS
 * the product itself, reference the seeded product node - whose id === product
 * id (create_product, workspace.ts). No fabricated ids.
 */
function prod(p: Product): string {
  return `${p.id}/${p.id}`
}

// ─── the build ─────────────────────────────────────────────────────────────────

export interface BuildResult {
  summary: Record<string, unknown>
  validation: any
  digest: any
  census: any
  tree: any
}

/**
 * Author the entire Atlassian portfolio into `<targetDir>/.upg/` by driving the
 * real MCP tool handlers, then run the portfolio read/validate handlers and
 * return their output. Chdirs into `targetDir` for the duration (cwd-dependent
 * portfolio path resolution) and restores the previous cwd on exit.
 *
 * Idempotent: wipes and recreates `<targetDir>/.upg/` on every run.
 */
export async function buildPortfolioSaturated(targetDir: string): Promise<BuildResult> {
  const UPG_DIR = join(targetDir, '.upg')
  if (existsSync(UPG_DIR)) rmSync(UPG_DIR, { recursive: true, force: true })
  mkdirSync(UPG_DIR, { recursive: true })

  const prevCwd = process.cwd()
  process.chdir(targetDir)

  const stores: UPGFileStore[] = []
  try {
    return await author(UPG_DIR)
  } finally {
    for (const s of stores) {
      try {
        s.stopWatching()
      } catch {
        /* already stopped */
      }
    }
    process.chdir(prevCwd)
  }

  // ── inner authoring closure (keeps `stores` in scope for cleanup) ──────────
  async function author(upgDir: string): Promise<BuildResult> {
    // Every product store we open, tracked so `finally` can stop watchers.
    const track = (s: UPGFileStore): UPGFileStore => {
      stores.push(s)
      return s
    }

    // ── 1. Bootstrap: the org rollup is the founding graph ────────────────────
    // A real workspace begins as a single .upg; init_workspace turns it into a
    // portfolio. We seed the Atlassian corporate rollup (a minimal, valid
    // UPGDocument with its product node) and initialise the workspace around it.
    const ORG_ID = 'p_atlassian_corp'
    const ORG_FILE = 'atlassian-corp.upg'
    const orgSeed = {
      upg_version: '0.5',
      exported_at: new Date(0).toISOString(),
      source: { tool: 'build-portfolio-saturated' },
      product: {
        id: ORG_ID,
        title: 'Atlassian (Corporate Rollup)',
        description:
          'Company umbrella graph - vision, mission, OKR ladder, org structure. The founding graph the portfolio was initialised around.',
        stage: 'mature',
      },
      member_kind: 'org_rollup' as const,
      nodes: [
        {
          id: ORG_ID,
          type: 'product',
          title: 'Atlassian (Corporate Rollup)',
          properties: { stage: 'mature' },
        },
      ],
      edges: [],
    }
    writeFileSync(join(upgDir, ORG_FILE), JSON.stringify(orgSeed, null, 2))
    const orgStore = track(new UPGFileStore())
    await orgStore.load(join(upgDir, ORG_FILE))
    orgStore.stopWatching()

    // scratchCtx: the "active" store for portfolio-scoped handlers (create_product,
    // areas, portfolios, cross-edges, registry). These resolve portfolio.upg /
    // sibling files off process.cwd(); ctx.store is only touched by
    // create_product's deprecated in-graph attach path (never exercised here).
    const scratchCtx = makeCtx(orgStore)

    bodyOf(await initWorkspaceTool({ move_existing: false }, scratchCtx))

    // init_workspace registers the seed as {file, title} but does not cache
    // member_kind (it only reads the title). Annotate the workspace.json entry
    // so list_local_products / portfolio_census see the org as a rollup - the
    // one field create_product would have written for us.
    patchWorkspaceMemberKind(upgDir, ORG_FILE, 'org_rollup')

    // ── 2. Products: create the other 12 via the real create_product tool ─────
    // Each mints a canonical id, seeds a product node, writes the file into the
    // right subfolder, and registers on workspace.json + portfolio.upg.
    const org: Product = { key: 'ORG', id: ORG_ID, file: ORG_FILE, store: orgStore, member_kind: 'org_rollup' }

    async function makeProduct(args: {
      key: string
      name: string
      slug: string
      description: string
      stage: string
      dir?: string
      member_kind?: 'product' | 'watched' | 'operating_function'
    }): Promise<Product> {
      const res = bodyOf(
        await createProductTool(
          {
            name: args.name,
            slug: args.slug,
            description: args.description,
            stage: args.stage,
            ...(args.dir ? { dir: args.dir } : {}),
            ...(args.member_kind ? { member_kind: args.member_kind } : {}),
          },
          scratchCtx,
        ),
      )
      const store = track(new UPGFileStore())
      await store.load(join(upgDir, res.file))
      store.stopWatching()
      return { key: args.key, id: res.id, file: res.file, store, member_kind: args.member_kind ?? 'product' }
    }

    const JIRA = await makeProduct({ key: 'JIRA', name: 'Jira', slug: 'jira', dir: 'products', stage: 'growth', description: 'Flagship issue tracking and agile planning - boards, backlogs, sprints, roadmaps for software teams.' })
    const CONFLUENCE = await makeProduct({ key: 'CONFLUENCE', name: 'Confluence', slug: 'confluence', dir: 'products', stage: 'mature', description: 'Team workspace and knowledge base - docs, whiteboards, and decisions alongside the work in Jira.' })
    const BITBUCKET = await makeProduct({ key: 'BITBUCKET', name: 'Bitbucket', slug: 'bitbucket', dir: 'products', stage: 'mature', description: 'Git code hosting and CI/CD (Pipelines) for teams - the source-of-truth for repositories and deploys.' })
    const ROVO = await makeProduct({ key: 'ROVO', name: 'Rovo', slug: 'rovo', dir: 'products', stage: 'validation', description: 'AI teammates and search across Atlassian and connected tools. Incubated in Point A; validating adoption.' })
    const HIPCHAT = await makeProduct({ key: 'HIPCHAT', name: 'Hipchat', slug: 'hipchat', dir: 'products', stage: 'sunset', description: 'The original team chat product, sunset in favour of partner messaging. Kept as a wind-down graph.' })
    const DESIGN_SYSTEM = await makeProduct({ key: 'DESIGN_SYSTEM', name: 'Atlassian Design System', slug: 'atlassian-design-system', dir: 'design-system', stage: 'mature', description: 'Shared design system: components, tokens, and brand identity across every Atlassian surface.' })
    const WEBSITE = await makeProduct({ key: 'WEBSITE', name: 'atlassian.com', slug: 'atlassian-com', dir: 'web-ecosystem', stage: 'growth', description: 'Marketing site - product pages, competitor comparisons, pricing.' })
    const REVENUE_OPS = await makeProduct({ key: 'REVENUE_OPS', name: 'Revenue Operations', slug: 'revenue-ops', dir: 'products', stage: 'mature', description: 'Revenue operating function - pipeline, forecasting, deal desk, expansion.', member_kind: 'operating_function' })
    const SUPPORT_OPS = await makeProduct({ key: 'SUPPORT_OPS', name: 'Support Operations', slug: 'support-ops', dir: 'products', stage: 'mature', description: 'Customer support operating function - health scoring, renewals playbooks, escalations.', member_kind: 'operating_function' })
    const GITLAB = await makeProduct({ key: 'GITLAB', name: 'GitLab - Competitor Intel', slug: 'competitor-gitlab', dir: 'competitors', stage: 'growth', description: 'Competitive intelligence graph for GitLab (rivals Bitbucket).', member_kind: 'watched' })
    const LINEAR = await makeProduct({ key: 'LINEAR', name: 'Linear - Competitor Intel', slug: 'competitor-linear', dir: 'competitors', stage: 'growth', description: 'Competitive intelligence graph for Linear (rivals Jira).', member_kind: 'watched' })
    const NOTION = await makeProduct({ key: 'NOTION', name: 'Notion - Competitor Intel', slug: 'competitor-notion', dir: 'competitors', stage: 'growth', description: 'Competitive intelligence graph for Notion (rivals Confluence).', member_kind: 'watched' })

    const PRODUCTS = [JIRA, CONFLUENCE, BITBUCKET, ROVO, HIPCHAT, DESIGN_SYSTEM, WEBSITE, REVENUE_OPS, SUPPORT_OPS, GITLAB, LINEAR, NOTION, org]

    // small helpers bound to a product's store
    async function addNodes(p: Product, nodes: Array<{ id: string; type: string; title: string; [k: string]: unknown }>): Promise<void> {
      const ctx = makeCtx(p.store)
      for (let i = 0; i < nodes.length; i += 50) {
        const chunk = nodes.slice(i, i + 50)
        const result = bodyOf(await batchCreateNodes({ nodes: chunk.map(({ id: _drop, ...rest }) => rest) }, ctx))
        const created: Array<{ id: string }> = result.created
        chunk.forEach((n, idx) => { n.id = created[idx].id })
      }
    }
    async function addEdges(p: Product, edges: Array<Record<string, unknown>>): Promise<void> {
      const ctx = makeCtx(p.store)
      for (let i = 0; i < edges.length; i += 50) {
        bodyOf(await batchCreateEdges({ edges: edges.slice(i, i + 50) }, ctx))
      }
    }
    async function batchXEdges(edges: Array<Record<string, unknown>>): Promise<void> {
      for (let i = 0; i < edges.length; i += 50) {
        bodyOf(await batchCreateCrossProductEdges({ edges: edges.slice(i, i + 50), auto_create_portfolio: false }, scratchCtx))
      }
    }

    // ── 3. Organization singleton (routes to portfolio.upg) ───────────────────
    bodyOf(
      await createNode(
        {
          type: 'organization',
          title: 'Atlassian',
          description:
            'Enterprise software company - the maker of Jira, Confluence, Bitbucket, and more. Modelled here as the UPG portfolio-saturated fixture: a real, recognisable multi-product portfolio used to battle-test portfolio features (nested portfolios/areas, registry, cross-edges, all member_kinds, reclassification signals). Content is a simplified public-knowledge model.',
          properties: { industry: 'Team collaboration & developer software (SaaS)' },
          overwrite_organization: true,
        },
        scratchCtx,
      ),
    )

    // ── 4. Areas (organisational axis, one nested) ────────────────────────────
    const areaEng = bodyOf(await createArea({ title: 'Product Engineering', strategic_priority: 'critical' }, scratchCtx)).node
    const areaAI = bodyOf(await createArea({ title: 'AI & Intelligence', parent_area_id: areaEng.id, strategic_priority: 'high' }, scratchCtx)).node
    const areaGtm = bodyOf(await createArea({ title: 'Go-to-Market Org', strategic_priority: 'high' }, scratchCtx)).node
    const areaDesign = bodyOf(await createArea({ title: 'Design & Brand', strategic_priority: 'medium' }, scratchCtx)).node

    // ── 5. Portfolios (strategic axis, one nested, all 5 kinds) ───────────────
    const pfCloud = bodyOf(await createPortfolio({ title: 'Atlassian Cloud', kind: 'owned', hierarchy_model: 'nested' }, scratchCtx)).node
    const pfPointA = bodyOf(await createPortfolio({ title: 'Point A', kind: 'strategic', parent_portfolio_id: pfCloud.id }, scratchCtx)).node // real Atlassian incubator
    const pfGtm = bodyOf(await createPortfolio({ title: 'Go-to-Market', kind: 'gtm' }, scratchCtx)).node
    const pfInternal = bodyOf(await createPortfolio({ title: 'Brand & Web', kind: 'internal' }, scratchCtx)).node
    const pfCompetitive = bodyOf(await createPortfolio({ title: 'Competitive Landscape', kind: 'watched' }, scratchCtx)).node

    // ── 6. Attach products to portfolios + assign to areas ────────────────────
    const attachments: Array<[Product, { id: string }, { id: string } | null]> = [
      [JIRA, pfCloud, areaEng],
      [CONFLUENCE, pfCloud, areaEng],
      [BITBUCKET, pfCloud, areaEng],
      [ROVO, pfPointA, areaAI],
      [HIPCHAT, pfCloud, areaEng],
      [REVENUE_OPS, pfGtm, areaGtm],
      [SUPPORT_OPS, pfGtm, areaGtm],
      [DESIGN_SYSTEM, pfInternal, areaDesign],
      [WEBSITE, pfInternal, areaDesign],
      [GITLAB, pfCompetitive, null],
      [LINEAR, pfCompetitive, null],
      [NOTION, pfCompetitive, null],
    ]
    for (const [p, pf, area] of attachments) {
      bodyOf(await attachProductToPortfolioTool({ product_id: p.id, portfolio_id: pf.id }, scratchCtx))
      if (area) bodyOf(await assignProductToAreaTool({ product_id: p.id, area_id: area.id }, scratchCtx))
    }
    // ORG (org_rollup) deliberately left outside every portfolio/area - org-level.

    // ── 7. Registry (canonical shared-vocabulary tier) ────────────────────────
    const canonPersona = bodyOf(await defineCanonicalEntity({ type: 'persona', title: 'Software Team Lead', description: 'Leads a software delivery team; plans sprints and tracks work across Jira and Confluence.', properties: { audience_role: 'user' } }, scratchCtx)).canonical
    const canonMetric = bodyOf(await defineCanonicalEntity({ type: 'metric', title: 'Monthly Active Users', description: 'Distinct users active across Atlassian products in a calendar month.', properties: { designation: 'kpi', unit: 'count' } }, scratchCtx)).canonical
    const canonSegment = bodyOf(await defineCanonicalEntity({ type: 'market_segment', title: 'Enterprise Engineering Orgs', description: 'Large software organisations, 500+ engineers, standardising on a single toolchain.' }, scratchCtx)).canonical
    const canonSpec = bodyOf(await defineCanonicalEntity({ type: 'specification', title: 'Git Protocol', description: 'The Git wire protocol Bitbucket implements for clone/fetch/push.' }, scratchCtx)).canonical
    const canonPrimitive = bodyOf(await defineCanonicalEntity({ type: 'primitive', title: 'Repository', description: 'The canonical data primitive representing a single version-controlled repository.' }, scratchCtx)).canonical
    // Classification axis + values MUST live in the registry (not a product-local
    // graph): the reclassification-signal detector only reads portfolio.upg's
    // registry.nodes/registry.edges, never product files.
    const canonAxis = bodyOf(await defineCanonicalEntity({ type: 'classification_axis', title: 'Deployment Model' }, scratchCtx)).canonical
    const canonValueCloud = bodyOf(await defineCanonicalEntity({ type: 'classification_value', title: 'Cloud-Native', properties: { rationale: 'Multi-tenant SaaS, no self-managed option.' } }, scratchCtx)).canonical
    const canonValueDataCenter = bodyOf(await defineCanonicalEntity({ type: 'classification_value', title: 'Data Center (Self-Managed)', properties: { rationale: 'Customer-hosted deployment; GitLab is migrating its centre of gravity to SaaS.' } }, scratchCtx)).canonical
    bodyOf(await createRegistryEdge({ source_id: canonAxis.id, target_id: canonValueCloud.id, type: 'classification_axis_includes_classification_value' }, scratchCtx))
    bodyOf(await createRegistryEdge({ source_id: canonAxis.id, target_id: canonValueDataCenter.id, type: 'classification_axis_includes_classification_value' }, scratchCtx))

    // ── 8. Product content: JIRA (rich flagship) ──────────────────────────────
    const jiraPersonaLead = { id: nid('n'), type: 'persona', title: 'Software Team Lead', description: 'Plans and tracks the team\'s sprint work in Jira.', properties: { audience_role: 'user' } }
    const jiraPersonaEngMgr = { id: nid('n'), type: 'persona', title: 'Engineering Manager', description: 'Oversees several teams; escalation point for cross-team delivery risk.', properties: { audience_role: 'buyer' } }
    const jiraJob = { id: nid('n'), type: 'job', title: 'Plan and track the team\'s sprint work', description: 'Break work into issues, sequence a sprint, and keep the board current.' }
    const jiraNeed = { id: nid('n'), type: 'need', title: 'A single source of truth for who is working on what' }
    const jiraVision = { id: nid('n'), type: 'vision', title: 'Every team ships with confidence.' }
    const jiraMission = { id: nid('n'), type: 'mission', title: 'Give every software team a live, trustworthy plan.' }
    const jiraOutcome = { id: nid('n'), type: 'outcome', title: 'Teams cut planning overhead and ship predictably.' }
    const jiraObjective = { id: nid('n'), type: 'objective', title: 'Cut average issue cycle time by 30%' }
    const jiraKeyResult = { id: nid('n'), type: 'key_result', title: 'Median cycle time drops from 6 days to 4 days' }
    const jiraMetric = { id: nid('n'), type: 'metric', title: 'Weekly Active Projects', properties: { designation: 'driver', statistical_function: 'count', metric_category: 'engagement' } }
    const jiraStrategicTheme = { id: nid('n'), type: 'strategic_theme', title: 'Connected Work' }
    const jiraStrategicPillar = { id: nid('n'), type: 'strategic_pillar', title: 'Automation over manual triage' }
    const jiraInitiative = { id: nid('n'), type: 'initiative', title: 'AI-Assisted Triage Rollout' }
    const jiraConstraintInternal = { id: nid('n'), type: 'constraint', title: 'No board view may block on a slow JQL query', properties: { constraint_kind: 'technical', constraint_origin: 'internal', constraint_status: 'binding', rule_strength: 'must' } }
    const jiraConstraintExternal = { id: nid('n'), type: 'constraint', title: 'SOC 2 audit-log retention for issue changes', properties: { constraint_kind: 'regulatory', constraint_origin: 'external', constraint_status: 'binding', rule_strength: 'must', source: 'SOC 2 Type II' } }
    const jiraStrategicQuestion = { id: nid('n'), type: 'strategic_question', title: 'Should cycle time be measured per-assignee or per-team?', properties: { question: 'Should cycle time be measured per-assignee or per-team?', priority: 'high' } }
    const jiraFeature1 = { id: nid('n'), type: 'feature', title: 'Timeline (roadmap) view', description: 'Cross-team roadmap of epics on a timeline.' }
    const jiraFeature2 = { id: nid('n'), type: 'feature', title: 'Rovo AI issue triage', description: 'Suggests assignee, priority, and duplicates on new issues.' }
    const jiraApiContract = { id: nid('n'), type: 'api_contract', title: 'Jira REST API', properties: { protocol: 'REST', version: 'v3' } }
    const jiraScreen = { id: nid('n'), type: 'screen', title: 'Board' }
    const jiraCapability = { id: nid('n'), type: 'capability', title: 'Automatic backlog triage' }
    const jiraDependency = { id: nid('n'), type: 'dependency', title: 'Waiting on Bitbucket deploy-status API for the dev panel' }
    const jiraOperatingLifecycle = { id: nid('n'), type: 'operating_lifecycle', title: 'Issue Lifecycle' }
    const jiraOperatingStage = { id: nid('n'), type: 'operating_stage', title: 'In Progress' }
    const jiraJourneyPhase = { id: nid('n'), type: 'journey_phase', title: 'Active Sprint Phase' }
    const jiraCompetitorStub = { id: nid('n'), type: 'competitor', title: 'GitLab (as tracked by Jira)', description: 'Lightweight local mention; canonicalised into the registry via promote_to_canonical.' }
    // Research provenance
    const jiraResearchStudy = { id: nid('n'), type: 'research_study', title: 'Sprint Planning Study - W12 2026' }
    const jiraResearchQuestion = { id: nid('n'), type: 'research_question', title: 'Where do teams lose the most time during sprint planning?' }
    const jiraParticipant = { id: nid('n'), type: 'participant', title: 'P07 - Senior Scrum Master, 6yr tenure' }
    const jiraObservation = { id: nid('n'), type: 'observation', title: 'P07 manually reconciled the board against three spreadsheets before standup.', properties: { source_url: 'https://research.atlassian.example/studies/w12-2026/obs-04' } }
    const jiraQuote = { id: nid('n'), type: 'quote', title: '"I rebuild half the board by hand every Monday when estimates drift."', properties: { source_url: 'https://research.atlassian.example/studies/w12-2026/quote-11' } }
    const jiraInsight = { id: nid('n'), type: 'insight', title: 'Teams fall back to manual reconciliation when the board and estimates drift apart.' }
    const jiraNodes = [
      jiraPersonaLead, jiraPersonaEngMgr, jiraJob, jiraNeed, jiraVision, jiraMission, jiraOutcome,
      jiraObjective, jiraKeyResult, jiraMetric, jiraStrategicTheme, jiraStrategicPillar, jiraInitiative,
      jiraConstraintInternal, jiraConstraintExternal, jiraStrategicQuestion, jiraFeature1, jiraFeature2,
      jiraApiContract, jiraScreen, jiraCapability, jiraDependency, jiraOperatingLifecycle, jiraOperatingStage,
      jiraJourneyPhase, jiraCompetitorStub, jiraResearchStudy, jiraResearchQuestion, jiraParticipant,
      jiraObservation, jiraQuote, jiraInsight,
    ]
    await addNodes(JIRA, jiraNodes)
    await addEdges(JIRA, [
      { source_id: jiraPersonaLead.id, target_id: jiraJob.id, type: 'persona_pursues_job' },
      { source_id: jiraPersonaLead.id, target_id: jiraNeed.id, type: 'persona_experiences_need' },
      { source_id: jiraObjective.id, target_id: jiraKeyResult.id, type: 'objective_achieved_through_key_result' },
      { source_id: jiraObjective.id, target_id: jiraMetric.id, type: 'objective_measured_by_metric' },
      { source_id: jiraKeyResult.id, target_id: jiraMetric.id, type: 'key_result_quantified_by_metric' },
      { source_id: jiraOutcome.id, target_id: jiraMetric.id, type: 'outcome_measured_by_metric' },
      { source_id: jiraStrategicTheme.id, target_id: jiraObjective.id, type: 'strategic_theme_contains_objective' },
      { source_id: jiraStrategicTheme.id, target_id: jiraInitiative.id, type: 'strategic_theme_pursues_initiative' },
      { source_id: jiraStrategicTheme.id, target_id: jiraOutcome.id, type: 'strategic_theme_delivers_outcome' },
      { source_id: jiraInitiative.id, target_id: jiraOutcome.id, type: 'initiative_drives_outcome' },
      { source_id: jiraObjective.id, target_id: jiraOutcome.id, type: 'objective_advances_outcome' },
      { source_id: jiraObjective.id, target_id: jiraStrategicQuestion.id, type: 'objective_raises_strategic_question' },
      { source_id: jiraObjective.id, target_id: jiraDependency.id, type: 'objective_depends_on_dependency' },
      { source_id: jiraJourneyPhase.id, target_id: jiraOperatingStage.id, type: 'journey_phase_realises_operating_stage' },
      { source_id: jiraOperatingLifecycle.id, target_id: jiraOperatingStage.id, type: 'operating_lifecycle_contains_operating_stage' },
      { source_id: jiraResearchStudy.id, target_id: jiraResearchQuestion.id, type: 'research_study_investigates_research_question' },
      { source_id: jiraResearchStudy.id, target_id: jiraParticipant.id, type: 'research_study_enrolls_participant' },
      { source_id: jiraResearchStudy.id, target_id: jiraObservation.id, type: 'research_study_captures_observation' },
      { source_id: jiraParticipant.id, target_id: jiraQuote.id, type: 'participant_voiced_quote' },
      { source_id: jiraObservation.id, target_id: jiraInsight.id, type: 'observation_yields_insight' },
      { source_id: jiraInsight.id, target_id: jiraQuote.id, type: 'insight_evidenced_by_quote' },
      { source_id: jiraObservation.id, target_id: jiraQuote.id, type: 'observation_evidenced_by_quote' },
    ])

    // ── 9. Product content: CONFLUENCE (peer overlap with Jira) ───────────────
    const cfPersona = { id: nid('n'), type: 'persona', title: 'Software Team Lead', description: 'The same team lead, capturing decisions and docs in Confluence alongside the work in Jira.', properties: { audience_role: 'user' } }
    const cfJob = { id: nid('n'), type: 'job', title: 'Plan and track the team\'s sprint work' }
    const cfNeed = { id: nid('n'), type: 'need', title: 'A single source of truth for who is working on what' }
    const cfFeature = { id: nid('n'), type: 'feature', title: 'Whiteboards' }
    const cfMetric = { id: nid('n'), type: 'metric', title: 'Weekly Active Spaces', properties: { designation: 'driver' } }
    await addNodes(CONFLUENCE, [cfPersona, cfJob, cfNeed, cfFeature, cfMetric])
    await addEdges(CONFLUENCE, [
      { source_id: cfPersona.id, target_id: cfJob.id, type: 'persona_pursues_job' },
      { source_id: cfPersona.id, target_id: cfNeed.id, type: 'persona_experiences_need' },
    ])

    // ── 10. Product content: BITBUCKET (foundations - Git spec + Repository) ──
    const bbApiContract = { id: nid('n'), type: 'api_contract', title: 'Bitbucket REST API', properties: { protocol: 'REST', version: 'v2' } }
    const bbFeature = { id: nid('n'), type: 'feature', title: 'Pipelines (CI/CD)' }
    await addNodes(BITBUCKET, [bbApiContract, bbFeature])

    // ── 11. Product content: ROVO (deliberately thin, early-stage AI bet) ─────
    const rvPersona = { id: nid('n'), type: 'persona', title: 'AI-Curious Team Lead' }
    const rvHypothesis = { id: nid('n'), type: 'hypothesis', title: 'Teams will trust an AI teammate to triage and answer over manual search.' }
    await addNodes(ROVO, [rvPersona, rvHypothesis])

    // ── 12. Product content: HIPCHAT (deliberately messy, sunset) ─────────────
    // insights-without-evidence and feature-requests-without-provenance are
    // stage-gated to exclude `sunset` - a sunset-stage product is exempt from
    // active content-quality checks. The evidence-free insight and
    // provenance-free feature_request are left in as an honest record of that
    // gap; the anti-pattern that actually gates here is `orphan-loose-thoughts`.
    const hcInsightNoEvidence = { id: nid('n'), type: 'insight', title: 'Users say Hipchat feels slow.' }
    const hcFeatureRequestNoProvenance = { id: nid('n'), type: 'feature_request', title: 'Add threaded replies' }
    const hcOrphan1 = { id: nid('n'), type: 'assumption', title: 'Orphaned assumption nobody connected to anything.' }
    const hcOrphan2 = { id: nid('n'), type: 'decision', title: 'Decided to freeze feature work - never linked to anything downstream.' }
    const hcOrphan3 = { id: nid('n'), type: 'learning', title: 'Learned users want threads - nobody wired it to a hypothesis.' }
    const hcOrphan4 = { id: nid('n'), type: 'market_trend', title: 'Stray market-trend note from an old strategy deck.' }
    await addNodes(HIPCHAT, [hcInsightNoEvidence, hcFeatureRequestNoProvenance, hcOrphan1, hcOrphan2, hcOrphan3, hcOrphan4])

    // ── 13. Product content: REVENUE OPS (operating_function, COMPLIANT) ──────
    const roNorthStar = { id: nid('n'), type: 'metric', title: 'Net Revenue Retention', properties: { designation: 'north_star', statistical_function: 'percentage', metric_category: 'revenue' } }
    const roPipeline = { id: nid('n'), type: 'pipeline_sales', title: 'Enterprise Expansion Pipeline' }
    const roGtmStrategy = { id: nid('n'), type: 'gtm_strategy', title: 'Cloud Migration Land-and-Expand' }
    await addNodes(REVENUE_OPS, [roNorthStar, roPipeline, roGtmStrategy])

    // ── 14. Product content: SUPPORT OPS (operating_function, VIOLATING) ──────
    // Has operating content (>3 entities so the check evaluates) but NO
    // north_star metric and NO org-link cross-edge - exercises both
    // operating-function-without-north-star and operating-function-without-org-link.
    const suHealthScore = { id: nid('n'), type: 'customer_health_score', title: 'Account Health Score' }
    const suPlaybook = { id: nid('n'), type: 'playbook', title: 'At-Risk Renewal Playbook' }
    const suChurnReason = { id: nid('n'), type: 'churn_reason', title: 'Migrated to a competing suite' }
    const suTouchpoint = { id: nid('n'), type: 'touchpoint', title: 'Quarterly Business Review' }
    await addNodes(SUPPORT_OPS, [suHealthScore, suPlaybook, suChurnReason, suTouchpoint])

    // ── 15. Product content: DESIGN SYSTEM ────────────────────────────────────
    const dsDesignSystem = { id: nid('n'), type: 'design_system', title: 'Atlassian Design System' }
    const dsComponent1 = { id: nid('n'), type: 'design_component', title: 'Button (ADS)' }
    const dsComponent2 = { id: nid('n'), type: 'design_component', title: 'Lozenge (status badge)' }
    const dsBrandIdentity = { id: nid('n'), type: 'brand_identity', title: 'Atlassian Brand Identity' }
    await addNodes(DESIGN_SYSTEM, [dsDesignSystem, dsComponent1, dsComponent2, dsBrandIdentity])
    await addEdges(DESIGN_SYSTEM, [
      { source_id: dsDesignSystem.id, target_id: dsComponent1.id, type: 'design_system_contains_design_component' },
      { source_id: dsDesignSystem.id, target_id: dsComponent2.id, type: 'design_system_contains_design_component' },
    ])

    // ── 16. Product content: WEBSITE ──────────────────────────────────────────
    const wbScreenHome = { id: nid('n'), type: 'screen', title: 'Homepage' }
    const wbScreenCompare = { id: nid('n'), type: 'screen', title: 'Jira vs GitLab Comparison' }
    const wbFeatureShowcase = { id: nid('n'), type: 'feature', title: 'Product Showcase Block' }
    await addNodes(WEBSITE, [wbScreenHome, wbScreenCompare, wbFeatureShowcase])

    // ── 17. Competitors (watched) ─────────────────────────────────────────────
    const glCompetitor = { id: nid('n'), type: 'competitor', title: 'GitLab' }
    const glFeature1 = { id: nid('n'), type: 'competitor_feature', title: 'GitLab Duo (AI)' }
    await addNodes(GITLAB, [glCompetitor, glFeature1])

    const liCompetitor = { id: nid('n'), type: 'competitor', title: 'Linear' }
    const liFeature1 = { id: nid('n'), type: 'competitor_feature', title: 'Linear Auto-Triage' }
    await addNodes(LINEAR, [liCompetitor, liFeature1])

    const noCompetitor = { id: nid('n'), type: 'competitor', title: 'Notion' }
    const noSignal = { id: nid('n'), type: 'competitor_signal', title: 'Notion shipped AI Q&A over your workspace', properties: { signal_type: 'feature_launch' } }
    const noOpportunity = { id: nid('n'), type: 'opportunity', title: 'Ship Rovo answers before Notion owns the AI-wiki narrative' }
    await addNodes(NOTION, [noCompetitor, noSignal, noOpportunity])

    // ── 18. Org rollup: vision/mission/OKR ladder + org structure ─────────────
    const orgVision = { id: nid('n'), type: 'vision', title: 'Unleash the potential of every team.' }
    const orgMission = { id: nid('n'), type: 'mission', title: 'Build the system of work for every team.' }
    const orgOutcome = { id: nid('n'), type: 'outcome', title: 'Atlassian is the default system of work for software teams.' }
    const orgObjective = { id: nid('n'), type: 'objective', title: 'Grow cloud-migrated seat share to 60%' }
    const orgKeyResult = { id: nid('n'), type: 'key_result', title: 'Cloud seat share: 45% -> 60%' }
    const orgMetric = { id: nid('n'), type: 'metric', title: 'Company-wide Cloud Seats', properties: { designation: 'north_star', statistical_function: 'percentage' } }
    const orgStrategicTheme = { id: nid('n'), type: 'strategic_theme', title: 'Cloud-First' }
    const orgTeamPlatform = { id: nid('n'), type: 'team', title: 'Platform Team' }
    const orgTeamRevenue = { id: nid('n'), type: 'team', title: 'Revenue Team' }
    const orgDeptRevenue = { id: nid('n'), type: 'department', title: 'Revenue Org' }
    const orgDependency = { id: nid('n'), type: 'dependency', title: 'Company OKR waiting on Jira cycle-time objective' }
    const orgCapability = { id: nid('n'), type: 'capability', title: 'Cross-Product Benchmarking' }
    const orgMetricMau = { id: nid('n'), type: 'metric', title: 'Monthly Active Users', properties: { designation: 'kpi', unit: 'count' } }
    await addNodes(org, [
      orgVision, orgMission, orgOutcome, orgObjective, orgKeyResult, orgMetric, orgStrategicTheme,
      orgTeamPlatform, orgTeamRevenue, orgDeptRevenue, orgDependency, orgCapability, orgMetricMau,
    ])
    await addEdges(org, [
      { source_id: orgObjective.id, target_id: orgKeyResult.id, type: 'objective_achieved_through_key_result' },
      { source_id: orgKeyResult.id, target_id: orgMetric.id, type: 'key_result_quantified_by_metric' },
      { source_id: orgOutcome.id, target_id: orgMetric.id, type: 'outcome_measured_by_metric' },
      { source_id: orgStrategicTheme.id, target_id: orgObjective.id, type: 'strategic_theme_contains_objective' },
      { source_id: orgDeptRevenue.id, target_id: orgTeamRevenue.id, type: 'department_contains_team' },
      { source_id: orgMetric.id, target_id: orgMetricMau.id, type: 'metric_decomposes_into_metric' },
    ])

    for (const p of PRODUCTS) await p.store.flush()

    // ── 19. Cross-product edges: peer overlap (Jira ↔ Confluence) ─────────────
    await batchXEdges([
      { source_id: `${JIRA.id}/${jiraPersonaLead.id}`, target_id: `${CONFLUENCE.id}/${cfPersona.id}`, type: 'shares_persona' },
      { source_id: `${JIRA.id}/${jiraJob.id}`, target_id: `${CONFLUENCE.id}/${cfJob.id}`, type: 'shares_job' },
      { source_id: `${JIRA.id}/${jiraNeed.id}`, target_id: `${CONFLUENCE.id}/${cfNeed.id}`, type: 'shares_need' },
      { source_id: `${JIRA.id}/${jiraMetric.id}`, target_id: `${CONFLUENCE.id}/${cfMetric.id}`, type: 'shares_metric' },
      { source_id: `${JIRA.id}/${jiraCompetitorStub.id}`, target_id: `${GITLAB.id}/${glCompetitor.id}`, type: 'shares_competitor' },
    ])

    // ── 20. Cross-product edges: product-to-product ───────────────────────────
    await batchXEdges([
      { source_id: prod(CONFLUENCE), target_id: prod(JIRA), type: 'depends_on_product' },
      { source_id: prod(ROVO), target_id: prod(JIRA), type: 'cannibalises' },
      { source_id: prod(JIRA), target_id: prod(HIPCHAT), type: 'succeeds' },
      { source_id: prod(JIRA), target_id: prod(BITBUCKET), type: 'hosts' },
    ])

    // ── 21. Cross-product edges: OKR / measurement rollup ─────────────────────
    await batchXEdges([
      { source_id: `${JIRA.id}/${jiraObjective.id}`, target_id: `${org.id}/${orgKeyResult.id}`, type: 'objective_achieved_through_key_result' },
      { source_id: `${JIRA.id}/${jiraMetric.id}`, target_id: `${org.id}/${orgMetric.id}`, type: 'rolls_up_to' },
      { source_id: `${REVENUE_OPS.id}/${roNorthStar.id}`, target_id: `${org.id}/${orgOutcome.id}`, type: 'contributes_to' },
    ])
    await batchXEdges([
      { source_id: prod(JIRA), target_id: `${org.id}/${orgObjective.id}`, type: 'product_targets_objective' },
      { source_id: prod(REVENUE_OPS), target_id: `${org.id}/${orgOutcome.id}`, type: 'product_pursues_outcome' },
      { source_id: `${org.id}/${orgStrategicTheme.id}`, target_id: `${JIRA.id}/${jiraObjective.id}`, type: 'strategic_theme_contains_objective' },
    ])

    // ── 22. Cross-product edges: foundations (specification / primitive) ──────
    await batchXEdges([
      { source_id: prod(BITBUCKET), target_id: `registry/${canonSpec.id}`, type: 'product_implements_specification' },
      { source_id: prod(BITBUCKET), target_id: `registry/${canonSpec.id}`, type: 'product_exposes_specification' },
      { source_id: `${BITBUCKET.id}/${bbFeature.id}`, target_id: `registry/${canonSpec.id}`, type: 'feature_conforms_to_specification' },
      { source_id: `${BITBUCKET.id}/${bbApiContract.id}`, target_id: `registry/${canonSpec.id}`, type: 'api_contract_speaks_specification' },
      { source_id: prod(BITBUCKET), target_id: `registry/${canonPrimitive.id}`, type: 'product_exposes_primitive' },
      { source_id: `${BITBUCKET.id}/${bbFeature.id}`, target_id: `registry/${canonPrimitive.id}`, type: 'feature_manipulates_primitive' },
    ])
    // Note: primitive_stored_as_data_type NOT exercised - the spec has no
    // `data_type` entity type, so there is no valid target for this cross-only
    // edge type in the current catalog. See README coverage table.

    // ── 23. Cross-product edges: persona / brand / marketing ──────────────────
    await batchXEdges([
      { source_id: `${JIRA.id}/${jiraPersonaLead.id}`, target_id: `${JIRA.id}/${jiraPersonaEngMgr.id}`, type: 'persona_delegates_to_persona' },
      { source_id: prod(WEBSITE), target_id: `registry/${canonPersona.id}`, type: 'product_expresses_brand_identity' },
    ])
    await batchXEdges([
      { source_id: `${WEBSITE.id}/${wbScreenHome.id}`, target_id: `${DESIGN_SYSTEM.id}/${dsComponent1.id}`, type: 'screen_renders_design_component' },
      { source_id: `${WEBSITE.id}/${wbScreenHome.id}`, target_id: prod(JIRA), type: 'screen_markets_product' },
      { source_id: `${WEBSITE.id}/${wbScreenCompare.id}`, target_id: `${GITLAB.id}/${glCompetitor.id}`, type: 'screen_targets_competitor' },
      { source_id: `${WEBSITE.id}/${wbFeatureShowcase.id}`, target_id: prod(JIRA), type: 'feature_surfaces_product' },
      { source_id: `${JIRA.id}/${jiraFeature1.id}`, target_id: `${DESIGN_SYSTEM.id}/${dsComponent2.id}`, type: 'feature_uses_design_component' },
      { source_id: prod(JIRA), target_id: `${DESIGN_SYSTEM.id}/${dsDesignSystem.id}`, type: 'product_implements_design_system' },
    ])

    // ── 24. Cross-product edges: org ownership + dependency ───────────────────
    await batchXEdges([
      { source_id: prod(REVENUE_OPS), target_id: `${org.id}/${orgDeptRevenue.id}`, type: 'node_owned_by_department' },
      { source_id: prod(JIRA), target_id: `${org.id}/${orgTeamPlatform.id}`, type: 'node_owned_by_team' },
      // support-ops deliberately gets NO node_owned_by_* edge (org-link violation).
    ])
    await batchXEdges([
      { source_id: `${JIRA.id}/${jiraObjective.id}`, target_id: `${org.id}/${orgDependency.id}`, type: 'objective_depends_on_dependency' },
      { source_id: `${org.id}/${orgDependency.id}`, target_id: `${JIRA.id}/${jiraObjective.id}`, type: 'dependency_blocks_objective' },
    ])

    // ── 25. Cross-product edges: defer (property-carrying, deliberate_only) ────
    await batchXEdges([
      {
        source_id: `${JIRA.id}/${jiraObjective.id}`,
        target_id: `${ROVO.id}/${rvHypothesis.id}`,
        type: 'objective_defers_capability',
        properties: { deferred_to: '2027-Q1' },
      },
    ])
    bodyOf(
      await createCrossProductEdge(
        {
          source_id: `${JIRA.id}/${jiraObjective.id}`,
          target_id: `${org.id}/${orgCapability.id}`,
          type: 'objective_defers_capability',
          properties: { deferred_to: '2026-Q4' },
        },
        scratchCtx,
      ),
    )

    // ── 26. Registry: instance_of (with one sanctioned alias divergence) ──────
    bodyOf(await registerInstance({ node_id: `${JIRA.id}/${jiraPersonaLead.id}`, canonical_id: canonPersona.id, source_product_id: JIRA.id }, scratchCtx))
    bodyOf(await registerInstance({ node_id: `${CONFLUENCE.id}/${cfPersona.id}`, canonical_id: canonPersona.id, source_product_id: CONFLUENCE.id, alias: true }, scratchCtx))
    bodyOf(await registerInstance({ node_id: `${org.id}/${orgMetricMau.id}`, canonical_id: canonMetric.id, source_product_id: org.id }, scratchCtx))
    bodyOf(await promoteToCanonical({ node_id: jiraCompetitorStub.id, source_product_id: JIRA.id, canonical_id: 'canon_gitlab_competitor' }, scratchCtx))

    // ── 27. Area-to-audience matrix ───────────────────────────────────────────
    bodyOf(await linkAreaToAudience({ area_id: areaEng.id, canonical_id: canonPersona.id, relevance: 'primary', audience_role: 'user' }, scratchCtx))
    bodyOf(await linkAreaToAudience({ area_id: areaGtm.id, canonical_id: canonSegment.id, relevance: 'primary' }, scratchCtx))

    // ── 28. Parity edge (property-carrying) ───────────────────────────────────
    bodyOf(
      await createParityEdge(
        {
          feature_id: `${JIRA.id}/${jiraFeature2.id}`,
          competitor_feature_id: `${LINEAR.id}/${liFeature1.id}`,
          parity_status: 'behind',
          quality: 'worse',
          evidence: 'Linear auto-triages in under 2s; Jira Rovo triage averages 12s (Q2 2026 bakeoff).',
          confidence: 'medium',
          assessed_on: '2026-06-01',
        },
        scratchCtx,
      ),
    )

    // ── 29. Classification edges (twice, same axis → reclassification signal) ──
    bodyOf(
      await createClassificationEdge(
        { node_id: `${GITLAB.id}/${glCompetitor.id}`, classification_value_id: `registry/${canonValueDataCenter.id}`, node_product_id: GITLAB.id, confidence: 'medium', rationale: 'GitLab\'s centre of gravity was self-managed / Data Center through 2024.' },
        scratchCtx,
      ),
    )
    bodyOf(
      await createClassificationEdge(
        { node_id: `${GITLAB.id}/${glCompetitor.id}`, classification_value_id: `registry/${canonValueCloud.id}`, node_product_id: GITLAB.id, confidence: 'high', rationale: 'GitLab is steering customers to GitLab.com SaaS - reclassifying to Cloud-Native.', evidence: 'GitLab SaaS-first positioning, 2025.' },
        scratchCtx,
      ),
    )
    // Node-level (non-competitor) classification, for polymorphic coverage.
    bodyOf(
      await createClassificationEdge(
        { node_id: prod(HIPCHAT), classification_value_id: `registry/${canonValueDataCenter.id}`, node_product_id: HIPCHAT.id, rationale: 'Hipchat shipped a self-managed Server edition; kept for classification-axis coverage.' },
        scratchCtx,
      ),
    )

    // ── 30. Competitor signal edges ───────────────────────────────────────────
    await batchXEdges([
      { source_id: `${NOTION.id}/${noSignal.id}`, target_id: `${JIRA.id}/${jiraFeature2.id}`, type: 'competitor_signal_maps_to_feature' },
      { source_id: `${NOTION.id}/${noSignal.id}`, target_id: `${NOTION.id}/${noOpportunity.id}`, type: 'competitor_signal_surfaces_opportunity' },
    ])

    for (const p of PRODUCTS) await p.store.flush()

    // ── 31. Verify: run the actual portfolio read/validate handlers ───────────
    const digest = bodyOf(await portfolioDigest({}, scratchCtx))
    const census = bodyOf(await portfolioCensus({ type: 'persona', group_by: 'product' }, scratchCtx))
    const validation = bodyOf(await portfolioValidate({ include_violations: true, violation_limit: 25 }, scratchCtx))
    const tree = bodyOf(await getPortfolioTree({ shape: 'structure' }, scratchCtx))

    const summary = {
      generated_at: new Date().toISOString(),
      company: 'Atlassian',
      digest_rollup: digest.rollup,
      persona_census_total: census.total ?? null,
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

    return { summary, validation, digest, census, tree }
  }
}

// ─── workspace.json member_kind cache patch ─────────────────────────────────────
// init_workspace registers moved/pre-existing files as {file, title} without a
// member_kind. Set it for the founding org rollup so the workspace cache matches
// what create_product writes for every other non-product member.
function patchWorkspaceMemberKind(upgDir: string, file: string, memberKind: string): void {
  const path = join(upgDir, 'workspace.json')
  const ws = JSON.parse(readFileSync(path, 'utf-8'))
  for (const p of ws.products ?? []) {
    if (p.file === file) p.member_kind = memberKind
  }
  writeFileSync(path, JSON.stringify(ws, null, 2) + '\n')
}
