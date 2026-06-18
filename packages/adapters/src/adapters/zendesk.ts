/**
 * Zendesk Adapter
 *
 * Imports customer support and feedback entities from Zendesk: an enterprise
 * support + knowledge management platform with tickets, organizations, help
 * center articles, community posts, and CSAT ratings.
 *
 * Zendesk's UPG story spans two domains:
 * - Customer Success / Support: Tickets → support_ticket; Organizations → account
 * - Customer Feedback: CSAT ratings → customer_feedback; Community posts → customer_feedback
 *
 *
 * Edges emitted:
 * - customer_feedback_becomes_feature_request  (satisfaction_rating/post → feature context)
 * - support_ticket_reports_bug                 (ticket typed as bug)
 * - node_owned_by_team                         (group ownership)
 *
 * Skipped with warnings:
 * - section     : help center structural container, not product knowledge
 * - comment     : ticket comment thread, operational
 * - tag         : flat metadata, folded into node tags[]
 * - macro       : automation template, platform config
 * - trigger     : automation rule, platform config
 * - view        : saved filter, UI config
 * - ticket_field: custom field schema definition, not product knowledge
 */

import { getLifecycleForType, UPG_EDGE_PAIR_MAP } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Zendesk entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 *
 * All UPG entity types verified against the live catalog.
 */
