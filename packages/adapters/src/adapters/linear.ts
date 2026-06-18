/**
 * Linear Adapter
 *
 * Imports projects, issues, milestones, documents, and initiatives from
 * Linear via the Linear MCP. Cycles have no UPG equivalent and are skipped
 * with a warning.
 *
 * Mapping:
 * - Project    → project
 * - Issue      → feature | bug | task | user_story | epic
 *                (discriminated via metadata.issue_type: Linear's issueType.name)
 * - Milestone  → milestone
 * - Document   → document
 * - Initiative → initiative
 * - Cycle      → SKIPPED (no UPG equivalent)
 *
 * Linear's hierarchy: Team > Project > Issue > Sub-issue
 * maps to UPG: team > project > feature/bug/task/user_story/epic
 *
 * Cross-domain edges emitted (when metadata is present):
 * - project → initiative    (project_implements_initiative)
 * - project → milestone     (project_targets_milestone)
 * - epic    → user_story (epic_specified_by_user_story)
 * - task    → user_story (task_implements_user_story)
 * - node    → team           (node_owned_by_team)
 * - bug     → feature        (bug_affects_feature, when parent is a feature)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolveContainmentEdge, getLifecycleForType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Issue type map (discriminated by issueType.name from Linear API) ─────────

/**
 * Maps Linear issue type names (from issueType.name) to UPG entity types.
 * These are the canonical discriminators from the Linear API.
 */
const LINEAR_ISSUE_TYPE_MAP: Record<string, string> = {
  feature: 'feature',
  bug: 'bug',
  chore: 'task',
  story: 'user_story',
  epic: 'epic',
  // Default value used when issue_type is absent or unrecognised
  default: 'task',
}

/**
 * Maps Linear entity types (non-issue) to UPG entity types.
 * Null values indicate entities with no UPG equivalent: they are skipped.
 */
const LINEAR_ENTITY_TYPE_MAP: Record<string, string | null> = {
  project: 'project',
  milestone: 'milestone',
  document: 'document',
  cycle: null, // No UPG equivalent: emit warning and skip
  initiative: 'initiative',
}

// ─── Status normalisation ──────────────────────────────────────────────────────

/**
 * Normalises Linear workflow state names to UPG status values.
 *
 * Linear states are freeform strings set by each team: we match by
 * lowercase substring to handle common naming variants.
 *
 * Spec normalisation:
 * - "Backlog" / "Triage" → draft
 * - "Todo" / "In Progress" → active
 * - "Done" / "Completed" → complete
 * - "Cancelled" → abandoned
 */
