/**
 * `upg log` - recent mutation feed for the current session.
 *
 * Mirrors getChanges from the MCP server: shows every node/edge create, update,
 * or delete logged since the store was loaded (or since a --since timestamp).
 *
 * Usage:
 *   upg log                      all changes this session
 *   upg log --since <iso>        changes on or after ISO 8601 timestamp
 *   upg log --limit <n>          cap output to most recent N entries
 *   upg log --json               machine-readable JSON
 */

import { Command, InvalidArgumentError } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader } from '../lib/formatter.js'
import { die, usageError } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import type { ChangeEntry } from '@unified-product-graph/sdk'

// ── helpers ───────────────────────────────────────────────────────────────────

const ACTION_COLORS: Record<string, (s: string) => string> = {
  create: chalk.green,
  update: chalk.yellow,
  delete: chalk.red,
}

function colorAction(action: string): string {
  const fn = ACTION_COLORS[action] ?? chalk.gray
  return fn(sanitizeForTerminal(action).padEnd(6))
}

function formatEntry(entry: ChangeEntry): string {
  const ts = chalk.dim(entry.timestamp.replace('T', ' ').replace('Z', ''))
  const entity = chalk.dim(entry.entity.padEnd(4))
  const type = chalk.dim(sanitizeForTerminal(entry.type).padEnd(26))
  const title = entry.title ? chalk.white(`"${sanitizeForTerminal(entry.title)}"`) : chalk.dim(`(${sanitizeForTerminal(entry.id)})`)
  return `  ${ts}  ${colorAction(entry.action)}  ${entity}  ${type}  ${title}`
}

// ── command ───────────────────────────────────────────────────────────────────

export const logCommand = new Command('log')
  .description('Recent mutation feed: create/update/delete events logged this session.')
  .option('--file <path>', 'Path to .upg file')
  .option('--since <iso>', 'Show only changes at or after this ISO 8601 timestamp')
  .option('--limit <n>', 'Cap output to the most recent N entries', (raw) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 1) throw new InvalidArgumentError('--limit must be a positive integer.')
    return n
  })
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      // Validate --since before loading the store
      const since: string | undefined = opts.since
      if (since) {
        const d = new Date(since)
        if (isNaN(d.getTime())) {
          die(usageError(`--since must be an ISO 8601 timestamp; got "${sanitizeForTerminal(since)}".`))
        }
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let changes = store.getChanges(since)

      const limit: number | undefined = opts.limit
      if (limit !== undefined) {
        // Most recent N: slice from the tail
        changes = changes.slice(-limit)
      }

      store.stopWatching()

      const summary = { create: 0, update: 0, delete: 0 }
      for (const c of changes) {
        const key = c.action as keyof typeof summary
        if (key in summary) summary[key]++
      }

      // ── JSON output ───────────────────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify({ changes, summary, total: changes.length }, null, 2))
        return
      }

      // ── Human output ──────────────────────────────────────────────────────
      process.stderr.write(upgHeader('Log') + '\n')

      if (changes.length === 0) {
        process.stderr.write(chalk.dim('  No changes recorded this session.\n\n'))
        return
      }

      for (const entry of changes) {
        console.log(formatEntry(entry))
      }

      const parts = [
        summary.create > 0 ? chalk.green(`${summary.create} created`) : null,
        summary.update > 0 ? chalk.yellow(`${summary.update} updated`) : null,
        summary.delete > 0 ? chalk.red(`${summary.delete} deleted`) : null,
      ].filter(Boolean)

      process.stderr.write(`\n  ${changes.length} event(s)`)
      if (parts.length > 0) process.stderr.write(chalk.dim(' - ') + parts.join(chalk.dim(', ')))
      process.stderr.write('\n\n')
    } catch (err) {
      die(err)
    }
  })
