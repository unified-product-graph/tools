/**
 * GitHub Adapter
 *
 * Imports issues, milestones, releases, repositories, and other GitHub entities
 * via the GitHub MCP or gh CLI. Pull Requests are explicitly skipped with a
 * warning: they are code-layer artifacts below UPG's scope.
 *
 * Mapping:
 * - Issue        → feature | bug | epic | story_statement | task
 *                  (discriminated via labels: see inferIssueType)
 * - Repository   → code_repository
 * - Milestone    → milestone
 * - Release      → release
 * - Project      → project (GitHub ProjectV2)
 * - Discussion   → document
 * - Workflow     → ci_pipeline
 * - Deployment   → deployment
 * - Team         → team
 * - Organization → organization
 * - Pull Request → SKIPPED (code-layer artifact)
 *
 * Cross-domain edges emitted (when metadata is present):
 * - product/bounded_context → code_repository (stored_in)
 * - ci_pipeline → build_artifact              (produces)
 * - release → feature                         (release_contains_feature)
 * - release → bug                             (release_contains_bug)
 * - milestone → release                       (milestone_gates_release)
 * - node → team                               (node_owned_by_team)
 * - bug → feature                             (bug_affects_feature)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolveContainmentEdge } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Issue label sets ─────────────────────────────────────────────────────────

/** Labels that indicate a bug */
const BUG_LABELS = new Set([
  'bug',
  'defect',
  'fix',
  'regression',
  'crash',
  'error',
  'type: bug',
  'type:bug',
  'kind/bug',
])

/** Labels that indicate a feature */
const FEATURE_LABELS = new Set([
  'feature',
  'enhancement',
  'feat',
  'feature-request',
  'feature request',
  'type: feature',
  'type:feature',
  'kind/feature',
])

/** Labels that indicate an epic */
const EPIC_LABELS = new Set([
  'epic',
  'kind/epic',
])

/** Labels that indicate a user story */
const STORY_LABELS = new Set([
  'story',
  'user story',
  'user-story',
])

/** Labels that indicate chore/tech debt/task */
const TASK_LABELS = new Set([
  'tech debt',
  'refactor',
  'chore',
  'maintenance',
  'type: chore',
  'type:chore',
])

// ─── Non-issue entity type map ────────────────────────────────────────────────

/**
 * Maps GitHub non-issue entity types to UPG entity types.
 * Null values indicate entities that should be skipped.
 */
const GITHUB_ENTITY_TYPE_MAP: Record<string, string | null> = {
  repository: 'code_repository',
  milestone: 'milestone',
  release: 'release',
  project: 'project',        // GitHub ProjectV2
  discussion: 'document',
  pull_request: null,         // No UPG equivalent: skip with warning
  workflow: 'ci_pipeline',
  deployment: 'deployment',
  team: 'team',
  organization: 'organization',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Infer UPG entity type from a GitHub issue's labels.
 *
 * Precedence:
 * 1. bug labels (highest priority)
 * 2. feature / enhancement labels
 * 3. epic labels
 * 4. story labels
 * 5. chore / tech-debt labels
 * 6. Default: task (unlabelled issues are tasks, not features)
 */
export function inferIssueType(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase())
  if (lower.some((l) => BUG_LABELS.has(l))) return 'bug'
  if (lower.some((l) => FEATURE_LABELS.has(l))) return 'feature'
  if (lower.some((l) => EPIC_LABELS.has(l))) return 'epic'
  if (lower.some((l) => STORY_LABELS.has(l))) return 'story_statement'
  if (lower.some((l) => TASK_LABELS.has(l))) return 'task'
  return 'task' // default: unlabelled issues are delivery tasks
}

/** Map GitHub issue open/closed state to UPG status */
function mapGitHubState(state: string): string {
  switch (state.toLowerCase()) {
    case 'open':
      return 'active'
    case 'closed':
      return 'complete'
    default:
      return state.toLowerCase()
  }
}

// ─── GitHub Adapter ───────────────────────────────────────────────────────────

export class GitHubAdapter implements UPGAdapter {
  name = 'github'
  label = 'GitHub'
  description = 'Import issues, milestones, releases, and repositories from GitHub via the GitHub MCP'

