/**
 * `upg fmt`: rewrite `.upg` files to canonical form.
 *
 * The same logical graph always serialises to byte-identical output, so git
 * diffs reflect meaning, not formatting. `--check` exits non-zero if any file
 * is not already canonical (for CI). Pure text → text: it does NOT bump the
 * export timestamp or touch the graph — it is a formatter, not a save.
 *
 * Examples:
 *   upg fmt                 # format the discovered .upg file in place
 *   upg fmt .upg/*.upg      # format many files (shell-expanded)
 *   upg fmt --check .upg/*.upg   # CI gate: fail if any is non-canonical
 */

import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import chalk from 'chalk'
import { formatUpgText } from '@unified-product-graph/core'
import { discoverUPGFile } from '../lib/graph.js'
import { EXIT, die } from '../lib/errors.js'

export const fmtCommand = new Command('fmt')
  .description('Rewrite .upg files to canonical form (byte-stable, diff-friendly).')
  .argument('[files...]', 'Paths to .upg files. Defaults to the discovered .upg file.')
  .option('--check', 'Do not write; exit non-zero if any file is not already canonical.')
  .action(async (files: string[], opts: { check?: boolean }) => {
    try {
      let targets = files
      if (targets.length === 0) targets = [await discoverUPGFile(undefined)]

      let changed = 0
      let errored = 0
      const nonCanonical: string[] = []

      for (const file of targets) {
        let raw: string
        try {
          raw = await fs.readFile(file, 'utf-8')
        } catch {
          console.error(chalk.red(`cannot read ${file}`))
          errored++
          continue
        }

        let formatted: string
        try {
          formatted = formatUpgText(raw)
        } catch (err) {
          // Drift that fmt cannot safely repair (e.g. a non-JSON string field).
          console.error(chalk.red(`${file}: ${(err as Error).message}`))
          errored++
          continue
        }

        if (formatted === raw) continue // already canonical

        if (opts.check) {
          nonCanonical.push(file)
          continue
        }

        await fs.writeFile(file, formatted, 'utf-8')
        console.log(chalk.green(`formatted ${file}`))
        changed++
      }

      if (opts.check) {
        // A read/parse error is a runtime failure (exit 1) and takes priority.
        if (errored > 0) process.exit(EXIT.RUNTIME)
        if (nonCanonical.length > 0) {
          console.error(chalk.red(`\n${nonCanonical.length} file(s) not in canonical form:`))
          for (const f of nonCanonical) console.error(`  ${f}`)
          console.error(chalk.dim('\nRun `upg fmt` to fix.'))
          // Non-canonical = policy violation → exit 2 (CLI-FEEDBACK #6, S4).
          process.exit(EXIT.VIOLATION)
        }
        console.log(chalk.green(`${targets.length} file(s) already canonical.`))
        return
      }

      if (errored > 0) process.exit(EXIT.RUNTIME)
      console.log(chalk.dim(changed === 0 ? 'Nothing to format; already canonical.' : `Formatted ${changed} file(s).`))
    } catch (err) {
      die(err)
    }
  })
