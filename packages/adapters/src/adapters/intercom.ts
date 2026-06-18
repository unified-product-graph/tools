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

import { getLifecycleForType, UPG_EDGE_PAIR_MAP } from '@unified-product-graph/core'
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
  team: 'team',                    // Intercom team; needed as node_owned_by_team target
  feature_request: 'feature_request', // pass-through for edge resolution (pre-seeded)
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps raw Intercom status strings to candidate UPG phase ids, keyed by
 * target UPG type. Entries are tried AFTER the raw value is checked against
 * the type's own lifecycle, so only values that are NOT direct phase ids need
 * to appear here.
 */
export const INTERCOM_STATUS_MAP: Record<string, Record<string, string>> = {
  support_ticket: {
    open: 'opened',
    pending: 'triaged',
    snoozed: 'in_progress',
    closed: 'closed',
  },
  customer_feedback: {
    open: 'received',
    pending: 'triaged',
    snoozed: 'triaged',
    closed: 'acknowledged',
  },
  document: {
    open: 'draft',
    pending: 'draft',
    snoozed: 'draft',
    closed: 'archived',
  },
  feature_request: {
    open: 'new',
    pending: 'under_review',
    snoozed: 'under_review',
    closed: 'wont_do',
  },
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
 * Resolve an Intercom status string to a phase id valid for the target type's
 * lifecycle. Returns undefined for lifecycle-free types or when no mapping exists.
 */
export function resolveIntercomStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const typeMap = INTERCOM_STATUS_MAP[upgType] ?? {}
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

// ─── Intercom Adapter ─────────────────────────────────────────────────────────

export class IntercomAdapter implements UPGAdapter {
  name = 'intercom'
  label = 'Intercom'
  description =
    'Import conversations (as support_ticket), companies (as account), articles (as document), surveys (as customer_feedback), and segments (as market_segment) from Intercom.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Intercom adapter requires Intercom API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
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

      // ── Status normalisation (validated against target type's lifecycle) ──
      const rawStatus = meta.status as string | undefined
      const status = rawStatus ? resolveIntercomStatusForType(rawStatus, upgEntityType) : undefined

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
        // Preserve conversation_rating under properties so it survives the .upg writer
        ...(upgEntityType === 'support_ticket' && meta.conversation_rating !== undefined
          ? { properties: { conversation_rating: meta.conversation_rating as number } }
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

      // ── Company membership edge (contact_company_id) ───────────────────────
      // participant → account via company membership; node_informs_node (polymorphic)
      const contactCompanyId = meta.contact_company_id as string | undefined
      if (contactCompanyId) {
        const companyNodeId = sourceMap[contactCompanyId]
        if (companyNodeId) {
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

      const parentItem = items.find((i) => i.source_id === parentId)
      if (!parentItem) continue

      const parentEntityType = (parentItem.metadata?.entity_type as string | undefined) ?? ''
      const parentResolved = resolveIntercomType(parentEntityType)
      const parentUpg = (parentResolved as string | null | undefined) ?? 'document'
      const childUpg = upgEntityType

      // ── Team ownership: node_owned_by_team (polymorphic pair, explicit) ────
      // UPG_EDGE_PAIR_MAP has 'node:team' but not typed source:team pairs.
      // Direction: source = owned entity (child), target = team (parent).
      if (parentUpg === 'team') {
        edges.push({
          id: `edge-intercom-${nodeId}-${parentNodeId}`,
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
          id: `edge-intercom-${parentNodeId}-${nodeId}`,
          source,
          target,
          type: mapped.type as UPGEdgeType,
          mapping_confidence: 'medium',
        })
      } else {
        edges.push({
          id: `edge-intercom-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        warnings.push(
          `No canonical UPG edge for Intercom ${parentEntityType || 'parent'} -> ${entityType || 'child'} ` +
            `(${parentUpg} -> ${childUpg}); emitted node_informs_node as a generic link.`,
        )
      }
    }

    if (nodes.length === 0 && skippedOutbound === 0) {
      warnings.push('No entities were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