  /**
   * List available GitHub items.
   *
   * Requires GitHub MCP tools or gh CLI to be available.
   *
   * Config options:
   * - `owner` (string): repository owner
   * - `repo` (string): repository name
   * - `state`: 'open' | 'closed' | 'all': issue state filter (default: 'open')
   * - `milestone` (string): filter by milestone title
   * - `labels`: string[]: filter by label names
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const token = config.token as string
    const owner = config.owner as string
    const repo = config.repo as string

    if (!token || !owner || !repo) {
      throw new Error('GitHub adapter requires config.token, config.owner, config.repo')
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`

    const items: SourceItem[] = []

    // Fetch milestones
    const milestonesRes = await fetch(`${baseUrl}/milestones?state=all&per_page=100`, { headers })
    if (!milestonesRes.ok) throw new Error(`GitHub milestones fetch failed: ${milestonesRes.status}`)
    const milestones = await milestonesRes.json() as Array<{ number: number; title: string; description: string | null; state: string; due_on: string | null }>

    for (const m of milestones) {
      items.push({
        source_id: `milestone-${m.number}`,
        source_type: 'milestone',
        title: m.title,
        content: m.description ?? undefined,
        metadata: { entity_kind: 'milestone', status: m.state, due_on: m.due_on },
      })
    }

    // Fetch issues (paginated, all states)
    let page = 1
    while (true) {
      const issuesRes = await fetch(
        `${baseUrl}/issues?state=all&per_page=100&page=${page}&filter=all`,
        { headers },
      )
      if (!issuesRes.ok) throw new Error(`GitHub issues fetch failed: ${issuesRes.status}`)
      const issues = await issuesRes.json() as Array<{
        number: number; title: string; body: string | null; state: string
        labels: Array<{ name: string }>; milestone: { number: number } | null
        pull_request?: unknown
      }>
      if (issues.length === 0) break

      for (const issue of issues) {
        // Skip pull requests
        if (issue.pull_request) continue
        items.push({
          source_id: `issue-${issue.number}`,
          source_type: 'issue',
          title: issue.title,
          content: issue.body ?? undefined,
          metadata: {
            entity_kind: 'issue',
            labels: issue.labels.map((l) => l.name),
            state: issue.state,
            milestone_id: issue.milestone ? `milestone-${issue.milestone.number}` : undefined,
          },
        })
      }
      if (issues.length < 100) break
      page++
    }

    return items
  }

  /**
   * Convert GitHub source items to UPG entities.
   *
   * Processing order (three-pass):
   * Pass 1: Create milestone and release nodes so issues can reference them.
   * Pass 2: Create issue and remaining nodes; defer cross-domain edges.
   * Pass 3: Resolve deferred cross-domain edges after all nodes are built.
   *
   * Mapping logic:
   * - entity_type "issue"        → feature | bug | epic | story_statement | task
   * - entity_type "milestone"    → milestone
   * - entity_type "release"      → release
   * - entity_type "repository"   → code_repository
   * - entity_type "project"      → project
   * - entity_type "discussion"   → document
   * - entity_type "workflow"     → ci_pipeline
   * - entity_type "deployment"   → deployment
   * - entity_type "team"         → team
   * - entity_type "pull_request" → SKIPPED with warning
   * - Labels → tags on issue nodes (type-indicator labels filtered out)
   * - Issue state → UPG status (open → active, closed → complete)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedPRs = 0

    // Deferred cross-domain edges: resolved after all nodes are built
    const deferredEdges: Array<{
      fromSourceId: string
      toSourceId: string
      edgeType: UPGEdgeType
    }> = []

    // ── Pass 1: milestone and release nodes first ─────────────────────────────
    // Issues reference milestones via milestone_id so we need those IDs first.
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type
      if (entityType !== 'milestone' && entityType !== 'release') continue

      counter++
      const nodeId = `gh-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      const ugpType = GITHUB_ENTITY_TYPE_MAP[entityType] ?? 'document'

      const node: UPGBaseNode = {
        id: nodeId,
        type: ugpType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: 'high',
        external_tool: 'github',
        external_id: item.source_id,
        ...(meta.url ? { external_url: meta.url as string } : {}),
        properties: {
          ...(meta.due_on ? { due_date: meta.due_on } : {}),
          ...(meta.state ? { state: meta.state } : {}),
          ...(meta.tag_name ? { tag_name: meta.tag_name } : {}),
        },
      }

      nodes.push(node)

      // milestone → release edge (when a release references a milestone)
      const releaseMilestoneId = meta.milestone_id as string | undefined
      if (ugpType === 'release' && releaseMilestoneId) {
        deferredEdges.push({
          fromSourceId: releaseMilestoneId,
          toSourceId: item.source_id,
          edgeType: 'milestone_gates_release' as UPGEdgeType,
        })
      }
    }

    // ── Pass 2: all remaining items ───────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? item.source_type

      // Already processed in pass 1
      if (entityType === 'milestone' || entityType === 'release') continue

      // Pull requests: skip with warning (counted: message emitted at end)
      if (entityType === 'pull_request') {
        skippedPRs++
        continue
      }

      // Resolve UPG entity type
      let resolvedType: string
      let mappingConfidence: 'high' | 'medium' | 'low' = 'high'

      if (entityType === 'issue') {
        const labels = (meta.labels as string[] | undefined) ?? []
        resolvedType = inferIssueType(labels)
        mappingConfidence = labels.length > 0 ? 'high' : 'low'
      } else {
        const mapped = GITHUB_ENTITY_TYPE_MAP[entityType]
        if (mapped === undefined) {
          warnings.push(
            `Unknown GitHub entity type "${entityType}" for "${item.title}". Defaulting to "document".`,
          )
          resolvedType = 'document'
          mappingConfidence = 'low'
        } else if (mapped === null) {
          // Defensive: already caught by pull_request check above
          warnings.push(`"${item.title}" (${entityType}) skipped: no UPG equivalent.`)
          continue
        } else {
          resolvedType = mapped
        }
      }

      counter++
      const nodeId = `gh-import-${Date.now()}-${counter}`
      sourceMap[item.source_id] = nodeId

      // ── Issue-specific processing ─────────────────────────────────────────
      const isIssue = entityType === 'issue'
      const labels = isIssue ? ((meta.labels as string[] | undefined) ?? []) : []
      const status = isIssue ? mapGitHubState((meta.state as string) ?? 'open') : undefined

      // Filter type-indicator labels from tags: they're captured in entity type
      const tags = isIssue
        ? labels.filter(
            (l) =>
              !BUG_LABELS.has(l.toLowerCase()) &&
              !FEATURE_LABELS.has(l.toLowerCase()) &&
              !EPIC_LABELS.has(l.toLowerCase()) &&
              !STORY_LABELS.has(l.toLowerCase()) &&
              !TASK_LABELS.has(l.toLowerCase()),
          )
        : []

      // ── Properties ─────────────────────────────────────────────────────────
      const properties: Record<string, unknown> = {}
      if (meta.number !== undefined) properties.github_number = meta.number
      if (meta.assignees) properties.assignees = meta.assignees
      if (meta.created_at) properties.created_at = meta.created_at
      if (meta.closed_at) properties.closed_at = meta.closed_at
      if (meta.html_url) properties.html_url = meta.html_url
      if (meta.full_name) properties.full_name = meta.full_name   // for repositories
      if (meta.default_branch) properties.default_branch = meta.default_branch

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
        external_tool: 'github',
        external_id: item.source_id,
        ...(meta.url ? { external_url: meta.url as string } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      }

      nodes.push(node)

      // ── Children (sub-issues / task list items) ───────────────────────────
      for (const child of item.children ?? []) {
        counter++
        const childNodeId = `gh-import-${Date.now()}-${counter}`
        sourceMap[child.source_id] = childNodeId

        const childNode: UPGBaseNode = {
          id: childNodeId,
          type: 'task',
          title: child.title,
          ...(child.content ? { description: child.content } : {}),
          source_id: child.source_id,
          source_type: child.source_type,
          mapping_confidence: 'medium',
          external_tool: 'github',
          external_id: child.source_id,
        }

        nodes.push(childNode)

        const childEdgeType = resolveContainmentEdge(resolvedType, 'task') ?? 'node_informs_node'
        edges.push({
          id: `edge-${nodeId}-${childNodeId}`,
          source: nodeId,
          target: childNodeId,
          type: childEdgeType,
          mapping_confidence: childEdgeType === 'node_informs_node' ? 'low' : 'medium',
        })
      }

      // ── Defer cross-domain edges ──────────────────────────────────────────

      // Issue linked to milestone → release_contains_feature or release_contains_bug
      const milestoneLinkId = meta.milestone_id as string | undefined
      if (isIssue && milestoneLinkId) {
        if (resolvedType === 'feature') {
          deferredEdges.push({
            fromSourceId: milestoneLinkId,
            toSourceId: item.source_id,
            edgeType: 'release_contains_feature' as UPGEdgeType,
          })
        } else if (resolvedType === 'bug') {
          deferredEdges.push({
            fromSourceId: milestoneLinkId,
            toSourceId: item.source_id,
            edgeType: 'release_contains_bug' as UPGEdgeType,
          })
        } else {
          // Other types: fall back to catalogue-aware resolver
          const releaseEdgeType =
            resolveContainmentEdge('release', resolvedType) ?? 'node_informs_node'
          const milestoneNodeId = sourceMap[milestoneLinkId]
          if (milestoneNodeId) {
            edges.push({
              id: `edge-release-${milestoneNodeId}-${nodeId}`,
              source: milestoneNodeId,
              target: nodeId,
              type: releaseEdgeType,
              mapping_confidence: releaseEdgeType === 'node_informs_node' ? 'low' : 'high',
            })
          }
        }
      }

      // Issue / node → team ownership
      const teamId = meta.team_id as string | undefined
      if (teamId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: teamId,
          edgeType: 'node_owned_by_team' as UPGEdgeType,
        })
      }

      // Bug → parent feature
      const parentId = meta.parent_id as string | undefined
      if (resolvedType === 'bug' && parentId) {
        deferredEdges.push({
          fromSourceId: item.source_id,
          toSourceId: parentId,
          edgeType: 'bug_affects_feature' as UPGEdgeType,
        })
      }

      // Product → code_repository (product_id in repo metadata)
      const productId = meta.product_id as string | undefined
      if (resolvedType === 'code_repository' && productId) {
        deferredEdges.push({
          fromSourceId: productId,
          toSourceId: item.source_id,
          edgeType: 'product_stored_in_code_repository' as UPGEdgeType,
        })
      }

      // Bounded context → code_repository
      const boundedContextId = meta.bounded_context_id as string | undefined
      if (resolvedType === 'code_repository' && boundedContextId) {
        deferredEdges.push({
          fromSourceId: boundedContextId,
          toSourceId: item.source_id,
          edgeType: 'bounded_context_stored_in_code_repository' as UPGEdgeType,
        })
      }
    }

    // ── Pass 3: resolve deferred cross-domain edges ───────────────────────────
    for (const { fromSourceId, toSourceId, edgeType } of deferredEdges) {
      const fromNodeId = sourceMap[fromSourceId]
      const toNodeId = sourceMap[toSourceId]

      // Skip if either end is outside the import batch
      if (!fromNodeId || !toNodeId) continue

      // For bug_affects_feature: only emit if target IS a feature
      if (edgeType === 'bug_affects_feature') {
        const targetNode = nodes.find((n) => n.id === toNodeId)
        if (targetNode?.type !== 'feature') continue
      }

      const edgeId = `edge-xdomain-${fromNodeId}-${toNodeId}`
      if (edges.some((e) => e.id === edgeId)) continue

      edges.push({
        id: edgeId,
        source: fromNodeId,
        target: toNodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    // ── PR skip warning ───────────────────────────────────────────────────────
    if (skippedPRs > 0) {
      warnings.push(
        `${skippedPRs} pull request${skippedPRs > 1 ? 's were' : ' was'} not exported. ` +
          `PRs are code-layer artifacts below UPG's scope.`,
      )
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
