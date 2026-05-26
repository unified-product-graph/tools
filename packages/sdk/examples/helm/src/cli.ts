/**
 * Helm CLI entry point.
 *
 * Three subcommands, each a self-contained showcase of one part of the
 * @unified-product-graph/sdk surface:
 *
 *   helm capture <type> <title>            → upg.nodes.create
 *   helm connect <feature> <persona>       → upg.search + upg.edges.connect
 *   helm report                            → upg.health + upg.verify
 *
 * Run from this directory:
 *   npm run dev -- report
 *   npm run dev -- capture decision "Ship iOS first"
 *   npm run dev -- connect "Dark mode" "Night Owl"
 */

import { Command } from 'commander'
import { captureCommand } from './commands/capture.js'
import { connectCommand } from './commands/connect.js'
import { reportCommand } from './commands/report.js'

const program = new Command()

program
  .name('helm')
  .description('Tiny product-graph coach. Built on @unified-product-graph/sdk.')
  .version('0.1.0')
  .option(
    '-f, --file <path>',
    'Path to a .upg file (defaults to the bundled demo.upg)',
  )

program.addCommand(captureCommand)
program.addCommand(connectCommand)
program.addCommand(reportCommand)

program.parseAsync(process.argv)
