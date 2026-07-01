/**
 * Coda Adapter
 *
 * Imports rows from Coda tables via the Coda API.
 * This adapter is designed to be invoked from within a skill that has
 * access to Coda API credentials or pre-fetched table data.
 *
 * Mapping:
 * - Table rows → entities by table name (e.g. "Features" table → feature nodes)
 * - Lookup columns → UPG edges (via CODA_LOOKUP_EDGE_MAP)
 * - Canvas pages → document nodes
 * - Column values → node properties
 * - select / multiselect → status or tags
 * - formula / button / person columns → skipped with warning
 * - status → normalised UPG lifecycle stage (via CODA_STATUS_MAP)
 * - Views (tableType: "view") → skipped to prevent duplicate rows
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolvePairEdge } from './resolve-pair-edge.js'
import { getLifecycleForType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Table name → UPG entity type ────────────────────────────────────────────

/**
 * Maps normalised Coda table names to UPG entity types.
 *
 * Keys are lowercase, trimmed table name patterns.
 * Null values signal explicitly unmappable tables (views, automations, UI elements).
 *
 * All UPG entity types verified against the live catalog.
 */
export const CODA_TABLE_TYPE_MAP: Record<string, string | null> = {
  // ── Strategy ──────────────────────────────────────────────────────────────
  objective: 'objective',
  objectives: 'objective',
  okr: 'objective',
  okrs: 'objective',
  goal: 'objective',
  goals: 'objective',

  'key result': 'key_result',
  'key results': 'key_result',
  key_result: 'key_result',
  key_results: 'key_result',
  kr: 'key_result',
  krs: 'key_result',

  initiative: 'initiative',
  initiatives: 'initiative',

  metric: 'metric',
  metrics: 'metric',
  kpi: 'metric',
  kpis: 'metric',
  'north star': 'metric',
  'success metrics': 'metric',

  outcome: 'outcome',
  outcomes: 'outcome',

  vision: 'vision',
  mission: 'mission',

  assumption: 'assumption',
  assumptions: 'assumption',
  'assumption register': 'assumption',

  decision: 'decision',
  decisions: 'decision',
  'decision log': 'decision',
  adr: 'decision',
  adrs: 'decision',

  // ── Discovery ─────────────────────────────────────────────────────────────
  opportunity: 'opportunity',
  opportunities: 'opportunity',
  'problem space': 'opportunity',
  problem: 'opportunity',
  problems: 'opportunity',

  solution: 'solution',
  solutions: 'solution',

  hypothesis: 'hypothesis',
  hypotheses: 'hypothesis',

  experiment: 'experiment',
  experiments: 'experiment',

  // ── Delivery / spec ───────────────────────────────────────────────────────
  feature: 'feature',
  features: 'feature',
  'product features': 'feature',

  epic: 'epic',
  epics: 'epic',

  story: 'user_story',
  stories: 'user_story',
  'user story': 'user_story',
  'user stories': 'user_story',

  task: 'task',
  tasks: 'task',
  'to-do': 'task',
  todos: 'task',
  'action items': 'task',
  'action item': 'task',

  bug: 'bug',
  bugs: 'bug',
  defect: 'bug',
  defects: 'bug',

  requirement: 'acceptance_criterion',
  requirements: 'acceptance_criterion',
  'acceptance criterion': 'acceptance_criterion',
  'acceptance criteria': 'acceptance_criterion',

  release: 'release',
  releases: 'release',
  version: 'release',
  versions: 'release',

  roadmap: 'roadmap_item',
  'roadmap items': 'roadmap_item',
  'product roadmap': 'roadmap_item',

  // ── Research ──────────────────────────────────────────────────────────────
  insight: 'insight',
  insights: 'insight',
  'research insights': 'insight',

  research: 'research_study',
  'user research': 'research_study',
  'research study': 'research_study',
  'research studies': 'research_study',
  interview: 'research_study',
  interviews: 'research_study',

  observation: 'observation',
  observations: 'observation',

  quote: 'quote',
  quotes: 'quote',

  // ── User / Persona ────────────────────────────────────────────────────────
  persona: 'persona',
  personas: 'persona',
  'user types': 'persona',
  'buyer personas': 'persona',

  user: 'participant',
  users: 'participant',
  participant: 'participant',
  participants: 'participant',
  customer: 'persona',
  customers: 'persona',

  // ── Feedback ──────────────────────────────────────────────────────────────
  feedback: 'customer_feedback',
  'customer feedback': 'customer_feedback',

  'feature request': 'feature_request',
  'feature requests': 'feature_request',
  feature_request: 'feature_request',
  feature_requests: 'feature_request',

  // ── Market ────────────────────────────────────────────────────────────────
  competitor: 'competitor',
  competitors: 'competitor',
  'competitor analysis': 'competitor',

  // ── Content / documents ───────────────────────────────────────────────────
  document: 'document',
  documents: 'document',
  note: 'document',
  notes: 'document',
  spec: 'document',
  specs: 'document',
  'meeting notes': 'document',

  // ── Explicitly unmappable: skip with warning ─────────────────────────────
  view: null,
  views: null,
  automation: null,
  automations: null,
  control: null,
  controls: null,
  button: null,
  buttons: null,
}

