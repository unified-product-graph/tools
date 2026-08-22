/**
 * Import recipes — the canonical mapping-table shape + the source registry.
 *
 * This is the DATA layer behind the `get_import_recipe` MCP tool (
 * "agent-native import; mapping-as-guidance"). It defines ONE uniform recipe-
 * table interface (`SourceMappingTables`) and a registry (`SOURCE_RECIPES`)
 * that points every known source at its EXISTING exported const tables —
 * served verbatim, never rewritten. The per-adapter const definitions remain
 * the single source of truth in `./adapters/*.ts`; this module only references
 * and groups them into the uniform shape so a consumer reads one shape rather
 * than 37 bespoke ones.
 *
 * Deliberately imports the pure per-adapter const modules directly (not the
 * package index) so it never pulls a transport SDK (`@linear/sdk`,
 * `@notionhq/client`) into the graph — the mapping tables are plain data.
 *
 * Scope note: the tables are read AS-IS. Migrating/extracting the
 * per-adapter const definitions into a shared data directory, and the generic
 * table-driven converter / `upg import` batch runner, are explicit follow-ons.
 */

import {
  DATABASE_TYPE_MAP,
  LIFECYCLE_STATUS_MAP,
  CONFIDENCE_MAP,
  RELATION_EDGE_MAP,
} from './adapters/notion.js'
import { DOVETAIL_TYPE_MAP, BASE_CONFIDENCE_MAP } from './adapters/dovetail.js'
import { VISTALY_TYPE_MAP, VISTALY_STATUS_BY_TYPE } from './adapters/vistaly.js'
import { QUANTIVE_TYPE_MAP, QUANTIVE_STATUS_MAP } from './adapters/quantive.js'
import {
  SHORTCUT_STORY_TYPE_MAP,
  SHORTCUT_ENTITY_TYPE_MAP,
  SHORTCUT_STATUS_MAP,
} from './adapters/shortcut.js'
import { CODA_TABLE_TYPE_MAP, CODA_STATUS_MAP, CODA_LOOKUP_EDGE_MAP } from './adapters/coda.js'
import { AMPLITUDE_TYPE_MAP, AMPLITUDE_STATUS_MAP } from './adapters/amplitude.js'
import { POSTHOG_TYPE_MAP, POSTHOG_STATUS_MAP } from './adapters/posthog.js'
import { CANNY_TYPE_MAP, CANNY_STATUS_MAP } from './adapters/canny.js'
import { INTERCOM_TYPE_MAP, INTERCOM_STATUS_MAP } from './adapters/intercom.js'
import { HUBSPOT_TYPE_MAP, HUBSPOT_STATUS_MAP } from './adapters/hubspot.js'
import { SALESFORCE_TYPE_MAP, SALESFORCE_STATUS_MAP } from './adapters/salesforce.js'
import { GAINSIGHT_TYPE_MAP, GAINSIGHT_STATUS_MAP } from './adapters/gainsight.js'
import { PENDO_TYPE_MAP, PENDO_STATUS_MAP } from './adapters/pendo.js'
import { FIGMA_TYPE_MAP } from './adapters/figma.js'
import { MIRO_FRAME_TYPE_MAP, MIRO_ENTITY_TYPE_MAP } from './adapters/miro.js'
import { CONFLUENCE_PAGE_TYPE_MAP, CONFLUENCE_ENTITY_TYPE_MAP } from './adapters/confluence.js'
import { LAUNCHDARKLY_TYPE_MAP, LAUNCHDARKLY_STATUS_MAP } from './adapters/launchdarkly.js'
import { CONDENS_TYPE_MAP, CONDENS_STATUS_MAP, CONDENS_CONFIDENCE_MAP } from './adapters/condens.js'
import { LOOKBACK_TYPE_MAP, LOOKBACK_STATUS_MAP, LOOKBACK_CONFIDENCE_MAP } from './adapters/lookback.js'
import { SPRIG_TYPE_MAP, SPRIG_STATUS_MAP, SPRIG_CONFIDENCE_MAP } from './adapters/sprig.js'
import { MAZE_TYPE_MAP, MAZE_STATUS_MAP } from './adapters/maze.js'
import { SLACK_TYPE_MAP } from './adapters/slack.js'
import { GITLAB_ENTITY_TYPE_MAP, GITLAB_ISSUE_LABEL_MAP, GITLAB_STATUS_MAP } from './adapters/gitlab.js'
import {
  JIRA_ISSUE_TYPE_MAP,
  JIRA_STRUCTURAL_TYPE_MAP,
  JIRA_STATUS_MAP,
  JIRA_LINK_EDGE_MAP,
} from './adapters/jira.js'
import { PRODUCTBOARD_TYPE_MAP, PRODUCTBOARD_STATUS_MAP } from './adapters/productboard.js'
import { AHA_TYPE_MAP, AHA_STATUS_MAP } from './adapters/aha.js'
import { ZENDESK_TYPE_MAP, ZENDESK_STATUS_MAP } from './adapters/zendesk.js'
import { LATTICE_TYPE_MAP, LATTICE_STATUS_MAP } from './adapters/lattice.js'
import { STORYBOOK_TYPE_MAP } from './adapters/storybook.js'
import { AIRFOCUS_TYPE_MAP, AIRFOCUS_STATUS_MAP } from './adapters/airfocus.js'
import { CRAFTIO_TYPE_MAP, CRAFTIO_STATUS_MAP } from './adapters/craftio.js'
import { CHISEL_TYPE_MAP, CHISEL_STATUS_MAP } from './adapters/chisel.js'
import { PRODPAD_TYPE_MAP, PRODPAD_STATUS_MAP } from './adapters/prodpad.js'

