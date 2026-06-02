/**
 * Slack Adapter
 *
 * Imports structured artifacts from Slack: the team communication platform.
 * Slack adapters are intentionally shallow: regular messages and threads are
 * unstructured communication, not product knowledge entities.
 *
 * This adapter focuses on specific structured artifacts:
 * - Pinned messages → observation (a noteworthy, team-endorsed observation)
 * - Bookmarks → document (a channel reference/resource)
 * - Canvases → document (a structured collaborative document)
 * - Files → document (a shared file reference)
 *
 * The `channel_name` is added as a tag on all imported nodes.
 *
 *
 * IMPORTANT: Regular Slack messages and threads are always skipped with
 * explicit count-based warnings recommending a selective capture flow
 * (a Slack capture integration in the host application).
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type maps ────────────────────────────────────────────────────────────────

/**
 * Maps Slack entity types to UPG entity types.
 * Null = skip with warning.
 */
export const SLACK_TYPE_MAP: Record<string, string | null> = {
  pinned_message: 'observation', // a pinned message = a noteworthy observation
  bookmark: 'document', // a channel bookmark = a reference document
  canvas: 'document', // a Slack canvas = a structured document
  canvas_section: null, // canvas sections are structural: skip
  message: null, // regular messages: skip (unstructured)
  thread: null, // thread: skip
  channel: null, // channel: skip (communication container)
  workspace: null, // skip
  workflow: null, // automation: skip
  file: 'document', // shared file = a document reference
  reminder: null, // operational: skip
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().trim()
}

export function getConfidenceForSlackType(entityType: string): 'high' | 'medium' | 'low' {
  const lower = normalizeName(entityType)
  switch (lower) {
    case 'canvas':
    case 'bookmark':
      return 'high'
    case 'pinned_message':
    case 'file':
      return 'medium'
    default:
      return 'low'
  }
}

// ─── Slack Adapter ────────────────────────────────────────────────────────────

export class SlackAdapter implements UPGAdapter {
  name = 'slack'
  label = 'Slack'
  description =
    'Import structured Slack artifacts (pinned messages, bookmarks, canvases, files) into UPG. Regular messages and threads are intentionally excluded.'

  async list(_config: AdapterConfig): Promise<SourceItem[]> {
    throw new Error(
      'Slack adapter requires Slack API connection. ' +
        'Use /upg-sync-import to connect, or pass pre-fetched items via config.',
    )
  }

  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    let counter = 0
    let skippedMessages = 0
    let skippedThreads = 0
    let skippedOther = 0

    // ── Pass 1: build nodes ─────────────────────────────────────────────────
    for (const item of items) {
      counter++
      const nodeId = `slack-import-${Date.now()}-${counter}`
      const meta = item.metadata ?? {}
      const entityType = (meta.entity_type as string | undefined) ?? ''
      const channelName = (meta.channel_name as string | undefined) ?? undefined

      // Count skipped items separately for targeted warnings
      const lower = normalizeName(entityType)
      if (lower === 'message') {
        skippedMessages++
        continue
      }
      if (lower === 'thread') {
        skippedThreads++
        continue
      }

      const resolved = SLACK_TYPE_MAP[lower]

      // Explicitly null types (canvas_section, channel, workspace, workflow, reminder)
      if (resolved === null) {
        skippedOther++
        continue
      }

      // Unknown type
      let upgType: string
      let mappingConfidence: 'high' | 'medium' | 'low'

      if (resolved === undefined) {
        warnings.push(
          `Slack item "${item.title}" has unknown entity_type "${entityType}". ` +
            `Defaulting to "document". Update the adapter if this type should be mapped.`,
        )
        upgType = 'document'
        mappingConfidence = 'low'
      } else {
        upgType = resolved
        mappingConfidence = getConfidenceForSlackType(entityType)
      }

      sourceMap[item.source_id] = nodeId

      // Add channel_name as a tag
      const tags: string[] = []
      if (Array.isArray(meta.tags)) {
        tags.push(...(meta.tags as string[]))
      }
      if (channelName) {
        tags.push(`channel:${channelName}`)
      }
      if (meta.author && typeof meta.author === 'string') {
        tags.push(`author:${meta.author}`)
      }

      const node: UPGBaseNode = {
        id: nodeId,
        type: upgType as UPGEntityType,
        title: item.title,
        ...(item.content ? { description: item.content } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        // Slack status is not applicable to most entities: omit
        source_id: item.source_id,
        source_type: item.source_type,
        mapping_confidence: mappingConfidence,
        external_tool: 'slack',
        external_id: item.source_id,
        ...(meta.channel_name ? { channel_name: meta.channel_name as string } : {}),
      }

      nodes.push(node)
    }

    // Emit targeted warnings for skipped items
    if (skippedMessages > 0) {
      const msgPlural = skippedMessages === 1
      warnings.push(
        `${skippedMessages} regular Slack message${msgPlural ? '' : 's'} ${msgPlural ? 'was' : 'were'} skipped. ` +
          `Unstructured conversational messages sit outside the product knowledge graph. ` +
          `Use a Slack capture integration to selectively promote specific messages ` +
          `into UPG entities.`,
      )
    }

    if (skippedThreads > 0) {
      const thrdPlural = skippedThreads === 1
      warnings.push(
        `${skippedThreads} Slack thread${thrdPlural ? '' : 's'} skipped: ` +
          `use a Slack capture integration for selective thread import.`,
      )
    }

    // ── Pass 2: emit edges ──────────────────────────────────────────────────
    for (const item of items) {
      const meta = item.metadata ?? {}
      const parentId = meta.parent_id as string | undefined

      const nodeId = sourceMap[item.source_id]
      if (!nodeId) continue
      if (!parentId) continue

      const parentNodeId = sourceMap[parentId]
      if (!parentNodeId) {
        warnings.push(
          `Slack item "${item.title}" references parent_id "${parentId}" which was not found ` +
            `in the imported set. Edge skipped.`,
        )
        continue
      }

      // All Slack structural parent-child relationships use node_informs_node
      // (canvases within channels, etc.: no typed product edges)
      edges.push({
        id: `edge-slack-${parentNodeId}-${nodeId}`,
        source: parentNodeId,
        target: nodeId,
        type: 'node_informs_node' as UPGEdgeType,
        mapping_confidence: 'low',
      })
    }

    if (nodes.length === 0 && skippedMessages === 0 && skippedThreads === 0) {
      warnings.push('No Slack items were converted. Check that source items were provided.')
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
