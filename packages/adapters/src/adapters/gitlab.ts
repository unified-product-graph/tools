/**
 * GitLab Adapter
 *
 * Imports issues, epics, milestones, groups, and projects from GitLab.
 * Merge Requests and CI/CD Pipelines are explicitly skipped with warnings :
 * they are engineering collaboration objects below UPG's scope.
 *
 * Mapping:
 * - Issue (label-discriminated) → bug | user_story | epic | task
 * - Issue (issue_type=incident) → incident
 * - Epic (native GitLab Epic) → epic
 * - Milestone                  → release
 * - Group (top-level)          → product
 * - Subgroup                   → feature_area
 * - Project                    → project
 * - Merge Request              → SKIPPED (code-review artifact)
 * - Pipeline                   → SKIPPED (operational infrastructure)
 *
 * Cross-domain edges emitted (when metadata is present):
 * - product → feature_area           (product_organises_into_feature_area)
 * - product → project                (product_organises_into_feature_area, approximation)
 * - project → epic                   (project_delivers_epic)
 * - epic → child epic                (feature_decomposed_into_epic)
 * - epic → user_story/task/bug  (epic_specified_by_user_story)
 * - release → user_story/task   (release_contains_feature)
 * - release → bug                    (release_contains_bug)
 *
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Issue label → UPG entity type ───────────────────────────────────────────

/**
 * Maps GitLab issue label values (lowercased) to UPG entity types.
 *
 * Checked in priority order inside inferIssueType: the first matching
 * label wins. Order here does NOT define priority; precedence is defined
 * in inferIssueType itself.
 */
export const GITLAB_ISSUE_LABEL_MAP: Record<string, string> = {
  // Bug labels
  bug: 'bug',
  defect: 'bug',
  fix: 'bug',
  // Feature / story labels
  feature: 'user_story',
  enhancement: 'user_story',
  'feature request': 'user_story',
  // Epic label (label-based convention; overridden if using native GitLab Epics)
  epic: 'epic',
  // Task / chore labels
  task: 'task',
  chore: 'task',
  'tech debt': 'task',
  'tech-debt': 'task',
  maintenance: 'task',
  documentation: 'task',
}

// ─── Non-issue entity type map ────────────────────────────────────────────────

/**
 * Maps GitLab non-issue entity types to UPG entity types.
 * Null values indicate entities that should be skipped with a warning.
 */
