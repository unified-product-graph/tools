/**
 * Structural type definitions for the parser.
 * `type` and `id` are plain strings; concrete type validation happens at
 * resolution time.
 */

// ─── Frontmatter ──────────────────────────────────────────────────────────────

/** Required frontmatter fields for a .upg.md document */
export interface UPGMarkdownFrontmatter {
  /** Human-readable document title */
  title: string

  /** Product slug this document belongs to */
  upg_product: string

  /** UPG spec version this document targets */
  upg_version: string

  /** Must be 'document' */
  entity_type: 'document'

  /** Stable unique identifier for this document entity */
  entity_id: string

  /** Who created this document */
  author?: string

  /** ISO 8601 date of creation */
  created_at?: string

  /** ISO 8601 date of last update */
  updated_at?: string

  /** Freeform categorisation tags */
  tags?: string[]

  /** Document lifecycle status */
  status?: 'draft' | 'review' | 'published' | 'archived'

  /** Which composition pattern this follows */
  composition_pattern?: string

  /** Relative path to the .upg file this document resolves against */
  graph_source?: string

  /** Additional frontmatter fields (preserved, not validated) */
  [key: string]: unknown
}

// ─── References ───────────────────────────────────────────────────────────────

/** An inline property attached to an entity reference */
export interface InlineProperty {
  key: string
  value: string
}

/** A parsed entity reference: [[type:id]], [[type:id|props]], [[+type:id]], [[type:id@product]] */
export interface EntityReference {
  /** Entity type (e.g. 'persona', 'need', 'hypothesis') */
  type: string

  /** Entity ID (e.g. 'alex-senior-pm', 'no-single-source-of-truth') */
  id: string

  /** Product slug for cross-product references (e.g. 'other-product') */
  product?: string

  /** Whether this is a creation reference ([[+type:id]]) */
  isCreation: boolean

  /** Inline properties (key:value pairs from the | modifiers) */
  properties: InlineProperty[]

  /** Display text override (quoted string from the | modifiers) */
  displayText?: string

  /** Line number in the source document (1-based) */
  line: number

  /** Column offset in the source line (0-based) */
  column: number

  /** The full raw match string (e.g. '[[persona:alex-senior-pm|"Alex"]]') */
  raw: string
}

/** A parsed edge reference: {{source → target|verb}} */
export interface EdgeReference {
  /** Source entity */
  source: { type: string; id: string; product?: string }

  /** Target entity */
  target: { type: string; id: string; product?: string }

  /** Relationship verb (e.g. 'informs', 'pursues', 'produces') */
  verb: string

  /** Line number in the source document (1-based) */
  line: number

  /** Column offset in the source line (0-based) */
  column: number

  /** The full raw match string */
  raw: string
}

// ─── Parse Result ─────────────────────────────────────────────────────────────

/** The complete result of parsing a .upg.md file */
export interface ParseResult {
  /** Parsed and validated frontmatter */
  frontmatter: UPGMarkdownFrontmatter

  /** The markdown body (everything after the frontmatter) */
  body: string

  /** All entity references found in the body */
  entityRefs: EntityReference[]

  /** All edge references found in the body */
  edgeRefs: EdgeReference[]

  /** Parse warnings (non-fatal issues) */
  warnings: ParseWarning[]

  /** Parse errors (fatal issues that invalidate the document) */
  errors: ParseError[]
}

export interface ParseWarning {
  /** Warning code for programmatic handling */
  code: WarningCode

  /** Human-readable message */
  message: string

  /** Line number where the warning occurred */
  line: number
}

export interface ParseError {
  /** Error code for programmatic handling */
  code: ErrorCode

  /** Human-readable message */
  message: string

  /** Line number where the error occurred */
  line?: number
}

export type WarningCode =
  | 'UNCLOSED_ENTITY_REF'
  | 'UNCLOSED_EDGE_REF'
  | 'MULTILINE_EXCEEDS_LIMIT'
  | 'UNKNOWN_MODIFIER_FORMAT'
  | 'CROSS_PRODUCT_REF'

export type ErrorCode =
  | 'MISSING_FRONTMATTER'
  | 'INVALID_FRONTMATTER_YAML'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_ENTITY_TYPE'
  | 'INVALID_ENTITY_ID'
  | 'NESTED_REFERENCE'
  | 'INVALID_EDGE_FORMAT'

// ─── Reference Index ──────────────────────────────────────────────────────────

/** A unique entity referenced in the document (deduplicated) */
export interface IndexEntry {
  /** Entity type */
  type: string

