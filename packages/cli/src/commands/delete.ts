import { Command } from 'commander'
import chalk from 'chalk'
import { input, search } from '@inquirer/prompts'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { formatNode, upgHeader } from '../lib/formatter.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

export const deleteCommand = new Command('delete')
  .arguments('[id]')
  .description('Delete an entity and its edges. Omit ID for an interactive picker.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Filter the picker by entity type')
  .option('--force', 'Skip confirmation')
  .action(async (id, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let node: UPGBaseNode | undefined

      if (id) {
        node = store.getNode(id)
        if (!node) {
          console.error(chalk.red(`Node not found: ${id}`))
          process.exit(1)
        }
      } else {
        // Interactive picker
        let nodes = store.getAllNodes()
        if (opts.type) nodes = nodes.filter((n) => n.type === opts.type)

        if (nodes.length === 0) {
          console.log('No entities to delete.')
          store.stopWatching()
          return
        }

        const picked = await search({
          message: 'Search for entity to delete:',
          source: async (term) => {
            const q = (term ?? '').toLowerCase()
            return nodes
              .filter((n) => !q || n.title.toLowerCase().includes(q) || n.type.includes(q))
              .slice(0, 20)
              .map((n) => ({
                name: `${chalk.dim(n.type.padEnd(16))} ${n.title}`,
                value: n.id,
                description: n.id,
              }))
          },
        })

        node = store.getNode(picked)
        if (!node) {
          console.error(chalk.red('Entity not found.'))
          store.stopWatching()
          process.exit(1)
        }
      }

      const edges = store.getEdgesForNode(node.id)

      if (!opts.force) {
        console.log()
        console.log(`  Will delete: ${formatNode(node)}`)
        console.log(chalk.dim(`  ${edges.length} connected edge(s) will also be removed`))
        console.log()

        const answer = await input({
          message: `Type "${node.title}" to confirm deletion:`,
        })

        if (answer !== node.title) {
          console.log(chalk.dim('  Cancelled.'))
          store.stopWatching()
          return
        }
      }

      const { removedEdgeIds } = store.removeNode(node.id)
      await store.flush()
      store.stopWatching()

      console.log(chalk.green(`\n  ✓ Deleted: ${node.type} "${node.title}" (${removedEdgeIds.length} edges removed)\n`))
    } catch (err) {
      console.error(chalk.red((err as Error).message))
      process.exit(2)
    }
  })
