/**
 * Shortcut Adapter
 *
 * Imports entities from Shortcut (formerly Clubhouse): a project management
 * tool for software teams with a native OKR layer (Objective + Key Result)
 * on top of the delivery hierarchy (Epic → Story → Task).
 *
 * Shortcut calls its primary delivery entity a "Story", discriminated by
 * `story_type` into feature / bug / chore. This adapter maps each story_type
 * to the correct UPG entity, then walks the full strategy-to-delivery chain:
 *   Objective → Key Result → Epic → Story (feature/bug/chore) → Task
 *
 *
 * Hierarchy edges (all verified in the UPG edge catalogue):
 * - objective  → key_result     → objective_achieved_through_key_result
 * - key_result → metric         → key_result_quantified_by_metric
 * - project    → work item      → project_delivers_work_item (emitted explicitly)
 * - epic       → story (feature) → epic_specified_by_user_story
 * - story (feature) → task      → task_implements_user_story
 * - story (bug) → story (feature) → bug_affects_feature
 * - team       → any entity     → node_owned_by_team
 *
 * Gap (approximation, emitted with warning):
 * - objective → epic: no direct edge exists in UPG. Emits
 *   `initiative_drives_outcome` as an approximation and warns.
 *
 * Skipped types (no UPG equivalent):
 * - iteration (sprint / time-box delivery container)
 * - workflow   (state machine config)
 * - label      (metadata tag: folded into node tags[])
 * - comment    (collaboration thread)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'
import { isProjectWorkItemMembership, PROJECT_WORK_ITEM_EDGE } from './resolve-pair-edge.js'

// ─── Story type discriminator ─────────────────────────────────────────────────

/**
 * Maps Shortcut story_type values to UPG entity types.
 *
 * The story_type field is the CRITICAL discriminator for Story entities.
 * A feature story in Shortcut IS a UPG user_story. A bug IS a bug.
 * A chore IS a task (engineering maintenance, no user-facing capability).
 *
 * All UPG entity types verified against the live catalog.
 */
export const SHORTCUT_STORY_TYPE_MAP: Record<string, string> = {
  feature: 'user_story',
  bug: 'bug',
  chore: 'task',
}

// ─── Non-story entity type map ────────────────────────────────────────────────

/**
 * Maps Shortcut entity_type values (non-story) to UPG entity types.
 *
 * Null values mean the entity type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 */
export const SHORTCUT_ENTITY_TYPE_MAP: Record<string, string | null> = {
  story: 'user_story', // default when story_type is missing
  epic: 'epic',
  objective: 'objective',
  key_result: 'key_result',
  'key-result': 'key_result',
  team: 'team',
  project: 'project',
  document: 'document',
  milestone: 'objective', // deprecated → map to objective for consistency
  // No UPG equivalent: skip with warning
  iteration: null, // sprint / time-box delivery container
  workflow: null, // state machine config
  label: null, // metadata tag: not a standalone entity
  comment: null, // collaboration thread
  task: 'task', // sub-item within a story
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Shortcut story/epic workflow state names to UPG status values.
 *
 * Shortcut states are set per team workflow but map to three canonical
 * state types: unstarted / started / done. We also handle common custom
 * variant names teams use.
 */
export const SHORTCUT_STATUS_MAP: Record<string, string> = {
  unstarted: 'draft',
  'to do': 'draft',
  to_do: 'draft',
  upcoming: 'draft',
  'in progress': 'active',
  in_progress: 'active',
  started: 'active',
  'in development': 'active',
  'in review': 'active',
  done: 'complete',
  completed: 'complete',
  accepted: 'complete',
  cancelled: 'abandoned',
  archived: 'abandoned',
}

/**
 * Maps Shortcut Objective health_status to UPG status values.
 *
 * Shortcut surfaces health as a separate field alongside state for Objectives.
 * We map all health values to 'active' since an objective with any health
 * status is still in progress. The health nuance is preserved via tags.
 */
export const SHORTCUT_HEALTH_MAP: Record<string, string> = {
  on_track: 'active',
  at_risk: 'active',
  off_track: 'active',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Shortcut entity_type (non-story) to a UPG entity type */
export function resolveShortcutEntityType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in SHORTCUT_ENTITY_TYPE_MAP) {
    return SHORTCUT_ENTITY_TYPE_MAP[lower]
  }
  return undefined
}

/** Resolve a Shortcut story_type to a UPG entity type */
export function resolveStoryType(storyType: string): string {
  const lower = normalizeName(storyType)
  return SHORTCUT_STORY_TYPE_MAP[lower] ?? 'user_story'
}