// ─── Lookup column name → UPG edge type ──────────────────────────────────────

/**
 * Maps Coda lookup column names (case-insensitive, trimmed) to
 * canonical UPG edge types.
 *
 * Lookup columns are Coda's primary cross-table linking mechanism :
 * structurally equivalent to Notion's relation property.
 *
 * All edge types verified against the live UPG edge catalog.
 */
export const CODA_LOOKUP_EDGE_MAP: Record<string, string> = {
  // outcome ← feature
  objective: 'outcome_delivered_by_feature',
  objectives: 'outcome_delivered_by_feature',

  // release → feature
  release: 'release_contains_feature',
  releases: 'release_contains_feature',

  // epic → user_story
  epic: 'epic_specified_by_user_story',
  epics: 'epic_specified_by_user_story',

  // opportunity → solution
  opportunity: 'opportunity_drives_solution',
  opportunities: 'opportunity_drives_solution',

  // product → persona
  persona: 'product_targets_persona',
  personas: 'product_targets_persona',

  // initiative → outcome
  initiative: 'initiative_drives_outcome',
  initiatives: 'initiative_drives_outcome',

  // key_result → metric
  'key result': 'key_result_quantified_by_metric',
  key_result: 'key_result_quantified_by_metric',
  'key results': 'key_result_quantified_by_metric',
  key_results: 'key_result_quantified_by_metric',

  // feature_area → feature
  'feature area': 'feature_area_contains_feature',
  feature_area: 'feature_area_contains_feature',
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps common Coda select-column status values to normalised UPG lifecycle stages.
 *
 * Coda has no built-in structured status type: teams use a `select` column
 * with their own naming. This map covers the most common patterns.
 */
export const CODA_STATUS_MAP: Record<string, string> = {
  // Not started / backlog variants → maps to common initial phase candidates
  new: 'new',
  'not started': 'todo',
  'not started yet': 'todo',
  todo: 'todo',
  'to-do': 'todo',
  backlog: 'todo',
  open: 'open',
  planned: 'planned',
  proposed: 'proposed',
  draft: 'draft',

  // Active / in-progress variants
  'in progress': 'in_progress',
  'in-progress': 'in_progress',
  'in_progress': 'in_progress',
  active: 'active',
  doing: 'in_progress',
  ongoing: 'in_progress',
  started: 'in_progress',

  // Done / shipped / complete variants
  done: 'done',
  complete: 'complete',
  completed: 'done',
  shipped: 'shipped',
  released: 'shipped',
  closed: 'done',
  finished: 'done',
  verified: 'verified',
  achieved: 'achieved',

  // Cancelled / abandoned variants
  cancelled: 'abandoned',
  canceled: 'abandoned',
  dropped: 'abandoned',
  "won't do": 'abandoned',
  "wont do": 'abandoned',
  archived: 'archived',
  rejected: 'abandoned',
  'will not implement': 'abandoned',
  "won't implement": 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a name string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Infer UPG entity type from a Coda table name.
 *
 * Returns:
 * - A UPG entity type string if matched
 * - null if the table is explicitly unmappable (views, automations)
 * - undefined if the table name is unknown (caller should warn + default)
 */
export function inferTableType(tableName: string): string | null | undefined {
  const lower = normalizeName(tableName)

  // Direct match (handles null for explicitly unmappable tables)
  if (lower in CODA_TABLE_TYPE_MAP) {
    return CODA_TABLE_TYPE_MAP[lower]
  }

  // Plural → singular heuristic: "epics" → "epic"
  if (lower.endsWith('s')) {
    const singular = lower.slice(0, -1)
    if (singular in CODA_TABLE_TYPE_MAP) {
      return CODA_TABLE_TYPE_MAP[singular]
    }
  }

  // Singular → plural heuristic: "feature" → "features"
  if (!lower.endsWith('s')) {
    const plural = `${lower}s`
    if (plural in CODA_TABLE_TYPE_MAP) {
      return CODA_TABLE_TYPE_MAP[plural]
    }
  }

  return undefined // unknown table: caller warns + defaults to 'document'
}

/**
 * Resolve a Coda lookup column name to a UPG edge type.
 * Returns null if the column name is not recognised.
 */
export function resolveLookupEdge(
  columnName: string,
  _sourceEntityType: string,
  _targetTable: string,
): string | null {
  const lower = normalizeName(columnName)
  return CODA_LOOKUP_EDGE_MAP[lower] ?? null
}

/** Valid status values for a UPG entity type, or null when lifecycle-free. */
function validStatusesForType(type: string): ReadonlySet<string> | null {
  const lc = getLifecycleForType(type)
  if (!lc) return null
  const set = new Set<string>()
  for (const p of lc.phases) {
    set.add(p.id)
    for (const s of p.core_states ?? []) set.add(s.id)
  }
  return set
}

/**
 * Resolve a Coda raw status string to a valid UPG phase id for the target
 * entity type's lifecycle. Returns undefined when:
 * - the type is lifecycle-free (no status should be set), or
 * - the raw value (and its mapped candidate) is not a valid phase id for this type.
 */
export function resolveCodaStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined            // lifecycle-free type: no status
  const lower = normalizeName(rawStatus)
  // Try the raw value first (some teams already use UPG phase ids directly)
  if (valid.has(lower)) return lower
  // Then try the intermediate map
  const candidate = CODA_STATUS_MAP[lower]
  if (candidate && valid.has(candidate)) return candidate
  return undefined
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface LookupField {
  column_name: string
  target_row_id: string
  target_table: string
}

// ─── Coda Adapter ─────────────────────────────────────────────────────────────

export class CodaAdapter implements UPGAdapter {
  name = 'coda'
  label = 'Coda'
  description =
    'Import rows from Coda tables. Table name infers entity type. Lookup columns become UPG edges.'

  /**
   * List available Coda tables and rows.
   *
   * Requires Coda API access. This adapter is designed to be called from
   * within a skill that has access to a Coda API connection.
   *
   * Config options:
   * - `rows`: SourceItem[]: pre-fetched Coda rows (from API call)
   * - `doc_id` (string): specific doc to import from
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would call:
    //   GET /docs/:docId/tables
    //   GET /docs/:docId/tables/:tableId/rows
    //
    // The skill layer passes pre-fetched data via config.rows when API
    // access isn't directly available from this adapter.
    throw new Error(
      'Coda adapter requires Coda API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched rows via config.rows.',
    )
  }

  /**
   * Convert Coda source items to UPG entities.
   *
   * Mapping logic (two-pass):
   *
   * Pass 1: Build nodes:
   * - source_type "table_row" → entity type inferred from metadata.table_name
   * - metadata.status → normalised lifecycle stage via CODA_STATUS_MAP
   * - metadata.tags → node tags
   * - metadata.current_value / target_value / unit → preserved for metric/key_result
   * - Unmappable table names (views, automations) → warning + skip
   * - Unknown table names → warning + default to "document"
   * - metadata.has_formula_columns / has_button_columns → warning emitted once per table
   *
   * Pass 2: Emit lookup edges:
   * - metadata.lookup_fields → resolve against sourceMap + CODA_LOOKUP_EDGE_MAP
   * - Unknown lookup target (row not in import set) → warning + skip
   * - Unresolvable column name → skip (no edge emitted)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    // Track which tables have already had formula/button warnings emitted
    // to avoid one warning per row.
    const formulaWarnedTables = new Set<string>()
    const buttonWarnedTables = new Set<string>()

    let counter = 0

    // ── Pass 1: Build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `coda-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const tableName = (meta.table_name as string | undefined) ?? ''

      // ── Table-level formula / button column warnings ─────────────────────
      if (meta.has_formula_columns && !formulaWarnedTables.has(tableName)) {
        formulaWarnedTables.add(tableName)
        warnings.push(
          `Coda formula columns are computed values and were skipped: only source data columns are exported as UPG properties.`,
        )
      }
      if (meta.has_button_columns && !buttonWarnedTables.has(tableName)) {
        buttonWarnedTables.add(tableName)
        warnings.push(
          `Coda button and control columns are UI elements with no UPG equivalent and were skipped.`,
        )
      }

      // ── Resolve entity type from table name ──────────────────────────────
      const resolved = tableName ? inferTableType(tableName) : undefined

      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === null) {
        // Explicitly unmappable table (view, automation, control)
        warnings.push(
          `Coda table "${tableName}" is a UI-layer construct (view/automation/control) with no ` +
            `UPG equivalent. Rows from this table were skipped.`,
        )
        // Do not register in sourceMap: row is skipped
        continue
      } else if (resolved === undefined) {
        // Unknown table name
        warnings.push(
          `Coda table "${tableName}" could not be mapped to a UPG entity type. ` +
            `Rows from this table were defaulted to "document". ` +
            `Rename the table to a recognised UPG entity name (e.g., "Features", "Opportunities") for accurate mapping.`,
        )
        entityType = 'document'
        mappingConfidence = 'low'
      } else {
        entityType = resolved
        mappingConfidence = _inferConfidence(tableName)
      }

      // Register in sourceMap so lookup edges can resolve this row
      sourceMap[item.source_id] = nodeId

      // ── Tags ──────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      // ── Status → per-type lifecycle phase id ──────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolveCodaStatusForType(rawStatus, entityType) : undefined

      // ── Numeric fields for metric / key_result → nested under properties ──
      const numericProperties: Record<string, unknown> = {}
      if (entityType === 'metric' || entityType === 'key_result') {
        if (meta.current_value !== undefined) numericProperties.current_value = meta.current_value as number
        if (meta.target_value !== undefined) numericProperties.target_value = meta.target_value as number
        if (meta.unit !== undefined) numericProperties.unit = meta.unit as string
      }
      const hasNumericProperties = Object.keys(numericProperties).length > 0

      // ── Build node ────────────────────────────────────────────────────────
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
        external_tool: 'coda',
        external_id: item.source_id,
        ...(meta.external_url ? { external_ref: meta.external_url as string } : {}),
        ...(hasNumericProperties ? { properties: numericProperties } : {}),
      }

      nodes.push(node)
    }

    // ── Pass 2: Emit lookup edges ───────────────────────────────────────────
    // Processed after all nodes are created so sourceMap is complete.
    //
    // Direction model: a Coda lookup column on row A pointing to row B means
    // "A belongs to / references B". B is the parent (source in most UPG edges),
    // A is the child (target in most UPG edges). resolvePairEdge() provides the
    // canonical edge type AND direction from the UPG catalogue; sourceIsChild=true
    // means the item with the lookup column is the edge's source.
    const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type as string]))

    for (const item of items) {
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue // Row was skipped in pass 1

      const meta = item.metadata ?? {}
      const childType = nodeTypeById.get(nodeId) ?? ''
      const lookupFields = meta.lookup_fields as LookupField[] | undefined

      if (!lookupFields || lookupFields.length === 0) continue

      for (const lookup of lookupFields) {
        const parentNodeId = sourceMap[lookup.target_row_id]

        if (!parentNodeId) {
          warnings.push(
            `Coda lookup from "${item.title}" to row "${lookup.target_row_id}" ` +
              `(column "${lookup.column_name}"). Target row not in import set. Edge skipped.`,
          )
          continue
        }

        const parentType = nodeTypeById.get(parentNodeId) ?? ''
        const mapped = resolvePairEdge(parentType, childType)

        if (!mapped) {
          // No canonical edge for this parent→child type pair: emit a generic link
          edges.push({
            id: `edge-coda-${parentNodeId}-${nodeId}-lookup`,
            source: parentNodeId,
            target: nodeId,
            type: 'node_informs_node' as UPGEdgeType,
            mapping_confidence: 'low',
          })
          continue
        }

        const source = mapped.sourceIsChild ? nodeId : parentNodeId
        const target = mapped.sourceIsChild ? parentNodeId : nodeId
        edges.push({
          id: `edge-coda-${source}-${target}`,
          source,
          target,
          type: mapped.type as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      }
    }

    if (nodes.length === 0) {
      warnings.push('No rows were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Infer mapping confidence based on table name specificity.
 *
 * - high: Unambiguous domain-specific table names (Opportunities, Experiments, etc.)
 * - medium: Contextually probable but could vary (Features, Tasks, etc.)
 * - low: Generic names that could mean many things (Notes, Documents, etc.)
 */
function _inferConfidence(tableName: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(tableName)
  const HIGH_CONFIDENCE = new Set([
    'opportunities',
    'opportunity',
    'experiments',
    'experiment',
    'hypotheses',
    'hypothesis',
    'insights',
    'insight',
    'personas',
    'persona',
    'okrs',
    'okr',
    'key results',
    'key result',
    'krs',
    'competitors',
    'competitor',
    'feature requests',
    'feature request',
    'bugs',
    'bug',
    'defects',
    'user stories',
    'user story',
    'epics',
    'epic',
    'releases',
    'release',
    'decisions',
    'decision',
    'assumptions',
    'assumption',
    'observations',
    'observation',
    'customer feedback',
    'feedback',
  ])
  const MEDIUM_CONFIDENCE = new Set([
    'features',
    'feature',
    'tasks',
    'task',
    'roadmap',
    'objectives',
    'objective',
    'goals',
    'metrics',
    'metric',
    'kpis',
    'kpi',
    'research',
    'interviews',
    'interview',
    'initiatives',
    'initiative',
    'solutions',
    'solution',
    'outcomes',
    'outcome',
  ])
  if (HIGH_CONFIDENCE.has(lower)) return 'high'
  if (MEDIUM_CONFIDENCE.has(lower)) return 'medium'
  return 'low'
}
