/**
 * Salesforce Adapter
 *
 * Imports objects from Salesforce: the dominant enterprise CRM. Salesforce
 * organises everything around the commercial relationship: Account, Contact,
 * Lead, Opportunity (deal), Case, Campaign.
 *
 * CRITICAL NAME COLLISION: THE MOST IMPORTANT MAPPING IN THE UPG ECOSYSTEM:
 * Salesforce "Opportunity" = a sales deal (Prospecting → Closed Won).
 * UPG `opportunity` = a user problem worth solving (Teresa Torres sense).
 * They share a word. They mean COMPLETELY different things.
 * Salesforce Opportunity maps to UPG `deal`, NOT `opportunity`.
 * A batch warning is emitted once per convert() call with the count.
 *
 *
 * Edges:
 * - account → contact:       account_contains_contact
 * - account → deal:          account_negotiates_deal
 * - lead → account:          lead_becomes_account
 * - case → feature context:  customer_feedback_becomes_feature_request
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type map ─────────────────────────────────────────────────────────────────

/**
 * Maps Salesforce Standard Object API names to UPG entity types.
 *
 * Null = no UPG equivalent, skip with warning.
 * All UPG entity types verified against the live catalog.
 */
export const SALESFORCE_TYPE_MAP: Record<string, string | null> = {
  lead: 'participant',
  contact: 'participant',
  account: 'account',
  opportunity: 'deal', // CRITICAL: Salesforce Opportunity = sales deal → UPG `deal`, NOT `opportunity`
  case: 'support_ticket',
  campaign: null, // marketing campaign: skip
  product: null, // CRM product catalog: not UPG product
  pricebook: null, // skip
  contract: null, // legal document: skip
  order: null, // skip
  task: 'task', // CRM task/activity
  event: null, // calendar event: skip
  note: 'observation', // CRM note
  knowledge__kav: 'document', // Salesforce Knowledge article
  idea: 'feature_request', // Salesforce Ideas community
}

// ─── Status normalisation ─────────────────────────────────────────────────────

/**
 * Maps Salesforce status/stage values to UPG status values.
 *
 * Covers Case statuses, Lead statuses, and Opportunity stage names.
 * Stage names are lowercase for consistent matching.
 */
