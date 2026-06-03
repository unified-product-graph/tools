/**
 * `upg fmt`: rewrite `.upg` files to canonical form.
 *
 * The same logical graph always serialises to byte-identical output, so git
 * diffs reflect meaning, not formatting. `--check` exits non-zero if any file
 * is not already canonical (for CI). Pure text → text: it does NOT bump the
 * export timestamp or touch the graph — it is a formatter, not a save.
 *
 * `--check` also VALIDATES each file against the spec ( item 7): a file
 * that is byte-canonical but semantically invalid (dangling edge, missing
 * required field) used to pass green, green-lighting a broken document into CI.
 * Invalid files now fail with exit 2.
 *
 * Examples:
 *   upg fmt                 # format the discovered .upg file in place
 *   upg fmt .upg/*.upg      # format many files (shell-expanded)
 *   upg fmt --check .upg/*.upg   # CI gate: fail if any is non-canonical OR invalid
 */

import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import chalk from 'chalk'
import { formatUpgText, parseUpg, validateUPGDocument } from '@unified-product-graph/core'
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
      const invalid: Array<{ file: string; reason: string }> = []

      for (const file of targets) {
        let raw: string
        try {
          raw = await fs.readFile(file, 'utf-8')
        } catch {
          console.error(chalk.red(`cannot read ${file}`))
          errored++
          continue
        }

        // item 7: under --check, validate the document against the spec.
        // A byte-canonical but semantically invalid file (dangling edge, missing
        // required field) must NOT be reported as "already canonical" — that
        // green-lights a broken document. Skip portfolio docs (the product
        // validator does not apply to them).
        if (opts.check) {
          try {
            const parsed = parseUpg(raw)
            if (!('type' in parsed && parsed.type === 'portfolio')) {
              const result = validateUPGDocument(parsed)
              if (!result.valid) {
                const first = result.errors[0]
                invalid.push({
                  file,
                  reason: first ? `${first.path}: ${first.message}` : 'failed spec validation',
                })
                continue
              }
            }
          } catch (err) {
            // Unparsable / not a .upg document at all.
            invalid.push({ file, reason: (err as Error).message })
            continue
          }
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
        // An invalid document is a policy violation → exit 2, and it takes
        // priority over a mere non-canonical formatting nit ( item 7).
        if (invalid.length > 0) {
          console.error(chalk.red(`\n${invalid.length} file(s) failed validation:`))
          for (const { file, reason } of invalid) console.error(`  ${file}: ${reason}`)
          console.error(chalk.dim('\nFix the document (see `upg verify`) before formatting.'))
          process.exit(EXIT.VIOLATION)
        }
        if (nonCanonical.length > 0) {
          console.error(chalk.red(`\n${nonCanonical.length} file(s) not in canonical form:`))
          for (const f of nonCanonical) console.error(`  ${f}`)
          console.error(chalk.dim('\nRun `upg fmt` to fix.'))
          // Non-canonical = policy violation → exit 2 (CLI-FEEDBACK #6, S4).
          process.exit(EXIT.VIOLATION)
        }
        console.log(chalk.green(`${targets.length} file(s) already canonical and valid.`))
        return
      }

      if (errored > 0) process.exit(EXIT.RUNTIME)
      console.log(chalk.dim(changed === 0 ? 'Nothing to format; already canonical.' : `Formatted ${changed} file(s).`))
    } catch (err) {
      die(err)
    }
  })