// ─── Canonical recipe-table shape ────────────────────────────────────────────

/**
 * The uniform mapping-table shape a recipe serves for one source. Every field
 * is a verbatim reference to an existing exported adapter const; the keys of
 * each sub-record name the source construct the table maps from (e.g. Notion's
 * `database`, Jira's `issue_type`).
 */
export interface SourceMappingTables {
  /**
   * Source construct → UPG entity type. `null` = explicitly unmappable (the
   * adapter emits a warning and defaults). Keyed by construct kind so a source
   * with several type maps (Jira: `issue_type` + `structural`) stays uniform.
   */
  entity_type_maps: Record<string, Record<string, string | null>>
  /** Source status value → UPG lifecycle stage, keyed by construct kind. */
  status_maps?: Record<string, Record<string, string>>
  /**
   * By-type status maps: some sources resolve a status differently per target
   * type. Shape: construct → UPG type → (source status → lifecycle stage), with
   * `null` = drop. Kept separate from the flat `status_maps` so both stay
   * uniformly typed.
   */
  status_by_type_maps?: Record<string, Record<string, Record<string, string | null>>>
  /** Source name/type → mapping confidence (`high` / `medium` / `low`). */
  confidence_map?: Record<string, 'high' | 'medium' | 'low'>
  /**
   * Source relation/link/lookup construct → UPG edge type. `null` = a relation
   * the adapter recognises but cannot map to a canonical edge (warn, skip).
   */
  edge_maps?: Record<string, Record<string, string | null>>
}

/** A curated import recipe for one source: metadata + its verbatim tables. */
export interface SourceRecipe {
  /** Stable slug, also the `upg import --from <slug>` name. */
  source: string
  /** Human-readable label. */
  label: string
  /** One-line source description. */
  description: string
  tables: SourceMappingTables
}

// ─── Source caveats ───────────────────────────────────────────────────────────

/**
 * Per-source read hazards, keyed by slug. Independent of `SOURCE_RECIPES`,
 * deliberately: a source can have a hazard worth knowing without having a
 * curated mapping table, and Linear is exactly that case.
 *
 * These are not mapping guidance. They are facts about reading the source that,
 * if unknown, produce a silently wrong import: the class where a FAILURE LOOKS
 * LIKE A SUCCESS. That is why they belong on the recipe an importer reads rather
 * than in a code comment inside an adapter.
 */
export const SOURCE_CAVEATS: Record<string, string[]> = {
  linear: [
    'list_issues TRUNCATES issue descriptions, cutting mid-markup: 913 of 1,032 issues in the measured corpus. get_issue is the only faithful read of an issue body. Use bulk listings for enumeration only. An importer that batches through list_issues ships truncated bodies and reports success.',
    'An over-complex query returns HTTP 200 with an error body. Error handling that branches on the status code alone reads that failure as a success, imports nothing, and reports fine. Inspect the body, not the status.',
  ],
}

/**
 * Read hazards for a source, resolved from a slug or from free text.
 *
 * Matches the same way `resolveSourceRecipe` does (exact slug, then a
 * whole-word mention) so that "Linear issues" and "linear" reach the same
 * caveats, and returns an empty list when none are recorded.
 */