export const SALESFORCE_STATUS_MAP: Record<string, string> = {
  new: 'draft',
  open: 'active',
  working: 'active',
  escalated: 'active',
  closed: 'complete',
  prospecting: 'draft',
  qualification: 'active',
  proposal: 'active',
  negotiation: 'active',
  'closed won': 'complete',
  'closed lost': 'abandoned',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a string for map lookup: lowercase, trimmed */
function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

/** Resolve a Salesforce object type to a UPG entity type */
export function resolveSalesforceType(objectType: string): string | null | undefined {
  const lower = normalizeName(objectType)
  if (lower in SALESFORCE_TYPE_MAP) {
    return SALESFORCE_TYPE_MAP[lower]
  }
  return undefined
}

/** Normalize a Salesforce status/stage string to a UPG status value */
export function normalizeSalesforceStatus(status: string): string {
  const lower = normalizeName(status)
  return SALESFORCE_STATUS_MAP[lower] ?? status
}

/** Resolve mapping confidence for a Salesforce object type */
export function getSalesforceConfidence(objectType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(objectType)
  switch (lower) {
    case 'account':
    case 'contact':
    case 'lead':
    case 'opportunity': // maps to deal: confidence is high because it's an exact concept match
    case 'case':
      return 'high'
    case 'task':
    case 'note':
    case 'knowledge__kav':
    case 'idea':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Salesforce Adapter ───────────────────────────────────────────────────────

export class SalesforceAdapter implements UPGAdapter {
  name = 'salesforce'
  label = 'Salesforce'
  description =
    'Import Account, Contact, Lead, Opportunity (deal), Case, Knowledge, and Ideas from Salesforce.'

  /**
   * List available Salesforce objects.
   *
   * Requires Salesforce Connected App with OAuth 2.0. Pre-fetched objects
   * may be passed via config.items when API access is not available.
   */
  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Salesforce adapter requires Salesforce Connected App OAuth token. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.items.',
    )
  }

  /**
   * Convert Salesforce source items to UPG entities.
   *
   * Mapping logic:
   * - metadata.entity_type discriminates the UPG entity type (via SALESFORCE_TYPE_MAP)
   * - metadata.parent_id + metadata.parent_type → hierarchy edges
   * - metadata.status + metadata.stage → normalised UPG status
   * - metadata.tags → node tags
   * - Salesforce Opportunity → UPG `deal` (NOT `opportunity`)
   *   Batch warning emitted once with the total count at the end
   * - Calendar events (event), campaigns → skipped with warning
   * - Unknown types → warning + default to 'document'
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let opportunityCount = 0

    for (const item of items) {
      counter++
      const nodeId = `salesforce-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const objectType = (meta.entity_type as string | undefined) ?? ''

      // ── Resolve entity type ──────────────────────────────────────────────
      const resolved = resolveSalesforceType(objectType)

      // Explicitly unmappable types (campaign, event, contract, etc.): skip
      if (resolved === null) {
        warnings.push(
          `Salesforce object "${item.title}" has type "${objectType}" which has no UPG equivalent ` +
            `(marketing campaigns, calendar events, and contracts are operational records). ` +
            `Object skipped.`,
        )
        continue
      }

      // Unknown type: warn and default
      let entityType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Salesforce object "${item.title}" has unknown type "${objectType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        entityType = 'document'
        mappingConfidence = 'low'
      } else {
        entityType = resolved
        mappingConfidence = getSalesforceConfidence(objectType)
      }

      // Register in sourceMap before any continue paths
      sourceMap[item.source_id] = nodeId

      // ── Count Opportunity records for batch warning ──────────────────────
      if (normalizeName(objectType) === 'opportunity') {
        opportunityCount++
      }

      // ── Normalise status ─────────────────────────────────────────────────
      const rawStatus =
        (meta.stage as string | undefined) ?? (meta.status as string | undefined)
      const status = rawStatus ? normalizeSalesforceStatus(rawStatus) : undefined

      // ── Tags ─────────────────────────────────────────────────────────────
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      // Preserve case origin as a tag
      if (meta.case_origin) {
        tags.push(`origin:${meta.case_origin as string}`)
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
        external_tool: 'salesforce',
        external_id: item.source_id,
        // Deal-specific fields
        ...(entityType === 'deal' && meta.amount !== undefined
          ? { amount: meta.amount as number }
          : {}),
      }

      nodes.push(node)
    }

    // ── CRITICAL: Opportunity batch warning ──────────────────────────────────
    // Emitted once, after all items are processed: not per-item
    if (opportunityCount > 0) {
      warnings.push(
        `${opportunityCount} Salesforce Opportunity record${opportunityCount === 1 ? '' : 's'} mapped to UPG \`deal\` (not \`opportunity\`). ` +
          `Salesforce's 'Opportunity' object represents a sales deal (Prospecting→Closed Won). ` +
          `UPG's \`opportunity\` entity represents a user problem worth solving. ` +
          `These are fundamentally different concepts. ` +
          `See salesforce-mapping.md for the full explanation.`,
      )
    }

    // ── Second pass: emit hierarchy edges ────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const objectType = (meta.entity_type as string | undefined) ?? ''
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Salesforce object "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      const edgeResult = resolveSalesforceEdge(parentType, objectType, item.title, warnings)

      if (edgeResult === null) {
        // Unrecognised pair: emit generic informational edge with low confidence
        edges.push({
          id: `edge-salesforce-${parentNodeId}-${nodeId}`,
          source: parentNodeId,
          target: nodeId,
          type: 'node_informs_node' as UPGEdgeType,
          mapping_confidence: 'low',
        })
        continue
      }

      edges.push({
        id: `edge-salesforce-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeResult as UPGEdgeType,
        mapping_confidence: 'medium',
      })
    }

    if (nodes.length === 0) {
      warnings.push('No objects were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}

// ─── Edge resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical UPG edge for a Salesforce parent_type → object_type pair.
 *
 * Returns a UPG edge type string, or null for unrecognised pairs
 * (caller emits node_informs_node fallback).
 *
 * All emitted edge types are verified against the live UPG edge catalogue.
 */
function resolveSalesforceEdge(
  parentType: string,
  childType: string,
  _itemTitle: string,
  _warnings: string[],
): string | null {
  const parent = normalizeName(parentType)
  const child = normalizeName(childType)

  // account → contact
  if (parent === 'account' && child === 'contact') {
    return 'account_contains_contact'
  }

  // account → opportunity (deal)
  if (parent === 'account' && child === 'opportunity') {
    return 'account_negotiates_deal'
  }

  // lead → account (after conversion)
  if (parent === 'lead' && child === 'account') {
    return 'lead_becomes_account'
  }

  // case → feature request context (when a Case generates a feature request)
  if (parent === 'case' && child === 'idea') {
    return 'customer_feedback_becomes_feature_request'
  }

  // account → case (support ticket belongs to account)
  // UPG edge: support_ticket_reveals_need: applicable when case reveals a product need
  // Here we use the structural relationship: support ticket under account
  if (parent === 'account' && child === 'case') {
    return null // no exact structural edge for account→support_ticket; use fallback
  }

  return null
}
