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
import { getLifecycleForType } from '@unified-product-graph/core'
import {
  resolveContainmentEdgeInferrable,
  isProjectWorkItemMembership,
  PROJECT_WORK_ITEM_EDGE,
} from './resolve-pair-edge.js'
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
  // 0.32.0: `planning_cycle` has existed since 0.20.0 and this line was stale
  // for eleven releases. It now maps, and issues link to it via
  // planning_cycle_schedules_work_item.
  cycle: 'planning_cycle',
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
 * - "Backlog" → backlog (0.32.0: WORK_ITEM gained the phase. Before it existed
 *   this mapped to `proposed`, which is not a WORK_ITEM phase, so
 *   resolveLinearStatusForType omitted it — and Backlog is typically the single
 *   largest group on a real board. Measured on a 1,032-issue corpus: 183 issues
 *   imported with no status at all.)
 * - "Triage" → open where the target lifecycle has it (INCIDENT: bug), falling
 *   back to `backlog`. Triage and backlog are DIFFERENT buckets and were
 *   previously collapsed onto one word.
 * - "In Progress" / "Started" → in_progress
 * - "In Review" / "Review" / "QA" → in_review (0.32.0: the normaliser had no
 *   review branch, so "In Review" fell through as the literal string "in review"
 *   and was dropped as invalid.)
 * - "Done" / "Completed" → done
 * - "Cancelled" / "Canceled" → cancelled (Linear's default states use the
 *   US spelling; the spec phase id is `cancelled`)
 * - "Duplicate" → cancelled (0.32.0: the WORK_ITEM `cancelled` description
 *   names duplicate explicitly. Previously dropped.)
 *
 * The raw label always survives regardless, on `workflow_state`.
 */
export function normalizeLinearStatus(state: string): string {
  const lower = state.toLowerCase().trim()
  // Map to real UPG delivery-lifecycle phase ids; resolveLinearStatusForType()
  // then keeps only those valid for the target type's lifecycle.
  // Order matters: the more specific states are tested before the substrings
  // that would swallow them ("in review" contains neither "progress" nor
  // "done", but "ready for review" would match a naive review check late).
  if (lower === 'triage' || lower.includes('triage')) return 'triage'
  if (lower === 'backlog' || lower.includes('backlog')) return 'backlog'
  if (lower === 'in review' || lower === 'review' || lower.includes('review') || lower === 'qa') return 'in_review'
  if (lower === 'in progress' || lower === 'started' || lower.includes('progress') || lower.includes('started')) return 'in_progress'
  if (lower === 'done' || lower === 'completed' || lower.includes('done') || lower.includes('complet')) return 'done'
  if (lower === 'duplicate' || lower.includes('duplicate')) return 'cancelled'
  if (lower === 'cancelled' || lower === 'canceled' || lower.includes('cancel')) return 'cancelled'
  if (lower === 'todo' || lower === 'to do' || lower.includes('todo')) return 'todo'
  return lower
}

/**
 * Per-lifecycle stand-ins for the cancel family. `cancelled` is the canonical
 * phase id (WORK_ITEM family: task, epic, deliverable, …), but lifecycles that
 * predate it spell their won't-do off-ramp differently — try those in order so
 * a Linear "Canceled" still lands on the closest valid phase (feature →
 * archived, bug → closed, investigation → abandoned).
 */
const CANCEL_FALLBACKS = ['archived', 'closed', 'wont_fix', 'abandoned'] as const

/**
 * Per-lifecycle stand-ins for the triage family (0.32.0). INCIDENT names `open`
 * and `triaged`; WORK_ITEM names neither and takes `backlog`, which is the
 * honest landing spot for un-accepted work.
 */
const TRIAGE_FALLBACKS = ['open', 'triaged', 'backlog', 'proposed'] as const

/**
 * Linear's priority is an INTEGER 0-4; UPG's `Priority` is a string enum.
 *
 * Before 0.32.0 the adapter wrote the raw integer straight into the string
 * slot — a live type violation on every issue that carried a priority, which on
 * a measured corpus was 958 of 1,032. The mapping itself is 1:1 and always was;
 * only the translation was missing.
 *
 * Linear: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
 * `0` is a REAL value, not an absence — a deliberate "no priority" — so it maps
 * to the enum's explicit `none` rather than being dropped.
 */
