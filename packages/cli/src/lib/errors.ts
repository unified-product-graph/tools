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
 * Standard catch-block terminator. Prints the message to stderr and exits with
 * the error's classified code (defaulting to runtime/1 for unclassified throws —
 * the common "file not found", "store failed" case). Validation/usage problems
 * should be raised as a `CliError` with the right code so they land on 2/3.
 */
export function die(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  let code: ExitCode = EXIT.RUNTIME
  if (err instanceof CliError) code = err.code
  // AmbiguousFileError (from graph.ts) is a usage error → exit 3. Matched by
  // name to avoid a circular import between lib/errors and lib/graph.
  else if (err instanceof Error && err.name === 'AmbiguousFileError') code = EXIT.USAGE
  console.error(message)
  process.exit(code)
}
