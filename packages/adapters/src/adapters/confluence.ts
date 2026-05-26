/**
 * Confluence Adapter
 *
 * Imports pages and blog posts from Confluence: Atlassian's enterprise wiki.
 * Entity type is inferred from page title patterns and labels/tags.
 *
 * Confluence is the canonical "product knowledge stored as prose" tool. This
 * adapter performs structural-level import (page → document node). AI-assisted
 * entity extraction (extracting features, decisions, OKRs from page body) is
 * a higher-fidelity path documented in the mapping doc but not implemented here.
 *
 *
 * Type inference priority:
 * 1. Page labels matching CONFLUENCE_PAGE_TYPE_MAP
 * 2. Page title pattern matching CONFLUENCE_PAGE_TYPE_MAP
 * 3. CONFLUENCE_ENTITY_TYPE_MAP by entity_type field
 * 4. Default: 'document'
 *
 * Edges: document_describes_decision for ADR/decision pages (verified in catalog).
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Maps title/label patterns to UPG entity types.
 * Keys are lowercase patterns. Values are UPG entity types or null to skip.
 */
export const CONFLUENCE_PAGE_TYPE_MAP: Record<string, string | null> = {
  adr: 'decision', // Architecture Decision Record
  decision: 'decision',
  'decision record': 'decision',
  'architecture decision': 'decision',
  rfc: 'document', // Request for Comment
  spec: 'document',
  prd: 'document', // Product Requirements Doc
  'product requirements': 'document',
  requirements: 'document',
  retrospective: 'observation', // retro = a set of observations
  retro: 'observation',
  postmortem: 'incident', // incident postmortem
  incident: 'incident',
  research: 'research_study',
  'user research': 'research_study',
  persona: 'persona',
  competitor: 'competitor',
  'competitive analysis': 'competitor',
  'meeting notes': 'observation',
  meeting: null, // generic meeting notes: skip
  announcement: null, // skip
  template: null, // skip templates
}

/**
 * Maps Confluence entity types to UPG entity types.
 * Used for the top-level entity_type classification.
 */
export const CONFLUENCE_ENTITY_TYPE_MAP: Record<string, string | null> = {
  page: 'document', // default: all Confluence pages are documents
  blogpost: 'document',
  comment: null, // skip
  attachment: null, // skip
  space: null, // space = top-level container, skip
  label: null, // metadata
}

// ─── Type inference ───────────────────────────────────────────────────────────

/**
 * Infer the UPG entity type for a Confluence page from its title and labels.
 *
 * Priority: labels (exact match) → title patterns (word boundary) → default 'document'
 *
 * Uses word-boundary matching on title to avoid substring collisions
 * (e.g. "spec" inside "retrospective").
 */
