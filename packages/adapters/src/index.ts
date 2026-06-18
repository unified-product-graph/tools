/**
 * Public entry point. Exports 37 adapters plus the `UPGAdapter` interface.
 *
 * `convert(items)` runs on pre-fetched data for every adapter.
 * `list(config)` runs in-memory for `markdown` and reads from an API or
 * MCP connection for the other 36. See README.md for the full table.
 */

// Types
export type {
  AdapterConfig,
  SourceItem,
  ImportResult,
  UPGAdapter,
} from './types.js'

// Notion types
export type {
  NotionPropertyType,
  NotionSelectOption,
  NotionStatusGroup,
  NotionPropertySchema,
  NotionRelationProperty,
  NotionDatabaseSchema,
  NotionPropertyValue,
  NotionPageProperties,
  NotionDatabaseInfo,
  NotionDatabasePlan,
  NotionPagePlan,
  NotionRelationLink,
  NotionWorkspacePlan,
  ClassificationConfidence,
  ClassificationMethod,
  SuggestedEdgeMapping,
  DatabaseClassification,
} from './adapters/notion-types.js'

// Production adapters
export { MarkdownAdapter } from './adapters/markdown.js'

// Notion adapter: import direction
export {
  NotionAdapter,
  DATABASE_TYPE_MAP,
  CONFIDENCE_MAP,
  RELATION_EDGE_MAP,
  PROPERTY_TYPE_MAP,
  LIFECYCLE_STATUS_MAP,
  inferTypeFromDatabase,
  getConfidenceForName,
  resolveRelationEdge,
  normalizeStatus,
} from './adapters/notion.js'

// Notion schema generator: UPG to Notion write direction
export {
  generateDatabaseSchema,
  generateRelationProperty,
  generateNotionWorkspace,
  getDatabaseName,
  ENTITY_DATABASE_NAMES,
  EDGE_RELATION_VERBS,
} from './adapters/notion-schema-generator.js'

// Notion discovery: Notion workspace to UPG classification
export {
  classifyDatabase,
  classifyDatabases,
  buildConfirmationPrompt,
} from './adapters/notion-discovery.js'

// Dovetail adapter: user research import
export {
  DovetailAdapter,
  DOVETAIL_TYPE_MAP,
  BASE_CONFIDENCE_MAP,
  resolveDovetailType,
  getBaseConfidence,
} from './adapters/dovetail.js'

// Vistaly adapter: continuous discovery import
export {
  VistalyAdapter,
  VISTALY_TYPE_MAP,
  VISTALY_STATUS_BY_TYPE,
  resolveCardType,
  normalizeVistalyStatus,
  getConfidenceForCardType,
} from './adapters/vistaly.js'

// Quantive adapter: OKR import
export {
  QuantiveAdapter,
  QUANTIVE_TYPE_MAP,
  QUANTIVE_STATUS_MAP,
  resolveQuantiveEntityType,
  normalizeQuantiveStatus,
  getQuantiveConfidence,
} from './adapters/quantive.js'

// Shortcut adapter: native OKR plus delivery hierarchy import
export {
  ShortcutAdapter,
  SHORTCUT_STORY_TYPE_MAP,
  SHORTCUT_ENTITY_TYPE_MAP,
  SHORTCUT_STATUS_MAP,
  SHORTCUT_HEALTH_MAP,
  resolveShortcutEntityType,
  resolveStoryType,
  normalizeShortcutStatus,
  getShortcutConfidence,
} from './adapters/shortcut.js'

// Coda adapter: table-name inference plus lookup column edges
export {
  CodaAdapter,
  CODA_TABLE_TYPE_MAP,
  CODA_LOOKUP_EDGE_MAP,
  CODA_STATUS_MAP,
  inferTableType,
  resolveLookupEdge,
  resolveCodaStatusForType,
} from './adapters/coda.js'

// Analytics and feedback adapters.
export {
  AmplitudeAdapter,
  AMPLITUDE_TYPE_MAP,
  AMPLITUDE_STATUS_MAP,
  resolveAmplitudeType,
  normalizeAmplitudeStatus,
  getConfidenceForAmplitudeType,
} from './adapters/amplitude.js'

export {
  PostHogAdapter,
  POSTHOG_TYPE_MAP,
  POSTHOG_STATUS_MAP,
  resolvePostHogType,
  normalizePostHogStatus,
  getConfidenceForPostHogType,
} from './adapters/posthog.js'

