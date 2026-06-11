/**
 * `upg disconnect <edge-id>` - remove a single edge by id.
 *
 * Wraps `store.removeEdge` via the SDK `deleteEdge` helper. The operation is
 * destructive and irreversible, so it requires `--yes` / `-y` in
 * non-interactive shells and prompts for confirmation on a TTY.
 *
 * Mirrors the MCP `delete_edge` handler semantics (edges.ts).
 */

import { Command } from 'commander'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { EXIT, die, runtimeError, usageError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'
import { deleteEdge } from '@unified-product-graph/sdk'

export const disconnectCommand = new Command('disconnect')
  .arguments('<edge-id>')
  .description('Remove a single edge by id.')
  .option('--file <path>', 'Path to .upg file')
  .option('-y, --yes', 'Skip confirmation (required for non-interactive use)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (edgeId: string, opts) => {
    try {
      const skipConfirm = Boolean(opts.yes)
      const interactive = isTTY() && Boolean(process.stdin.isTTY)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const edge = store.getEdge(edgeId)
      if (!edge) {
        store.stopWatching()
        die(runtimeError(`Edge not found: ${edgeId}`))
      }

      // Resolve the source and target nodes for a richer confirmation message.
      const sourceNode = store.getNode(edge.source)
      const targetNode = store.getNode(edge.target)

      if (!skipConfirm) {
        if (!interactive) {
          store.stopWatching()
          die(usageError(
            `Refusing to remove edge ${sanitizeForTerminal(edgeId)} without confirmation in a ` +
            `non-interactive shell. Re-run with --yes (or -y).`,
          ))
        }

        const sourceLabel = sourceNode
          ? `${sourceNode.type} "${sanitizeForTerminal(sourceNode.title)}"`
          : sanitizeForTerminal(edge.source)
        const targetLabel = targetNode
          ? `${targetNode.type} "${sanitizeForTerminal(targetNode.title)}"`
          : sanitizeForTerminal(edge.target)

        process.stderr.write('\n')
        process.stderr.write(`  Edge:   ${sanitizeForTerminal(edge.id)}  (${sanitizeForTerminal(edge.type)})\n`)
        process.stderr.write(`  Source: ${sourceLabel}\n`)
        process.stderr.write(`  Target: ${targetLabel}\n`)
        process.stderr.write('\n')

        const confirmed = await confirm({ message: 'Remove this edge?' })
        if (!confirmed) {
          process.stderr.write(chalk.dim('  Cancelled.\n'))
          store.stopWatching()
          return
        }
      }

      const result = deleteEdge(store, { edge_id: edgeId })

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        process.stderr.write(
          chalk.green(`\n  Removed edge: ${sanitizeForTerminal(result.deleted_edge_id)}  (${sanitizeForTerminal(edge.type)})\n`),
        )
        process.stdout.write(result.deleted_edge_id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
