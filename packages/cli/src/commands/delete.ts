import { Command } from 'commander'
import chalk from 'chalk'
import { input, search } from '@inquirer/prompts'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { formatNode } from '../lib/formatter.js'
import { EXIT, die, runtimeError, usageError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

export const deleteCommand = new Command('delete')
  .arguments('[id]')
  .description('Delete an entity and its edges. Omit ID for an interactive picker.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Filter the picker by entity type')
  .option('-y, --yes', 'Skip confirmation (required for non-interactive use)')
  .option('--force', 'Alias of --yes')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      const skipConfirm = Boolean(opts.yes || opts.force)
      const interactive = isTTY() && Boolean(process.stdin.isTTY)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let node: UPGBaseNode | undefined

      if (id) {
        node = store.getNode(id)
        if (!node) {
          store.stopWatching()
          die(runtimeError(`Node not found: ${id}`))
        }
      } else {
        // The interactive picker requires a TTY. In a non-TTY (CI/script) with
        // no id, fail fast with exit 3 rather than hang (CLI-FEEDBACK #3).
        if (!interactive) {
          store.stopWatching()
          die(usageError('No entity id given and no TTY for the picker. Pass an id, e.g. `upg delete <id> --yes`.'))
        }

        let nodes = store.getAllNodes()
        if (opts.type) nodes = nodes.filter((n) => n.type === opts.type)

        if (nodes.length === 0) {
          process.stderr.write('No entities to delete.\n')
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
          store.stopWatching()
          die(runtimeError('Entity not found.'))
        }
      }

      const edges = store.getEdgesForNode(node.id)

      if (!skipConfirm) {
        // Non-TTY without --yes must not hang; require explicit consent.
        if (!interactive) {
          store.stopWatching()
          die(usageError(
            `Refusing to delete ${node.type} "${node.title}" without confirmation in a non-interactive shell. ` +
            `Re-run with --yes (or -y).`,
          ))
        }

        process.stderr.write('\n')
        process.stderr.write(`  Will delete: ${formatNode(node)}\n`)
        process.stderr.write(chalk.dim(`  ${edges.length} connected edge(s) will also be removed\n`))
        process.stderr.write('\n')

        const answer = await input({
          message: `Type "${node.title}" to confirm deletion:`,
        })

        if (answer !== node.title) {
          process.stderr.write(chalk.dim('  Cancelled.\n'))
          store.stopWatching()
          return
        }
      }

      const deleted = { id: node.id, type: node.type, title: node.title }
      const cascadedEdges = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type }))

      const { removedEdgeIds } = store.removeNode(node.id)
      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify({ deleted, removed_edges: cascadedEdges }, null, 2) + '\n')
      } else {
        process.stderr.write(
          chalk.green(`\n  ✓ Deleted: ${node.type} "${node.title}" (${removedEdgeIds.length} edges removed)\n`),
        )
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