export {
  CannyAdapter,
  CANNY_TYPE_MAP,
  CANNY_STATUS_MAP,
  resolveCannyType,
  normalizeCannyStatus,
  getConfidenceForCannyType,
} from './adapters/canny.js'

export {
  IntercomAdapter,
  INTERCOM_TYPE_MAP,
  INTERCOM_STATUS_MAP,
  resolveIntercomType,
  resolveIntercomStatusForType,
  getConfidenceForIntercomType,
} from './adapters/intercom.js'

// HubSpot adapter: CRM and marketing platform import
export {
  HubSpotAdapter,
  HUBSPOT_TYPE_MAP,
  HUBSPOT_STATUS_MAP,
  resolveHubSpotType,
  normalizeHubSpotStatus,
  getHubSpotConfidence,
} from './adapters/hubspot.js'

// Salesforce adapter: enterprise CRM import
export {
  SalesforceAdapter,
  SALESFORCE_TYPE_MAP,
  SALESFORCE_STATUS_MAP,
  resolveSalesforceType,
  normalizeSalesforceStatus,
  getSalesforceConfidence,
} from './adapters/salesforce.js'

// Gainsight adapter: customer success platform import
export {
  GainsightAdapter,
  GAINSIGHT_TYPE_MAP,
  GAINSIGHT_STATUS_MAP,
  resolveGainsightType,
  normalizeGainsightStatus,
  getGainsightConfidence,
} from './adapters/gainsight.js'

// Pendo adapter: product analytics and feature adoption import
export {
  PendoAdapter,
  PENDO_TYPE_MAP,
  PENDO_STATUS_MAP,
  resolvePendoType,
  normalizePendoStatus,
  getPendoConfidence,
} from './adapters/pendo.js'

// Figma adapter: design layer import
export {
  FigmaAdapter,
  FIGMA_TYPE_MAP,
  resolveFigmaType,
  getConfidenceForFigmaType,
  normalizeFigmaStatus,
} from './adapters/figma.js'

// Miro adapter: visual whiteboard import
export {
  MiroAdapter,
  MIRO_FRAME_TYPE_MAP,
  MIRO_ENTITY_TYPE_MAP,
  resolveMiroType,
} from './adapters/miro.js'

// Confluence adapter: enterprise wiki import
export {
  ConfluenceAdapter,
  CONFLUENCE_PAGE_TYPE_MAP,
  CONFLUENCE_ENTITY_TYPE_MAP,
  inferConfluencePageType,
} from './adapters/confluence.js'

// LaunchDarkly adapter: feature flag and experimentation import
export {
  LaunchDarklyAdapter,
  LAUNCHDARKLY_TYPE_MAP,
  LAUNCHDARKLY_STATUS_MAP,
  normalizeLaunchDarklyStatus,
  getConfidenceForLDType,
} from './adapters/launchdarkly.js'

// Condens adapter: European research repository import
export {
  CondensAdapter,
  CONDENS_TYPE_MAP,
  CONDENS_STATUS_MAP,
  CONDENS_CONFIDENCE_MAP,
  resolveCondensType,
  normalizeCondensStatus,
  getCondensConfidence,
} from './adapters/condens.js'

// Lookback adapter: user interview and session recording import
export {
  LookbackAdapter,
  LOOKBACK_TYPE_MAP,
  LOOKBACK_STATUS_MAP,
  LOOKBACK_CONFIDENCE_MAP,
  resolveLookbackType,
  normalizeLookbackStatus,
  getLookbackConfidence,
} from './adapters/lookback.js'

// Sprig adapter: in-product survey and micro-feedback import
export {
  SprigAdapter,
  SPRIG_TYPE_MAP,
  SPRIG_STATUS_MAP,
  SPRIG_CONFIDENCE_MAP,
  resolveSprigType,
  normalizeSprigStatus,
  getSprigConfidence,
} from './adapters/sprig.js'

// Maze adapter: usability testing import
export {
  MazeAdapter,
  MAZE_TYPE_MAP,
  MAZE_STATUS_MAP,
  normalizeMazeStatus,
  getConfidenceForMazeType,
} from './adapters/maze.js'

// Slack adapter: structured artifact import
export {
  SlackAdapter,
  SLACK_TYPE_MAP,
  getConfidenceForSlackType,
} from './adapters/slack.js'