  /** Entity ID */
  id: string

  /** Product slug for cross-product references */
  product?: string

  /** Canonical key: 'type:id' or 'type:id@product' for cross-product refs */
  key: string

  /** Whether any reference to this entity is a creation reference */
  isCreation: boolean

  /** All line numbers where this entity is referenced */
  lines: number[]

  /** Number of times referenced */
  count: number
}

/** The reference index for a document */
export interface ReferenceIndex {
  /** All unique entities referenced (keyed by 'type:id') */
  entities: Map<string, IndexEntry>

  /** All unique edge triples referenced */
  edges: Array<{
    source: string  // 'type:id'
    target: string  // 'type:id'
    verb: string
    lines: number[]
  }>

  /** Total entity reference count (including duplicates) */
  totalEntityRefs: number

  /** Total edge reference count (including duplicates) */
  totalEdgeRefs: number

  /** Entities that are creation references */
  creationRefs: string[]  // 'type:id' keys
}

// ─── Transclusion ─────────────────────────────────────────────────────────────

/**
 * A transclusion edge: the document embeds this node's live value at the point
 * in its prose where the anchor sits.
 *
 * Deliberately carries NO position. A line number is the most volatile value a
 * text document has, since every insertion above moves every anchor below, so a
 * stored line is wrong after the next paragraph and nothing reports the drift.
 * Occurrence lines live on IndexEntry, where editing the prose re-derives them.
 */
export interface TransclusionEdge {
  /** The catalog edge type. Always 'document_transcludes_node'. */
  type: 'document_transcludes_node'

  /** The containing document, identified by its frontmatter entity_id */
  source: string

  /** The target node, as the caller's resolver identified it */
  target: string

  /** The anchor key this edge was keyed on ('type:id') */
  anchor: string
}

/** Why a referenced entity produced no transclusion edge */
export type TransclusionSkipReason =
  /** The frontmatter entity_type is not 'document', so there is no valid source */
  | 'source_not_a_document'
  /** The frontmatter is a document but carries no entity_id to source the edge on */
  | 'source_missing_entity_id'
  /** Reached the index only via a {{a -> b|verb}} edge ref, never as an inline anchor */
  | 'not_an_anchor'
  /** [[type:id@product]]: names another graph, which this edge cannot cross */
  | 'cross_product_anchor'
  /** The resolver found no such node, so an edge would dangle */
  | 'unresolved_anchor'

/** A referenced entity that did not become an edge, and why */
export interface SkippedAnchor {
  /** Canonical key: 'type:id' or 'type:id@product' */
  key: string

  /** Why no edge was written */
  reason: TransclusionSkipReason

  /** Whether the anchor was a creation anchor ([[+type:id]]) */
  isCreation: boolean
}

/** Options for transclusion edge emission */
export interface TransclusionOptions {
  /**
   * Resolve an anchor key ('type:id') to the target's identity in the graph.
   * Return null when the graph holds no such node.
   *
   * Required, and not optional like the validate() lookups: an edge may only be
   * written to a node the caller has actually resolved, so with no resolver
   * there is nothing an emitter could honestly emit.
   */
  resolveTarget: (key: string) => string | null | Promise<string | null>
}

/** The result of emitting transclusion edges for one document */
export interface TransclusionResult {
  /** The edges to write, one per (document, node) pair */
  edges: TransclusionEdge[]

  /** Every referenced entity that produced no edge, with its reason */
  skipped: SkippedAnchor[]
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Options for reference validation against a graph */
export interface ValidationOptions {
  /** Set of valid entity types. Optional; when omitted, type validation is skipped */
  validTypes?: ReadonlySet<string>

  /** Set of valid edge verbs. Optional; when omitted, verb validation is skipped */
  validVerbs?: ReadonlySet<string>

  /** Lookup function: given 'type:id', returns true if the entity exists */
  entityExists?: (key: string) => boolean | Promise<boolean>

  /** Lookup function: given source, target, verb, returns true if the edge exists */
  edgeExists?: (source: string, target: string, verb: string) => boolean | Promise<boolean>
}

export interface ValidationResult {
  /** Whether all references resolve */
  valid: boolean

  /** References that don't resolve */
  staleRefs: Array<{ key: string; line: number; reason: 'not_found' | 'type_mismatch' | 'unknown_type' | 'unknown_verb' }>

  /** References that resolved successfully */
  resolvedCount: number

  /** References that couldn't be checked (no lookup function provided) */
  skippedCount: number
}
