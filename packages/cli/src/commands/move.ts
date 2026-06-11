/**
 * `upg move <id> <new-parent>` - re-parent a node under a new parent.
 *
 * Wraps the SDK `moveNode` (atomic re-parent: removes the existing hierarchy
 * edge and creates a new one to the target parent). The new edge type is
 * auto-inferred from the catalog; pass --type to override.
 *
 * Mirrors the MCP `move_node` handler semantics (edges.ts).
 */

import { Command } from 'commander'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { formatNode } from '../lib/formatter.js'
import { EXIT, die, runtimeError, usageError, violation } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'
import { moveNode } from '@unified-product-graph/sdk'

export const moveCommand = new Command('move')
  .arguments('<id> <new-parent>')
  .description('Move a node under a new parent, re-typing its containment edge.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <edge-type>', 'Override the inferred containment edge type')
  .option('--old-edge <edge-id>', 'Disambiguate when the node has multiple hierarchy edges')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id: string, newParentId: string, opts) => {
    try {
      const skipConfirm = Boolean(opts.yes)
      const interactive = isTTY() && Boolean(process.stdin.isTTY)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node = store.getNode(id)
      if (!node) {
        store.stopWatching()
        die(runtimeError(`Node not found: ${id}`))
      }

      const newParent = store.getNode(newParentId)
      if (!newParent) {
        store.stopWatching()
        die(runtimeError(`New parent not found: ${newParentId}`))
      }

      if (id === newParentId) {
        store.stopWatching()
        die(usageError('Cannot move a node onto itself.'))
      }

      if (!skipConfirm) {
        if (!interactive) {
          store.stopWatching()
          die(usageError(
            `Refusing to move "${sanitizeForTerminal(node.title)}" without confirmation in a ` +
            `non-interactive shell. Re-run with --yes (or -y).`,
          ))
        }

        process.stderr.write('\n')
        process.stderr.write(`  Moving:     ${formatNode(node)}\n`)
        process.stderr.write(`  New parent: ${formatNode(newParent)}\n`)
        if (opts.type) {
          process.stderr.write(chalk.dim(`  Edge type:  ${sanitizeForTerminal(opts.type)}\n`))
        }
        process.stderr.write('\n')

        const confirmed = await confirm({ message: 'Proceed with move?' })
        if (!confirmed) {
          process.stderr.write(chalk.dim('  Cancelled.\n'))
          store.stopWatching()
          return
        }
      }

      const result = moveNode(store, {
        node_id: id,
        new_parent_id: newParentId,
        new_edge_type: opts.type as string | undefined,
        old_edge_id: opts.oldEdge as string | undefined,
      })

      if (!result.moved) {
        store.stopWatching()
        // Catalog/inference failures are policy violations (exit 2); not-found is
        // runtime (exit 1). A missing-node message contains "not found".
        const isViolation = !/not found/i.test(result.error)
        die(isViolation ? violation(result.error) : runtimeError(result.error))
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        const { removed_edge: _omit, ...rest } = result as typeof result & { removed_edge?: unknown }
        void _omit
        process.stdout.write(JSON.stringify({ ...rest, new_parent_id: newParent.id }, null, 2) + '\n')
      } else {
        const edgeInfo = result.new_edge.type
        process.stderr.write(
          chalk.green(
            `\n  Moved: ${node.type} "${sanitizeForTerminal(node.title)}" -> ` +
            `${newParent.type} "${sanitizeForTerminal(newParent.title)}" ` +
            `(${edgeInfo})\n`,
          ),
        )
        if (result.warning) {
          process.stderr.write(chalk.dim(`  Warning: ${result.warning}\n`))
        }
        process.stdout.write(result.new_edge.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