// Delivery layer: Linear, GitHub, GitLab.
export { LinearAdapter } from './adapters/linear.js'
export { GitHubAdapter } from './adapters/github.js'
export {
  GitLabAdapter,
  GITLAB_ISSUE_LABEL_MAP,
  GITLAB_ENTITY_TYPE_MAP,
  GITLAB_STATUS_MAP,
  inferIssueType as inferGitLabIssueType,
} from './adapters/gitlab.js'

// Jira adapter: delivery layer import
export {
  JiraAdapter,
  JIRA_ISSUE_TYPE_MAP,
  JIRA_STRUCTURAL_TYPE_MAP,
  JIRA_LINK_EDGE_MAP,
  JIRA_STATUS_MAP,
  resolveIssueType,
  normalizeJiraStatus,
  getConfidenceForIssueType,
} from './adapters/jira.js'

// Productboard adapter: feature management and feedback import
export {
  ProductboardAdapter,
  PRODUCTBOARD_TYPE_MAP,
  PRODUCTBOARD_STATUS_MAP,
  resolveProductboardType,
  normalizeProductboardStatus,
  getConfidenceForProductboardType,
  resolveFeatureType,
} from './adapters/productboard.js'

// Aha! adapter: strategy, delivery, and customer intelligence import
export {
  AhaAdapter,
  AHA_TYPE_MAP,
  AHA_STATUS_MAP,
  resolveAhaType,
  resolveAhaStatusForType,
  getConfidenceForAhaType,
} from './adapters/aha.js'

// Zendesk adapter: enterprise support and customer feedback import
export {
  ZendeskAdapter,
  ZENDESK_TYPE_MAP,
  ZENDESK_STATUS_MAP,
  resolveZendeskType,
  resolveZendeskStatusForType,
  getZendeskConfidence,
} from './adapters/zendesk.js'

// Lattice adapter: people management and OKR import
export {
  LatticeAdapter,
  LATTICE_TYPE_MAP,
  LATTICE_STATUS_MAP,
  resolveLatticeType,
  normalizeLatticeStatus,
  getLatticeConfidence,
} from './adapters/lattice.js'

// Storybook adapter: design system component import
export {
  StorybookAdapter,
  STORYBOOK_TYPE_MAP,
  resolveStorybookType,
  getStorybookConfidence,
} from './adapters/storybook.js'

// Airfocus adapter: prioritisation, roadmapping, and OKR import
export {
  AirfocusAdapter,
  AIRFOCUS_TYPE_MAP,
  AIRFOCUS_STATUS_MAP,
  resolveAirfocusType,
  normalizeAirfocusStatus,
  getAirfocusConfidence,
} from './adapters/airfocus.js'

// Craft.io adapter: product strategy, OKR, roadmap, and feedback import
export {
  CraftioAdapter,
  CRAFTIO_TYPE_MAP,
  CRAFTIO_STATUS_MAP,
  resolveCraftioType,
  normalizeCraftioStatus,
  getCraftioConfidence,
} from './adapters/craftio.js'

// Chisel adapter: discovery, roadmap, and team alignment OKR import
export {
  ChiselAdapter,
  CHISEL_TYPE_MAP,
  CHISEL_STATUS_MAP,
  resolveChiselType,
  normalizeChiselStatus,
  getChiselConfidence,
} from './adapters/chisel.js'

// ProdPad adapter: product backlog and strategy import
export {
  ProdpadAdapter,
  PRODPAD_TYPE_MAP,
  PRODPAD_STATUS_MAP,
  resolveProdpadType,
  normalizeProdpadStatus,
  getProdpadConfidence,
} from './adapters/prodpad.js'

