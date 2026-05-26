/**
 * Notion Adapter
 *
 * Imports pages and databases from Notion via the Notion MCP.
 * This adapter is designed to be invoked from within a skill that has
 * access to Notion MCP tools (mcp__notion__*).
 *
 * Mapping:
 * - Database items → entities by database name (e.g. "Features" DB → feature nodes)
 * - Pages → document (default) or inferred from title
 * - Nested pages → parent-child edges
 * - Page properties → node properties
 * - Tags / multi-select → node tags
 * - Relations between databases → UPG edges (via RELATION_EDGE_MAP)
 * - unique_id property → external_id sync anchor
 * - status property → normalised UPG lifecycle stage
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolveContainmentEdge } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Database name → UPG entity type ─────────────────────────────────────────

/**
 * Maps normalised Notion database names to UPG entity types.
 *
 * Keys are lowercase, trimmed database name patterns. Entries cover:
 * - Canonical singular/plural forms
 * - Common abbreviations and alternate names
 * - Null values signal explicitly unmappable databases (emit warning)
 *
 * All UPG entity types verified against the live catalog via list_entity_types.
 */
export const DATABASE_TYPE_MAP: Record<string, string | null> = {
  // ── Delivery / spec ──────────────────────────────────────────────────────
  task: 'task',
  tasks: 'task',
  'to-do': 'task',
  'to-dos': 'task',
  todo: 'task',
  todos: 'task',
  'action items': 'task',
  'action item': 'task',

  bug: 'bug',
  bugs: 'bug',
  defect: 'bug',
  defects: 'bug',
  'bug tracker': 'bug',
  'bug reports': 'bug',

  feature: 'feature',
  features: 'feature',
  'product features': 'feature',

  epic: 'epic',
  epics: 'epic',

  story: 'story_statement',
  stories: 'story_statement',
  'user story': 'story_statement',
  'user stories': 'story_statement',
  'story statements': 'story_statement',

  release: 'release',
  releases: 'release',
  version: 'release',
  versions: 'release',
  'release notes': 'release',

  roadmap: 'roadmap_item',
  'roadmap items': 'roadmap_item',
  'roadmap item': 'roadmap_item',
  'product roadmap': 'roadmap_item',

  changelog: 'changelog',
  'change log': 'changelog',
  changelogs: 'changelog',

  // ── Strategy / OKRs ──────────────────────────────────────────────────────
  objective: 'objective',
  objectives: 'objective',
  okr: 'objective',
  okrs: 'objective',
  goal: 'objective',
  goals: 'objective',

  'key result': 'key_result',
  'key results': 'key_result',
  kr: 'key_result',
  krs: 'key_result',

  metric: 'metric',
  metrics: 'metric',
  kpi: 'metric',
  kpis: 'metric',
  'north star': 'metric',
  'success metrics': 'metric',

  decision: 'decision',
  decisions: 'decision',
  'decision log': 'decision',
  'decision register': 'decision',
  adr: 'decision',
  adrs: 'decision',

  assumption: 'assumption',
  assumptions: 'assumption',
  'assumption register': 'assumption',

  initiative: 'initiative',
  initiatives: 'initiative',

  // ── Discovery ─────────────────────────────────────────────────────────────
  opportunity: 'opportunity',
  opportunities: 'opportunity',
  'problem space': 'opportunity',

  solution: 'solution',
  solutions: 'solution',
  'solution space': 'solution',

  // ── Validation ────────────────────────────────────────────────────────────
  experiment: 'experiment',
  experiments: 'experiment',
  test: 'experiment',
  tests: 'experiment',
  'assumption test': 'experiment',
  'assumption tests': 'experiment',
  'a/b test': 'experiment',
  'a/b tests': 'experiment',

  hypothesis: 'hypothesis',
  hypotheses: 'hypothesis',

  // ── Research ──────────────────────────────────────────────────────────────
  research: 'research_study',
  'user research': 'research_study',
  'research study': 'research_study',
  'research studies': 'research_study',
  interview: 'research_study',
  interviews: 'research_study',
  'user interviews': 'research_study',

  insight: 'insight',
  insights: 'insight',
  'research insights': 'insight',
  'user insights': 'insight',
  observation: 'observation',
  observations: 'observation',

  // ── User / Persona ────────────────────────────────────────────────────────
  persona: 'persona',
  personas: 'persona',
  'user types': 'persona',
  'user type': 'persona',
  'customer types': 'persona',
  'buyer personas': 'persona',

  // ── Competitive ───────────────────────────────────────────────────────────
  competitor: 'competitor',
  competitors: 'competitor',
  'competitor tracker': 'competitor',
  'competitor analysis': 'competitor',
  competition: 'competitor',

  // ── Feedback ──────────────────────────────────────────────────────────────
  'feature request': 'feature_request',
  'feature requests': 'feature_request',
  'feedback requests': 'feature_request',
  'customer requests': 'feature_request',
  requests: 'feature_request',

  // ── Program management ────────────────────────────────────────────────────
  project: 'project',
  projects: 'project',
  'active projects': 'project',

  milestone: 'milestone',
  milestones: 'milestone',

  // ── Content ───────────────────────────────────────────────────────────────
  'content calendar': 'content_calendar',
  'editorial calendar': 'content_calendar',
  'content plan': 'content_calendar',

  content: 'content_piece',
  posts: 'content_piece',
  articles: 'content_piece',
  'blog posts': 'content_piece',
  'content pieces': 'content_piece',

  // ── Documents / knowledge ─────────────────────────────────────────────────
  'meeting notes': 'document',
  meetings: 'document',
  'meeting minutes': 'document',
  notes: 'document',
  documents: 'document',
  'knowledge base': 'document',

  // ── Team / people ─────────────────────────────────────────────────────────
  team: 'team',
  'team members': 'team',
  people: 'team',
  roster: 'team',
  staff: 'team',

  // ── Explicitly unmappable (warn + default to task) ────────────────────────
  // Sprints and cycles are delivery-layer constructs with no UPG equivalent.
  sprint: null,
  sprints: null,
  cycle: null,
  cycles: null,
  'sprint board': null,
  backlog: null,
  'sprint backlog': null,
  'product backlog': null,
}

