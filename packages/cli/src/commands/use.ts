/**
 * `upg use <lens>` — set the sticky operating lens (CLI-DESIGN-SPEC §2, Move 1).
 *
 * The lens is session-local state stored next to the resolved `.upg` file (see
 * lib/session.ts). It scopes the vocabulary the Tier-1 verbs speak. `full` is
 * always available for the unfiltered graph. Validated against the canonical 8
 * lens ids from core.
 *
 * `upg use` with no argument prints the current lens + the available ids.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getLens } from '@unified-product-graph/core'
import { discoverUPGFile } from '../lib/graph.js'
import { readSession, writeSession, validLensIds, isValidLens, FULL_LENS } from '../lib/session.js'
import { EXIT, die, usageError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const useCommand = new Command('use')
  .arguments('[lens]')
  .description('Set the sticky operating lens (scopes vocabulary). No arg shows the current lens.')
  .option('--file <path>', 'Path to .upg file')
  .option('--clear', 'Reset to the full (unfiltered) lens')
  .option('--json', 'Machine-readable JSON output')
  .action(async (lens, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)

      // No arg (and no --clear): report current lens + the menu.
      if (!lens && !opts.clear) {
        const current = readSession(filePath).lens ?? FULL_LENS
        if (opts.json) {
          process.stdout.write(JSON.stringify({ lens: current, available: validLensIds() }, null, 2) + '\n')
        } else {
          process.stderr.write(`◐ Lens: ${chalk.bold(current)}\n`)
          process.stderr.write(chalk.dim(`  available: ${validLensIds().join(' · ')}\n`))
          process.stdout.write(current + '\n')
        }
        process.exit(EXIT.OK)
      }

      if (opts.clear) {
        writeSession(filePath, { lens: FULL_LENS })
        if (opts.json) process.stdout.write(JSON.stringify({ lens: FULL_LENS }, null, 2) + '\n')
        else process.stderr.write(`◐ Lens reset to ${chalk.bold(FULL_LENS)}\n`)
        process.exit(EXIT.OK)
      }

      if (!isValidLens(lens)) {
        die(usageError(`Unknown lens "${lens}". Available: ${validLensIds().join(', ')}`))
      }

      writeSession(filePath, { lens })

      const meta = lens === FULL_LENS ? undefined : getLens(lens)
      if (opts.json) {
        process.stdout.write(JSON.stringify({ lens, description: meta?.description ?? null }, null, 2) + '\n')
      } else {
        const desc = meta?.description ? chalk.dim(` — "${meta.description}"`) : ''
        const line = isTTY()
          ? `◐ Lens: ${chalk.bold(meta?.name ?? lens)}${desc}`
          : `Lens: ${lens}`
        process.stderr.write(line + '\n')
        process.stdout.write(lens + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