export function normalizeLinearStatus(state: string): string {
  const lower = state.toLowerCase().trim()
  // Map to real UPG delivery-lifecycle phase ids; resolveLinearStatusForType()
  // then keeps only those valid for the target type's lifecycle.
  if (lower === 'backlog' || lower === 'triage' || lower.includes('backlog') || lower.includes('triage')) return 'proposed'
  if (lower === 'in progress' || lower === 'started' || lower.includes('progress') || lower.includes('started')) return 'in_progress'
  if (lower === 'done' || lower === 'completed' || lower.includes('done') || lower.includes('complet')) return 'done'
  if (lower === 'cancelled' || lower === 'canceled' || lower.includes('cancel')) return 'archived'
  if (lower === 'todo' || lower === 'to do' || lower.includes('todo')) return 'todo'
  return lower
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
 * Resolve a Linear workflow state to a status valid for the target type's
 * lifecycle. Tries the raw state, then the generic normalisation, and omits
 * anything that does not fit rather than persisting an invalid status.
 */
function resolveLinearStatusForType(rawState: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = rawState.toLowerCase().trim()
  if (valid.has(raw)) return raw
  const normalised = normalizeLinearStatus(rawState)
  return valid.has(normalised) ? normalised : undefined
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the UPG entity type for a Linear issue.
 *
 * Precedence:
 * 1. metadata.issue_type: the canonical discriminator (issueType.name from Linear API)
 * 2. metadata.labels: fallback for legacy ingestion paths
 * 3. Default to "task"
 */
function resolveIssueEntityType(meta: Record<string, unknown>): string {
  const issueType = meta.issue_type as string | undefined
  if (issueType) {
    const lower = issueType.toLowerCase().trim()
    return LINEAR_ISSUE_TYPE_MAP[lower] ?? LINEAR_ISSUE_TYPE_MAP.default
  }
  // Fallback: label-based inference for pre-fetchers that don't carry issue_type
  const labels = (meta.labels as string[] | undefined) ?? []
  const lowerLabels = labels.map((l) => l.toLowerCase())
  if (lowerLabels.some((l) => ['bug', 'defect', 'fix'].includes(l))) return 'bug'
  if (lowerLabels.some((l) => ['feature', 'enhancement', 'feat'].includes(l))) return 'feature'
  if (lowerLabels.some((l) => ['epic'].includes(l))) return 'epic'
  if (lowerLabels.some((l) => ['story', 'user story'].includes(l))) return 'user_story'
  if (lowerLabels.some((l) => ['tech debt', 'refactor', 'chore'].includes(l))) return 'task'
  return LINEAR_ISSUE_TYPE_MAP.default
}

// ─── Linear Adapter ───────────────────────────────────────────────────────────

export class LinearAdapter implements UPGAdapter {
  name = 'linear'
  label = 'Linear'
  description = 'Import projects, issues, milestones, and initiatives from Linear via the Linear MCP'

  /**
   * List available Linear items.
   *
   * Requires Linear MCP tools (mcp__linear-server__*) to be available in the
   * current session. This adapter is designed to be called from within a skill
   * that has access to Linear MCP tools.
   *
   * Config options:
   * - `team_id` (string): Linear team to import from
   * - `project_id` (string): specific project to import
   * - `include_completed` (boolean): whether to include done issues (default: false)
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const { LinearClient } = await import('@linear/sdk')
    const apiKey = config.api_key as string
    if (!apiKey) throw new Error('Linear adapter requires config.api_key (LINEAR_API_KEY)')

    const client = new LinearClient({ apiKey })
    const items: SourceItem[] = []

    // Teams
    const teams = await client.teams()
    const teamNodes = teams.nodes

    // Projects (all accessible)
    const projects = await client.projects({ first: 250 })
    for (const project of projects.nodes) {
      items.push({
        source_id: `project-${project.id}`,
        source_type: 'project',
        title: project.name,
        content: project.description ?? undefined,
        metadata: { entity_kind: 'project', status: project.state },
      })
    }

    // Cycles per team
    for (const team of teamNodes) {
      const cycles = await client.cycles({ filter: { team: { id: { eq: team.id } } } })
      for (const cycle of cycles.nodes) {
        items.push({
          source_id: `cycle-${cycle.id}`,
          source_type: 'cycle',
          title: cycle.name ?? `Cycle ${cycle.number}`,
          metadata: { entity_kind: 'cycle', status: cycle.completedAt ? 'completed' : cycle.startsAt && new Date(cycle.startsAt) <= new Date() ? 'active' : 'future', team_id: team.id },
        })
      }
    }

    // Issues
    const issues = await client.issues({ first: 250 })
    for (const issue of issues.nodes) {
      const state = await issue.state
      const labelConn = await issue.labels()
      const labels = labelConn?.nodes?.map((l) => l.name) ?? []
      const parent = await issue.parent
      const project = await issue.project
      const cycle = await issue.cycle

      items.push({
        source_id: `issue-${issue.id}`,
        source_type: 'issue',
        title: issue.title,
        content: issue.description ?? undefined,
        metadata: {
          entity_kind: 'issue',
          issue_type: undefined,   // discriminated by labels
          labels,
          status: state?.name ?? 'Backlog',
          parent_id: parent ? `issue-${parent.id}` : undefined,
          project_id: project ? `project-${project.id}` : undefined,
          milestone_id: cycle ? `cycle-${cycle.id}` : undefined,
          estimate: issue.estimate ?? undefined,
          priority: issue.priority,
        },
      })
    }

    return items
  }

  /**
   * Convert Linear source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type "project"    → project
   * - entity_type "issue"      → feature | bug | task | user_story | epic
   *                              (discriminated by metadata.issue_type)
   * - entity_type "milestone"  → milestone
   * - entity_type "document"   → document
   * - entity_type "initiative" → initiative
   * - entity_type "cycle"      → SKIPPED with warning
   *
   * Parent-child hierarchy edges: resolved via catalogue-aware resolver.
   * Cross-domain edges: emitted when metadata relation IDs are present.
   *
   * Status normalisation:
   * - "Backlog" / "Triage"       → draft
   * - "Todo" / "In Progress"     → active
   * - "Done" / "Completed"       → complete
   * - "Cancelled"                → abandoned
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedCycles = 0

    // Deferred cross-domain edges: resolved after all nodes are built so
    // source IDs referenced in metadata can be looked up in sourceMap.
    const deferredEdges: Array<{
      fromSourceId: string
      toSourceId: string
      edgeType: UPGEdgeType
    }> = []

    const processItem = (item: SourceItem, parentId: string | null): void => {
      const meta = item.metadata ?? {}
      const entityType = meta.entity_type as string | undefined

      // ── Cycle: skip with warning ─────────────────────────────────────────
      if (
        item.source_type === 'cycle' ||
        entityType === 'cycle'
      ) {
        skippedCycles++
        warnings.push(
          `"${item.title}" is a Linear Cycle. Cycles are ` +
            `delivery-layer sprint constructs outside UPG scope. Skipped.`,
        )
        return
      }

      counter++
      const nodeId = `linear-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      // ── Resolve UPG entity type ───────────────────────────────────────────
      let resolvedType: string
      let mappingConfidence: 'high' | 'medium' | 'low' = 'medium'

      if (
        item.source_type === 'issue' ||
        entityType === 'issue'
      ) {
        resolvedType = resolveIssueEntityType(meta)
        // High confidence when discriminated by explicit issue_type, low when label-inferred
        mappingConfidence = meta.issue_type ? 'high' : 'medium'
      } else {
        // Non-issue entity types
        const sourceTypeKey = entityType ?? item.source_type
        const mapped = LINEAR_ENTITY_TYPE_MAP[sourceTypeKey]
        if (mapped === undefined) {
          warnings.push(
            `Unknown Linear entity type "${sourceTypeKey}" for "${item.title}". Defaulting to "document".`,
          )
          resolvedType = 'document'
          mappingConfidence = 'low'
        } else if (mapped === null) {
          // Should have been caught by cycle check above; defensive fallback
          warnings.push(
            `Linear entity type "${sourceTypeKey}" for "${item.title}" skipped: no UPG equivalent.`,
          )
          return
        } else {
          resolvedType = mapped
          mappingConfidence = 'high'
        }
      }

      // ── Status normalisation (validated against the target lifecycle) ─────
      // list() populates metadata.status (the workflow state name); accept
      // metadata.state too for callers that use it.
      const rawState = (meta.status ?? meta.state) as string | undefined
      const status = rawState ? resolveLinearStatusForType(rawState, resolvedType) : undefined

      // ── Tags from labels ─────────────────────────────────────────────────
      const labels = (meta.labels as string[] | undefined) ?? []

      // ── Properties ───────────────────────────────────────────────────────
      const properties: Record<string, unknown> = {}
      if (meta.priority !== undefined) properties.priority = meta.priority
      if (meta.estimate !== undefined) properties.estimate = meta.estimate
      if (meta.identifier) properties.linear_identifier = meta.identifier
      if (meta.due_date) properties.due_date = meta.due_date
      if (meta.cycle_id) properties.cycle_id = meta.cycle_id

      // ── Build node ────────────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: resolvedType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(labels.length > 0 ? { tags: labels } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'linear',
        external_id: item.source_id,
        ...(meta.url ? { external_ref: meta.url as string } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      }

      nodes.push(node)

      // ── Parent-child containment edge ─────────────────────────────────────
      if (parentId) {
        const parentNode = nodes.find((n) => n.id === parentId)
        const parentType = parentNode?.type ?? 'project'
        const edgeType = resolveContainmentEdge(parentType, resolvedType) ?? 'node_informs_node'
        edges.push({
          id: `edge-${parentId}-${nodeId}`,
          source: parentId,
          target: nodeId,
          type: edgeType,
          mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'medium',
        })
      }

      // ── Defer cross-domain edges from metadata relation IDs ───────────────
      // project → initiative
      const initiativeId = meta.initiative_id as string | undefined
      if (resolvedType === 'project' && initiativeId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: initiativeId,
          edgeType: 'project_implements_initiative' as UPGEdgeType,
        })
      }

      // project → milestone
      const projectMilestoneId = meta.milestone_id as string | undefined
      if (resolvedType === 'project' && projectMilestoneId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: projectMilestoneId,
          edgeType: 'project_targets_milestone' as UPGEdgeType,
        })
      }

      // epic → user_story
      const parentSourceId = meta.parent_id as string | undefined
      if (resolvedType === 'user_story' && parentSourceId) {
        // The parent may be an epic: we defer and check once all nodes exist
        deferredEdges.push({
          fromSourceId: parentSourceId,
          toSourceId: item.source_id,
          edgeType: 'epic_specified_by_user_story' as UPGEdgeType,
        })
      }

      // task → user_story (when a task has a parent story)
      if (resolvedType === 'task' && parentSourceId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: parentSourceId,
          edgeType: 'task_implements_user_story' as UPGEdgeType,
        })
      }

      // node → team (ownership)
      const teamId = meta.team_id as string | undefined
      if (teamId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: teamId,
          edgeType: 'node_owned_by_team' as UPGEdgeType,
        })
      }

      // bug → feature (when parent_id resolves to a feature node)
      if (resolvedType === 'bug' && parentSourceId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: parentSourceId,
          edgeType: 'bug_affects_feature' as UPGEdgeType,
        })
      }

      // ── Recurse into children ─────────────────────────────────────────────
      for (const child of item.children ?? []) {
        processItem(child, nodeId)
      }
    }

    for (const item of items) {
      processItem(item, null)
    }

    // ── Resolve deferred cross-domain edges ───────────────────────────────────
    // Processed after all nodes are built so sourceMap is complete.
    for (const { fromSourceId, toSourceId, edgeType } of deferredEdges) {
      const fromNodeId = sourceMap[fromSourceId]
      const toNodeId = sourceMap[toSourceId]

      if (!fromNodeId || !toNodeId) {
        // Target may be a team/initiative that wasn't in the import batch: skip silently
        continue
      }

      // Validate edge type makes sense for the resolved node types.
      // For bug_affects_feature: only emit if the target node IS a feature.
      if (edgeType === 'bug_affects_feature') {
        const targetNode = nodes.find((n) => n.id === toNodeId)
        if (targetNode?.type !== 'feature') continue
      }

      // For epic_specified_by_user_story: only emit if the source IS an epic.
      if (edgeType === 'epic_specified_by_user_story') {
        const sourceNode = nodes.find((n) => n.id === fromNodeId)
        if (sourceNode?.type !== 'epic') continue
      }

      // For task_implements_user_story: only emit if the target IS a user_story.
      if (edgeType === 'task_implements_user_story') {
        const targetNode = nodes.find((n) => n.id === toNodeId)
        if (targetNode?.type !== 'user_story') continue
      }

      const edgeId = `edge-xdomain-${fromNodeId}-${toNodeId}`
      // Avoid duplicate edges (e.g. a bug's parent-child edge + bug_affects_feature edge)
      if (edges.some((e) => e.id === edgeId)) continue

      edges.push({
        id: edgeId,
        source: fromNodeId,
        target: toNodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (skippedCycles > 0) {
      warnings.push(
        `${skippedCycles} Linear Cycle${skippedCycles > 1 ? 's were' : ' was'} not exported. ` +
          `Cycles are sprint-layer constructs with no UPG equivalent.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
