/**
 * Intercom Adapter
 *
 * Imports customer communications entities from Intercom: a customer messaging
 * platform for in-app chat, support conversations, and surveys.
 *
 * Intercom's UPG story spans two domains:
 * - Customer Success / Support: Conversations → support_ticket; Companies → account
 * - Customer Feedback: Conversations with feature tags → customer_feedback; Articles → document
 *
 *
 * Edges emitted:
 * - customer_feedback_becomes_feature_request  (when support_ticket parent is a feature_request)
 * - node_owned_by_team                          (polymorphic ownership)
 *
 * Skipped with warnings:
 * - news_item : outbound news, no UPG product knowledge equivalent
 * - series    : automated message series, no UPG equivalent
 * - tag       : metadata property
 * - messenger_app: platform app, not product knowledge
 */

import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Intercom entity_type values to UPG entity types.
 *
 * Null values mean the type has no UPG equivalent and will be skipped
 * with a warning.
 */
export const INTERCOM_TYPE_MAP: Record<string, string | null> = {
  conversation: 'support_ticket', // customer conversation
  contact: 'participant',         // individual user/lead
  company: 'account',             // company account
  article: 'document',            // help center article
  news_item: null,                 // outbound news: skip
  series: null,                    // automated message series: skip
  tag: null,                       // metadata
  segment: 'market_segment',      // named contact segment
  survey: 'customer_feedback',    // survey submission
  messenger_app: null,             // platform app: skip
}

// ─── Status normalisation ─────────────────────────────────────────────────────

export const INTERCOM_STATUS_MAP: Record<string, string> = {
  open: 'active',
  pending: 'active',
  snoozed: 'active',
  closed: 'complete',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve an Intercom entity_type to a UPG entity type */
export function resolveIntercomType(entityType: string): string | null | undefined {
  const lower = normalizeName(entityType)
  if (lower in INTERCOM_TYPE_MAP) {
    return INTERCOM_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize an Intercom status string to a UPG status value */
export function normalizeIntercomStatus(status: string): string {
  const lower = normalizeName(status)
  return INTERCOM_STATUS_MAP[lower] ?? status
}

/** Resolve confidence for an Intercom entity_type → UPG type mapping */
export function getConfidenceForIntercomType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'company':
    case 'conversation':
    case 'article':
      return 'high'
    case 'contact':
    case 'segment':
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

// ─── Intercom Adapter ─────────────────────────────────────────────────────────

export class IntercomAdapter implements UPGAdapter {
  name = 'intercom'
  label = 'Intercom'
  description =
    'Import conversations (as support_ticket), companies (as account), articles (as document), surveys (as customer_feedback), and segments (as market_segment) from Intercom.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Intercom adapter requires Intercom API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedOutbound = 0

    // ── Pass 1: build nodes ───────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `intercom-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ────────────────────────────────────────────────
      const resolved = resolveIntercomType(entityType)

      // Explicitly unmappable types
      if (resolved === null) {
        if (entityType === 'news_item' || entityType === 'series') {
          skippedOutbound++
        } else if (entityType === 'tag' || entityType === 'messenger_app') {
          // Silent skip: these are platform metadata/config
        } else {
          warnings.push(
            `Intercom entity "${item.title}" (type "${entityType}") skipped: no UPG equivalent.`,
          )
        }
        continue
      }

      // Unknown entity_type: warn and default
      let upgEntityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Intercom entity "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgEntityType = 'document'
        mappingConfidence = 'low'
      } else {
        upgEntityType = resolved
        mappingConfidence = getConfidenceForIntercomType(entityType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Status normalisation ───────────────────────────────────────────────
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? normalizeIntercomStatus(rawStatus) : undefined

      // ── Tags ───────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }

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
        external_tool: 'intercom',
        external_id: item.source_id,
        // Preserve conversation_rating on support_ticket nodes
        ...(upgEntityType === 'support_ticket' && meta.conversation_rating !== undefined
          ? { conversation_rating: meta.conversation_rating as number }
          : {}),
      }

      nodes.push(node)
    }

    // Aggregate warning for skipped outbound entities
    if (skippedOutbound > 0) {
      warnings.push(
        `${skippedOutbound} Intercom news item${skippedOutbound > 1 ? 's' : ''} and automated series were skipped: outbound messaging campaigns are platform operations with no UPG product knowledge equivalent.`,
      )
    }

    // ── Pass 2: emit hierarchy edges ──────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined

      // Skip items that were not registered
      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue

      // ── Team ownership edge ────────────────────────────────────────────────
      // Emit node_owned_by_team when a contact_company_id or team reference is present
      const contactCompanyId = meta.contact_company_id as string | undefined
      if (contactCompanyId) {
        const companyNodeId = sourceMap[contactCompanyId]
        if (companyNodeId) {
          // contact → account (ownership relationship via company membership)
          edges.push({
            id: `edge-intercom-ownership-${nodeId}-${companyNodeId}`,
            source: nodeId,
            target: companyNodeId,
            type: 'node_informs_node' as UPGEdgeType,
            mapping_confidence: 'low',
          })
        }
      }

      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Intercom entity "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve the UPG entity type for the current item
      const resolved = resolveIntercomType(entityType)
      if (!resolved) continue

      const upgEntityType = resolved

      // Determine edge type based on parent entity type
      const parentItem = items.find((i) => i.source_id === parentId)
      if (!parentItem) continue

      const parentEntityType = (parentItem.metadata?.entity_type as string | undefined) ?? ''
      const parentResolved = resolveIntercomType(parentEntityType)

      let edgeType: UPGEdgeType | null = null

      // support_ticket → feature_request when parent is a feature_request
      if (upgEntityType === 'support_ticket') {
        if (parentResolved === 'feature_request' || parentEntityType === 'feature_request') {
          edgeType = safeEdgeType(
            'customer_feedback_becomes_feature_request',
            `Intercom: customer_feedback_becomes_feature_request not in catalog. Falling back to node_informs_node for "${item.title}".`,
            warnings,
          )
        }
      }

      // node_owned_by_team for team ownership
      const parentType = meta.parent_type as string | undefined
      if (parentType === 'team' || parentEntityType === 'team') {
        edgeType = safeEdgeType(
          'node_owned_by_team',
          `Intercom: node_owned_by_team not in catalog. Falling back to node_informs_node for "${item.title}".`,
          warnings,
        )
      }

      if (edgeType === null) {
        edges.push({
          id: `edge-intercom-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-intercom-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0 && skippedOutbound === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