export function inferConfluencePageType(title: string, labels: string[]): string {
  const titleLower = title.toLowerCase()
  const allLabels = labels.map((l) => l.toLowerCase())

  // Check labels first (exact match)
  for (const label of allLabels) {
    if (label in CONFLUENCE_PAGE_TYPE_MAP && CONFLUENCE_PAGE_TYPE_MAP[label] !== null) {
      return CONFLUENCE_PAGE_TYPE_MAP[label] as string
    }
  }

  // Skip if a label explicitly maps to null
  for (const label of allLabels) {
    if (label in CONFLUENCE_PAGE_TYPE_MAP && CONFLUENCE_PAGE_TYPE_MAP[label] === null) {
      return '__skip__'
    }
  }

  // Helper: check whether the title contains the pattern as a whole word/phrase
  // Uses word boundaries to avoid "spec" matching inside "retrospective".
  function titleContainsPattern(pattern: string): boolean {
    // For multi-word patterns (e.g. "meeting notes"), simple substring is fine: word boundary
    // collision only happens with short single-word patterns like "spec", "rfc", "prd".
    // Wrap pattern in word-boundary regex.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|\\s|[^a-z])${escaped}(?:$|\\s|[^a-z])`, 'i')
    return re.test(titleLower)
  }

  // Check non-null title patterns
  for (const [pattern, type] of Object.entries(CONFLUENCE_PAGE_TYPE_MAP)) {
    if (type !== null && titleContainsPattern(pattern)) {
      return type
    }
  }

  // Check null patterns in title (explicit skips)
  for (const [pattern, type] of Object.entries(CONFLUENCE_PAGE_TYPE_MAP)) {
    if (type === null && titleContainsPattern(pattern)) {
      return '__skip__'
    }
  }

  return 'document' // default
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

function normalizeConfluenceStatus(status: string | undefined): string | undefined {
  if (!status) return undefined
  const lower = normalizeName(status)
  if (lower === 'current') return 'active'
  if (lower === 'draft') return 'draft'
  if (lower === 'archived') return 'abandoned'
  return undefined
}

// ─── Confluence Adapter ───────────────────────────────────────────────────────

export class ConfluenceAdapter implements UPGAdapter {
  name = 'confluence'
  label = 'Confluence'
  description =
    'Import pages and blog posts from Confluence. Maps to document, decision, research_study, persona, and other UPG entity types via title patterns and labels.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Confluence adapter requires Confluence API connection. ' +
        'Use /upg-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let defaultDocumentCount = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `confluence-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? 'page'
      const labels = Array.isArray(meta.labels) ? (meta.labels as string[]) : []

      // Check entity type first
      const entityResolved = CONFLUENCE_ENTITY_TYPE_MAP[normalizeName(entityType)]
      if (entityResolved === null) {
        // Explicitly skipped entity types (comment, attachment, space, label)
        warnings.push(
          `Confluence item "${item.title}" has entity_type "${entityType}" which has no UPG equivalent. Item skipped.`,
        )
        continue
      }

      if (entityResolved === undefined && normalizeName(entityType) !== 'page' && normalizeName(entityType) !== 'blogpost') {
        warnings.push(
          `Confluence item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document".`,
        )
      }

      // Infer the specific type from title + labels
      const inferredType = inferConfluencePageType(item.title, labels)

      if (inferredType === '__skip__') {
        warnings.push(
          `Confluence page "${item.title}" matched a skip pattern (meeting/announcement/template). Item skipped.`,
        )
        continue
      }

      const upgType = inferredType
      const mappingConfidence: 'high' | 'medium' | 'low' =
        upgType === 'document' ? 'medium' : 'high'

      if (upgType === 'document') {
        defaultDocumentCount++
      }

      sourceMap[item.source_id] = nodeId

      const rawStatus = meta.status as string | undefined
      const status = normalizeConfluenceStatus(rawStatus)

      const tags: string[] = []
      if (Array.isArray(meta.labels)) {
        tags.push(...(meta.labels as string[]))
      }
      if (meta.space_key && typeof meta.space_key === 'string') {
        tags.push(`space:${meta.space_key}`)
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(status ? { status } : {}),
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'confluence',
        external_id: item.source_id,
        ...(meta.last_modified ? { last_modified: meta.last_modified as string } : {}),
      }

      nodes.push(node)
    }

    // Emit default document warning
    if (defaultDocumentCount > 0) {
      warnings.push(
        `${defaultDocumentCount} Confluence page${defaultDocumentCount === 1 ? '' : 's'} ` +
          `were mapped to 'document' by default. Add page labels matching UPG entity types ` +
          `(e.g. 'adr', 'research', 'persona') for more accurate mapping.`,
      )
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined
      const parentType = (meta.parent_type as string | undefined) ?? ''

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Confluence item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // Determine the edge type based on parent/child pair
      const currentNode = nodes.find((n) => n.id === nodeId)
      const parentNode = nodes.find((n) => n.id === parentNodeId)

      if (!currentNode || !parentNode) continue

      let edgeType = 'node_informs_node'
      let confidence: 'high' | 'medium' | 'low' = 'low'

      // document describes decision: document_describes_decision (verified in catalog)
      if (parentNode.type === 'document' && currentNode.type === 'decision') {
        edgeType = 'document_describes_decision'
        confidence = 'high'
      } else if (parentNode.type === 'document' && currentNode.type === 'persona') {
        edgeType = 'document_describes_persona'
        confidence = 'high'
      } else if (parentNode.type === 'document' && currentNode.type === 'competitor') {
        edgeType = 'document_describes_competitor'
        confidence = 'high'
      } else {
        // Generic parent–child hierarchy → node_informs_node
        const pType = normalizeName(parentType)
        if (pType === 'page' || pType === 'blogpost') {
          edgeType = 'node_informs_node'
          confidence = 'low'
        }
      }

      edges.push({
        id: `edge-confluence-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: edgeType as UPGEdgeType,
        mapping_confidence: confidence,
      })
    }

    if (nodes.length === 0) {
      warnings.push('No Confluence items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