export const ZENDESK_TYPE_MAP: Record<string, string | null> = {
  ticket: 'support_ticket',
  user: 'participant',            // end user / customer
  organization: 'account',
  article: 'document',            // help center article
  section: null,                   // help center section: structural, skip
  comment: null,                   // ticket comment: skip
  tag: null,
  macro: null,                     // automation template: skip
  trigger: null,                   // automation: skip
  view: null,                      // saved filter: skip
  satisfaction_rating: 'customer_feedback', // CSAT rating
  ticket_field: null,              // custom field definition: skip
  group: 'team',                   // agent group
  forum_topic: 'document',        // community forum topic
  post: 'customer_feedback',      // community post / feature request
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps raw Zendesk status strings to candidate UPG phase ids, keyed by target
 * UPG type. Entries are tried AFTER the raw value is checked against the type's
 * own lifecycle, so only values that are NOT direct phase ids appear here.
 *
 * support_ticket phases: opened | triaged | in_progress | resolved | closed
 */
export const ZENDESK_STATUS_MAP: Record<string, Record<string, string>> = {
  support_ticket: {
    new: 'opened',
    open: 'opened',
    pending: 'triaged',
    hold: 'in_progress',
    solved: 'resolved',
    closed: 'closed',
  },
  customer_feedback: {
    new: 'received',
    open: 'received',
    pending: 'triaged',
    hold: 'triaged',
    solved: 'acknowledged',
    closed: 'acknowledged',
  },
  document: {
    new: 'draft',
    open: 'draft',
    pending: 'review',
    hold: 'review',
    solved: 'published',
    closed: 'archived',
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Zendesk entity_type to a UPG entity type */
export function resolveZendeskType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in ZENDESK_TYPE_MAP) {
    return ZENDESK_TYPE_MAP[lower]
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
 * Resolve a Zendesk status string to a phase id valid for the target type's
 * lifecycle. Returns undefined for lifecycle-free types or when no mapping exists.
 */
export function resolveZendeskStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const typeMap = ZENDESK_STATUS_MAP[upgType] ?? {}
  const mapped = typeMap[raw]
  return mapped && valid.has(mapped) ? mapped : undefined
}

/** Canonical UPG edge for a parent UPG type → child UPG type pair via catalogue,
 *  honouring direction; null when no canonical edge exists. */
function resolvePairEdge(parentUpg: string, childUpg: string): { type: string; sourceIsChild: boolean } | null {
  const fwd = UPG_EDGE_PAIR_MAP[`${parentUpg}:${childUpg}`]
  if (fwd && fwd.length > 0) return { type: fwd[0], sourceIsChild: false }
  const rev = UPG_EDGE_PAIR_MAP[`${childUpg}:${parentUpg}`]
  if (rev && rev.length > 0) return { type: rev[0], sourceIsChild: true }
  return null
}

/** Resolve mapping confidence for a Zendesk entity type */
export function getZendeskConfidence(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'ticket':
    case 'organization':
    case 'article':
    case 'group':
      return 'high'
    case 'user':
    case 'satisfaction_rating':
    case 'post':
    case 'forum_topic':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Zendesk Adapter ──────────────────────────────────────────────────────────

export class ZendeskAdapter implements UPGAdapter {
  name = 'zendesk'
  label = 'Zendesk'
  description =
    'Import tickets (as support_ticket), organisations (as account), articles (as document), CSAT ratings and community posts (as customer_feedback), and groups (as team) from Zendesk.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Zendesk adapter requires Zendesk API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Zendesk source items to UPG entities.
   *
   * Mapping logic:
   * - entity_type "ticket"              → support_ticket (status normalised)
   * - entity_type "user"                → participant (end-user / customer)
   * - entity_type "organization"        → account
   * - entity_type "article"             → document (help center article)
   * - entity_type "satisfaction_rating" → customer_feedback (CSAT; satisfaction_score preserved)
   * - entity_type "group"               → team (agent group)
   * - entity_type "forum_topic"         → document
   * - entity_type "post"                → customer_feedback (community post)
   * - entity_type "section"             → SKIPPED (structural container)
   * - entity_type "comment"             → SKIPPED (not product knowledge)
   * - entity_type "tag"                 → SKIPPED (metadata, folded into tags[])
   * - entity_type "macro"               → SKIPPED (automation template)
   * - entity_type "trigger"             → SKIPPED (automation rule)
   * - entity_type "view"                → SKIPPED (UI config)
   * - entity_type "ticket_field"        → SKIPPED (schema definition)
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedStructural = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `zendesk-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveZendeskType(entityType)

      // Explicitly unmappable types: skip
      if (resolved === null) {
        // Structural/operational types: batch count only
        if (
          entityType === 'section' ||
          entityType === 'comment' ||
          entityType === 'tag' ||
          entityType === 'macro' ||
          entityType === 'trigger' ||
          entityType === 'view' ||
          entityType === 'ticket_field'
        ) {
          skippedStructural++
        } else {
          warnings.push(
            `Zendesk entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Zendesk entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getZendeskConfidence(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Status normalisation (validated against target type's lifecycle) ──
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolveZendeskStatusForType(rawStatus, upgEntityType) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

      // ── Preserve satisfaction_score on customer_feedback nodes ─────────────
      const satisfactionScore = meta.satisfaction_score as string | undefined

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
        external_tool: 'zendesk',
        external_id: item.source_id,
        // Preserve satisfaction_score under properties so it survives the .upg writer
        ...(upgEntityType === 'customer_feedback' && satisfactionScore !== undefined
          ? { properties: { satisfaction_score: satisfactionScore } }
          : {}),
      }

      nodes.push(node)
    }

    // Aggregate warning for skipped structural entities
    if (skippedStructural > 0) {
      warnings.push(
        `${skippedStructural} Zendesk structural or operational entit${skippedStructural > 1 ? 'ies' : 'y'} skipped (sections, comments, tags, macros, triggers, views, ticket fields). Platform config has no UPG product knowledge equivalent.`,
      )
    }

    // ── Pass 2: emit edges (catalogue-driven) ─────────────────────────────────
    const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type as string]))

    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined
      const organizationId = meta.organization_id as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      const childUpg = nodeTypeById.get(nodeId) ?? ''

      // ── Organization membership edge for tickets ───────────────────────────
      // account <-> support_ticket has no canonical edge → node_informs_node.
      if (childUpg === 'support_ticket' && organizationId) {
        const orgNodeId = sourceMap[organizationId]
        if (orgNodeId) {
          edges.push({
            id: `edge-zendesk-org-${nodeId}-${orgNodeId}`,
            source: nodeId,
            target: orgNodeId,
            type: 'node_informs_node' as UPGEdgeType,
            mapping_confidence: 'low',
          })
        }
      }

      // ── Hierarchy edges from parent relationship ───────────────────────────
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Zendesk entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const parentUpg = nodeTypeById.get(parentNodeId) ?? ''

      // ── Team ownership: node_owned_by_team (owned-entity → team) ────────────
      // UPG_EDGE_PAIR_MAP has 'node:team' but not typed source:team pairs.
      if (parentUpg === 'team') {
        edges.push({
          id: `edge-zendesk-${nodeId}-${parentNodeId}`,
          source: nodeId,        // owned entity
          target: parentNodeId,  // team
          type: 'node_owned_by_team' as UPGEdgeType,
          mapping_confidence: 'medium',
        })
        continue
      }

      // ── Catalogue-driven resolution for all other parent→child pairs ───────
      const mapped = resolvePairEdge(parentUpg, childUpg)
      if (mapped) {
        const source = mapped.sourceIsChild ? nodeId : parentNodeId
        const target = mapped.sourceIsChild ? parentNodeId : nodeId
        edges.push({
          id: `edge-zendesk-${parentNodeId}-${nodeId}`,
          source,
          target,
          type: mapped.type as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      } else {
        edges.push({
          id: `edge-zendesk-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
      }
    }

    if (nodes.length === 0 && skippedStructural === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

