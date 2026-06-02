/**
 * Output hygiene (finding #9).
 *
 *   - Data goes to stdout (so `upg list --json | jq` works).
 *   - Chrome / diagnostics / progress / drift notices / boxes go to stderr,
 *     so they never pollute captured or piped output.
 *   - Colour and decorative boxes are dropped when stdout is not a TTY, and
 *     when `NO_COLOR` is set or `--no-color` is passed.
 *
 * chalk@4 already auto-detects TTY and honours `NO_COLOR`/`FORCE_COLOR`. The
 * only thing we add is the explicit `--no-color` flag and a single `isTTY`
 * predicate that commands use to decide between rich and plain rendering.
 */

import chalk from 'chalk'

/** True when stdout is an interactive terminal (rich output is appropriate). */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY)
}

/**
 * Honour `--no-color` (and `NO_COLOR`). Call once, early, from the entry point
 * after parsing the global flag. `NO_COLOR` is handled by chalk natively, but
 * we force level 0 here so the flag and the env var converge on one code path.
 */
export function applyColorPreference(noColor: boolean): void {
  if (noColor || process.env.NO_COLOR) {
    chalk.level = 0
  }
}

/** Write a chrome / diagnostic line to stderr (never stdout). */
export function chrome(line = ''): void {
  process.stderr.write(line + '\n')
}

/** Write a data line to stdout. */
export function data(line = ''): void {
  process.stdout.write(line + '\n')
}