export function mapLinearPriority(raw: unknown): string | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n)) {
    // Already a valid enum string (a caller that pre-mapped): pass it through.
    if (typeof raw === 'string' && ['urgent', 'high', 'medium', 'low', 'none'].includes(raw)) return raw
    return undefined
  }
  switch (n) {
    case 0: return 'none'
    case 1: return 'urgent'
    case 2: return 'high'
    case 3: return 'medium'
    case 4: return 'low'
    default: return undefined
  }
}

/**
 * The six-bucket category of a resolved phase, for the dual-band pair.
 *
 * `workflow_state` keeps the source's raw label; this gives a consumer the
 * canonical bucket to reason over without promoting that label to `status`.
 * Narrowed to `StatusCategory` in the spec at 0.32.0, so an unmapped phase
 * yields undefined rather than a free string.
 */
function statusCategoryFor(upgType: string, phaseId: string | undefined): string | undefined {
  if (!phaseId) return undefined
  const lc = getLifecycleForType(upgType)
  if (!lc) return undefined
  for (const p of lc.phases) {
    if (p.id === phaseId) return p.status_category
    for (const st of p.core_states ?? []) if (st.id === phaseId) return p.status_category
  }
  return undefined
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
  if (valid.has(normalised)) return normalised
  if (normalised === 'cancelled') {
    for (const alias of CANCEL_FALLBACKS) if (valid.has(alias)) return alias
  }
  // Triage is a real bucket but only some lifecycles name a phase for it
  // (INCIDENT gives `bug` open/triaged). WORK_ITEM deliberately has no triage
  // phase — a task nobody has accepted is a task in `backlog` — so a source
  // "Triage" lands there rather than being dropped.
  if (normalised === 'triage') {
    for (const alias of TRIAGE_FALLBACKS) if (valid.has(alias)) return alias
  }
  // A review state on a lifecycle with no review phase is still in flight.
  if (normalised === 'in_review' && valid.has('in_progress')) return 'in_progress'
  return undefined
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
          metadata: { entity_kind: 'cycle', status: cycle.completedAt ? 'completed' : cycle.startsAt && new Date(cycle.startsAt) <= new Date() ? 'active' : 'future', team_id: team.id, starts_at: cycle.startsAt ?? undefined, ends_at: cycle.endsAt ?? undefined, number: cycle.number },
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
          // An issue's CYCLE was being reported as its milestone_id, which then
          // resolved to a project_targets_milestone edge or to nothing. They are
          // different axes: a cycle is a time-box, a milestone is a gate.
          cycle_id: cycle ? `cycle-${cycle.id}` : undefined,
          estimate: issue.estimate ?? undefined,
          priority: issue.priority,
          identifier: issue.identifier ?? undefined,
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
   * - entity_type "cycle"      → planning_cycle (0.32.0; was SKIPPED)
   *
   * Parent-child hierarchy edges: resolved via catalogue-aware resolver.
   * Cross-domain edges: emitted when metadata relation IDs are present.
   *
   * Status normalisation: see `normalizeLinearStatus` for the mapping table and
   * `resolveLinearStatusForType` for the per-lifecycle validation. The raw
   * source label always survives on `workflow_state` regardless of how it maps,
   * which is what makes the round trip lossless rather than merely successful.
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

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

      // ── Cycle: a real entity since spec 0.20.0 ───────────────────────────
      // This branch used to skip every cycle with a warning that they were
      // "outside UPG scope". `planning_cycle` shipped at 0.20.0 and the line was
      // stale for eleven releases; at 0.32.0 the scheduling edge widened past
      // `user_story`, so a cycle can finally hold the `task` that tracker
      // imports actually produce. Cycles now import as nodes and issues link to
      // them. Handled inline below rather than here.

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

      // ── Cycle lifecycle: Linear's own three states map 1:1 ───────────────
      // planned -> active -> closed is the planning_cycle lifecycle, and
      // list() already computes future/active/completed from the dates.
      const cycleStatus =
        resolvedType === 'planning_cycle'
          ? ({ completed: 'closed', active: 'active', future: 'planned' } as Record<string, string>)[
              String(meta.status ?? '')
            ]
          : undefined

      // ── Tags from labels ─────────────────────────────────────────────────
      const labels = (meta.labels as string[] | undefined) ?? []

      // ── Properties ───────────────────────────────────────────────────────
      // Four fixes at 0.32.0. Three of these were UNDECLARED properties — the
      // adapter was inventing schema — and all three now have declared homes
      // that this release created or already had.
      const properties: Record<string, unknown> = {}
      // `priority` was declared but written as Linear's raw integer 0-4 into a
      // string enum: a live type violation on every issue that had one.
      if (resolvedType === 'planning_cycle') {
        // `cadence_kind` is REQUIRED, and a Linear Cycle is an execution box
        // rather than a coarse period or a buffer. `cadence_label` keeps what
        // the team calls it — the same dual-band idea as workflow_state.
        properties.cadence_kind = 'iteration'
        properties.cadence_label = 'cycle'
        if (meta.starts_at) properties.starts_on = meta.starts_at
        if (meta.ends_at) properties.ends_on = meta.ends_at
        if (meta.number !== undefined) properties.sequence = meta.number
      }
      const priority = mapLinearPriority(meta.priority)
      if (priority) properties.priority = priority
      // `estimate` was undeclared on every target type — it was removed from
      // `task` at 0.14.0 in favour of `effort`, the family-uniform name. Linear
      // points are numeric, `effort` is a string by design ("3 points", "2d"),
      // so the unit travels with the number instead of being guessed later.
      if (meta.estimate !== undefined) properties.effort = `${meta.estimate} points`
      if (meta.due_date) properties.due_date = meta.due_date
      // The raw workflow state always survives, even when it mapped cleanly:
      // that is what the dual-band pair is for, and it is what makes a
      // round-trip lossless rather than merely successful.
      if (rawState) {
        properties.workflow_state = rawState
        const bucket = statusCategoryFor(resolvedType, status)
        if (bucket) properties.workflow_state_category = bucket
      }
      // `linear_identifier` was undeclared and vendor-namespaced. The citable
      // key is now a base-node field, so it lands there — see the node build.
      // `cycle_id` was an undeclared stringly-typed stand-in for the edge that
      // did not exist; it is now a real planning_cycle_schedules_work_item edge,
      // deferred below. Neither survives as a property.

      // ── Build node ────────────────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: resolvedType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(labels.length > 0 ? { tags: labels } : {}),
        ...(cycleStatus ? { status: cycleStatus } : status ? { status } : {}),
        // The externally-cited key (ENG-123). It survives the import verbatim
        // because the corpus cites it from outside the tracker — repo docs,
        // commit messages, other issues — and renumbering would silently break
        // every one of those references.
        ...(meta.identifier ? { key: meta.identifier as string } : {}),
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
        // A Linear project holding a work item. Emitted EXPLICITLY because the
        // resolver above cannot produce it: `project_delivers_work_item` is
        // `deliberate_only` AND its catalogue target widened to the `node` wildcard
        // in 0.33.0, so `project:<work item>` is not a pair-map key at all. A Linear
        // project membership is an authored fact the source system stores, not
        // co-occurrence. This is the relation the 0.33.0 widening was built for:
        // without it a project parent silently degrades to node_informs_node and the
        // memberships strand, exactly as they did on properties.linear_project_id.
        // Consulted only after the resolver declines, so project -> milestone keeps
        // project_targets_milestone. See isProjectWorkItemMembership() for the full
        // why. Do NOT "tidy" this back onto the resolver: the edge silently vanishes.
        const edgeType =
          resolveContainmentEdgeInferrable(parentType, resolvedType) ??
          (isProjectWorkItemMembership(parentType, resolvedType)
            ? PROJECT_WORK_ITEM_EDGE
            : 'node_informs_node')
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

      // planning_cycle → work item (0.32.0)
      // Was an undeclared `cycle_id` string on the node: a stand-in for the edge
      // that did not exist. Direction matters — the cycle SCHEDULES the item, so
      // the cycle is the source, and the item keeps its feature/epic parent.
      const cycleSourceId = meta.cycle_id as string | undefined
      if (cycleSourceId && resolvedType !== 'planning_cycle') {
        deferredEdges.push({
          fromSourceId: cycleSourceId,
          toSourceId: item.source_id,
          edgeType: 'planning_cycle_schedules_work_item' as UPGEdgeType,
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

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
