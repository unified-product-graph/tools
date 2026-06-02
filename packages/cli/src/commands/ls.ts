/**
 * `upg ls` — neighbours of the cursor, grouped by edge relationship, rendered
 * as VERBS (CLI-DESIGN-SPEC §2, Move 2 / §3). Plus a "suggested next here" hint
 * from `buildAdjacentEdges` so the author discovers what they can create next
 * without staring at 312 types.
 *
 *   ls            neighbours of the current cursor
 *   ls --at <id>  neighbours of a node, stateless (never reads the cursor)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { buildAdjacentEdges } from '@unified-product-graph/sdk'
import { resolveCursor } from '../lib/cursor.js'
import { edgeVerb } from '../lib/inference.js'
import { EXIT, die, runtimeError } from '../lib/errors.js'

export const lsCommand = new Command('ls')
  .description('List the cursor\'s neighbours, grouped by relationship, with a "next here" hint.')
  .option('--file <path>', 'Path to .upg file')
  .option('--at <id>', 'List a node\'s neighbours statelessly (ignores the cursor)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const node = resolveCursor(store, filePath, opts.at)

      if (!node) {
        store.stopWatching()
        if (opts.at) die(runtimeError(`No node matches "${opts.at}".`))
        die(runtimeError('No cursor set. Run `upg find <query>` or `upg at <node>` to stand somewhere.'))
      }

      const edges = store.getAllEdges()
      const out = edges.filter((e) => e.source === node.id)
      const inc = edges.filter((e) => e.target === node.id)
      const titleOf = (id: string) => store.getNode(id)?.title ?? id
      const typeOf = (id: string) => store.getNode(id)?.type ?? '?'

      // "next here": adjacency the catalog allows from this type (top 3).
      const adjacent = buildAdjacentEdges(node.type)

      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              node: { id: node.id, type: node.type, title: node.title },
              outgoing: out.map((e) => ({ verb: edgeVerb(e.type), edge_type: e.type, target: { id: e.target, type: typeOf(e.target), title: titleOf(e.target) } })),
              incoming: inc.map((e) => ({ verb: edgeVerb(e.type), edge_type: e.type, source: { id: e.source, type: typeOf(e.source), title: titleOf(e.source) } })),
              suggested_next: adjacent.map((a) => a.target_type),
            },
            null,
            2,
          ) + '\n',
        )
        process.exit(EXIT.OK)
      }

      process.stderr.write(`${chalk.bold(node.type)} ${chalk.cyan(`"${node.title}"`)}\n`)
      if (out.length === 0 && inc.length === 0) {
        process.stderr.write(chalk.dim('  (no neighbours yet)\n'))
      }
      for (const e of out) {
        process.stderr.write(`  ${chalk.green(edgeVerb(e.type).padEnd(18))} → ${typeOf(e.target)} ${chalk.dim(`"${titleOf(e.target)}"`)}\n`)
      }
      for (const e of inc) {
        process.stderr.write(`  ${chalk.dim('←' + ' ' + edgeVerb(e.type).padEnd(16))} ${chalk.dim(`${typeOf(e.source)} "${titleOf(e.source)}"`)}\n`)
      }
      if (adjacent.length > 0) {
        process.stderr.write(chalk.dim(`  next here: ${adjacent.map((a) => a.target_type).join(', ')}\n`))
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
