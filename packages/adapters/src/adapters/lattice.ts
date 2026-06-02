/**
 * Lattice Adapter
 *
 * Imports OKR and people-management entities from Lattice: a people management
 * + OKR platform where Goals cascade from company → department → individual.
 *
 * Lattice's UPG story is concentrated in the Strategy region:
 * - Goals (Objectives) and Key Results form the OKR hierarchy
 * - Initiatives drive goal achievement
 * - Teams and Departments provide organisational structure
 * - Performance Reviews surface organisational signals
 *
 *
 * Hierarchy edges (all verified in the UPG edge catalogue):
 * - objective → key_result    → objective_achieved_through_key_result
 * - initiative → outcome      → initiative_drives_outcome
 * - team → team_okr           → team_targets_team_okr (for team-level goals)
 * - team_okr → objective      → team_okr_aligns_with_objective (cascade alignment)
 *
 * Skipped types (no UPG equivalent):
 * - update    : goal progress update, operational
 * - competency: HR skill framework definition
 * - praise    : social recognition message
 * - one_on_one: meeting record
 */

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Lattice entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 */
export const LATTICE_TYPE_MAP: Record<string, string | null> = {
  goal: 'objective',              // OKR goal (company/team/individual level)
  key_result: 'key_result',
  initiative: 'initiative',
  review: 'observation',          // performance review cycle result
  update: null,                    // goal progress update: operational, skip
  department: 'team',
  team: 'team',
  individual_goal: 'objective',  // individual-level goal: still an objective
  competency: null,               // skill competency: HR domain, skip
  praise: null,                    // social recognition: skip
  survey: 'customer_feedback',   // engagement survey
  one_on_one: null,              // meeting record: skip
}

// ─── Status normalisation ─────────────────────────────────────────────────────

export const LATTICE_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  on_track: 'active',
  at_risk: 'active',
  behind: 'active',
  complete: 'complete',
  abandoned: 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Lattice entity_type to a UPG entity type */
export function resolveLatticeType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in LATTICE_TYPE_MAP) {
    return LATTICE_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Lattice status string to a UPG status value */
export function normalizeLatticeStatus(status: string): string {
  const lower = normalizeName(status)
  return LATTICE_STATUS_MAP[lower] ?? status
}

/** Resolve mapping confidence for a Lattice entity type */
export function getLatticeConfidence(
  entityType: string,
  level?: string,
): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'key_result':
    case 'initiative':
    case 'team':
    case 'department':
      return 'high'
    case 'goal':
      // Individual-level goals have slightly lower confidence: they're objectives
      // but don't naturally sit at the top of the UPG strategy hierarchy
      return level === 'individual' ? 'medium' : 'high'
    case 'individual_goal':
      return 'medium'
    case 'review':
    case 'survey':
      return 'medium'
    default:
      return 'low'
  }
}

/** Check if an edge type is in the UPG catalogue; fall back to node_informs_node if not */
function safeEdgeType(
  candidate: string,
  fallbackWarning: string,
  warnings: string[],
): UPGEdgeType {
  const edgeSet = new Set(UPG_EDGE_TYPES)
  if (edgeSet.has(candidate as UPGEdgeType)) {
    return candidate as UPGEdgeType
  }
  warnings.push(fallbackWarning)
  return 'node_informs_node' as UPGEdgeType
}

// ─── Lattice Adapter ──────────────────────────────────────────────────────────

export class LatticeAdapter implements UPGAdapter {
  name = 'lattice'
  label = 'Lattice'
  description =
    'Import goals (as objectives), key results, initiatives, performance reviews (as observations), engagement surveys (as customer_feedback), and teams/departments from Lattice.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Lattice adapter requires Lattice API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Lattice source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type "goal"           → objective (status normalised; individual level emits warning)
   * - entity_type "key_result"     → key_result (current_value, target_value, unit preserved)
   * - entity_type "initiative"     → initiative
   * - entity_type "review"         → observation (performance review signal)
   * - entity_type "department"     → team
   * - entity_type "team"           → team
   * - entity_type "individual_goal"→ objective (individual level, warning emitted)
   * - entity_type "survey"         → customer_feedback (engagement survey)
   * - entity_type "update"         → SKIPPED (goal progress update, operational)
   * - entity_type "competency"     → SKIPPED (HR skill framework, no UPG equivalent)
   * - entity_type "praise"         → SKIPPED (social recognition, no UPG equivalent)
   * - entity_type "one_on_one"     → SKIPPED (meeting record, not product knowledge)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedHR = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `lattice-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const level = meta.level as string | undefined

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveLatticeType(entityType)

      // Explicitly unmappable types: skip
      if (resolved === null) {
        // HR / operational types: batch count
        if (
          entityType === 'update' ||
          entityType === 'competency' ||
          entityType === 'praise' ||
          entityType === 'one_on_one'
        ) {
          skippedHR++
        } else {
          warnings.push(
            `Lattice entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Lattice entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getLatticeConfidence(entityType, level)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Individual goal warning ────────────────────────────────────────────
      if (level === 'individual' && (entityType === 'goal' || entityType === 'individual_goal')) {
        warnings.push(
          `Lattice individual goal "${item.title}" mapped to objective. Individual OKRs connect ` +
            `to team objectives via team_okr_aligns_with_objective. ` +
            `Consider linking to the parent team goal.`,
        )
      }

