/**
 * Jira Adapter
 *
 * Imports issues, projects, components, and versions from Jira (Atlassian Cloud)
 * into the Unified Product Graph.
 *
 * Jira is an issue-centric, polymorphic delivery tool. Every entity is an Issue
 * discriminated by its `issueType.name` field. Projects, Components, and Versions
 * are structural scaffolding around issues.
 *
 *
 * Key structural notes:
 * - Epic hierarchy inversion: Jira Epic (largest) ≠ UPG epic (smallest below feature)
 *   Default mode: literal mapping (Jira Epic → UPG epic). Emit warning on every Epic.
 * - IssueLink "Relates To": has no UPG typed equivalent: skipped with warning
 * - Sprint: delivery-layer time container: no UPG equivalent, skipped with warning
 * - IssueLink "Causes": creates a root_cause node + root_cause_causes_bug edge
 *
 * Hierarchy edges emitted:
 * - epic_specified_by_user_story   (epic → story or task)
 * - task_implements_user_story     (sub-task → story parent)
 * - project_delivers_epic               (project → epic)
 * - feature_area_contains_feature       (component → issue mapped as feature/story)
 * - release_contains_feature            (fixVersion → feature/story/epic)
 * - release_contains_bug                (fixVersion → bug)
 * - root_cause_causes_bug               ("Causes" IssueLink)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolvePairEdge } from './resolve-pair-edge.js'
import { getLifecycleForType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Issue type → UPG entity type ────────────────────────────────────────────

/**
 * Maps Jira issue type names (lowercased) to UPG entity types.
 *
 * Null values mean the issue type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const JIRA_ISSUE_TYPE_MAP: Record<string, string | null> = {
  // Standard issue types
  story: 'user_story',
  'user story': 'user_story',
  task: 'task',
  'sub-task': 'task',
  subtask: 'task',
  bug: 'bug',
  defect: 'bug',
  epic: 'epic', // literal mapping: see Epic Inversion warning
  initiative: 'initiative', // Jira Align only
  theme: null, // Jira Align only, no UPG equivalent
  incident: 'incident', // Jira Service Management
  request: 'support_ticket', // JSM
  'service request': 'support_ticket',
  change: 'task',
  problem: 'bug',
  chore: 'task',
  spike: 'task',
  design: 'task',
  sprint: null, // skip with warning
}

/**
 * Maps Jira non-issue structural entity kinds to UPG entity types.
 */
export const JIRA_STRUCTURAL_TYPE_MAP: Record<string, string | null> = {
  project: 'project',
  component: 'feature_area',
  version: 'release',
  sprint: null, // intentionally excluded
  board: null, // view config, not a knowledge entity
}

// ─── IssueLink type → edge ────────────────────────────────────────────────────

/**
 * Maps IssueLink type inward verbs to UPG edge types.
 *
 * "blocks" → source is the blocking issue (dependency)
 * "is blocked by" → skip: already captured from the other side
 * "is caused by" → root_cause_causes_bug (root_cause → bug)
 */