// ─── Confidence map ───────────────────────────────────────────────────────────

/**
 * Indicates how confident we are that a database name → entity type mapping is correct.
 *
 * - high: Unambiguous canonical name (e.g. "personas" → persona, always)
 * - medium: Probable but context-dependent (e.g. "projects" → project, usually)
 * - low: Heuristic or partial match: could mean different things in different teams
 */
export const CONFIDENCE_MAP: Record<string, 'high' | 'medium' | 'low'> = {
  persona: 'high',
  personas: 'high',
  'buyer personas': 'high',
  insights: 'high',
  insight: 'high',
  'research insights': 'high',
  okrs: 'high',
  okr: 'high',
  'key results': 'high',
  'key result': 'high',
  krs: 'high',
  opportunities: 'high',
  experiments: 'high',
  experiment: 'high',
  hypotheses: 'high',
  hypothesis: 'high',
  competitors: 'high',
  competitor: 'high',
  'feature requests': 'high',
  'feature request': 'high',
  bugs: 'high',
  bug: 'high',
  defects: 'high',
  'user stories': 'high',
  'user story': 'high',
  epics: 'high',
  epic: 'high',
  releases: 'high',
  release: 'high',
  changelog: 'high',
  changelogs: 'high',
  'decision log': 'high',
  decisions: 'high',
  decision: 'high',
  assumptions: 'high',
  assumption: 'high',
  'assumption tests': 'high',
  observations: 'high',

  projects: 'medium',
  project: 'medium',
  features: 'medium',
  feature: 'medium',
  tasks: 'medium',
  task: 'medium',
  roadmap: 'medium',
  'roadmap items': 'medium',
  objectives: 'medium',
  objective: 'medium',
  goals: 'medium',
  metrics: 'medium',
  metric: 'medium',
  kpis: 'medium',
  research: 'medium',
  interviews: 'medium',
  interview: 'medium',
  milestones: 'medium',
  milestone: 'medium',
  initiative: 'medium',
  initiatives: 'medium',
  solutions: 'medium',
  solution: 'medium',
  'content calendar': 'medium',

  content: 'low',
  posts: 'low',
  articles: 'low',
  notes: 'low',
  documents: 'low',
  people: 'low',
  team: 'low',
  meetings: 'low',
  tests: 'low',
  requests: 'low',
}

// ─── Relation property name → UPG edge type ───────────────────────────────────

/**
 * Maps Notion relation property names (case-insensitive, trimmed) to
 * canonical UPG edge types.
 *
 * All edge types verified against the live UPG edge catalog via list_edge_types.
 */