      // ── Status normalisation ───────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeLatticeStatus(rawStatus) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve the level as a tag so hierarchy nuance isn't lost
      if (level) {
        tags.push(`level:${level}`)
      }

      // ── Preserve metric values on key_result nodes ─────────────────────────
      const currentValue = meta.current_value as number | undefined
      const targetValue = meta.target_value as number | undefined
      const unit = meta.unit as string | undefined
      const progressPercent = meta.progress_percent as number | undefined

      // ── Build the UPG node ─────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: upgEntityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'lattice',
        external_id: item.source_id,
        // Key Result / goal metric value fields: preserve numeric progress data
        ...(upgEntityType === 'key_result' && currentValue !== undefined
          ? { current_value: currentValue }
          : {}),
        ...(upgEntityType === 'key_result' && targetValue !== undefined
          ? { target_value: targetValue }
          : {}),
        ...(upgEntityType === 'key_result' && unit !== undefined
          ? { unit }
          : {}),
        ...(progressPercent !== undefined
          ? { progress_percent: progressPercent }
          : {}),
      }

      nodes.push(node)
    }

    // Aggregate warning for skipped HR/operational entities
    if (skippedHR > 0) {
      warnings.push(
        `${skippedHR} Lattice HR or operational entit${skippedHR > 1 ? 'ies' : 'y'} skipped (updates, competencies, praise, 1:1s). People-management layer has no UPG product knowledge equivalent.`,
      )
    }

    // ── Pass 2: emit hierarchy edges (sourceMap is now complete) ──────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''
      const level = meta.level as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Lattice entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeResult = resolveLatticeEdge(
        parentType,
        entityType,
        level,
        item.title,
        warnings,
        (candidate, msg) => safeEdgeType(candidate, msg, warnings),
      )

      if (edgeResult === null) {
        // Unrecognised pair: emit generic fallback
        edges.push({
          id: `edge-lattice-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-lattice-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeResult,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedHR === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Lattice parent_type → entity_type pair.
 *
 * Returns:
 * - A UPGEdgeType string for the edge to emit
 * - null for unrecognised pairs (caller emits node_informs_node fallback)
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveLatticeEdge(
  parentType: string,
  childType: string,
  level: string | undefined,
  itemTitle: string,
  warnings: string[],
  safe: (candidate: string, msg: string) => UPGEdgeType,
): UPGEdgeType | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // objective → key_result
  if ((parent === 'goal' || parent === 'objective' || parent === 'individual_goal') &&
      child === 'key_result') {
    return safe(
      'objective_achieved_through_key_result',
      `Lattice: objective_achieved_through_key_result not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
    )
  }

  // initiative → goal/outcome: initiative_drives_outcome
  if (child === 'initiative' &&
      (parent === 'goal' || parent === 'objective' || parent === 'key_result')) {
    return safe(
      'initiative_drives_outcome',
      `Lattice: initiative_drives_outcome not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
    )
  }

  // team → team-level goal: team_targets_team_okr
  // This edge connects a team to a team-level OKR. Applies when parent is a team
  // and child is a team-level goal.
  if ((parent === 'team' || parent === 'department') &&
      (child === 'goal' || child === 'individual_goal') &&
      (level === 'team' || level === 'department')) {
    return safe(
      'team_targets_team_okr',
      `Lattice: team_targets_team_okr not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
    )
  }

  // team goal → company objective: team_okr_aligns_with_objective
  // When a team-level goal has a company goal as parent
  if ((child === 'goal' || child === 'individual_goal') &&
      (parent === 'goal' || parent === 'objective')) {
    warnings.push(
      `Lattice goal cascade for "${itemTitle}": emitting team_okr_aligns_with_objective. ` +
        `The child goal aligns upward to the parent objective via the cascade hierarchy.`,
    )
    return safe(
      'team_okr_aligns_with_objective',
      `Lattice: team_okr_aligns_with_objective not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
    )
  }

  // Unrecognised pair
  return null
}