export const JIRA_LINK_EDGE_MAP: Record<string, string | null> = {
  blocks: 'dependency_blocks_team', // approximation
  'is blocked by': null, // skip: captured from the other side
  causes: null, // handled specially: create root_cause node
  'is caused by': 'root_cause_causes_bug', // root_cause → bug
  duplicates: null, // skip with warning
  'is duplicated by': null,
  'relates to': null, // skip with warning
  clones: null,
  'is cloned by': null,
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Jira status names (lowercased) to UPG status values.
 */
// Jira workflow statuses mapped to UPG delivery-lifecycle phase ids.
// resolveJiraStatusForType() tries the raw status first (a bug's "Open" is a real
// bug phase) then this map, keeping only what is valid for the target type.
export const JIRA_STATUS_MAP: Record<string, string> = {
  backlog: 'todo',
  triage: 'todo',
  todo: 'todo',
  'to do': 'todo',
  open: 'todo',
  new: 'todo',
  'in progress': 'in_progress',
  'in development': 'in_progress',
  'in review': 'in_progress',
  'in testing': 'in_progress',
  done: 'done',
  closed: 'done',
  resolved: 'done',
  completed: 'done',
  released: 'done',
  cancelled: 'abandoned',
  "won't do": 'abandoned',
  'wont do': 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Jira issue type to a UPG entity type */
export function resolveIssueType(issueType: string): string | null | undefined {
  const lower = normalizeName(issueType)
  if (lower in JIRA_ISSUE_TYPE_MAP) {
    return JIRA_ISSUE_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Jira status string to a UPG status value */
export function normalizeJiraStatus(status: string): string {
  const lower = normalizeName(status)
  return JIRA_STATUS_MAP[lower] ?? status
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

/** Resolve a Jira status to one valid for the target type's lifecycle (omit otherwise). */
function resolveJiraStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const mapped = JIRA_STATUS_MAP[raw]
  return mapped && valid.has(mapped) ? mapped : undefined
}

/** Get confidence for a Jira issue type → UPG entity type mapping */
export function getConfidenceForIssueType(issueType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(issueType)
  switch (lower) {
    case 'story':
    case 'user story':
    case 'bug':
    case 'defect':
    case 'incident':
      return 'high'
    case 'epic':
    case 'task':
    case 'sub-task':
    case 'subtask':
    case 'initiative':
    case 'request':
    case 'service request':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Jira Adapter ─────────────────────────────────────────────────────────────

export class JiraAdapter implements UPGAdapter {
  name = 'jira'
  label = 'Jira'
  description =
    'Import issues, projects, components, and versions from Jira. Epic, Story, Task, Bug, and Sub-task hierarchy with IssueLink edge mapping.'

  /**
   * List available Jira issues.
   *
   * Requires Jira API access. This adapter is designed to be called from
   * within a skill that has access to a Jira API connection.
   *
   * Config options:
   * - `items`: SourceItem[]: pre-fetched Jira items
   * - `project_key` (string): specific project to import
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const baseUrl = (config.base_url as string)?.replace(/\/$/, '')
    const email = config.email as string
    const token = config.api_token as string
    if (!baseUrl || !email || !token) {
      throw new Error('Jira adapter requires config.base_url, config.email, config.api_token')
    }

    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    const items: SourceItem[] = []

    // Projects
    const projectsRes = await fetch(`${baseUrl}/rest/api/3/project/search?maxResults=50`, { headers })
    if (!projectsRes.ok) throw new Error(`Jira projects fetch failed: ${projectsRes.status}`)
    const projectsData = await projectsRes.json() as { values: Array<{ id: string; key: string; name: string; projectTypeKey: string }> }

    for (const project of projectsData.values) {
      items.push({
        source_id: `project-${project.key}`,
        source_type: 'project',
        title: project.name,
        metadata: { entity_kind: 'project', project_key: project.key, project_type: project.projectTypeKey },
      })

      // Versions (releases) per project
      const versionsRes = await fetch(`${baseUrl}/rest/api/3/project/${project.key}/versions`, { headers })
      if (versionsRes.ok) {
        const versions = await versionsRes.json() as Array<{ id: string; name: string; description?: string; released: boolean; releaseDate?: string }>
        for (const v of versions) {
          items.push({
            source_id: `version-${v.id}`,
            source_type: 'version',
            title: v.name,
            content: v.description,
            metadata: { entity_kind: 'version', project_id: `project-${project.key}`, released: v.released, release_date: v.releaseDate },
          })
        }
      }

      // Components per project
      const componentsRes = await fetch(`${baseUrl}/rest/api/3/project/${project.key}/components`, { headers })
      if (componentsRes.ok) {
        const components = await componentsRes.json() as Array<{ id: string; name: string; description?: string }>
        for (const c of components) {
          items.push({
            source_id: `component-${c.id}`,
            source_type: 'component',
            title: c.name,
            content: c.description,
            metadata: { entity_kind: 'component', project_id: `project-${project.key}` },
          })
        }
      }

      // Issues per project (paginated)
      let startAt = 0
      while (true) {
        const searchRes = await fetch(
          `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(`project = "${project.key}" ORDER BY created DESC`)}&maxResults=100&startAt=${startAt}&fields=summary,description,issuetype,status,parent,subtasks,fixVersions,components,labels,priority`,
          { headers },
        )
        if (!searchRes.ok) break
        const searchData = await searchRes.json() as { issues: Array<{ id: string; key: string; fields: Record<string, unknown> }>; total: number }

        for (const issue of searchData.issues) {
          const fields = issue.fields as Record<string, unknown>
          const issueType = (fields.issuetype as { name: string; hierarchyLevel: number; subtask: boolean }) ?? {}
          const parent = fields.parent as { key: string; fields?: { issuetype?: { name: string } } } | undefined
          const status = fields.status as { name: string } | undefined
          const fixVersions = (fields.fixVersions as Array<{ id: string }>) ?? []
          const components = (fields.components as Array<{ id: string }>) ?? []

          items.push({
            source_id: `issue-${issue.key}`,
            source_type: 'issue',
            title: (fields.summary as string) ?? issue.key,
            content: (fields.description as string) ?? undefined,
            metadata: {
              entity_kind: 'issue',
              issue_type: issueType.name,
              hierarchy_level: issueType.hierarchyLevel,
              parent_id: parent ? `issue-${parent.key}` : undefined,
              parent_type: parent?.fields?.issuetype?.name,
              status: status?.name,
              project_id: `project-${project.key}`,
              version_ids: fixVersions.map((v) => `version-${v.id}`),
              component_ids: components.map((c) => `component-${c.id}`),
            },
          })
        }

        startAt += searchData.issues.length
        if (startAt >= searchData.total || searchData.issues.length === 0) break
      }
    }

    return items
  }

  /**
   * Convert Jira source items to UPG entities.
   *
   * Two-pass loop:
   * Pass 1: build nodes + populate sourceMap
   * Pass 2: emit hierarchy edges + IssueLink edges
   *
   * Mapping logic:
   * - metadata.entity_kind discriminates non-issue structural types
   * - metadata.issue_type discriminates issue types (via JIRA_ISSUE_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status → normalised UPG status (via JIRA_STATUS_MAP)
   * - metadata.component_ids → feature_area_contains_feature edges
   * - metadata.version_ids → release_contains_feature/bug edges
   * - metadata.issue_links → IssueLink edge resolution
   * - Epic → warning about hierarchy inversion
   * - Sprint items → skipped with warning
   * - Theme items → skipped with warning
   * - "Relates to" IssueLinks → skipped with warning
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let sprintSkipCount = 0

    // ── Pass 1: Build nodes ────────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `jira-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityKind = meta.entity_kind as string | undefined
      const issueType = (meta.issue_type as string | undefined) ?? ''

      // Structural (non-issue) entities: ONLY the structural kinds
      // (project/component/version/board/sprint) are handled here. Issues carry
      // entity_kind 'issue' (and a source_type 'issue') and must fall through to
      // issue-type discrimination below — previously a non-structural entity_kind
      // was treated as "unknown" and the issue was skipped entirely.
      const entityKindLower = entityKind ? normalizeName(entityKind) : ''
      if (entityKindLower && entityKindLower in JIRA_STRUCTURAL_TYPE_MAP) {
        const structuralType = JIRA_STRUCTURAL_TYPE_MAP[entityKindLower]
        if (structuralType === null) {
          warnings.push(
            `Jira structural entity "${item.title}" has kind "${entityKind}" which has no UPG equivalent. Entity skipped.`,
          )
          continue
        }
        sourceMap[item.source_id] = nodeId
        const rawStatus = meta.status as string | undefined
        const status = rawStatus ? resolveJiraStatusForType(rawStatus, structuralType) : undefined
        const node: UPGBaseNode = {
          id: nodeId,
          type: structuralType as UPGEntityType,
          title: item.title,
          ...(item.content ? { description: item.content } : {}),
          ...(status ? { status } : {}),
          source_id: item.source_id,
          source_type: item.source_type,
          mapping_confidence: 'high',
          external_tool: 'jira',
          external_id: item.source_id,
        }
        nodes.push(node)
        continue
      }

      // Issue entities: discriminate by issue_type
      const resolved = resolveIssueType(issueType)

      if (resolved === null) {
        if (normalizeName(issueType) === 'sprint') {
          sprintSkipCount++
        } else if (normalizeName(issueType) === 'theme') {
          warnings.push(
            `Jira Theme "${item.title}" (Jira Align only) has no UPG equivalent. Item skipped.`,
          )
        } else {
          warnings.push(
            `Jira issue "${item.title}" has issue_type "${issueType}" which has no UPG equivalent. Item skipped.`,
          )
        }
        continue
      }

      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Jira issue "${item.title}" has unknown issue_type "${issueType}". ` +
            `Defaulting to "task". Update the adapter if this type should be mapped differently.`,
        )
        entityType = 'task'
        mappingConfidence = 'low'
      } else {
        entityType = resolved
        mappingConfidence = getConfidenceForIssueType(issueType)
      }

      // Register in sourceMap before type-specific warnings
      sourceMap[item.source_id] = nodeId

      // Epic hierarchy inversion warning
      if (normalizeName(issueType) === 'epic') {
        warnings.push(
          `Jira Epic "${item.title}" mapped to UPG 'epic' (literal mapping). In UPG, 'epic' is ` +
            `smaller than 'feature'. If you want semantic mapping (Jira Epic → UPG feature), ` +
            `run with --semantic-mode.`,
        )
      }

      // Normalise status against the resolved type's lifecycle (omit if invalid)
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolveJiraStatusForType(rawStatus, entityType) : undefined

      // Build node
      const node: UPGBaseNode = {
        id: nodeId,
        type: entityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'jira',
        external_id: item.source_id,
      }

      nodes.push(node)
    }

    // Emit sprint skip warning once after pass 1
    if (sprintSkipCount > 0) {
      warnings.push(
        `Sprint nodes are delivery-layer time containers with no UPG equivalent. ` +
          `${sprintSkipCount} sprint item(s) were skipped.`,
      )
    }

    // ── Pass 2: Emit edges ─────────────────────────────────────────────────────
    const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type as string]))
    let edgeCounter = 0
    // Emit the canonical edge for a parent->child pair (correct type + direction),
    // or an honest node_informs_node when no catalogued edge exists for the pair.
    const emitPairEdge = (parentNodeId: string, childNodeId: string): void => {
      const pUpg = nodeTypeById.get(parentNodeId)
      const cUpg = nodeTypeById.get(childNodeId)
      if (!pUpg || !cUpg) return
      const mapped = resolvePairEdge(pUpg, cUpg)
      edgeCounter++
      if (mapped) {
        const source = mapped.sourceIsChild ? childNodeId : parentNodeId
        const target = mapped.sourceIsChild ? parentNodeId : childNodeId
        edges.push({ id: `edge-jira-${edgeCounter}`, source, target, type: mapped.type as UPGEdgeType, mapping_confidence: 'medium' })
      } else {
        edges.push({ id: `edge-jira-${edgeCounter}`, source: parentNodeId, target: childNodeId, type: 'node_informs_node' as UPGEdgeType, mapping_confidence: 'low' })
      }
    }

    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      // ── Parent hierarchy edge (catalogue-driven) ───────────────────────────
      if (parentId) {
        const parentNodeId = sourceMap[parentId]
        if (!parentNodeId) {
          warnings.push(
            `Jira item "${item.title}" references parent_id "${parentId}" which was not found in the imported set. Edge skipped.`,
          )
        } else {
          emitPairEdge(parentNodeId, nodeId)
        }
      }

      // ── Component membership edges (component=feature_area → issue) ────────
      const componentIds = meta.component_ids as string[] | undefined
      if (Array.isArray(componentIds)) {
        for (const componentId of componentIds) {
          const componentNodeId = sourceMap[componentId]
          if (!componentNodeId) continue
          emitPairEdge(componentNodeId, nodeId)
        }
      }

      // ── Version (release) membership edges (version=release → issue) ───────
      const versionIds = meta.version_ids as string[] | undefined
      if (Array.isArray(versionIds)) {
        for (const versionId of versionIds) {
          const releaseNodeId = sourceMap[versionId]
          if (!releaseNodeId) continue
          emitPairEdge(releaseNodeId, nodeId)
        }
      }

      // ── IssueLink edges ────────────────────────────────────────────────────
      const issueLinks = meta.issue_links as
        | Array<{ link_type: string; target_id: string }>
        | undefined
      if (Array.isArray(issueLinks)) {
        let relatesCount = 0

        for (const link of issueLinks) {
          const linkType = normalizeName(link.link_type)

          if (linkType === 'relates to') {
            relatesCount++
            continue
          }

          if (linkType === 'duplicates' || linkType === 'is duplicated by') {
            continue // skip silently
          }

          if (linkType === 'is blocked by' || linkType === 'is cloned by' || linkType === 'clones') {
            continue // skip: captured from other side or irrelevant
          }

          // "causes": create a root_cause node + root_cause_causes_bug edge
          if (linkType === 'causes') {
            const targetNodeId = sourceMap[link.target_id]
            if (targetNodeId) {
              // The current issue is the root cause; link.target_id is the bug
              edgeCounter++
              edges.push({
                id: `edge-jira-${edgeCounter}`,
                source: nodeId,
                target: targetNodeId,
                type: 'root_cause_causes_bug' as UPGEdgeType,
                mapping_confidence: 'high',
              })
            }
            continue
          }

          // "is caused by": root_cause → current issue (bug)
          if (linkType === 'is caused by') {
            const targetNodeId = sourceMap[link.target_id]
            if (targetNodeId) {
              edgeCounter++
              edges.push({
                id: `edge-jira-${edgeCounter}`,
                source: targetNodeId,
                target: nodeId,
                type: 'root_cause_causes_bug' as UPGEdgeType,
                mapping_confidence: 'high',
              })
            }
            continue
          }

          // "blocks": dependency_blocks_team approximation
          if (linkType === 'blocks') {
            const targetNodeId = sourceMap[link.target_id]
            if (targetNodeId) {
              edgeCounter++
              edges.push({
                id: `edge-jira-${edgeCounter}`,
                source: nodeId,
                target: targetNodeId,
                type: 'dependency_blocks_team' as UPGEdgeType,
                mapping_confidence: 'low',
              })
            }
            continue
          }
        }

        if (relatesCount > 0) {
          warnings.push(
            `Issue "${item.title}" has ${relatesCount} 'relates to' IssueLink(s) that were skipped: ` +
              `UPG uses typed edges, separate from generic relates_to relationships. Review these links and map them to appropriate edge types.`,
          )
        }
      }
    }

    if (nodes.length === 0) {
      warnings.push('No items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// Hierarchy, component, and version edges are all catalogue-driven via
// resolvePairEdge() (UPG_EDGE_PAIR_MAP) inside convert(): the emitted edge type
// and direction come from the catalogue for the resolved (parent, child) UPG-type
// pair, with a node_informs_node fallback when no canonical edge exists.
