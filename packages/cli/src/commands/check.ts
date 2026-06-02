/**
 * `upg check` — one ranked verdict folding verify + health + gaps + anti-pattern
 * lint (CLI-DESIGN-SPEC §3). Replaces running four commands and synthesizing in
 * your head. `--json` / `--ci` make it the pipeline gate.
 *
 * Exit codes (the floor's table):
 *   0  clean (structure valid, no high-severity findings)
 *   2  a policy violation (structure invalid, or any high-severity anti-pattern)
 *
 * `--ci` is an alias for `--json` semantics with the strict exit contract; the
 * exit codes are identical either way (a high finding is always exit 2).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { buildVerdict } from '../lib/check-engine.js'
import { scoreBar, scoreColor } from '../lib/formatter.js'
import { EXIT, die } from '../lib/errors.js'

export const checkCommand = new Command('check')
  .description('One ranked verdict: structure + health + gaps + anti-patterns. Exit 2 on violations.')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .option('--ci', 'CI mode: JSON output, strict exit contract (exit 2 on any high finding)')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const verdict = buildVerdict(store)
      store.stopWatching()

      const hasHigh = verdict.findings.some((f) => f.severity === 'high')
      const violation = !verdict.structureValid || hasHigh
      const exitCode = violation ? EXIT.VIOLATION : EXIT.OK

      if (opts.json || opts.ci) {
        process.stdout.write(JSON.stringify({ ...verdict, ok: !violation }, null, 2) + '\n')
        process.exit(exitCode)
      }

      const stageStr = verdict.product.stage ? ` · stage: ${verdict.product.stage}` : ''
      process.stderr.write(`⬡ ${chalk.bold(verdict.product.title)}${chalk.dim(stageStr)}\n`)
      process.stderr.write(
        `  Health ${scoreColor(verdict.health)}/100   ${scoreBar(verdict.health)}      Structure ${verdict.structureValid ? chalk.green('✓ valid') : chalk.red('✗ invalid')}\n`,
      )

      if (verdict.findings.length === 0) {
        process.stderr.write('\n  ' + chalk.green('✓ No findings. The graph is clean.') + '\n')
        process.exit(exitCode)
      }

      process.stderr.write('\n  Top fixes (ranked):\n')
      verdict.findings.forEach((f, i) => {
        const mark = f.severity === 'high' ? chalk.red('✗') : f.severity === 'medium' ? chalk.yellow('◑') : chalk.dim('◔')
        process.stderr.write(`  ${i + 1} ${mark} ${chalk.bold(f.title)} (${f.severity})  ${chalk.dim(f.detail)}\n`)
        const fixHint = f.autoRemediable ? chalk.green('upg fix') : chalk.dim(f.command)
        process.stderr.write(`       → ${fixHint}\n`)
      })
      process.stderr.write('\n')
      process.exit(exitCode)
    } catch (err) {
      die(err)
    }
  })
