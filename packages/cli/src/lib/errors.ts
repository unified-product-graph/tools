/**
 * Exit-code contract (published in `upg --help` and the docs).
 *
 *   0  success
 *   1  runtime / operation error  (not found, write failed, bad input value)
 *   2  validation / policy violation  (verify, health --min-score, fmt --check,
 *      incompatible connect, invalid lifecycle status)
 *   3  usage error  (unknown flag/arg, missing required confirmation in non-TTY)
 *
 * Use these constants everywhere instead of bare numbers so the contract stays
 * uniform across commands. The catch-all `die` helper classifies a thrown error:
 * anything that isn't explicitly a policy/usage problem is a runtime error (1).
 */

export const EXIT = {
  OK: 0,
  RUNTIME: 1,
  VIOLATION: 2,
  USAGE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** A typed error that carries the exit code the CLI should terminate with. */
export class CliError extends Error {
  readonly code: ExitCode
  constructor(message: string, code: ExitCode = EXIT.RUNTIME) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/** Validation / policy violation → exit 2. */
export function violation(message: string): CliError {
  return new CliError(message, EXIT.VIOLATION)
}

/** Usage error (bad flag/arg, missing confirmation) → exit 3. */
export function usageError(message: string): CliError {
  return new CliError(message, EXIT.USAGE)
}

/** Runtime/operation error (not found, write failed, bad value) → exit 1. */
export function runtimeError(message: string): CliError {
  return new CliError(message, EXIT.RUNTIME)
}

/**
 * When true, `die` emits a machine-readable JSON error envelope on stdout
 * instead of a human line on stderr. Set once, early, from `--json` in argv
 * ( D1) so every error path — there are dozens of `die` call sites —
 * becomes JSON-aware without threading the flag through each command.
 */
let jsonMode = false

/** Set global `--json` error mode. Call once from the entry point, early. */
export function setJsonErrorMode(on: boolean): void {
  jsonMode = on
}

/** True when `--json` was passed (errors should be emitted as JSON). */
export function isJsonErrorMode(): boolean {
  return jsonMode
}

/** Classify a thrown value into an exit code (the shared `die` taxonomy). */
function classify(err: unknown): ExitCode {
  if (err instanceof CliError) return err.code
  // AmbiguousFileError (graph.ts) and AmbiguousTitleError (cursor.ts) are usage
  // errors → exit 3. Matched by name to avoid a circular import between
  // lib/errors and lib/graph / lib/cursor.
  if (err instanceof Error && (err.name === 'AmbiguousFileError' || err.name === 'AmbiguousTitleError')) {
    return EXIT.USAGE
  }
  return EXIT.RUNTIME
}

/**
 * Standard catch-block terminator. Prints the message and exits with the
 * error's classified code (defaulting to runtime/1 for unclassified throws —
 * the common "file not found", "store failed" case). Validation/usage problems
 * should be raised as a `CliError` with the right code so they land on 2/3.
 *
 * Under `--json` ( D1) the error is emitted as a single-line JSON
 * envelope on STDOUT — `{"ok":false,"error":{"code":<exit>,"message":"..."}}` —
 * so a script that asked for JSON gets JSON on the error path too, never a bare
 * human sentence it cannot parse. The process still exits with the right code.
 */
export function die(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  const code = classify(err)
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n')
  } else {
    console.error(message)
  }
  process.exit(code)
}
