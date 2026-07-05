/**
 * HubSpot Adapter
 *
 * Imports entities from HubSpot: the CRM + marketing + service platform for
 * growing companies. HubSpot organises everything as CRM Objects: Contact,
 * Company, Deal, Ticket, and a large set of marketing/service entities.
 *
 * CRITICAL NAME MAPPING:
 * HubSpot "Deal" = a sales deal (pipeline stage: appointment → closed won).
 * UPG `deal` = a sales deal.
 * UPG `opportunity` = a user problem worth solving (Teresa Torres / discovery sense).
 * HubSpot Deal maps to UPG `deal`, NOT `opportunity`. This is emitted as a
 * mandatory warning on every Deal import.
 *
 *
 * Edges:
 * - feedback_submission → feature context: customer_feedback_becomes_feature_request
 * - node → team:                            node_owned_by_team (polymorphic)
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import { resolvePairEdge } from './resolve-pair-edge.js'
import { getLifecycleForType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps HubSpot CRM object types to UPG entity types.
 *
 * Null = no UPG equivalent, skip with warning.
 * All UPG entity types verified against the live catalog.
 */
export const HUBSPOT_TYPE_MAP: Record<string, string | null> = {
  contact: 'participant',
  company: 'account',
  deal: 'deal', // CRITICAL: HubSpot Deal = sales deal → UPG `deal`, NOT `opportunity`
  ticket: 'support_ticket',
  feedback_submission: 'customer_feedback',
  note: 'observation', // CRM note/activity
  meeting: null, // calendar event: skip
  call: null, // call log: skip
  email: null, // email activity: skip
  task: 'task', // CRM task
  product: null, // CRM product line: not a UPG product
  line_item: null, // order line item: skip
  quote: null, // sales quote: skip
  workflow: null, // marketing automation: skip
  list: 'market_segment', // contact list / segment
  form: null, // web form: skip
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps HubSpot status values to UPG lifecycle phase ids.
 *
 * Values are real phase ids from each type's lifecycle:
 * - support_ticket: open, triaged, in_progress, resolved, closed
 * - deal: qualified, proposal, negotiation, closed_won, closed_lost
 *
 * Lifecycle-free types (participant, account, observation, market_segment)
 * never have a status set; resolveHubSpotStatusForType() returns undefined for them.
 */
export const HUBSPOT_STATUS_MAP: Record<string, string> = {
  // Ticket statuses → support_ticket phases
  new: 'open',
  open: 'open',
  in_progress: 'in_progress',
  waiting: 'triaged',
  closed: 'closed',
  resolved: 'resolved',
  // Deal stages → deal phases (raw values already match phase ids)
  closed_won: 'closed_won',
  closed_lost: 'closed_lost',
  // Generic fallbacks
  deferred: 'closed_lost', // closest deal phase; closed for tickets
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a HubSpot object type to a UPG entity type */
export function resolveHubSpotType(objectType: string): string | null | undefined {
  const lower = normalizeName(objectType)
  if (lower in HUBSPOT_TYPE_MAP) {
    return HUBSPOT_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a HubSpot status string to a UPG status value (raw map lookup) */
export function normalizeHubSpotStatus(status: string): string {
  const lower = normalizeName(status)
  return HUBSPOT_STATUS_MAP[lower] ?? status
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
 * Resolve a HubSpot status to one valid for the target type's lifecycle.
 * Returns undefined for lifecycle-free types or when no valid mapping exists.
 */
function resolveHubSpotStatusForType(rawStatus: string, upgType: string): string | undefined {
  const valid = validStatusesForType(upgType)
  if (!valid) return undefined
  const raw = normalizeName(rawStatus)
  if (valid.has(raw)) return raw
  const mapped = HUBSPOT_STATUS_MAP[raw]
  return mapped && valid.has(mapped) ? mapped : undefined
}

/** Resolve mapping confidence for a HubSpot object type */
export function getHubSpotConfidence(objectType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(objectType)
  switch (lower) {
    case 'company':
    case 'contact':
    case 'deal':
    case 'ticket':
    case 'task':
      return 'high'
    case 'feedback_submission':
    case 'note':
    case 'list':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── HubSpot Adapter ──────────────────────────────────────────────────────────

export class HubSpotAdapter implements UPGAdapter {
  name = 'hubspot'
  label = 'HubSpot'
  description =
    'Import Contact, Company, Deal, Ticket, Feedback, Notes, and Lists from HubSpot.'

  /**
   * List available HubSpot CRM objects.
   *
   * Requires HubSpot Private App token or OAuth 2.0. Pre-fetched objects
   * may be passed via config.items when API access is not available.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'HubSpot adapter requires HubSpot API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert HubSpot source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via HUBSPOT_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status + metadata.deal_stage → normalised UPG status
   * - metadata.lifecycle_stage → preserved as tag
   * - metadata.tags → node tags
   * - HubSpot Deal → UPG `deal` (NOT `opportunity`): mandatory warning emitted per deal
   * - Calendar/activity types (meeting, call, email) → skipped with warning
   * - Unknown types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0

    for (const item of items) {
      counter++
      const nodeId = `hubspot-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const objectType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ──────────────────────────────────────────────
      const resolved = resolveHubSpotType(objectType)

      // Explicitly unmappable types (meeting, call, email, etc.): skip
      if (resolved === null) {
        warnings.push(
          `HubSpot object "${item.title}" has type "${objectType}" which has no UPG equivalent ` +
            `(calendar events, call logs, and email activities are operational records, not product knowledge). ` +
            `Object skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `HubSpot object "${item.title}" has unknown type "${objectType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        entityType = 'document'
        mappingConfidence = 'low'
      } else {
        entityType = resolved
        mappingConfidence = getHubSpotConfidence(objectType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── CRITICAL: Deal name collision warning ────────────────────────────
      if (objectType === 'deal') {
        warnings.push(
          `HubSpot Deal "${item.title}" maps to UPG \`deal\` (a sales opportunity/transaction), ` +
            `NOT UPG \`opportunity\` (a user problem worth solving). ` +
            `These are different concepts. ` +
            `If this deal represents a user problem, create a separate \`opportunity\` node.`,
        )
      }

      // ── Normalise status (validated against the target type's lifecycle) ─
      const rawStatus =
        (meta.deal_stage as string | undefined) ?? (meta.status as string | undefined)
      const status = rawStatus ? resolveHubSpotStatusForType(rawStatus, entityType) : undefined

      // ── Tags ─────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve lifecycle_stage as a tag
      if (meta.lifecycle_stage) {
        tags.push(`lifecycle:${meta.lifecycle_stage as string}`)
      }

      // ── Build the UPG node ───────────────────────────────────────────────
      const node: UPGBaseNode = {
        id: nodeId,
        type: entityType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'hubspot',
        external_id: item.source_id,
        // Deal-specific numeric fields belong under properties (off-schema fields
        // are silently dropped by the .upg writer; nesting preserves them).
        ...(entityType === 'deal'
          ? (() => {
              const p: Record<string, unknown> = {}
              if (meta.amount !== undefined) p.amount = meta.amount as number
              if (meta.mrr !== undefined) p.mrr = meta.mrr as number
              if (meta.arr !== undefined) p.arr = meta.arr as number
              return Object.keys(p).length > 0 ? { properties: p } : {}
            })()
          : {}),
      }

      nodes.push(node)
    }

    // ── Second pass: emit hierarchy edges (catalogue-driven) ─────────────────
    // Build a nodeId → UPG type map so we can look up canonical edge types.
    const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type as string]))

    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `HubSpot object "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Resolve canonical edge via the catalogue using the actual UPG types.
      const parentUpgType = nodeTypeById.get(parentNodeId)
      const childUpgType = nodeTypeById.get(nodeId)

      if (!parentUpgType || !childUpgType) continue

      const mapped = resolvePairEdge(parentUpgType, childUpgType)
      const edgeSource = mapped?.sourceIsChild ? nodeId : parentNodeId
      const edgeTarget = mapped?.sourceIsChild ? parentNodeId : nodeId
      const edgeType = (mapped ? mapped.type : 'node_informs_node') as UPGEdgeType

      edges.push({
        id: `edge-hubspot-${edgeSource}-${edgeTarget}`,
        source: edgeSource,
        target: edgeTarget,
        type: edgeType,
        mapping_confidence: mapped ? 'medium' : 'low',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No objects were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