export function caveatsForSource(input: string | null | undefined): string[] {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return []
  if (SOURCE_CAVEATS[raw]) return SOURCE_CAVEATS[raw]
  const words = new Set(raw.split(/[^a-z0-9.!]+/).filter(Boolean))
  for (const slug of Object.keys(SOURCE_CAVEATS)) {
    if (words.has(slug)) return SOURCE_CAVEATS[slug]
  }
  return []
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Every source with an exported const mapping table, keyed by slug. This is the
 * "curated exists" set: `get_import_recipe` serves these tables verbatim and
 * never free-generates a mapping for a slug present here (the drift-prevention
 * guarantee). Sources absent here (e.g. markdown/linear/github, whose mapping
 * lives inside `convert()` and is not exported) fall through to the schema-
 * grounded scaffold path.
 */
export const SOURCE_RECIPES: Record<string, SourceRecipe> = {
  notion: {
    source: 'notion',
    label: 'Notion',
    description: 'Pages and databases from Notion (via the Notion MCP).',
    tables: {
      entity_type_maps: { database: DATABASE_TYPE_MAP },
      status_maps: { status: LIFECYCLE_STATUS_MAP },
      confidence_map: CONFIDENCE_MAP,
      edge_maps: { relation: RELATION_EDGE_MAP },
    },
  },
  dovetail: {
    source: 'dovetail',
    label: 'Dovetail',
    description: 'User-research repository: studies, insights, observations.',
    tables: {
      entity_type_maps: { record: DOVETAIL_TYPE_MAP },
      confidence_map: BASE_CONFIDENCE_MAP,
    },
  },
  vistaly: {
    source: 'vistaly',
    label: 'Vistaly',
    description: 'Continuous-discovery cards: opportunities, solutions, assumptions.',
    tables: {
      entity_type_maps: { card_type: VISTALY_TYPE_MAP },
      status_by_type_maps: { card_type: VISTALY_STATUS_BY_TYPE },
    },
  },
  quantive: {
    source: 'quantive',
    label: 'Quantive',
    description: 'OKR platform: objectives, key results, initiatives.',
    tables: {
      entity_type_maps: { type: QUANTIVE_TYPE_MAP },
      status_maps: { status: QUANTIVE_STATUS_MAP },
    },
  },
  shortcut: {
    source: 'shortcut',
    label: 'Shortcut',
    description: 'Delivery + native OKRs: stories, epics, objectives, key results.',
    tables: {
      entity_type_maps: { story_type: SHORTCUT_STORY_TYPE_MAP, entity: SHORTCUT_ENTITY_TYPE_MAP },
      status_maps: { status: SHORTCUT_STATUS_MAP },
    },
  },
  coda: {
    source: 'coda',
    label: 'Coda',
    description: 'Docs + tables: table-name inference, lookup-column edges.',
    tables: {
      entity_type_maps: { table: CODA_TABLE_TYPE_MAP },
      status_maps: { status: CODA_STATUS_MAP },
      edge_maps: { lookup_column: CODA_LOOKUP_EDGE_MAP },
    },
  },
  amplitude: {
    source: 'amplitude',
    label: 'Amplitude',
    description: 'Product analytics: metrics, experiments, feature adoption.',
    tables: {
      entity_type_maps: { type: AMPLITUDE_TYPE_MAP },
      status_maps: { status: AMPLITUDE_STATUS_MAP },
    },
  },
  posthog: {
    source: 'posthog',
    label: 'PostHog',
    description: 'Product analytics + experimentation: metrics, experiments, flags.',
    tables: {
      entity_type_maps: { type: POSTHOG_TYPE_MAP },
      status_maps: { status: POSTHOG_STATUS_MAP },
    },
  },
  canny: {
    source: 'canny',
    label: 'Canny',
    description: 'Feedback + roadmap: feature requests, posts, roadmap items.',
    tables: {
      entity_type_maps: { type: CANNY_TYPE_MAP },
      status_maps: { status: CANNY_STATUS_MAP },
    },
  },
  intercom: {
    source: 'intercom',
    label: 'Intercom',
    description: 'Customer messaging + support: conversations, feedback.',
    tables: {
      entity_type_maps: { type: INTERCOM_TYPE_MAP },
      status_by_type_maps: { type: INTERCOM_STATUS_MAP },
    },
  },
  hubspot: {
    source: 'hubspot',
    label: 'HubSpot',
    description: 'CRM + marketing: contacts, deals, feedback, tickets.',
    tables: {
      entity_type_maps: { type: HUBSPOT_TYPE_MAP },
      status_maps: { status: HUBSPOT_STATUS_MAP },
    },
  },
  salesforce: {
    source: 'salesforce',
    label: 'Salesforce',
    description: 'Enterprise CRM: accounts, opportunities, cases.',
    tables: {
      entity_type_maps: { type: SALESFORCE_TYPE_MAP },
      status_maps: { status: SALESFORCE_STATUS_MAP },
    },
  },
  gainsight: {
    source: 'gainsight',
    label: 'Gainsight',
    description: 'Customer success: health, feedback, feature requests.',
    tables: {
      entity_type_maps: { type: GAINSIGHT_TYPE_MAP },
      status_maps: { status: GAINSIGHT_STATUS_MAP },
    },
  },
  pendo: {
    source: 'pendo',
    label: 'Pendo',
    description: 'Product analytics + feedback: features, adoption, requests.',
    tables: {
      entity_type_maps: { type: PENDO_TYPE_MAP },
      status_maps: { status: PENDO_STATUS_MAP },
    },
  },
  figma: {
    source: 'figma',
    label: 'Figma',
    description: 'Design layers: frames, components, flows.',
    tables: {
      entity_type_maps: { node_type: FIGMA_TYPE_MAP },
    },
  },
  miro: {
    source: 'miro',
    label: 'Miro',
    description: 'Visual whiteboard: frames and sticky-note clusters.',
    tables: {
      entity_type_maps: { frame: MIRO_FRAME_TYPE_MAP, entity: MIRO_ENTITY_TYPE_MAP },
    },
  },
  confluence: {
    source: 'confluence',
    label: 'Confluence',
    description: 'Enterprise wiki: pages inferred to documents, decisions, specs.',
    tables: {
      entity_type_maps: { page: CONFLUENCE_PAGE_TYPE_MAP, entity: CONFLUENCE_ENTITY_TYPE_MAP },
    },
  },
  launchdarkly: {
    source: 'launchdarkly',
    label: 'LaunchDarkly',
    description: 'Feature flags + experimentation: flags, experiments.',
    tables: {
      entity_type_maps: { type: LAUNCHDARKLY_TYPE_MAP },
      status_maps: { status: LAUNCHDARKLY_STATUS_MAP },
    },
  },
  condens: {
    source: 'condens',
    label: 'Condens',
    description: 'Research repository: studies, insights, observations.',
    tables: {
      entity_type_maps: { type: CONDENS_TYPE_MAP },
      status_maps: { status: CONDENS_STATUS_MAP },
      confidence_map: CONDENS_CONFIDENCE_MAP,
    },
  },
  lookback: {
    source: 'lookback',
    label: 'Lookback',
    description: 'User interviews + session recordings: studies, insights.',
    tables: {
      entity_type_maps: { type: LOOKBACK_TYPE_MAP },
      status_maps: { status: LOOKBACK_STATUS_MAP },
      confidence_map: LOOKBACK_CONFIDENCE_MAP,
    },
  },
  sprig: {
    source: 'sprig',
    label: 'Sprig',
    description: 'In-product surveys + micro-feedback: studies, insights.',
    tables: {
      entity_type_maps: { type: SPRIG_TYPE_MAP },
      status_maps: { status: SPRIG_STATUS_MAP },
      confidence_map: SPRIG_CONFIDENCE_MAP,
    },
  },
  maze: {
    source: 'maze',
    label: 'Maze',
    description: 'Usability testing: studies, tests, insights.',
    tables: {
      entity_type_maps: { type: MAZE_TYPE_MAP },
      status_maps: { status: MAZE_STATUS_MAP },
    },
  },
  slack: {
    source: 'slack',
    label: 'Slack',
    description: 'Structured artifacts pulled from Slack messages.',
    tables: {
      entity_type_maps: { type: SLACK_TYPE_MAP },
    },
  },
  gitlab: {
    source: 'gitlab',
    label: 'GitLab',
    description: 'Delivery: issues (typed by label), epics, milestones.',
    tables: {
      entity_type_maps: { entity: GITLAB_ENTITY_TYPE_MAP, issue_label: GITLAB_ISSUE_LABEL_MAP },
      status_maps: { status: GITLAB_STATUS_MAP },
    },
  },
  jira: {
    source: 'jira',
    label: 'Jira',
    description: 'Delivery: issue types, structural types, issue-link edges.',
    tables: {
      entity_type_maps: { issue_type: JIRA_ISSUE_TYPE_MAP, structural: JIRA_STRUCTURAL_TYPE_MAP },
      status_maps: { status: JIRA_STATUS_MAP },
      edge_maps: { issue_link: JIRA_LINK_EDGE_MAP },
    },
  },
  productboard: {
    source: 'productboard',
    label: 'Productboard',
    description: 'Feature management + feedback: features, notes, objectives.',
    tables: {
      entity_type_maps: { type: PRODUCTBOARD_TYPE_MAP },
      status_maps: { status: PRODUCTBOARD_STATUS_MAP },
    },
  },
  aha: {
    source: 'aha',
    label: 'Aha!',
    description: 'Strategy + delivery + customer intelligence.',
    tables: {
      entity_type_maps: { type: AHA_TYPE_MAP },
      status_by_type_maps: { type: AHA_STATUS_MAP },
    },
  },
  zendesk: {
    source: 'zendesk',
    label: 'Zendesk',
    description: 'Support + customer feedback: tickets, feature requests.',
    tables: {
      entity_type_maps: { type: ZENDESK_TYPE_MAP },
      status_by_type_maps: { type: ZENDESK_STATUS_MAP },
    },
  },
  lattice: {
    source: 'lattice',
    label: 'Lattice',
    description: 'People management + OKRs: objectives, key results.',
    tables: {
      entity_type_maps: { type: LATTICE_TYPE_MAP },
      status_maps: { status: LATTICE_STATUS_MAP },
    },
  },
  storybook: {
    source: 'storybook',
    label: 'Storybook',
    description: 'Design-system components: stories mapped to components.',
    tables: {
      entity_type_maps: { type: STORYBOOK_TYPE_MAP },
    },
  },
  airfocus: {
    source: 'airfocus',
    label: 'airfocus',
    description: 'Prioritisation + roadmapping + OKRs.',
    tables: {
      entity_type_maps: { type: AIRFOCUS_TYPE_MAP },
      status_maps: { status: AIRFOCUS_STATUS_MAP },
    },
  },
  craftio: {
    source: 'craftio',
    label: 'Craft.io',
    description: 'Product strategy, OKRs, roadmap, and feedback.',
    tables: {
      entity_type_maps: { type: CRAFTIO_TYPE_MAP },
      status_maps: { status: CRAFTIO_STATUS_MAP },
    },
  },
  chisel: {
    source: 'chisel',
    label: 'Chisel',
    description: 'Discovery, roadmap, team-alignment OKRs.',
    tables: {
      entity_type_maps: { type: CHISEL_TYPE_MAP },
      status_maps: { status: CHISEL_STATUS_MAP },
    },
  },
  prodpad: {
    source: 'prodpad',
    label: 'ProdPad',
    description: 'Product backlog + strategy: ideas, features, feedback.',
    tables: {
      entity_type_maps: { type: PRODPAD_TYPE_MAP },
      status_maps: { status: PRODPAD_STATUS_MAP },
    },
  },
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

/** All curated recipe slugs, sorted. */
export function listRecipeSlugs(): string[] {
  return Object.keys(SOURCE_RECIPES).sort()
}

/**
 * Resolve a free-text source description to a curated recipe. Matches on exact
 * slug, then exact label (case-insensitive), then a whole-word slug/label
 * mention inside the input (e.g. "my notion workspace" → notion). Returns
 * `undefined` when no curated recipe exists (caller serves the scaffold path).
 */
export function resolveSourceRecipe(input: string): SourceRecipe | undefined {
  const raw = input.trim().toLowerCase()
  if (!raw) return undefined
  if (SOURCE_RECIPES[raw]) return SOURCE_RECIPES[raw]

  const words = new Set(raw.split(/[^a-z0-9.!]+/).filter(Boolean))
  for (const recipe of Object.values(SOURCE_RECIPES)) {
    const label = recipe.label.toLowerCase()
    if (label === raw) return recipe
    if (words.has(recipe.source) || words.has(label)) return recipe
  }
  return undefined
}

/**
 * The distinct UPG entity types a recipe can produce: every non-null value
 * across all its entity type maps, de-duplicated and sorted.
 */
export function producedEntityTypes(recipe: SourceRecipe): string[] {
  const out = new Set<string>()
  for (const table of Object.values(recipe.tables.entity_type_maps)) {
    for (const value of Object.values(table)) {
      if (value) out.add(value)
    }
  }
  return [...out].sort()
}

/**
 * The distinct UPG edge types a recipe can produce: every non-null value across
 * all its edge maps, de-duplicated and sorted. Empty when the source maps no
 * relations (parent/child containment is inferred, not table-driven).
 */
export function producedEdgeTypes(recipe: SourceRecipe): string[] {
  const out = new Set<string>()
  for (const table of Object.values(recipe.tables.edge_maps ?? {})) {
    for (const value of Object.values(table)) {
      if (value) out.add(value)
    }
  }
  return [...out].sort()
}
