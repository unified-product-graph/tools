/**
 * `upg find <query>` — fuzzy search → navigable results (CLI-DESIGN-SPEC §2,
 * Move 2). On a TTY, picking a result SETS THE CURSOR (you land where you
 * searched). On a pipe, it just lists (the cursor is never set non-interactively
 * — that would be hidden state in a script). `--json` emits structured results.
 *
 * With a single hit, the cursor moves directly (no prompt needed) on a TTY.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { select } from '@inquirer/prompts'
import { discoverUPGFile, loadStore, searchNodes } from '../lib/graph.js'
import { writeSession } from '../lib/session.js'
import { formatNode } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { EXIT, die } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const findCommand = new Command('find')
  .arguments('<query>')
  .description('Fuzzy search; on a TTY, pick a result to move the cursor there.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Filter results by entity type')
  .option('--no-pick', 'List only; never move the cursor (even on a TTY)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (query, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const results = searchNodes(store, query, {
        type: opts.type,
        fields: ['title', 'description', 'tags'],
      })
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(results.map((s) => ({ id: s.node.id, type: s.node.type, title: s.node.title, score: s.score })), null, 2) + '\n',
        )
        process.exit(EXIT.OK)
      }

      if (results.length === 0) {
        process.stderr.write(`No results for "${query}".\n`)
        process.exit(EXIT.OK)
      }

      const interactive = isTTY() && Boolean(process.stdin.isTTY) && opts.pick !== false

      // Non-interactive (pipe, or --no-pick): list, never set the cursor.
      if (!interactive) {
        for (const { node } of results) process.stdout.write(formatNode(node) + '  ' + chalk.dim(node.id) + '\n')
        process.exit(EXIT.OK)
      }

      // TTY, single hit: move directly.
      if (results.length === 1) {
        const node = results[0]!.node
        writeSession(filePath, { cursor: node.id })
        process.stderr.write(`▸ cursor → ${chalk.bold(sanitizeForTerminal(node.type))} ${chalk.cyan(`"${sanitizeForTerminal(node.title)}"`)}  ${chalk.dim(node.id)}\n`)
        process.stdout.write(node.id + '\n')
        process.exit(EXIT.OK)
      }

      // TTY, several hits: pick one to land the cursor.
      const picked = await select<string>({
        message: `${results.length} matches for "${query}" — stand where?`,
        choices: results.map((s) => ({ name: `${sanitizeForTerminal(s.node.type)}  "${sanitizeForTerminal(s.node.title)}"`, value: s.node.id })),
      }).catch(() => undefined)

      if (!picked) {
        process.stderr.write('cancelled; cursor unchanged\n')
        process.exit(EXIT.OK)
      }

      const node = store.getNode(picked)
      writeSession(filePath, { cursor: picked })
      process.stderr.write(`▸ cursor → ${chalk.bold(sanitizeForTerminal(node?.type ?? '?'))} ${chalk.cyan(`"${sanitizeForTerminal(node?.title ?? picked)}"`)}  ${chalk.dim(picked)}\n`)
      process.stdout.write(picked + '\n')
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