export const RELATION_EDGE_MAP: Record<string, string> = {
  // insight → opportunity
  informs: 'insight_informs_opportunity',
  'informs opportunity': 'insight_informs_opportunity',
  surfaces: 'insight_informs_opportunity',
  reveals: 'insight_informs_opportunity',
  'relates to opportunity': 'insight_informs_opportunity',

  // insight → job
  'informs job': 'insight_informs_job',
  'surfaces job': 'insight_informs_job',

  // insight → solution
  'informs solution': 'insight_informs_solution',

  // opportunity → solution
  drives: 'opportunity_drives_solution',
  addresses: 'opportunity_drives_solution',
  'drives solution': 'opportunity_drives_solution',
  'addressed by': 'opportunity_drives_solution',
  'solved by': 'opportunity_drives_solution',

  // solution → hypothesis
  'proposes hypothesis': 'solution_proposes_hypothesis',
  hypothesises: 'solution_proposes_hypothesis',
  'proposes hypothesis on': 'solution_proposes_hypothesis',

  // research study → insight
  produces: 'research_study_produces_insight',
  'produces insight': 'research_study_produces_insight',
  generated: 'research_study_produces_insight',
  'generated insights': 'research_study_produces_insight',

  // research study → participant
  enrolls: 'research_study_enrolls_participant',
  participants: 'research_study_enrolls_participant',

  // observation → insight
  yields: 'observation_yields_insight',
  'yields insight': 'observation_yields_insight',

  // outcome ← feature (note: edge goes outcome→feature)
  'delivered by': 'outcome_delivered_by_feature',
  delivers: 'outcome_delivered_by_feature',
  ships: 'outcome_delivered_by_feature',
  'delivered by feature': 'outcome_delivered_by_feature',

  // initiative → outcome
  'drives outcome': 'initiative_drives_outcome',
  'achieves outcome': 'initiative_drives_outcome',

  // feature → epic
  'decomposed into': 'feature_decomposed_into_epic',
  'broken into epics': 'feature_decomposed_into_epic',

  // epic → story_statement
  'specified by': 'epic_specified_by_story_statement',
  'broken into stories': 'epic_specified_by_story_statement',
  stories: 'epic_specified_by_story_statement',

  // project → initiative
  implements: 'project_implements_initiative',
  'implements initiative': 'project_implements_initiative',
  'aligns with': 'project_implements_initiative',
  'aligns with initiative': 'project_implements_initiative',

  // document → decision
  'describes decision': 'document_describes_decision',
  'documents decision': 'document_describes_decision',

  // document → insight
  'contains insight': 'document_contains_insight',
  'links to insight': 'document_contains_insight',

  // content calendar → content piece
  schedules: 'content_calendar_schedules_content_piece',
  'scheduled content': 'content_calendar_schedules_content_piece',

  // node → team (polymorphic ownership)
  'owned by': 'node_owned_by_team',
  owner: 'node_owned_by_team',
  team: 'node_owned_by_team',
}

// ─── Notion property type → UPG handling ─────────────────────────────────────

/**
 * Maps Notion property types to how UPG should handle them during import.
 *
 * - 'edge': This property represents a UPG edge (relation → special handling)
 * - 'enum': Map to a UPG enum / select property
 * - 'numeric': Map to a numeric property
 * - 'date': Map to a date property
 * - 'owner': Map to an owner/assignee field
 * - 'description': Map to a text description field
 * - 'boolean': Map to a boolean property
 * - 'external_id': Map to external_id (the bidirectional sync anchor)
 * - 'lifecycle': Map to lifecycle/status field
 * - 'ignore': Not mapped to UPG (formula, rollup, audit fields)
 */
export const PROPERTY_TYPE_MAP: Record<
  string,
  'edge' | 'enum' | 'numeric' | 'date' | 'owner' | 'description' | 'boolean' | 'external_id' | 'lifecycle' | 'ignore'
> = {
  title: 'description',
  rich_text: 'description',
  number: 'numeric',
  select: 'enum',
  multi_select: 'enum',
  status: 'lifecycle',
  date: 'date',
  people: 'owner',
  files: 'ignore',
  checkbox: 'boolean',
  url: 'description',
  email: 'description',
  phone_number: 'description',
  formula: 'ignore',
  relation: 'edge',
  rollup: 'ignore',
  created_time: 'ignore',
  last_edited_time: 'ignore',
  created_by: 'ignore',
  last_edited_by: 'ignore',
  unique_id: 'external_id',
  verification: 'ignore',
}

// ─── Lifecycle status normalization ──────────────────────────────────────────

