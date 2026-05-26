/**
 * Notion × UPG: Shared TypeScript types
 *
 * Used across:
 * - notion.ts          (import adapter)
 * - notion-schema-generator.ts (UPG → Notion write direction)
 * - notion-discovery.ts        (Notion workspace classification)
 *
 * These types mirror the Notion API shape but are kept minimal :
 * we model only what the adapter layer needs, not the full Notion SDK.
 * No Notion SDK dependency is introduced; these are plain TS types.
 */

// ─── Notion property schemas ──────────────────────────────────────────────────

/** The set of Notion property types the adapter understands */
export type NotionPropertyType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'people'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone_number'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'created_time'
  | 'last_edited_time'
  | 'created_by'
  | 'last_edited_by'
  | 'unique_id'
  | 'verification'

/** Select option for a select/multi_select/status property */
export interface NotionSelectOption {
  name: string
  color?: string
}

/** Status group for the status property type */
export interface NotionStatusGroup {
  name: string
  color?: string
  options: NotionSelectOption[]
}

/** A single property definition in a Notion database schema */
export interface NotionPropertySchema {
  /** The Notion property type */
  type: NotionPropertyType
  /** Display name as it appears in Notion */
  name: string
  /** For select/multi_select: the allowed options */
  options?: NotionSelectOption[]
  /** For status: the status groups (Not started / In progress / Done) */
  groups?: NotionStatusGroup[]
  /** For formula: the formula expression */
  formula?: string
  /** For number: the display format */
  number_format?: 'number' | 'number_with_commas' | 'percent' | 'dollar' | 'euro' | 'pound'
  /** Whether this property is required */
  required?: boolean
  /** Human-readable description of what this property captures */
  description?: string
}

/** A Notion relation property definition: links to rows in another database */
export interface NotionRelationProperty {
  /** Property display name (e.g. "Drives", "Produces", "Implements") */
  name: string
  /** The target Notion database name (e.g. "Solutions") */
  target_database_name: string
  /** Whether Notion should create the reverse relation automatically */
  two_way: boolean
  /** The reverse relation property name on the target database */
  reverse_name?: string
  /** The UPG edge type this relation represents */
  upg_edge_type: string
}

/** The full property schema for a Notion database (name → definition) */
export type NotionDatabaseSchema = Record<string, NotionPropertySchema>

// ─── Notion page properties (values, not schema) ──────────────────────────────

/** A property value on a Notion page */
export interface NotionPropertyValue {
  type: NotionPropertyType
  value: unknown
}

/** The full set of property values for a Notion page */
export type NotionPageProperties = Record<string, NotionPropertyValue>

// ─── Notion database info (for discovery) ────────────────────────────────────

/** Minimal database metadata returned by the Notion API list-databases call */
export interface NotionDatabaseInfo {
  /** Notion database UUID */
  database_id: string
  /** The database title (e.g. "My Opportunities") */
  name: string
  /** The property schema of this database */
  properties: NotionPropertySchema[]
  /** Optional: parent page or workspace context */
  parent_type?: 'page_id' | 'workspace'
}

// ─── Schema generator output ─────────────────────────────────────────────────

/** A Notion database to create: one per UPG entity type */
export interface NotionDatabasePlan {
  /** UPG entity type (e.g. "opportunity") */
  entity_type: string
  /** Human-readable database name (e.g. "Opportunities") */
  database_name: string
  /** Property schema to create on this database */
  properties: NotionDatabaseSchema
  /** Relation properties: wired after all databases exist */
  relations: NotionRelationProperty[]
}

/** A Notion page to create: one per UPG node */
export interface NotionPagePlan {
  /** UPG entity type */
  entity_type: string
  /** Target database name */
  database_name: string
  /** Property values to set on the page */
  properties: NotionPageProperties
  /** The source UPG node ID */
  source_node_id: string
}

/** A relation link to populate once pages exist */
export interface NotionRelationLink {
  /** Notion page ID of the source page (after creation) */
  source_page_id: string
  /** The relation property name to populate */
  relation_property: string
  /** Notion page ID of the target page */
  target_page_id: string
  /** The UPG edge type this link represents */
  edge_type: string
}

/**
 * The full plan output from `generateNotionWorkspace()`.
 *
 * Execution order:
 *   1. Create all databases (from `databases`)
 *   2. Create all pages in their respective databases (from `pages`)
 *   3. Populate all relation properties once page IDs are known (from `relations`)
 */
export interface NotionWorkspacePlan {
  databases: NotionDatabasePlan[]
  pages: NotionPagePlan[]
  relations: NotionRelationLink[]
  warnings: string[]
}

// ─── Discovery output ─────────────────────────────────────────────────────────

/** Confidence level for a database → entity type classification */
export type ClassificationConfidence = 'high' | 'medium' | 'low' | 'unknown'

/** How the classification was arrived at */
export type ClassificationMethod = 'name' | 'properties' | 'heuristic' | 'none'

/** A suggested edge mapping derived from a Notion relation property */
export interface SuggestedEdgeMapping {
  /** The Notion relation property name (e.g. "Informs") */
  property_name: string
  /** The UPG edge type inferred (e.g. "insight_informs_opportunity") */
  inferred_edge_type: string | null
  /** Confidence in this specific edge mapping */
  confidence: ClassificationConfidence
}

/** Classification result for a single Notion database */
export interface DatabaseClassification {
  /** Notion database UUID */
  database_id: string
  /** The database title as discovered */
  database_name: string
  /** The UPG entity type inferred, or null if unresolvable */
  inferred_entity_type: string | null
  /** Confidence in the entity type match */
  confidence: ClassificationConfidence
  /** How the match was arrived at */
  matched_by: ClassificationMethod
  /** Suggested edge mappings from relation properties */
  suggested_edge_mappings: SuggestedEdgeMapping[]
  /** Warnings or ambiguities to surface to the user */
  warnings: string[]
}
