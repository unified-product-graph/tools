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

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
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

export const ZENDESK_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  open: 'active',
  pending: 'active',
  hold: 'active',
  solved: 'complete',
  closed: 'complete',
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

/** Normalize a Zendesk status string to a UPG status value */
export function normalizeZendeskStatus(status: string): string {
  const lower = normalizeName(status)
  return ZENDESK_STATUS_MAP[lower] ?? status
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

// ─── Zendesk Adapter ──────────────────────────────────────────────────────────

export class ZendeskAdapter implements UPGAdapter {
  name = 'zendesk'
  label = 'Zendesk'
  description =
    'Import tickets (as support_ticket), organisations (as account), articles (as document), CSAT ratings and community posts (as customer_feedback), and groups (as team) from Zendesk.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Zendesk adapter requires Zendesk API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
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

      // ── Status normalisation ───────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeZendeskStatus(rawStatus) : undefined

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
        // Preserve satisfaction score on customer_feedback nodes
        ...(upgEntityType === 'customer_feedback' && satisfactionScore !== undefined
          ? { satisfaction_score: satisfactionScore }
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

    // ── Pass 2: emit edges ────────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''
      const organizationId = meta.organization_id as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      const resolved = resolveZendeskType(entityType)
      if (!resolved) continue
      const upgEntityType = resolved

      // ── Organization membership edge for tickets ───────────────────────────
      // Ticket → Organization: node_informs_node (no specific ticket→account edge)
      if (upgEntityType === 'support_ticket' && organizationId) {
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

      const edgeType = resolveZendeskEdge(
        parentType,
        entityType,
        upgEntityType,
        item.title,
        warnings,
        (candidate, msg) => safeEdgeType(candidate, msg, warnings),
      )

      if (edgeType === null) {
        // Unrecognised pair: emit generic fallback
        edges.push({
          id: `edge-zendesk-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-zendesk-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedStructural === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Zendesk parent_type → entity_type pair.
 *
 * Returns:
 * - A UPGEdgeType string for the edge to emit
 * - null for unrecognised pairs (caller emits node_informs_node fallback)
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveZendeskEdge(
  parentType: string,
  entityType: string,
  upgEntityType: string,
  itemTitle: string,
  warnings: string[],
  safe: (candidate: string, msg: string) => UPGEdgeType,
): UPGEdgeType | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(entityType)

  // satisfaction_rating (customer_feedback) or post (customer_feedback) → feature context
  // customer_feedback_becomes_feature_request: source=customer_feedback, target=feature_request
  if (
    (child === 'satisfaction_rating' || child === 'post') &&
    upgEntityType === 'customer_feedback'
  ) {
    if (parent === 'feature_request' || parent === 'feature') {
      return safe(
        'customer_feedback_becomes_feature_request',
        `Zendesk: customer_feedback_becomes_feature_request not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
      )
    }
  }

  // support_ticket → bug (when parent_type signals a bug context)
  if (child === 'ticket' && upgEntityType === 'support_ticket') {
    if (parent === 'bug') {
      return safe(
        'support_ticket_reports_bug',
        `Zendesk: support_ticket_reports_bug not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
      )
    }
  }

  // group (team) → ticket: node_owned_by_team
  if (parent === 'group') {
    return safe(
      'node_owned_by_team',
      `Zendesk: node_owned_by_team not in catalog. Falling back to node_informs_node for "${itemTitle}".`,
    )
  }

  // Post or satisfaction_rating with a ticket parent: informational link
  if (child === 'satisfaction_rating' && parent === 'ticket') {
    warnings.push(
      `Zendesk CSAT rating "${itemTitle}" linked to parent ticket: UPG has no direct ` +
        `customer_feedback→support_ticket edge. Emitting node_informs_node as informational link.`,
    )
    return null
  }

  // Unrecognised pair
  return null
}
