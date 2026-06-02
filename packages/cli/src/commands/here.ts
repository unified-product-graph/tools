/**
 * `upg here` / `upg at <node>` — the graph cursor (CLI-DESIGN-SPEC §2, Move 2).
 *
 *   here          show where the cursor stands (and the active lens)
 *   at <node>     move the cursor to a node (by id or title)
 *
 * The cursor is session-local (lib/session.ts); the Tier-3 flat commands never
 * read it. `here --clear` drops the cursor back to root.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { resolveNodeRef, resolveCursor } from '../lib/cursor.js'
import { readSession, writeSession, clearCursor, FULL_LENS } from '../lib/session.js'
import { EXIT, die, runtimeError } from '../lib/errors.js'

export const hereCommand = new Command('here')
  .description('Show where the cursor stands (the current node) and the active lens.')
  .option('--file <path>', 'Path to .upg file')
  .option('--clear', 'Reset the cursor to root (nowhere)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)

      if (opts.clear) {
        clearCursor(filePath)
        if (opts.json) process.stdout.write(JSON.stringify({ cursor: null }, null, 2) + '\n')
        else process.stderr.write('▸ cursor cleared (you are at root)\n')
        process.exit(EXIT.OK)
      }

      const store = await loadStore(filePath)
      const lens = readSession(filePath).lens ?? FULL_LENS
      const node = resolveCursor(store, filePath)
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            { cursor: node ? { id: node.id, type: node.type, title: node.title } : null, lens },
            null,
            2,
          ) + '\n',
        )
        process.exit(EXIT.OK)
      }

      process.stderr.write(chalk.dim(`lens: ${lens}\n`))
      if (!node) {
        process.stderr.write(
          '▸ you are at ' + chalk.dim('root (nowhere yet). Try `upg find <query>` or `upg at <node>`') + '\n',
        )
      } else {
        process.stderr.write(`▸ you are at: ${chalk.bold(node.type)} ${chalk.cyan(`"${node.title}"`)}\n`)
        process.stdout.write(node.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })

export const atCommand = new Command('at')
  .arguments('<node>')
  .description('Move the cursor to a node (resolved by id or title).')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .action(async (ref, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const node = resolveNodeRef(store, ref)
      store.stopWatching()

      if (!node) {
        die(runtimeError(`No node matches "${ref}". Try \`upg find <query>\` or pass a node id.`))
      }

      writeSession(filePath, { cursor: node.id })

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ cursor: { id: node.id, type: node.type, title: node.title } }, null, 2) + '\n',
        )
      } else {
        process.stderr.write(`▸ cursor → ${chalk.bold(node.type)} ${chalk.cyan(`"${node.title}"`)}  ${chalk.dim(node.id)}\n`)
        process.stdout.write(node.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
