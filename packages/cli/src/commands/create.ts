import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore, inferEdgeType, nodeId, edgeId } from '../lib/graph.js'
import { getDomainForType, type UPGBaseNode } from '@unified-product-graph/core'

export const createCommand = new Command('create')
  .arguments('<type> <title>')
  .description('Create an entity. Type is validated against the spec.')
  .option('--file <path>', 'Path to .upg file')
  .option('--parent <id>', 'Parent node ID. Auto-creates an edge')
  .option('--status <status>', 'Lifecycle status. Defaults to active')
  .option('--data <json>', 'Type-specific fields as JSON')
  .option('--tags <list>', 'Comma-separated tags', (v) => v.split(','))
  .action(async (type, title, opts) => {
    try {
      // Validate type
      const domain = getDomainForType(type)
      if (!domain) {
        console.error(`Unknown entity type: "${type}". Use a valid UPG type (e.g. persona, job, feature).`)
        process.exit(1)
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node: UPGBaseNode = {
        id: nodeId(),
        type,
        title,
      }
      if (opts.status) node.status = opts.status
      if (opts.tags) node.tags = opts.tags
      if (opts.data) {
        try { node.properties = JSON.parse(opts.data) } catch {
          console.error('Invalid --data JSON'); process.exit(1)
        }
      }

      store.addNode(node)

      // Auto-create edge if parent specified
      if (opts.parent) {
        const parent = store.getNode(opts.parent)
        if (!parent) {
          console.error(`Parent node not found: ${opts.parent}`)
          await store.flush()
          store.stopWatching()
          process.exit(1)
        }
        const edgeType = inferEdgeType(parent.type, type)
        store.addEdge({
          id: edgeId(),
          source: opts.parent,
          target: node.id,
          type: edgeType,
        })
      }

      await store.flush()
      store.stopWatching()

      console.log(chalk.green('✓') + ` Created ${chalk.dim(type)} "${chalk.white(title)}"  ${chalk.dim(node.id)}`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