// Registry of all 37 adapters. `markdown` runs `list()` in-memory.
// The other 36 need an API key or MCP connection for `list()`, and are
// listed in `API_REQUIRED_ADAPTERS`. `convert()` works on pre-fetched
// data for every adapter.
import { MarkdownAdapter } from './adapters/markdown.js'
import { NotionAdapter } from './adapters/notion.js'
import { DovetailAdapter } from './adapters/dovetail.js'
import { VistalyAdapter } from './adapters/vistaly.js'
import { QuantiveAdapter } from './adapters/quantive.js'
import { ShortcutAdapter } from './adapters/shortcut.js'
import { CodaAdapter } from './adapters/coda.js'
import { AmplitudeAdapter } from './adapters/amplitude.js'
import { PostHogAdapter } from './adapters/posthog.js'
import { CannyAdapter } from './adapters/canny.js'
import { IntercomAdapter } from './adapters/intercom.js'
import { HubSpotAdapter } from './adapters/hubspot.js'
import { SalesforceAdapter } from './adapters/salesforce.js'
import { GainsightAdapter } from './adapters/gainsight.js'
import { PendoAdapter } from './adapters/pendo.js'
import { FigmaAdapter } from './adapters/figma.js'
import { MiroAdapter } from './adapters/miro.js'
import { ConfluenceAdapter } from './adapters/confluence.js'
import { LaunchDarklyAdapter } from './adapters/launchdarkly.js'
import { CondensAdapter } from './adapters/condens.js'
import { LookbackAdapter } from './adapters/lookback.js'
import { SprigAdapter } from './adapters/sprig.js'
import { MazeAdapter } from './adapters/maze.js'
import { SlackAdapter } from './adapters/slack.js'
import { LinearAdapter } from './adapters/linear.js'
import { GitHubAdapter } from './adapters/github.js'
import { GitLabAdapter } from './adapters/gitlab.js'
import { JiraAdapter } from './adapters/jira.js'
import { ProductboardAdapter } from './adapters/productboard.js'
import { AhaAdapter } from './adapters/aha.js'
import { ZendeskAdapter } from './adapters/zendesk.js'
import { LatticeAdapter } from './adapters/lattice.js'
import { StorybookAdapter } from './adapters/storybook.js'
import { AirfocusAdapter } from './adapters/airfocus.js'
import { CraftioAdapter } from './adapters/craftio.js'
import { ChiselAdapter } from './adapters/chisel.js'
import { ProdpadAdapter } from './adapters/prodpad.js'
import type { UPGAdapter } from './types.js'

/** All adapters, keyed by name. Use `getAdapter(name)` to look up. */
export const ADAPTERS: Record<string, UPGAdapter> = {
  markdown: new MarkdownAdapter(),
  notion: new NotionAdapter(),
  dovetail: new DovetailAdapter(),
  vistaly: new VistalyAdapter(),
  quantive: new QuantiveAdapter(),
  shortcut: new ShortcutAdapter(),
  coda: new CodaAdapter(),
  amplitude: new AmplitudeAdapter(),
  posthog: new PostHogAdapter(),
  canny: new CannyAdapter(),
  intercom: new IntercomAdapter(),
  hubspot: new HubSpotAdapter(),
  salesforce: new SalesforceAdapter(),
  gainsight: new GainsightAdapter(),
  pendo: new PendoAdapter(),
  figma: new FigmaAdapter(),
  miro: new MiroAdapter(),
  confluence: new ConfluenceAdapter(),
  launchdarkly: new LaunchDarklyAdapter(),
  condens: new CondensAdapter(),
  lookback: new LookbackAdapter(),
  sprig: new SprigAdapter(),
  maze: new MazeAdapter(),
  slack: new SlackAdapter(),
  linear: new LinearAdapter(),
  github: new GitHubAdapter(),
  gitlab: new GitLabAdapter(),
  jira: new JiraAdapter(),
  productboard: new ProductboardAdapter(),
  aha: new AhaAdapter(),
  zendesk: new ZendeskAdapter(),
  lattice: new LatticeAdapter(),
  storybook: new StorybookAdapter(),
  airfocus: new AirfocusAdapter(),
  craftio: new CraftioAdapter(),
  chisel: new ChiselAdapter(),
  prodpad: new ProdpadAdapter(),
}

/**
 * Adapter names whose `list()` method requires an external API connection
 * or MCP server. `convert()` works end-to-end on pre-fetched data.
 */
export const API_REQUIRED_ADAPTERS = [
  'notion',
  'dovetail',
  'vistaly',
  'quantive',
  'shortcut',
  'coda',
  'amplitude',
  'posthog',
  'canny',
  'intercom',
  'hubspot',
  'salesforce',
  'gainsight',
  'pendo',
  'figma',
  'miro',
  'confluence',
  'launchdarkly',
  'condens',
  'lookback',
  'sprig',
  'maze',
  'slack',
  'linear',
  'github',
  'gitlab',
  'jira',
  'productboard',
  'aha',
  'zendesk',
  'lattice',
  'storybook',
  'airfocus',
  'craftio',
  'chisel',
  'prodpad',
] as const

/** Get an adapter by name. */
export function getAdapter(name: string): UPGAdapter | undefined {
  return ADAPTERS[name]
}
