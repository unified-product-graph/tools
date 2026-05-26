import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { resolveApiKey } from '../lib/config.js'
import { callTool } from '../lib/cloud.js'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'

export const pullCommand = new Command('pull')
  .description('Pull cloud changes into the local .upg file.')
  .option('--file <path>', 'Path to .upg file')
  .option('--endpoint <url>', 'Cloud endpoint. Defaults to stored value')
  .option('--product-id <id>', 'Cloud product ID to pull from')
  .option('--force', 'Overwrite local with cloud. Skips merge')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const { endpoint, apiKey } = await resolveApiKey(opts.endpoint)

      // Read existing sync state
      const syncPath = filePath.replace('.upg', '.upg-sync')
      let syncState: { product_id?: string; node_id_map?: Record<string, string>; edge_id_map?: Record<string, string> } | null = null
      try {
        const raw = await fs.readFile(syncPath, 'utf-8')
        syncState = JSON.parse(raw)
      } catch { /* no sync file */ }

      const productId = opts.productId ?? syncState?.product_id
      if (!productId) {
        console.error('No product ID. Push first with `upg push`, or specify --product-id.')
        process.exit(1)
      }

      console.log()
      const spinner = ora({
        text: `Pulling from ${endpoint}...`,
        prefixText: ' ',
      }).start()

      // Export cloud state
      const cloudDoc = await callTool(
        { endpoint, apiKey },
        'export_upg_document',
        { product_id: productId }
      ) as {
        product: { title: string; description: string; stage?: string }
        nodes: Array<Record<string, unknown>>
        edges: Array<Record<string, unknown>>
      }

      spinner.text = `${cloudDoc.nodes.length} nodes, ${cloudDoc.edges.length} edges from cloud`

      if (opts.force) {
        // Full overwrite: rebuild .upg from cloud.
        const store = await loadStore(filePath)
        const doc = store.getDocument()

        // Clear and rebuild
        for (const node of store.getAllNodes().slice().reverse()) {
          store.removeNode(node.id)
        }

        // Re-add from cloud with local IDs
        const nodeIdMap: Record<string, string> = {}
        const edgeIdMap: Record<string, string> = {}
        const { nodeId, edgeId } = await import('../lib/graph.js')

        for (const cn of cloudDoc.nodes) {
          const localId = nodeId()
          nodeIdMap[localId] = cn.id as string
          store.addNode({
            id: localId,
            type: cn.type as string,
            title: cn.title as string,
            description: cn.description as string | undefined,
            status: cn.status as string | undefined,
            tags: cn.tags as string[] | undefined,
            properties: cn.data as Record<string, unknown> | undefined,
          } as UPGBaseNode)
        }

        // Reverse map for edge resolution
        const reverseMap = new Map(Object.entries(nodeIdMap).map(([l, c]) => [c, l]))
        for (const ce of cloudDoc.edges) {
          const sourceLocal = reverseMap.get(ce.source_id as string)
          const targetLocal = reverseMap.get(ce.target_id as string)
          if (sourceLocal && targetLocal) {
            const localEdgeId = edgeId()
            edgeIdMap[localEdgeId] = ce.id as string
            store.addEdge({
              id: localEdgeId,
              source: sourceLocal,
              target: targetLocal,
              type: (ce.edge_type as UPGEdge['type']) ?? 'related_to',
            })
          }
        }

        await store.flush()
        store.stopWatching()

        // Update sync state
        const raw = await fs.readFile(filePath, 'utf-8')
        const fileHash = crypto.createHash('sha256').update(raw).digest('hex')
        await fs.writeFile(syncPath, JSON.stringify({
          cloud_endpoint: endpoint,
          product_id: productId,
          last_synced_at: new Date().toISOString(),
          node_id_map: nodeIdMap,
          edge_id_map: edgeIdMap,
          last_snapshot_hash: fileHash,
        }, null, 2) + '\n', 'utf-8')

        spinner.succeed('Pulled (force overwrite)')
        console.log(`\n  ${chalk.dim('Nodes')}  ${chalk.green(String(Object.keys(nodeIdMap).length))}`)
        console.log(`  ${chalk.dim('Edges')}  ${chalk.green(String(Object.keys(edgeIdMap).length))}\n`)
        return
      }

      // Incremental pull: use the local MCP tool pattern.
      // For now, show what would change
      const localNodeCount = (await loadStore(filePath)).getAllNodes().length
      const reverseNodeMap = new Map(
        Object.entries(syncState?.node_id_map ?? {}).map(([l, c]) => [c, l])
      )
      const newOnCloud = cloudDoc.nodes.filter((n) => !reverseNodeMap.has(n.id as string))
      const existingMapped = cloudDoc.nodes.filter((n) => reverseNodeMap.has(n.id as string))

      spinner.succeed('Compared local and cloud')
      console.log()
      console.log(`  ${chalk.dim('Local')}       ${localNodeCount} nodes`)
      console.log(`  ${chalk.dim('New on cloud')} ${chalk.green(String(newOnCloud.length))}`)
      console.log(`  ${chalk.dim('Mapped')}      ${existingMapped.length}`)
      console.log(chalk.dim(`\n  Use --force to overwrite local with cloud state.\n`))
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