/** Normalize a Shortcut status or health_status string to a UPG status value */
export function normalizeShortcutStatus(status: string, isHealthStatus = false): string {
  const lower = normalizeName(status)
  if (isHealthStatus) {
    return SHORTCUT_HEALTH_MAP[lower] ?? 'active'
  }
  return SHORTCUT_STATUS_MAP[lower] ?? status
}

/** Get mapping confidence for a Shortcut entity type */
export function getShortcutConfidence(
  entityType: string,
  storyType?: string,
): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)

  // Stories: confidence driven by story_type presence
  if (lower === 'story') {
    return storyType ? 'high' : 'medium'
  }

  switch (lower) {
    // Direct 1:1 canonical matches
    case 'epic':
    case 'objective':
    case 'key_result':
    case 'key-result':
    case 'team':
    case 'task':
      return 'high'
    // Strong matches with minor structural differences
    case 'project':
    case 'document':
      return 'high'
    // Deprecated type remapped to current equivalent
    case 'milestone':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Shortcut Adapter ─────────────────────────────────────────────────────────

export class ShortcutAdapter implements UPGAdapter {
  name = 'shortcut'
  label = 'Shortcut'
  description =
    'Import Objectives, Key Results, Epics, and Stories from Shortcut. Native OKR plus delivery hierarchy with story_type discriminator.'

  /**
   * List available Shortcut entities.
   *
   * Requires Shortcut API access (REST API v3, API token). This adapter is
   * designed to be called from within a skill that has access to a Shortcut
   * API connection.
   *
   * Config options:
   * - `items`: SourceItem[]: pre-fetched Shortcut entities
   * - `workspace_id` (string): specific workspace to import
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would call the Shortcut REST API v3:
    //   GET /api/v3/objectives
    //   GET /api/v3/epics
    //   GET /api/v3/stories
    //   GET /api/v3/teams
    //
    // The skill layer passes pre-fetched data via config.items when API
    // access isn't directly available from this adapter.
    throw new Error(
      'Shortcut adapter requires Shortcut API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Shortcut source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type "story" → discriminated by metadata.story_type:
   *     feature → user_story
   *     bug     → bug
   *     chore   → task
   *     missing → user_story (default, warning emitted)
   * - entity_type "epic"       → epic
   * - entity_type "objective"  → objective (status from health_status)
   * - entity_type "key_result" → key_result (current_value, target_value, unit preserved)
   * - entity_type "team"       → team
   * - entity_type "project"    → project
   * - entity_type "document"   → document
   * - entity_type "milestone"  → objective (deprecated mapping, warning emitted)
   * - entity_type "task"       → task
   * - entity_type "iteration"  → SKIPPED with warning (no UPG equivalent)
   * - entity_type "workflow"   → SKIPPED with warning (no UPG equivalent)
   * - entity_type "label"      → SKIPPED (folded into tags)
   * - entity_type "comment"    → SKIPPED (not product knowledge)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedIterations = 0

    // ── First pass: build all nodes ───────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `shortcut-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = normalizeName((meta.entity_type as string | undefined) ?? 'story')
      const storyType = meta.story_type as string | undefined

      // ── Skip types with no UPG equivalent ─────────────────────────────────

      if (entityType === 'iteration') {
        skippedIterations++
        continue
      }

      if (entityType === 'workflow') {
        warnings.push(
          `Shortcut Workflow "${item.title}" is a state machine configuration entity with no UPG ` +
            `product knowledge equivalent. Skipped.`,
        )
        continue
      }

      if (entityType === 'label') {
        warnings.push(
          `Shortcut Label "${item.title}" is a metadata tag with no UPG standalone entity equivalent. ` +
            `Labels are folded into node tags[]. Skipped as standalone entity.`,
        )
        continue
      }

      if (entityType === 'comment') {
        // Comments are collaboration threads: skip silently to avoid noise
        continue
      }

      // ── Resolve UPG entity type ────────────────────────────────────────────

      let resolvedType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (entityType === 'story') {
        // Story: discriminate by story_type
        if (!storyType) {
          warnings.push(
            `Shortcut Story "${item.title}" has no story_type field. ` +
              `Defaulting to "user_story". Set story_type to "feature", "bug", or "chore" ` +
              `for accurate mapping.`,
          )
          resolvedType = 'user_story'
          mappingConfidence = 'medium'
        } else {
          resolvedType = resolveStoryType(storyType)
          mappingConfidence = 'high'
        }
      } else {
        // Non-story entity: look up in entity type map
        const resolved = resolveShortcutEntityType(entityType)

        if (resolved === null) {
          // Explicitly unmappable: defensive catch (iteration already handled above)
          warnings.push(
            `Shortcut entity "${item.title}" (type: "${entityType}") has no UPG equivalent. Skipped.`,
          )
          continue
        }

        if (resolved === undefined) {
          warnings.push(
            `Unknown Shortcut entity type "${entityType}" for "${item.title}". ` +
              `Defaulting to "document". Update the adapter if this type should be mapped.`,
          )
          resolvedType = 'document'
          mappingConfidence = 'low'
        } else {
          resolvedType = resolved
          mappingConfidence = getShortcutConfidence(entityType, storyType)

          // Deprecated milestone → warn
          if (entityType === 'milestone') {
            warnings.push(
              `Shortcut Milestone "${item.title}" is a deprecated entity type. ` +
                `Mapping to "objective" for consistency with Shortcut's current model. ` +
                `Review if this milestone should instead be a "release".`,
            )
          }
        }
      }

      // Register in sourceMap before any continue paths below
      sourceMap[item.source_id] = nodeId

      // ── Normalise status ───────────────────────────────────────────────────

      let status: string | undefined

      const rawHealthStatus = meta.health_status as string | undefined
      const rawStatus = meta.status as string | undefined

      if (resolvedType === 'objective' && rawHealthStatus) {
        status = normalizeShortcutStatus(rawHealthStatus, true)
      } else if (rawStatus) {
        status = normalizeShortcutStatus(rawStatus)
      }

      // ── Tags from labels ───────────────────────────────────────────────────

      const tags: string[] = []
      if (Array.isArray(meta.labels)) {
        tags.push(...(meta.labels as string[]))
      }
      // Preserve health_status as a tag for objectives so the nuance isn't lost
      if (resolvedType === 'objective' && rawHealthStatus) {
        tags.push(`health:${rawHealthStatus}`)
      }

      // ── Build the UPG node ─────────────────────────────────────────────────

      const node: UPGBaseNode = {
        id: nodeId,
        type: resolvedType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'shortcut',
        external_id: item.source_id,
        // Key Result value fields: preserve numeric progress data
        ...(resolvedType === 'key_result' && meta.current_value !== undefined
          ? { current_value: meta.current_value as number }
          : {}),
        ...(resolvedType === 'key_result' && meta.target_value !== undefined
          ? { target_value: meta.target_value as number }
          : {}),
        ...(resolvedType === 'key_result' && meta.unit !== undefined
          ? { unit: meta.unit as string }
          : {}),
      }

      nodes.push(node)
    }

    // Emit iteration skip summary warning once (batch, not per-item)
    if (skippedIterations > 0) {
      warnings.push(
        `Shortcut Iterations are time-boxed sprints (delivery process containers) with no UPG ` +
          `product knowledge equivalent. ${skippedIterations} iteration${skippedIterations > 1 ? 's were' : ' was'} skipped.`,
      )
    }

    // ── Second pass: emit hierarchy edges (sourceMap is now complete) ─────────

    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = normalizeName((meta.entity_type as string | undefined) ?? 'story')
      const storyType = meta.story_type as string | undefined
      const parentId = meta.parent_id as string | undefined
      const parentType = normalizeName((meta.parent_type as string | undefined) ?? '')
      const teamId = meta.team_id as string | undefined

      // Skip items that were not registered (skipped/unmapped in first pass)
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      // ── Team ownership edge ─────────────────────────────────────────────

      if (teamId) {
        const teamNodeId = sourceMap[teamId]
        if (teamNodeId) {
          edges.push({
            id: `edge-shortcut-team-${nodeId}-${teamNodeId}`,
            source: nodeId,
            target: teamNodeId,
            type: 'node_owned_by_team' as UPGEdgeType,
            mapping_confidence: 'high',
          })
        }
      }

      // ── Hierarchy edges from parent relationship ────────────────────────

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Shortcut entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeResult = resolveShortcutEdge(
        parentType,
        entityType,
        storyType,
        item.title,
        warnings,
      )

      if (edgeResult === 'warning-only') {
        continue
      }

      if (edgeResult === null) {
        // Unrecognised parent/child pair: emit generic fallback
        edges.push({
          id: `edge-shortcut-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      // EdgeDescriptor: source/target explicitly specified (handles reversed UPG edge directions)
      if (typeof edgeResult === 'object') {
        const edgeSource = edgeResult.source === 'child' ? nodeId : parentNodeId
        const edgeTarget = edgeResult.target === 'parent' ? parentNodeId : nodeId
        edges.push({
          id: `edge-shortcut-${edgeSource}-${edgeTarget}`,
          source: edgeSource,
          target: edgeTarget,
          type: edgeResult.type as UPGEdgeType,
          mapping_confidence: 'medium',
        })
        continue
      }

      edges.push({
        id: `edge-shortcut-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeResult as UPGEdgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/** Descriptor for an edge where source/target are explicitly set (not defaulted to parent/child) */
interface EdgeDescriptor {
  type: string
  source: 'parent' | 'child' // which node is the UPG edge source
  target: 'parent' | 'child' // which node is the UPG edge target
}

/**
 * Resolve the canonical UPG edge for a Shortcut parent_type → entity_type pair.
 *
 * Returns:
 * - A UPG edge type string (most cases: source=parent, target=child)
 * - An EdgeDescriptor for edges where UPG direction differs from Shortcut parent/child order
 * - 'warning-only' for the objective→epic gap (warns but does NOT emit a direct edge)
 * - null for unrecognised pairs (caller emits node_informs_node fallback)
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveShortcutEdge(
  parentType: string,
  childEntityType: string,
  childStoryType: string | undefined,
  itemTitle: string,
  warnings: string[],
): string | EdgeDescriptor | 'warning-only' | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childEntityType)
  const childStory = childStoryType ? normalizeName(childStoryType) : undefined

  // objective → key_result
  if (parent === 'objective' && (child === 'key_result' || child === 'key-result')) {
    return 'objective_achieved_through_key_result'
  }

  // key_result → metric
  if ((parent === 'key_result' || parent === 'key-result') && child === 'metric') {
    return 'key_result_quantified_by_metric'
  }

  // project → work item (epic, story of any story_type, task)
  // Emitted EXPLICITLY, and it has to stay that way. `project_delivers_work_item` is
  // flagged `deliberate_only` in the catalogue AND its target widened to the `node`
  // wildcard in 0.33.0, so every generic-inference chokepoint (resolvePairEdge,
  // resolveContainmentEdgeInferrable) returns null for the pair: nothing should
  // derive project membership from mere co-occurrence. Shortcut's parent_id on an
  // Epic or Story is not co-occurrence, it is an authored fact the source system
  // itself stores, so carrying it across is faithful, not inferred. The allowlist
  // in isProjectWorkItemMembership() is narrower than the catalogue's `node` target
  // on purpose, so a project parent holding a document or objective is NOT swept in.
  // Do NOT "tidy" this onto the generic resolver: the edge would silently vanish.
  if (parent === 'project') {
    const childUpgType =
      child === 'story'
        ? ((childStory ? SHORTCUT_STORY_TYPE_MAP[childStory] : undefined) ?? 'user_story')
        : SHORTCUT_ENTITY_TYPE_MAP[child]
    if (childUpgType && isProjectWorkItemMembership('project', childUpgType)) {
      return PROJECT_WORK_ITEM_EDGE
    }
  }

  // epic → story (feature) → user_story
  if (parent === 'epic' && child === 'story') {
    const resolvedStoryType = childStory ? SHORTCUT_STORY_TYPE_MAP[childStory] : 'user_story'

    if (!childStory || resolvedStoryType === 'user_story') {
      return 'epic_specified_by_user_story'
    }

    // epic → story (bug): no canonical epic→bug edge; use node_informs_node fallback
    if (resolvedStoryType === 'bug') {
      return null
    }

    // epic → story (chore / task): no canonical epic→task edge; fallback
    return null
  }

  // story (feature) → task: task_implements_user_story
  // parent is a feature story, child is a task
  if (parent === 'story' && child === 'task') {
    return 'task_implements_user_story'
  }

  // story (bug) → story (feature): bug_affects_feature
  // In Shortcut: bug's parent_id points to the feature story.
  // UPG edge direction: source=bug, target=feature.
  // Shortcut parent/child order: parent=feature, child=bug: reversed from UPG.
  if (parent === 'story' && child === 'story' && childStory === 'bug') {
    return { type: 'bug_affects_feature', source: 'child', target: 'parent' }
  }

  // objective → epic: THE GAP
  // No direct objective→epic edge exists in the UPG catalogue.
  // The canonical path runs through initiative. Emit approximation with warning.
  if (parent === 'objective' && child === 'epic') {
    warnings.push(
      `Shortcut Objective→Epic relationship for "${itemTitle}": no direct objective→epic edge ` +
        `in UPG catalog. Emitting \`initiative_drives_outcome\` as an approximation. ` +
        `Consider adding an \`initiative\` node between them.`,
    )
    return 'initiative_drives_outcome'
  }

  // team → any entity
  if (parent === 'team') {
    return 'node_owned_by_team'
  }

  // Unrecognised pair
  return null
}