/**
 * Maps common Notion status values to a normalised UPG lifecycle stage string.
 * Notion's status groups (Not started / In progress / Done) and custom names
 * all collapse to these canonical values.
 */
export const LIFECYCLE_STATUS_MAP: Record<string, string> = {
  // Not started group
  'not started': 'planned',
  'not started yet': 'planned',
  'to do': 'planned',
  todo: 'planned',
  backlog: 'planned',
  new: 'planned',
  open: 'planned',
  planned: 'planned',

  // In progress group
  'in progress': 'in_progress',
  'in-progress': 'in_progress',
  'in review': 'in_review',
  review: 'in_review',
  testing: 'in_review',
  blocked: 'blocked',
  'on hold': 'paused',
  paused: 'paused',
  active: 'in_progress',
  ongoing: 'in_progress',

  // Done group
  done: 'done',
  complete: 'done',
  completed: 'done',
  closed: 'done',
  resolved: 'done',
  shipped: 'done',
  released: 'done',
  archived: 'archived',
  deprecated: 'archived',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a name string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Infer UPG entity type from a Notion database name. Returns null if unmappable. */
export function inferTypeFromDatabase(dbName: string): string | null {
  const lower = normalizeName(dbName)

  // Direct match (handles nulls for unmappable databases)
  if (lower in DATABASE_TYPE_MAP) {
    return DATABASE_TYPE_MAP[lower]
  }

  // Singular → plural heuristic: "persona" → try "personas"
  if (!lower.endsWith('s')) {
    const plural = `${lower}s`
    if (plural in DATABASE_TYPE_MAP) {
      return DATABASE_TYPE_MAP[plural]
    }
  }

  // Plural → singular heuristic: "epics" → try "epic"
  if (lower.endsWith('s')) {
    const singular = lower.slice(0, -1)
    if (singular in DATABASE_TYPE_MAP) {
      return DATABASE_TYPE_MAP[singular]
    }
  }

  return null
}

/** Get confidence for a database name → entity type mapping */
export function getConfidenceForName(dbName: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(dbName)
  return CONFIDENCE_MAP[lower] ?? 'low'
}

/** Resolve a Notion relation property name to a UPG edge type */
export function resolveRelationEdge(propertyName: string): string | null {
  const lower = normalizeName(propertyName)
  return RELATION_EDGE_MAP[lower] ?? null
}

/** Normalize a Notion status string to a UPG lifecycle stage */
export function normalizeStatus(status: string): string {
  const lower = normalizeName(status)
  return LIFECYCLE_STATUS_MAP[lower] ?? status
}

// ─── Notion Adapter ───────────────────────────────────────────────────────────

export class NotionAdapter implements UPGAdapter {
  name = 'notion'
  label = 'Notion'
  description = 'Import pages and databases from Notion via the Notion MCP'

  /**
   * List available Notion pages and databases.
   *
   * Requires mcp__notion__* tools to be available in the current session.
   * This adapter is designed to be called from within a skill that has
   * access to Notion MCP tools.
   *
   * Config options:
   * - `pages`: SourceItem[]: pre-fetched Notion pages (from MCP call)
   * - `database_id` (string): specific database to import
   * - `search_query` (string): search term to filter pages
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would call:
    //   mcp__notion__search({ query: config.search_query })
    //   mcp__notion__query_database({ database_id: config.database_id })
    //   mcp__notion__get_page({ page_id: ... })
    //
    // The skill layer passes pre-fetched data via config.pages when MCP
    // tools aren't directly callable from this adapter.
    throw new Error(
      'Notion adapter requires Notion MCP connection. ' +
        'Use /upg-import to connect, or pass pre-fetched pages via config.pages.',
    )
  }

  /**
   * Convert Notion source items to UPG entities.
   *
   * Mapping logic:
   * - source_type "database_item" → entity type inferred from database name
   * - source_type "page" → document (default)
   * - Children (nested pages) → parent-child edges via resolveContainmentEdge
   * - metadata.relations → UPG edges via RELATION_EDGE_MAP (deferred until all nodes exist)
   * - metadata.unique_id → external_id sync anchor (preferred over source_id)
   * - metadata.status → normalised lifecycle stage via LIFECYCLE_STATUS_MAP
   * - metadata.tags / metadata.multi_select → node tags
   * - Unmappable database names (sprint/cycle) → warning + default to "task"
   * - Unknown database names → warning + default to "document"
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Deferred relation edges: processed after all nodes are created
    // so that target node IDs are available in sourceMap.
    const deferredRelations: Array<{
      sourceId: string
      relationPropertyName: string
      targetSourceId: string
    }> = []

    let counter = 0

    const processItem = (item: SourceItem, parentId: string | null): void => {
      counter++
      const nodeId = `notion-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      // ── Determine entity type ────────────────────────────────────────────
      const meta = item.metadata ?? {}
      const dbName = meta.database_name as string | undefined

      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low' = 'medium'

      if (item.source_type === 'database_item' && dbName) {
        const lower = normalizeName(dbName)
        const inferred = inferTypeFromDatabase(dbName)

        if (inferred === null && lower in DATABASE_TYPE_MAP) {
          // Explicitly unmappable (sprint / cycle / backlog)
          warnings.push(
            `Database "${dbName}" has no UPG equivalent. Sprints and cycles are ` +
              `delivery-layer constructs outside UPG scope. Items will be typed as "task".`,
          )
          entityType = 'task'
          mappingConfidence = 'low'
        } else if (inferred !== null) {
          entityType = inferred
          mappingConfidence = getConfidenceForName(dbName)
        } else {
          warnings.push(
            `Database "${dbName}" could not be mapped to a UPG entity type. ` +
              `Defaulting to "document". Rename the database to a known pattern to improve accuracy.`,
          )
          entityType = 'document'
          mappingConfidence = 'low'
        }
      } else {
        entityType = 'document'
        mappingConfidence = 'low'
      }

      // ── Extract tags from multi_select and tags properties ─────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      if (Array.isArray(meta.multi_select)) {
        tags.push(...(meta.multi_select as string[]))
      }

      // ── Normalise status → lifecycle stage ───────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeStatus(rawStatus) : undefined

      // ── Extract unique_id as the sync anchor ─────────────────────────────
      // Notion's unique_id is auto-incrementing and stable: preferred over source_id
      // for the external_id sync anchor that enables bidirectional UPG ↔ Notion sync.
      const uniqueId = meta.unique_id as string | undefined
      const externalId = uniqueId ?? item.source_id

      // ── Collect relation properties for deferred edge creation ────────────
      // Relations are stored as Record<propertyName, targetSourceId[]> in metadata.
      const relations = meta.relations as Record<string, string[]> | undefined
      if (relations) {
        for (const [propName, targetSourceIds] of Object.entries(relations)) {
          for (const targetSourceId of targetSourceIds) {
            deferredRelations.push({
              sourceId: item.source_id,
              relationPropertyName: propName,
              targetSourceId,
            })
          }
        }
      }

      // ── Build the UPG node ───────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: entityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'notion',
        external_id: externalId,
        ...(meta.url ? { external_url: meta.url as string } : {}),
      }

      nodes.push(node)

      // ── Parent-child containment edge ─────────────────────────────────────
      // Uses the catalogue-aware resolver: never emits an uncatalogued type.
      // Falls back to node_informs_node when the pair is absent from the catalogue.
      if (parentId) {
        const parentType = nodes.find((n) => n.id === parentId)?.type ?? 'product'
        const edgeType = resolveContainmentEdge(parentType, entityType) ?? 'node_informs_node'
        edges.push({
          id: `edge-${parentId}-${nodeId}`,
          source: parentId,
          target: nodeId,
          type: edgeType,
          mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'medium',
        })
      }

      // ── Recurse into children (nested pages) ─────────────────────────────
      for (const child of item.children ?? []) {
        processItem(child, nodeId)
      }
    }

    for (const item of items) {
      processItem(item, null)
    }

    // ── Resolve deferred relation edges ──────────────────────────────────────
    // Processed after all nodes are built so sourceMap is complete.
    for (const { sourceId, relationPropertyName, targetSourceId } of deferredRelations) {
      const sourceNodeId = sourceMap[sourceId]
      const targetNodeId = sourceMap[targetSourceId]

      if (!sourceNodeId || !targetNodeId) {
        warnings.push(
          `Relation "${relationPropertyName}" references unknown item "${targetSourceId}". Skipped.`,
        )
        continue
      }

      const edgeType = resolveRelationEdge(relationPropertyName) as UPGEdgeType | null
      if (!edgeType) {
        warnings.push(
          `Relation property "${relationPropertyName}" could not be mapped to a UPG edge type. ` +
            `Consider renaming it to a canonical verb (e.g. "Informs", "Drives", "Produces").`,
        )
        continue
      }

      edges.push({
        id: `edge-relation-${sourceNodeId}-${targetNodeId}`,
        source: sourceNodeId,
        target: targetNodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
