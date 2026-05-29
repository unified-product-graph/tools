/**
 * Cloud-sync tools: read sync state, pull cloud changes, push local graph.
 * Bridges a `.upg` file with a UPG Cloud product. Heaviest network-touching
 * tool family (HTTP fetch + `.upg-sync` filesystem writes). Errors surface as
 * `textError`s so MCP clients see structured failures.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import type { SyncState } from '../lib/server-context.js'
import { nodeId, edgeId } from '@unified-product-graph/sdk'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType } from '@unified-product-graph/core'

/**
 * Read the `.upg-sync` file for the active product. Returns cloud product
 * ID, ID mappings, and last-sync timestamp. Returns `synced: false` (with a
 * helpful message) if no sync file exists, meaning the product has never
 * been pushed to the cloud.
 *
 * @returns JSON: `{ synced: false, message }` or
 *   `{ synced: true, cloud_endpoint, product_id, last_synced_at,
 *   mapped_nodes, mapped_edges, last_snapshot_hash }`.
 * @atomicity atomic (read-only)
 * @see push_to_cloud
 * @see apply_pull_changeset
 * @see get_workspace_info
 * @see get_changes
 */
export const getSyncState: ToolHandler = async (_args, ctx): Promise<ToolResult> => {
  const { store, sync } = ctx
  try {
    const syncState = await sync.readSyncState(store.getFilePath())
    if (!syncState) {
      return text(JSON.stringify({ synced: false, message: 'No .upg-sync file found. This product has never been pushed to the cloud.' }, null, 2))
    }
    return text(JSON.stringify({
      synced: true,
      cloud_endpoint: syncState.cloud_endpoint,
      product_id: syncState.product_id,
      last_synced_at: syncState.last_synced_at,
      mapped_nodes: Object.keys(syncState.node_id_map).length,
      mapped_edges: Object.keys(syncState.edge_id_map).length,
      last_snapshot_hash: syncState.last_snapshot_hash,
    }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Apply cloud changes to the local `.upg` file. Takes cloud nodes and edges
 * (from `export_upg_document` on the cloud server), computes what changed,
 * and merges into the local graph. Updates `.upg-sync` with new mappings.
 *
 * Strategies:
 *  - `cloud_wins` (default): cloud values overwrite local conflicts.
 *  - `local_wins`: keep local values; cloud changes are skipped on conflict.
 *  - `merge`: report conflicts without resolving; caller picks per field.
 *
 * @returns JSON: `{ nodes_created, nodes_updated, nodes_deleted,
 *   edges_created, edges_deleted, strategy, conflicts?, message? }`.
 * @throws Returns a textError when `cloud_nodes`, `cloud_edges`, or
 *   `cloud_product_id` is missing, or when sync-state I/O fails.
 * @atomicity non-atomic. Node/edge mutations apply incrementally; a partial
 *   failure mid-application leaves the graph in a half-merged state. The
 *   `.upg-sync` file is updated after the merge sweep so its hashes reflect
 *   whatever landed.
 * @warning Mutates the active product. Always call `get_workspace_info`
 *   first to confirm the right product is loaded; otherwise cloud changes
 *   land in the wrong file. `merge` strategy returns conflicts without
 *   applying them; the caller must re-run with `cloud_wins`/`local_wins`
 *   to commit.
 * @see push_to_cloud
 * @see get_sync_state
 * @see get_workspace_info
 * @see get_changes
 */
export const applyPullChangeset: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store, sync } = ctx
  const cloudNodes = args.cloud_nodes as Array<Record<string, unknown>> | undefined
  const cloudEdges = args.cloud_edges as Array<Record<string, unknown>> | undefined
  const cloudProductId = args.cloud_product_id as string | undefined
  const cloudEndpoint = (args.cloud_endpoint as string) ?? 'https://cloud.unifiedproductgraph.org'
  const strategy = (args.strategy as string) ?? 'cloud_wins'

  if (!cloudNodes) return textError('Missing required parameter: cloud_nodes')
  if (!cloudEdges) return textError('Missing required parameter: cloud_edges')
  if (!cloudProductId) return textError('Missing required parameter: cloud_product_id')

  try {
    const existingSyncState = await sync.readSyncState(store.getFilePath())

    const localNodes = new Map(store.getAllNodes().map((n) => [n.id, n]))
    const localEdges = new Map(store.getAllEdges().map((e) => [e.id, e]))
    void localEdges

    const nodeIdMap: Record<string, string> = existingSyncState?.node_id_map ?? {}
    const edgeIdMap: Record<string, string> = existingSyncState?.edge_id_map ?? {}
    const reverseNodeMap = new Map<string, string>()
    for (const [localId, cloudId] of Object.entries(nodeIdMap)) {
      reverseNodeMap.set(cloudId, localId)
    }

    let nodesCreated = 0
    let nodesUpdated = 0
    let nodesDeleted = 0
    let edgesCreated = 0
    let edgesDeleted = 0
    const conflicts: Array<{ local_id: string; cloud_id: string; field: string; local_value: unknown; cloud_value: unknown }> = []

    for (const cn of cloudNodes) {
      const cloudId = cn.id as string
      const localId = reverseNodeMap.get(cloudId)

      if (!localId) {
        const newLocalId = nodeId()
        const newNode: UPGBaseNode = {
          id: newLocalId,
          type: cn.type as UPGEntityType,
          title: cn.title as string,
        }
        if (cn.description) newNode.description = cn.description as string
        if (cn.status) newNode.status = cn.status as string
        if (cn.tags) newNode.tags = cn.tags as string[]
        if (cn.data) newNode.properties = cn.data as Record<string, unknown>
        store.addNode(newNode)
        nodeIdMap[newLocalId] = cloudId
        nodesCreated++
      } else {
        const localNode = localNodes.get(localId)
        if (!localNode) continue

        const cloudTitle = cn.title as string
        const cloudDesc = (cn.description as string) ?? ''
        const cloudStatus = (cn.status as string) ?? 'active'

        const titleChanged = localNode.title !== cloudTitle
        const descChanged = (localNode.description ?? '') !== cloudDesc
        const statusChanged = (localNode.status ?? 'active') !== cloudStatus

        if (titleChanged || descChanged || statusChanged) {
          if (strategy === 'cloud_wins') {
            const patch: Partial<UPGBaseNode> = {}
            if (titleChanged) patch.title = cloudTitle
            if (descChanged) patch.description = cloudDesc
            if (statusChanged) patch.status = cloudStatus
            store.updateNode(localId, patch)
            nodesUpdated++
          } else if (strategy === 'local_wins') {
            // no-op
          } else {
            if (titleChanged) conflicts.push({ local_id: localId, cloud_id: cloudId, field: 'title', local_value: localNode.title, cloud_value: cloudTitle })
            if (descChanged) conflicts.push({ local_id: localId, cloud_id: cloudId, field: 'description', local_value: localNode.description, cloud_value: cloudDesc })
            if (statusChanged) conflicts.push({ local_id: localId, cloud_id: cloudId, field: 'status', local_value: localNode.status, cloud_value: cloudStatus })
          }
        }
      }
    }

    const cloudNodeIds = new Set(cloudNodes.map((n) => n.id as string))
    for (const [localId, cloudId] of Object.entries(nodeIdMap)) {
      if (!cloudNodeIds.has(cloudId) && localNodes.has(localId)) {
        store.removeNode(localId)
        delete nodeIdMap[localId]
        nodesDeleted++
      }
    }

    const reverseEdgeMap = new Map<string, string>()
    for (const [localId, cloudId] of Object.entries(edgeIdMap)) {
      reverseEdgeMap.set(cloudId, localId)
    }

    for (const ce of cloudEdges) {
      const cloudEdgeId = ce.id as string
      const localEdgeId = reverseEdgeMap.get(cloudEdgeId)
      if (!localEdgeId) {
        const sourceCloudId = (ce.source_id as string)
        const targetCloudId = (ce.target_id as string)
        const sourceLocalId = reverseNodeMap.get(sourceCloudId) ?? Object.entries(nodeIdMap).find(([, v]) => v === sourceCloudId)?.[0]
        const targetLocalId = reverseNodeMap.get(targetCloudId) ?? Object.entries(nodeIdMap).find(([, v]) => v === targetCloudId)?.[0]
        if (sourceLocalId && targetLocalId && store.getNode(sourceLocalId) && store.getNode(targetLocalId)) {
          const newEdge: UPGEdge = {
            id: edgeId(),
            source: sourceLocalId,
            target: targetLocalId,
            type: ((ce.edge_type as string) ?? 'related_to') as UPGEdgeType,
          }
          store.addEdge(newEdge)
          edgeIdMap[newEdge.id] = cloudEdgeId
          edgesCreated++
        }
      }
    }

    const cloudEdgeIds = new Set(cloudEdges.map((e) => e.id as string))
    for (const [localId, cloudId] of Object.entries(edgeIdMap)) {
      if (!cloudEdgeIds.has(cloudId) && store.getEdge(localId)) {
        store.removeEdge(localId)
        delete edgeIdMap[localId]
        edgesDeleted++
      }
    }

    const snapshotHash = await sync.hashFile(store.getFilePath())
    const newSyncState: SyncState = {
      cloud_endpoint: cloudEndpoint,
      product_id: cloudProductId,
      last_synced_at: new Date().toISOString(),
      node_id_map: nodeIdMap,
      edge_id_map: edgeIdMap,
      last_snapshot_hash: snapshotHash,
    }
    await sync.writeSyncState(store.getFilePath(), newSyncState)

    const result: Record<string, unknown> = {
      nodes_created: nodesCreated,
      nodes_updated: nodesUpdated,
      nodes_deleted: nodesDeleted,
      edges_created: edgesCreated,
      edges_deleted: edgesDeleted,
      strategy,
    }
    if (conflicts.length > 0) {
      result.conflicts = conflicts
      result.message = `${conflicts.length} conflict(s) detected. Resolve manually or re-run with cloud_wins/local_wins strategy.`
    }

    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Push the current local graph to the cloud in one call. Reads the
 * in-memory graph (no file read needed), POSTs it to the cloud import
 * endpoint, and creates/updates the `.upg-sync` file with ID mappings.
 * Auto-discovers `cloud_endpoint` and `api_key` from `.mcp.json` (the
 * `upg-cloud` server entry) when not provided. Recommended call from Claude
 * Code (zero context cost).
 *
 * @returns JSON: `{ success, product_id, nodes_created, edges_created,
 *   errors, sync_file_updated }`.
 * @throws Returns a textError when credentials cannot be resolved, the cloud
 *   returns a non-2xx response, or the sync file write fails.
 * @atomicity non-atomic. Performs an HTTP round-trip and then writes the
 *   sync file as a separate filesystem mutation. A partial failure (e.g.
 *   cloud accepted some entities, then network broke) is reflected in the
 *   `errors` array; the sync file is only updated when the import call
 *   succeeds.
 * @warning Pushes the **currently-loaded** product. Call
 *   `get_workspace_info` first to confirm. Auto-discovers credentials
 *   from `.mcp.json`'s `upg-cloud` server entry; falls back to explicit
 *   `cloud_endpoint` + `api_key` arguments. Default `strategy: 'create_new'`
 *   creates a fresh cloud product on every call; pass `product_id` to
 *   target an existing one.
 * @see apply_pull_changeset
 * @see get_sync_state
 * @see get_workspace_info
 */
export const pushToCloud: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store, sync } = ctx
  let cloudEndpoint = args.cloud_endpoint as string | undefined
  let apiKey = args.api_key as string | undefined
  const strategy = (args.strategy as string) ?? 'create_new'
  const productId = args.product_id as string | undefined

  if (!cloudEndpoint || !apiKey) {
    try {
      const mcpConfigPath = path.join(process.cwd(), '.mcp.json')
      const mcpRaw = await fsp.readFile(mcpConfigPath, 'utf-8')
      const mcpConfig = JSON.parse(mcpRaw) as {
        mcpServers?: Record<string, {
          url?: string
          headers?: Record<string, string>
          env?: Record<string, string>
        }>
      }
      const upgCloud = mcpConfig.mcpServers?.['upg-cloud']
      if (upgCloud) {
        if (!cloudEndpoint && upgCloud.url) {
          cloudEndpoint = upgCloud.url.replace(/\/api\/mcp\/?$/, '')
        }
        if (!apiKey && upgCloud.headers?.['Authorization']) {
          const authHeader = upgCloud.headers['Authorization']
          const match = authHeader.match(/^Bearer\s+(.+)$/)
          if (match) apiKey = match[1]
        }
        if (!apiKey && upgCloud.env?.['UPG_CLOUD_API_KEY']) {
          apiKey = upgCloud.env['UPG_CLOUD_API_KEY']
        }
        if (!apiKey && upgCloud.env?.['TPC_GRAPH_API_KEY']) {
          // Backwards-compat with the legacy env-var name used in early adopter configs.
          apiKey = upgCloud.env['TPC_GRAPH_API_KEY']
        }
      }
    } catch {
      // .mcp.json not found or invalid; fall through to validation
    }
  }

  if (!cloudEndpoint) return textError('Missing cloud_endpoint. Pass it directly or add a upg-cloud server to .mcp.json')
  if (!apiKey) return textError('Missing api_key. Pass it directly or add a upg-cloud server to .mcp.json')

  try {
    const doc = store.getDocument()
    const url = `${cloudEndpoint.replace(/\/$/, '')}/api/mcp`
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }

    const callCloud = async (toolName: string, toolArgs: Record<string, unknown>) => {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(`Cloud returned ${resp.status}: ${body}`)
      }
      const rpc = await resp.json() as {
        result?: { content?: Array<{ text?: string }> }
        error?: { message?: string }
      }
      if (rpc.error) throw new Error(`Cloud error: ${rpc.error.message ?? JSON.stringify(rpc.error)}`)
      const resultText = rpc.result?.content?.[0]?.text
      if (!resultText) throw new Error('Unexpected cloud response format')
      return JSON.parse(resultText)
    }

    const importResult = await callCloud('import_upg_document', {
      document: doc,
      strategy,
      ...(productId ? { product_id: productId } : {}),
    }) as {
      product_id: string
      nodes_created: number
      edges_created: number
      node_id_map: Record<string, string>
      edge_id_map: Record<string, string>
      errors: Array<{ index: number; error: string }>
    }

    const nodeIdMap = importResult.node_id_map ?? {}
    const edgeIdMap = importResult.edge_id_map ?? {}

    const snapshotHash = await sync.hashFile(store.getFilePath())
    const syncState: SyncState = {
      cloud_endpoint: cloudEndpoint,
      product_id: importResult.product_id,
      last_synced_at: new Date().toISOString(),
      node_id_map: nodeIdMap,
      edge_id_map: edgeIdMap,
      last_snapshot_hash: snapshotHash,
    }
    await sync.writeSyncState(store.getFilePath(), syncState)

    return text(JSON.stringify({
      success: true,
      product_id: importResult.product_id,
      nodes_created: importResult.nodes_created,
      edges_created: importResult.edges_created,
      errors: importResult.errors ?? [],
      sync_file_updated: true,
    }, null, 2))
  } catch (err) {
    return textError(`Push failed: ${(err as Error).message}`)
  }
}

export type { ToolContext }
