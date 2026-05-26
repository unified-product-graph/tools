/**
 * Notion Discovery: Notion workspace → UPG classification
 *
 * Given a list of Notion databases (from the API), classifies each one
 * against the UPG entity type catalog. The output is a DatabaseClassification
 * array that the caller uses to:
 *   1. Confirm/correct with the user (via buildConfirmationPrompt)
 *   2. Drive the import adapter (NotionAdapter.convert)
 *
 * Classification algorithm:
 *   1. Exact name match against DATABASE_TYPE_MAP (high confidence)
 *   2. Plural/singular normalisation (medium confidence)
 *   3. Property analysis heuristics (medium/low confidence)
 *   4. Unknown: flag for user review (unknown confidence)
 *
 * Relation property names are also classified against RELATION_EDGE_MAP
 * to produce suggested edge mappings.
 *
 */

import {
  DATABASE_TYPE_MAP,
  CONFIDENCE_MAP,
  RELATION_EDGE_MAP,
  inferTypeFromDatabase,
  getConfidenceForName,
} from './notion.js'
import type {
  ClassificationConfidence,
  ClassificationMethod,
  DatabaseClassification,
  NotionDatabaseInfo,
  NotionPropertySchema,
  SuggestedEdgeMapping,
} from './notion-types.js'

// ─── Property heuristics ──────────────────────────────────────────────────────

/**
 * Each heuristic is a set of property names that, when present together,
 * suggest a particular UPG entity type. Keys are property name patterns
 * (case-insensitive substring match).
 *
 * These run when name-based matching fails or returns low confidence.
 */
