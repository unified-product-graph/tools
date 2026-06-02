/**
 * `upg fix` — execute the top remediation from `check` (CLI-DESIGN-SPEC §3).
 *
 * WAVE 1 honesty: most anti-pattern remediations need human judgment (draft a
 * hypothesis, link a persona to a job). `fix` executes only AUTO-REMEDIABLE
 * findings — currently dangling-edge cleanup, the one safe, deterministic
 * structural mutation. For a guided finding it prints the remediation + the
 * command to run, and exits cleanly WITHOUT fabricating entities.
 *
 *   - TTY: confirm before mutating.
 *   - non-TTY: require `--yes` (never block on a prompt); refuse otherwise.
 *   - `--json`: report what changed.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { buildVerdict, applyAutoFix } from '../lib/check-engine.js'
import { EXIT, die, usageError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const fixCommand = new Command('fix')
  .description('Execute the top auto-remediable fix from `upg check` (with confirmation).')
  .option('--file <path>', 'Path to .upg file')
  .option('--yes, -y', 'Skip confirmation (required for non-interactive use)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const verdict = buildVerdict(store)

      const top = verdict.findings[0]
      if (!top) {
        store.stopWatching()
        if (opts.json) process.stdout.write(JSON.stringify({ fixed: false, reason: 'no-findings' }, null, 2) + '\n')
        else process.stderr.write(chalk.green('✓ Nothing to fix. The graph is clean.\n'))
        process.exit(EXIT.OK)
      }

      // Guided (non-auto) finding: print the step, never fabricate.
      if (!top.autoRemediable) {
        store.stopWatching()
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ fixed: false, reason: 'guided', finding: { id: top.id, remediation: top.remediation, command: top.command } }, null, 2) + '\n',
          )
        } else {
          process.stderr.write(`${chalk.yellow('◑')} Top finding "${chalk.bold(top.title)}" needs a judgment call (not auto-fixable).\n`)
          process.stderr.write(`  ${top.remediation}\n`)
          process.stderr.write(`  → ${chalk.dim(top.command)}\n`)
        }
        process.exit(EXIT.OK)
      }

      // Auto-remediable. Confirm (TTY) or require --yes (non-TTY).
      const interactive = isTTY() && Boolean(process.stdin.isTTY)
      if (!opts.yes) {
        if (!interactive) {
          store.stopWatching()
          die(usageError(`Refusing to auto-fix "${top.title}" without --yes in a non-interactive shell.`))
        }
        const ok = await confirm({ message: `Fix "${top.title}"? (${top.detail})`, default: true }).catch(() => false)
        if (!ok) {
          store.stopWatching()
          process.stderr.write('cancelled; nothing changed\n')
          process.exit(EXIT.OK)
        }
      }

      const change = applyAutoFix(store, top) // WAVE 1: registry empty → throws; reached only when a future wave wires a handler.
      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify({ fixed: true, finding: top.id, changed: change.changed }, null, 2) + '\n')
      } else {
        process.stderr.write(`${chalk.green('✓')} Fixed "${chalk.bold(top.title)}": ${change.changed.length} change(s).\n`)
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
