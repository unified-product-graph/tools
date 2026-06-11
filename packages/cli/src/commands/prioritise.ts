/**
 * `upg prioritise [ids...]` - rank a set of graph entities using a scoring
 * framework (RICE, ICE, WSJF, value-vs-effort, ...).
 *
 * Mirrors the MCP `prioritise` tool defined in
 * packages/upg-mcp-server/src/tools/spec.ts, delegating to the same
 * `executePrioritise` function from @unified-product-graph/sdk.
 *
 * Requires a graph file (--file / discovery) and framework_id (--framework).
 * Read-only: never mutates the store.
 *
 * Usage:
 *   upg prioritise <id...> --framework rice-scoring
 *   upg prioritise <id...> --framework value-vs-effort --json
 *   upg prioritise <id...> --framework rice-scoring --file ./my.upg
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, formatNode, label } from '../lib/formatter.js'
import { die, usageError } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { executePrioritise } from '@unified-product-graph/sdk'
import { UPG_FRAMEWORKS_BY_ID, type UPGBaseNode } from '@unified-product-graph/core'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Format a numeric score for the ranked table. */
function fmtScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(4)
}

/** Left-align a string in a fixed-width column. */
function col(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

// ── command ────────────────────────────────────────────────────────────────────

export const prioritiseCommand = new Command('prioritise')
  .aliases(['prioritize'])
  .description('Rank entities by a scoring framework (RICE, ICE, WSJF, ...).')
  .argument('[ids...]', 'Entity IDs to rank (at least 2 recommended)')
  .requiredOption('--framework <id>', 'Framework id, e.g. rice-scoring, ice-scoring, wsjf')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .action(async (ids: string[], opts: {
    framework: string
    file?: string
    json?: boolean
  }) => {
    try {
      // Validate framework early - no file load required for this check.
      const framework = UPG_FRAMEWORKS_BY_ID[opts.framework]
      if (!framework) {
        die(usageError(
          `Unknown framework: "${opts.framework}". ` +
          `Run \`upg spec frameworks\` to see available ids (e.g. rice-scoring, ice-scoring, wsjf).`,
        ))
      }

      // At least one id is required (the MCP exercise_id path is not exposed here).
      if (!ids || ids.length === 0) {
        die(usageError(
          'Provide at least one entity id to rank, e.g. `upg prioritise <id1> <id2> --framework rice-scoring`.',
        ))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      // Delegate to the same executor the MCP tool uses (exact parity).
      const execResult = executePrioritise(framework, ids, store)

      // Snapshot node data for the human table before releasing the watcher.
      const nodeSnaps = new Map<string, UPGBaseNode>()
      for (const id of ids) {
        const n = store.getNode(id)
        if (n) nodeSnaps.set(id, n)
      }

      store.stopWatching()

      // ── type_mismatch result ────────────────────────────────────────────────
      if (execResult.kind === 'type_mismatch') {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              kind: 'type_mismatch',
              framework: execResult.framework_used,
              target_entity_types: execResult.target_entity_types,
              mismatched: execResult.mismatched,
              hint: execResult.hint,
            }, null, 2) + '\n',
          )
          return
        }
        process.stderr.write(upgHeader('Prioritise') + '\n')
        process.stderr.write(chalk.red('  Type mismatch: ') + sanitizeForTerminal(execResult.hint) + '\n\n')
        process.exit(1)
      }

      // ── fallback: framework has no computed expression ──────────────────────
      if (execResult.kind === 'fallback') {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              kind: 'fallback',
              framework: execResult.framework_used,
              hint: execResult.hint,
            }, null, 2) + '\n',
          )
          return
        }
        process.stderr.write(upgHeader('Prioritise') + '\n')
        process.stderr.write(
          chalk.yellow('  No scoring expression: ') +
          sanitizeForTerminal(execResult.hint) + '\n',
        )
        process.stderr.write(
          chalk.dim(
            `  Run \`upg spec framework ${sanitizeForTerminal(opts.framework)}\` to see the scoring guidance.\n\n`,
          ),
        )
        process.exit(1)
      }

      // ── execution: ranked rows ──────────────────────────────────────────────
      const { ranked, framework_used, required_properties } = execResult

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            framework: framework_used,
            required_properties,
            ranked,
          }, null, 2) + '\n',
        )
        return
      }

      // Human-readable ranked table
      process.stderr.write(upgHeader('Prioritise') + '\n')
      process.stderr.write(
        label(`  Framework: `) +
        chalk.white(sanitizeForTerminal(framework_used.name)) +
        chalk.dim(` (${sanitizeForTerminal(framework_used.id)})`) + '\n',
      )
      process.stderr.write(
        label(`  Expression: `) +
        chalk.dim(sanitizeForTerminal(framework_used.expression)) + '\n',
      )
      if (required_properties.length > 0) {
        process.stderr.write(
          label(`  Inputs: `) +
          chalk.dim(required_properties.map(sanitizeForTerminal).join(', ')) + '\n',
        )
      }
      process.stderr.write('\n')

      // Column widths
      const RANK_W = 4
      const SCORE_W = 12
      const ID_W = Math.max(8, ...ranked.map((r) => r.entity_id.length)) + 2

      // Header
      process.stderr.write(
        chalk.dim(
          `  ${col('#', RANK_W)}${col('Score', SCORE_W)}${col('ID', ID_W)}Title\n`,
        ),
      )
      process.stderr.write(chalk.dim(`  ${'─'.repeat(RANK_W + SCORE_W + ID_W + 28)}\n`))

      for (let i = 0; i < ranked.length; i++) {
        const row = ranked[i]
        const rankStr = chalk.dim(col(String(i + 1), RANK_W))
        const scoreStr = row.score !== null
          ? chalk.bold.white(col(fmtScore(row.score), SCORE_W))
          : chalk.dim(col('n/a', SCORE_W))
        const idStr = chalk.dim(col(sanitizeForTerminal(row.entity_id), ID_W))

        const snap = nodeSnaps.get(row.entity_id)
        const titleStr = snap
          ? formatNode(snap)
          : chalk.dim('(not found)')

        const missingStr = row.missing_properties?.length
          ? chalk.dim(`  missing: ${row.missing_properties.map(sanitizeForTerminal).join(', ')}`)
          : ''

        process.stdout.write(`  ${rankStr}${scoreStr}${idStr}${titleStr}${missingStr}\n`)
      }

      const scored = ranked.filter((r) => r.score !== null).length
      const skipped = ranked.length - scored
      process.stderr.write('\n')
      process.stderr.write(
        label(`  ${scored} of ${ranked.length} ranked`) +
        (skipped > 0
          ? chalk.dim(`, ${skipped} skipped (missing inputs)`)
          : '') +
        '\n',
      )
      process.stderr.write('\n')
    } catch (err) {
      die(err)
    }
  })