const PROPERTY_HEURISTICS: Array<{
  /** Property name patterns that must ALL be present (case-insensitive substring) */
  required: string[]
  /** Optional additional signals (any match boosts confidence) */
  optional?: string[]
  inferred_entity_type: string
  confidence: 'medium' | 'low'
  reason: string
}> = [
  {
    required: ['hypothesis', 'method', 'result'],
    inferred_entity_type: 'experiment',
    confidence: 'medium',
    reason: 'Hypothesis + Method + Result: experiment pattern',
  },
  {
    required: ['current value', 'target value'],
    optional: ['owner', 'unit', 'direction'],
    inferred_entity_type: 'metric',
    confidence: 'medium',
    reason: 'Current Value + Target Value: metric pattern',
  },
  {
    required: ['current value', 'target'],
    inferred_entity_type: 'key_result',
    confidence: 'low',
    reason: 'Current Value + Target: key_result or metric pattern',
  },
  {
    required: ['pain', 'gain', 'job'],
    inferred_entity_type: 'persona',
    confidence: 'medium',
    reason: 'Pain + Gain + Job: persona canvas pattern',
  },
  {
    required: ['frustrations', 'goals'],
    optional: ['job title', 'primary job'],
    inferred_entity_type: 'persona',
    confidence: 'medium',
    reason: 'Frustrations + Goals: persona pattern',
  },
  {
    required: ['assignee', 'priority', 'due date'],
    optional: ['status'],
    inferred_entity_type: 'task',
    confidence: 'medium',
    reason: 'Assignee + Priority + Due Date: task pattern',
  },
  {
    required: ['priority', 'status', 'assignee'],
    inferred_entity_type: 'story_statement',
    confidence: 'low',
    reason: 'Priority + Status + Assignee: task or story pattern',
  },
  {
    required: ['severity', 'reporter', 'steps to reproduce'],
    inferred_entity_type: 'bug',
    confidence: 'medium',
    reason: 'Severity + Reporter + Steps to Reproduce: bug pattern',
  },
  {
    required: ['severity', 'assignee'],
    optional: ['reporter'],
    inferred_entity_type: 'bug',
    confidence: 'low',
    reason: 'Severity + Assignee: potential bug tracker',
  },
  {
    required: ['participant', 'method', 'date'],
    optional: ['researcher', 'insights'],
    inferred_entity_type: 'research_study',
    confidence: 'medium',
    reason: 'Participant + Method + Date: research study pattern',
  },
  {
    required: ['rationale', 'decision date'],
    inferred_entity_type: 'decision',
    confidence: 'medium',
    reason: 'Rationale + Decision Date: decision log pattern',
  },
  {
    required: ['risk level', 'validation status'],
    inferred_entity_type: 'assumption',
    confidence: 'medium',
    reason: 'Risk Level + Validation Status: assumption pattern',
  },
  {
    required: ['source', 'category'],
    optional: ['opportunity', 'insight'],
    inferred_entity_type: 'insight',
    confidence: 'low',
    reason: 'Source + Category: insight or observation pattern',
  },
  {
    required: ['strengths', 'weaknesses'],
    optional: ['url', 'pricing'],
    inferred_entity_type: 'competitor',
    confidence: 'medium',
    reason: 'Strengths + Weaknesses: competitor analysis pattern',
  },
  {
    required: ['start date', 'end date', 'owner'],
    optional: ['milestones', 'budget'],
    inferred_entity_type: 'project',
    confidence: 'low',
    reason: 'Start Date + End Date + Owner: project or initiative pattern',
  },
  {
    required: ['release date', 'version'],
    inferred_entity_type: 'release',
    confidence: 'medium',
    reason: 'Release Date + Version: release pattern',
  },
  {
    required: ['votes', 'source'],
    optional: ['status', 'linked feature'],
    inferred_entity_type: 'feature_request',
    confidence: 'medium',
    reason: 'Votes + Source: feature request tracker pattern',
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePropertyName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Check if a set of property names satisfies a heuristic's required pattern.
 * Uses case-insensitive substring matching to handle slight naming variations.
 */
function matchesHeuristic(
  propertyNames: string[],
  required: string[],
  optional?: string[],
): boolean {
  const normalised = propertyNames.map(normalizePropertyName)

  // All required patterns must match (substring)
  const allRequiredMatch = required.every((req) =>
    normalised.some((prop) => prop.includes(req.toLowerCase())),
  )
  if (!allRequiredMatch) return false

  // If optional patterns are provided, at least one must match
  if (optional && optional.length > 0) {
    const anyOptionalMatch = optional.some((opt) =>
      normalised.some((prop) => prop.includes(opt.toLowerCase())),
    )
    // Optional signals boost confidence but don't gate the match
    return anyOptionalMatch || required.length >= 2
  }

  return true
}

/**
 * Classify relation properties on a database against RELATION_EDGE_MAP.
 * Returns suggested edge mappings for each relation property found.
 */
function classifyRelationProperties(
  properties: NotionPropertySchema[],
): SuggestedEdgeMapping[] {
  const suggestions: SuggestedEdgeMapping[] = []

  for (const prop of properties) {
    if (prop.type !== 'relation') continue

    const lower = normalizePropertyName(prop.name)
    const edgeType = RELATION_EDGE_MAP[lower] ?? null

    if (edgeType) {
      suggestions.push({
        property_name: prop.name,
        inferred_edge_type: edgeType,
        confidence: 'medium',
      })
    } else {
      // Unknown relation: flag it for user review
      suggestions.push({
        property_name: prop.name,
        inferred_edge_type: null,
        confidence: 'unknown',
      })
    }
  }

  return suggestions
}

// ─── Single database classification ──────────────────────────────────────────

/**
 * Classify a single Notion database by name and property analysis.
 *
 * Classification priority:
 *   1. Exact name match in DATABASE_TYPE_MAP (high or medium from CONFIDENCE_MAP)
 *   2. Plural/singular normalisation (inherits map confidence, capped at medium)
 *   3. Property heuristic analysis (medium or low)
 *   4. Unknown: returned as-is with confidence 'unknown'
 */
export function classifyDatabase(
  name: string,
  properties: NotionPropertySchema[],
): Omit<DatabaseClassification, 'database_id'> {
  const warnings: string[] = []
  const propertyNames = properties.map((p) => p.name)
  const lower = name.toLowerCase().trim()

  // ── Step 1: Exact name match ─────────────────────────────────────────────
  if (lower in DATABASE_TYPE_MAP) {
    const mapped = DATABASE_TYPE_MAP[lower]

    if (mapped === null) {
      // Explicitly unmappable (sprint/cycle/backlog)
      warnings.push(
        `"${name}" is a delivery-layer construct (sprint/cycle/backlog) with no UPG equivalent. ` +
          `UPG tracks product knowledge, separate from iteration boundaries. These items are skipped.`,
      )
      return {
        database_name: name,
        inferred_entity_type: null,
        confidence: 'unknown',
        matched_by: 'name',
        suggested_edge_mappings: classifyRelationProperties(properties),
        warnings,
      }
    }

    const nameConfidence = CONFIDENCE_MAP[lower] ?? 'medium'
    return {
      database_name: name,
      inferred_entity_type: mapped,
      confidence: nameConfidence,
      matched_by: 'name',
      suggested_edge_mappings: classifyRelationProperties(properties),
      warnings,
    }
  }

  // ── Step 2: Plural/singular normalisation ─────────────────────────────────
  const inferred = inferTypeFromDatabase(name)
  if (inferred !== null) {
    const nameConfidence = getConfidenceForName(name)
    // Normalised matches are capped at 'medium': the name wasn't exact
    const confidence: ClassificationConfidence =
      nameConfidence === 'high' ? 'medium' : nameConfidence
    return {
      database_name: name,
      inferred_entity_type: inferred,
      confidence,
      matched_by: 'name',
      suggested_edge_mappings: classifyRelationProperties(properties),
      warnings,
    }
  }

  // ── Step 3: Property heuristic analysis ──────────────────────────────────
  if (properties.length > 0) {
    for (const heuristic of PROPERTY_HEURISTICS) {
      if (matchesHeuristic(propertyNames, heuristic.required, heuristic.optional)) {
        warnings.push(
          `"${name}" was classified as "${heuristic.inferred_entity_type}" by property analysis ` +
            `(${heuristic.reason}). Verify this is correct before importing.`,
        )
        return {
          database_name: name,
          inferred_entity_type: heuristic.inferred_entity_type,
          confidence: heuristic.confidence,
          matched_by: 'properties',
          suggested_edge_mappings: classifyRelationProperties(properties),
          warnings,
        }
      }
    }
  }

  // ── Step 4: Unknown: flag for user review ────────────────────────────────
  warnings.push(
    `"${name}" could not be classified as a UPG entity type. ` +
      `It will be skipped unless you assign it a type manually. ` +
      `Consider renaming it to a canonical name (e.g. "Opportunities", "Insights", "Tasks").`,
  )

  return {
    database_name: name,
    inferred_entity_type: null,
    confidence: 'unknown',
    matched_by: 'none',
    suggested_edge_mappings: classifyRelationProperties(properties),
    warnings,
  }
}

// ─── Batch classification ─────────────────────────────────────────────────────

/**
 * Classify a list of Notion databases from a workspace discovery call.
 * Returns one DatabaseClassification per database.
 */
export function classifyDatabases(databases: NotionDatabaseInfo[]): DatabaseClassification[] {
  return databases.map((db) => {
    const classification = classifyDatabase(db.name, db.properties)
    return {
      database_id: db.database_id,
      ...classification,
    }
  })
}

// ─── Confirmation prompt builder ──────────────────────────────────────────────

/**
 * Given a list of DatabaseClassification results, returns a human-readable
 * confirmation prompt for the user to review before import begins.
 *
 * The prompt lists:
 * - High-confidence mappings (will be imported automatically)
 * - Medium/low-confidence mappings (user should verify)
 * - Unknown mappings (will be skipped unless the user assigns a type)
 * - Suggested edge mappings from relation properties
 */
export function buildConfirmationPrompt(classifications: DatabaseClassification[]): string {
  const lines: string[] = [
    'UPG Notion Discovery: Workspace Classification',
    '='.repeat(50),
    '',
  ]

  const high = classifications.filter((c) => c.confidence === 'high')
  const medium = classifications.filter((c) => c.confidence === 'medium')
  const low = classifications.filter((c) => c.confidence === 'low')
  const unknown = classifications.filter((c) => c.confidence === 'unknown')

  if (high.length > 0) {
    lines.push(`HIGH CONFIDENCE (${high.length}): will import automatically.`)
    for (const c of high) {
      lines.push(`  "${c.database_name}" → ${c.inferred_entity_type}`)
      if (c.suggested_edge_mappings.length > 0) {
        const mapped = c.suggested_edge_mappings.filter((e) => e.inferred_edge_type !== null)
        const unmapped = c.suggested_edge_mappings.filter((e) => e.inferred_edge_type === null)
        if (mapped.length > 0) {
          lines.push(`    Relations: ${mapped.map((e) => `"${e.property_name}" → ${e.inferred_edge_type}`).join(', ')}`)
        }
        if (unmapped.length > 0) {
          lines.push(`    Unknown relations (skipped): ${unmapped.map((e) => `"${e.property_name}"`).join(', ')}`)
        }
      }
    }
    lines.push('')
  }

  if (medium.length > 0) {
    lines.push(`MEDIUM CONFIDENCE (${medium.length}): please verify.`)
    for (const c of medium) {
      const method = c.matched_by === 'properties' ? ' [by property analysis]' : ''
      lines.push(`  "${c.database_name}" → ${c.inferred_entity_type}${method}`)
      if (c.warnings.length > 0) {
        for (const w of c.warnings) {
          lines.push(`    Note: ${w}`)
        }
      }
    }
    lines.push('')
  }

  if (low.length > 0) {
    lines.push(`LOW CONFIDENCE (${low.length}): verify before importing.`)
    for (const c of low) {
      lines.push(`  "${c.database_name}" → ${c.inferred_entity_type ?? 'none'} [low confidence]`)
      if (c.warnings.length > 0) {
        for (const w of c.warnings) {
          lines.push(`    Note: ${w}`)
        }
      }
    }
    lines.push('')
  }

  if (unknown.length > 0) {
    lines.push(`UNKNOWN (${unknown.length}): will be skipped.`)
    for (const c of unknown) {
      lines.push(`  "${c.database_name}": could not be classified`)
      if (c.warnings.length > 0) {
        lines.push(`    ${c.warnings[0]}`)
      }
    }
    lines.push('')
  }

  lines.push(`Total: ${classifications.length} databases, ${high.length} auto-import, ${medium.length + low.length} to verify, ${unknown.length} skipped`)

  return lines.join('\n')
}
