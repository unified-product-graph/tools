/**
 * `helm capture <type> <title>`: adds a node to the graph.
 *
 * Showcases:
 *   - upg.nodes.create()           : the canonical write path
 *   - UnknownEntityTypeError       : the SDK's built-in type validation
 *   - upg.health()                 : quick reward signal after the write
 *
 * Try:
 *   helm capture decision "We're shipping iOS first, not Android"
 *   helm capture feature "Saved searches"
 *   helm capture hypothesis "Power users want keyboard shortcuts"
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { UnknownEntityTypeError } from '@unified-product-graph/sdk'
import { getClient } from '../upg.js'

export const captureCommand = new Command('capture')
  .description('Capture a node into the product graph.')
  .argument('<type>', 'Entity type (e.g. decision, feature, hypothesis, persona)')
  .argument('<title>', 'Short, declarative title')
  .option('--description <text>', 'Optional longer description')
  .action(async (type: string, title: string, opts: { description?: string }, cmd) => {
    const file = cmd.parent?.opts().file as string | undefined
    const upg = getClient(file)

    try {
      // The whole write path in one call. The SDK:
      //   1. Resolves `type` against the UPG entity catalog (canonical + aliases)
      //   2. Generates the node ID
      //   3. Validates required properties
      //   4. Inserts into the in-memory store
      //   5. Flushes to disk before resolving
      const result = await upg.nodes.create({
        type,
        title,
        ...(opts.description ? { description: opts.description } : {}),
      })

      console.log(chalk.green('✓'), `Captured`, chalk.bold(result.node.title))
      console.log(chalk.dim(`  id:    ${result.node.id}`))
      console.log(chalk.dim(`  type:  ${result.node.type}`))
      if (result.warning) {
        console.log(chalk.yellow('  ⚠'), chalk.dim(result.warning))
      }

      // Tiny reward signal: show the graph got healthier (or didn't).
      const { score } = await upg.health()
      console.log(chalk.dim(`\nHealth: ${score}/100`))
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) {
        // The SDK's friendly error: tells the user the type is wrong AND
        // suggests near-misses. Helm doesn't write any of this logic itself.
        console.error(chalk.red('✗'), `Unknown entity type:`, chalk.bold(type))
        if (err.suggestions && err.suggestions.length > 0) {
          console.error(chalk.dim(`  Did you mean: ${err.suggestions.join(', ')}?`))
        }
        process.exit(1)
      }
      throw err
    }
  })