export const GITLAB_ENTITY_TYPE_MAP: Record<string, string | null> = {
  issue: 'task',             // default for issues without matching labels
  epic: 'epic',              // GitLab native Epic
  milestone: 'release',
  project: 'project',
  group: 'product',          // top-level group
  subgroup: 'feature_area',
  merge_request: null,       // skip with warning
  pipeline: null,            // skip: operational
  deployment: null,          // skip: operational
  snippet: null,             // skip
  label: null,               // metadata only
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps GitLab state/status strings to UPG status values.
 *
 * GitLab issue/epic states: opened | closed | reopened
 * GitLab milestone states: active | closed
 */
export const GITLAB_STATUS_MAP: Record<string, string> = {
  opened: 'active',
  open: 'active',
  reopened: 'active',
  closed: 'complete',
  merged: 'complete',
  active: 'active',     // milestone state
  upcoming: 'draft',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Infer UPG entity type from a GitLab issue's labels and issue_type.
 *
 * Precedence:
 * 1. issue_type == 'incident' (highest priority: platform-level type)
 * 2. Bug labels
 * 3. Feature / story labels → user_story
 * 4. Epic label
 * 5. Task / chore / tech-debt labels
 * 6. Default: task (unlabelled issues are tasks)
 */
export function inferIssueType(labels: string[], issueType?: string): string {
  if (issueType === 'incident') return 'incident'

  const lower = labels.map((l) => l.toLowerCase().trim())

  // Bug labels: highest label priority
  const bugLabels = new Set(['bug', 'defect', 'fix'])
  if (lower.some((l) => bugLabels.has(l))) return 'bug'

  // Feature / story labels
  const featureLabels = new Set(['feature', 'enhancement', 'feature request'])
  if (lower.some((l) => featureLabels.has(l))) return 'user_story'

  // Epic label
  if (lower.includes('epic')) return 'epic'

  // Task / chore / tech-debt labels
  const taskLabels = new Set(['task', 'chore', 'tech debt', 'tech-debt', 'maintenance', 'documentation'])
  if (lower.some((l) => taskLabels.has(l))) return 'task'

  return 'task' // default: unlabelled issues are delivery tasks
}

/** Map GitLab state string to UPG status */
function mapGitLabState(state: string): string {
  return GITLAB_STATUS_MAP[state.toLowerCase()] ?? state.toLowerCase()
}

// ─── GitLab Adapter ───────────────────────────────────────────────────────────

export class GitLabAdapter implements UPGAdapter {
  name = 'gitlab'
  label = 'GitLab'
  description =
    'Import issues, epics, milestones, groups, and projects from GitLab. Native Epics plus label-based issue typing.'

  /**
   * List available GitLab items.
   *
   * Requires GitLab API access or a GitLab MCP connection.
   *
   * Config options:
   * - `group_id` (string): GitLab group/namespace ID
   * - `project_id` (string): GitLab project ID
   * - `state`: 'opened' | 'closed' | 'all': filter by state
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    // In a real implementation, this would call:
    //   GET /groups/:id/epics
    //   GET /projects/:id/issues
    //   GET /projects/:id/milestones
    //   GET /groups/:id
    //   GET /groups/:id/subgroups
    //
    // The skill layer passes pre-fetched data via config.items when
    // tools aren't directly callable from this adapter.
    throw new Error(
      'GitLab adapter requires GitLab API access or MCP connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert GitLab source items to UPG entities.
   *
   * Processing order (three-pass):
   * Pass 1: Create milestone/release and group/project nodes first so issues
   *           and epics can reference them by source_id.
   * Pass 2: Create epics, then issues and remaining nodes; defer cross-domain edges.
   * Pass 3: Resolve deferred cross-domain edges after all nodes are built.
   *
   * Mapping logic:
   * - entity_type "issue"        → bug | user_story | epic | task | incident
   * - entity_type "epic"         → epic (native GitLab Epic)
   * - entity_type "milestone"    → release
   * - entity_type "group"        → product
   * - entity_type "subgroup"     → feature_area
   * - entity_type "project"      → project
   * - entity_type "merge_request"→ SKIPPED with warning
   * - entity_type "pipeline"     → SKIPPED with warning
   * - Labels → tags on issue nodes (type-indicator labels filtered out)
   * - Issue state → UPG status (opened → active, closed → complete)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedMRs = 0
    let skippedPipelines = 0

    // Deferred cross-domain edges: resolved after all nodes are built
    const deferredEdges: Array<{
      fromSourceId: string
      toSourceId: string
      edgeType: UPGEdgeType
    }> = []

    // ── Pass 1: milestone/release, group, subgroup, project nodes ─────────────
    // These are referenced by epics and issues via milestone_id, group_id, etc.
    const pass1Types = new Set(['milestone', 'group', 'subgroup', 'project'])

    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type
      if (!pass1Types.has(entityType)) continue

      const mapped = GITLAB_ENTITY_TYPE_MAP[entityType]
      if (mapped === null || mapped === undefined) continue

      counter++
      const nodeId = `gl-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      const node: UPGBaseNode = {
        id: nodeId,
        type: mapped as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: 'high',
        external_tool: 'gitlab',
        external_id: item.source_id,
        ...(meta.web_url ? { external_url: meta.web_url as string } : {}),
        properties: {
          ...(meta.due_date ? { due_date: meta.due_date } : {}),
          ...(meta.start_date ? { start_date: meta.start_date } : {}),
          ...(meta.state ? { state: meta.state } : {}),
          ...(meta.full_path ? { full_path: meta.full_path } : {}),
          ...(meta.namespace ? { namespace: meta.namespace } : {}),
        },
      }

      nodes.push(node)

      // Group → project/subgroup edges will be deferred in pass 2 when the
      // child items are processed. For now, just register groups in sourceMap.

      // Subgroup → parent group edge (subgroup has parent group in metadata)
      if (entityType === 'subgroup') {
        const parentGroupId = meta.group_id as string | undefined
        if (parentGroupId) {
          deferredEdges.push({
            fromSourceId: parentGroupId,
            toSourceId: item.source_id,
            edgeType: 'product_organises_into_feature_area' as UPGEdgeType,
          })
        }
      }

      // Project → parent group edge
      if (entityType === 'project') {
        const parentGroupId = meta.group_id as string | undefined
        if (parentGroupId) {
          deferredEdges.push({
            fromSourceId: parentGroupId,
            toSourceId: item.source_id,
            edgeType: 'product_organises_into_feature_area' as UPGEdgeType,
          })
        }
      }
    }

    // ── Pass 2: epics first (issues can reference them), then all remaining ────
    // We do a two-sub-pass: epics first so epic→issue edges resolve correctly.

    const pass2EpicItems = items.filter((item) => {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type
      return entityType === 'epic'
    })

    const pass2OtherItems = items.filter((item) => {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type
      return !pass1Types.has(entityType) && entityType !== 'epic'
    })

    for (const item of [...pass2EpicItems, ...pass2OtherItems]) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type

      // Merge requests: skip with warning (counted: message emitted at end)
      if (entityType === 'merge_request') {
        skippedMRs++
        continue
      }

      // Pipelines: skip with warning
      if (entityType === 'pipeline') {
        skippedPipelines++
        continue
      }

      // Skip other null-mapped types silently (deployment, snippet, label)
      const nullMapped = GITLAB_ENTITY_TYPE_MAP[entityType]
      if (nullMapped === null) {
        warnings.push(`"${item.title}" (${entityType}) skipped: no UPG equivalent.`)
        continue
      }

      // Resolve UPG entity type
      let resolvedType: string
      let mappingConfidence: 'high' | 'medium' | 'low' = 'high'

      if (entityType === 'issue') {
        const labels = (meta.labels as string[] | undefined) ?? []
        const issueType = meta.issue_type as string | undefined
        resolvedType = inferIssueType(labels, issueType)
        // Incidents have high confidence (platform type); others depend on labels
        if (issueType === 'incident') {
          mappingConfidence = 'high'
        } else {
          mappingConfidence = labels.length > 0 ? 'high' : 'low'
        }

        // Warn for issues defaulted to task due to no matching label
        if (resolvedType === 'task' && labels.length > 0 && issueType !== 'incident') {
          const lowerLabels = labels.map((l) => l.toLowerCase().trim())
          const hasMatchingLabel = lowerLabels.some((l) => l in GITLAB_ISSUE_LABEL_MAP)
          if (!hasMatchingLabel) {
            warnings.push(
              `GitLab issue '${item.title}' defaulted to 'task': no matching type label. ` +
                `Add labels like 'feature', 'bug', or 'enhancement' for accurate UPG mapping.`,
            )
          }
        }
      } else if (entityType === 'epic') {
        resolvedType = 'epic'
        mappingConfidence = 'high'
      } else if (nullMapped !== undefined) {
        resolvedType = nullMapped
      } else {
        warnings.push(
          `Unknown GitLab entity type "${entityType}" for "${item.title}". Defaulting to "document".`,
        )
        resolvedType = 'document'
        mappingConfidence = 'low'
      }

      counter++
      const nodeId = `gl-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      // ── Issue-specific processing ─────────────────────────────────────────
      const isIssue = entityType === 'issue'
      const isEpic = entityType === 'epic'
      const labels = isIssue ? ((meta.labels as string[] | undefined) ?? []) : []
      const status =
        isIssue || isEpic
          ? mapGitLabState((meta.status as string) ?? (meta.state as string) ?? 'opened')
          : undefined

      // Filter type-indicator labels from tags
      const typeIndicatorLabels = new Set([
        'bug', 'defect', 'fix',
        'feature', 'enhancement', 'feature request',
        'epic',
        'task', 'chore', 'tech debt', 'tech-debt', 'maintenance', 'documentation',
      ])
      const tags = isIssue
        ? labels.filter((l) => !typeIndicatorLabels.has(l.toLowerCase().trim()))
        : []

      // ── Properties ─────────────────────────────────────────────────────────
      const properties: Record<string, unknown> = {}
      if (meta.iid !== undefined) properties.gitlab_iid = meta.iid
      if (meta.number !== undefined) properties.gitlab_iid = meta.number
      if (meta.assignees) properties.assignees = meta.assignees
      if (meta.created_at) properties.created_at = meta.created_at
      if (meta.closed_at) properties.closed_at = meta.closed_at
      if (meta.web_url) properties.web_url = meta.web_url
      if (meta.due_date) properties.due_date = meta.due_date
      if (meta.start_date) properties.start_date = meta.start_date
      if (meta.weight !== undefined) properties.weight = meta.weight
      if (meta.project_id) properties.project_id = meta.project_id
      if (meta.group_id) properties.group_id = meta.group_id

      // ── Build node ─────────────────────────────────────────────────────────
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
        external_tool: 'gitlab',
        external_id: item.source_id,
        ...(meta.web_url ? { external_url: meta.web_url as string } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      }

      nodes.push(node)

      // ── Defer cross-domain edges ──────────────────────────────────────────

      // Issue linked to milestone → release_contains_feature/bug/task
      const milestoneLinkId = meta.milestone_id as string | undefined
      if (isIssue && milestoneLinkId) {
        if (resolvedType === 'bug') {
          deferredEdges.push({
            fromSourceId: milestoneLinkId,
            toSourceId: item.source_id,
            edgeType: 'release_contains_bug' as UPGEdgeType,
          })
        } else {
          // user_story, task, epic, incident: use release_contains_feature as approximation
          deferredEdges.push({
            fromSourceId: milestoneLinkId,
            toSourceId: item.source_id,
            edgeType: 'release_contains_feature' as UPGEdgeType,
          })
        }
      }

      // Epic linked to milestone
      if (isEpic && milestoneLinkId) {
        deferredEdges.push({
          fromSourceId: milestoneLinkId,
          toSourceId: item.source_id,
          edgeType: 'release_contains_feature' as UPGEdgeType,
        })
      }

      // Issue/epic belongs to an epic → epic_specified_by_user_story
      const epicId = meta.epic_id as string | undefined
      if (isIssue && epicId) {
        deferredEdges.push({
          fromSourceId: epicId,
          toSourceId: item.source_id,
          edgeType: 'epic_specified_by_user_story' as UPGEdgeType,
        })
      }

      // Epic has a parent epic → feature_decomposed_into_epic
      if (isEpic) {
        const parentEpicId = meta.parent_id as string | undefined
        if (parentEpicId) {
          deferredEdges.push({
            fromSourceId: parentEpicId,
            toSourceId: item.source_id,
            edgeType: 'feature_decomposed_into_epic' as UPGEdgeType,
          })
        }

        // Epic belongs to a project → project_delivers_epic
        const projectId = meta.project_id as string | undefined
        if (projectId) {
          deferredEdges.push({
            fromSourceId: projectId,
            toSourceId: item.source_id,
            edgeType: 'project_delivers_epic' as UPGEdgeType,
          })
        }

        // Epic belongs to a group (product) → product_organises_into_feature_area (approximation)
        const groupId = meta.group_id as string | undefined
        if (groupId && !projectId) {
          // Only emit group→epic if there's no project link (avoid double edges)
          // This is not a canonical edge: just informational, skip for now
          // (Epics in GitLab are group-scoped but the canonical project_delivers_epic is preferred)
        }
      }
    }

    // ── Pass 3: resolve deferred cross-domain edges ───────────────────────────
    for (const { fromSourceId, toSourceId, edgeType } of deferredEdges) {
      const fromNodeId = sourceMap[fromSourceId]
      const toNodeId = sourceMap[toSourceId]

      // Skip if either end is outside the import batch
      if (!fromNodeId || !toNodeId) continue

      const edgeId = `edge-xdomain-${fromNodeId}-${toNodeId}-${edgeType}`
      if (edges.some((e) => e.id === edgeId)) continue

      edges.push({
        id: edgeId,
        source: fromNodeId,
        target: toNodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    // ── Skip warnings ─────────────────────────────────────────────────────────
    if (skippedMRs > 0) {
      warnings.push(
        `${skippedMRs} merge request${skippedMRs > 1 ? 's were' : ' was'} not exported. ` +
          `MRs are engineering collaboration objects (code review plus CI) with no UPG product knowledge equivalent.`,
      )
    }

    if (skippedPipelines > 0) {
      warnings.push(
        `${skippedPipelines} CI/CD pipeline${skippedPipelines > 1 ? 's' : ''} skipped: ` +
          `pipelines are operational infrastructure with no UPG entity equivalent.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
