import { Command } from 'commander'
import { discoverUPGFile, loadStore, listNodes, getOrphans } from '../lib/graph.js'
import { formatNode, formatCountTable, upgHeader } from '../lib/formatter.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

export const listCommand = new Command('list')
  .description('Query entities from the graph.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Filter by entity type')
  .option('--status <status>', 'Filter by status')
  .option('--orphans', 'Restrict to disconnected entities')
  .option('--parent <id>', 'Restrict to children of a specific node')
  .option('--count', 'Print the count only')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let result = listNodes(store, {
        type: opts.type,
        status: opts.status,
        parentId: opts.parent,
      })

      let nodes = result.nodes as unknown as UPGBaseNode[]

      if (opts.orphans) {
        const orphanSet = new Set(getOrphans(store).map((n) => n.id))
        nodes = nodes.filter((n) => orphanSet.has(n.id))
      }

      store.stopWatching()

      if (opts.count) {
        if (opts.type || opts.status || opts.orphans || opts.parent) {
          console.log(nodes.length)
        } else {
          const counts: Record<string, number> = {}
          for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1
          console.log(formatCountTable(counts))
          console.log(`  ${'total'.padEnd(24)} ${nodes.length}`)
        }
        return
      }

      if (opts.json) {
        console.log(JSON.stringify(nodes.map((n) => ({
          id: n.id, type: n.type, title: n.title, status: n.status,
        })), null, 2))
        return
      }

      if (nodes.length === 0) {
        console.log('No matching entities.')
        return
      }

      console.log(upgHeader('List'))
      for (const node of nodes) console.log(formatNode(node, '  '))
      console.log(`\n  ${nodes.length} entities`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
