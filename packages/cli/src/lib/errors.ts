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
  //: a structurally invalid document is a validation failure, so reads
  // (`list`, `show`, `export`) must agree with `verify` and exit 2 — not the
  // generic runtime 1 they would otherwise inherit from a bare load throw. The
  // SDK throws an Error whose message starts "Invalid UPG document". Centralise
  // the mapping here so EVERY error path through `die` is consistent, instead of
  // each read command repeating the `startsWith` check.
  if (err instanceof Error && err.message.startsWith('Invalid UPG document')) {
    return EXIT.VIOLATION
  }
  return EXIT.RUNTIME
}

/**
 * Pull the absolute path out of a Node errno message, if present. Node formats
 * these as `EACCES: permission denied, open '/abs/path'` — the path is the last
 * single-quoted segment. Returns undefined when there is no quoted path (EISDIR
 * on a read, for instance, omits it).
 */
function errnoPath(message: string): string | undefined {
  const m = message.match(/'([^']+)'\s*$/)
  return m?.[1]
}

/**
 *: turn raw, internal failure strings into a human sentence.
 *
 * Two sources leak otherwise:
 *   1. Node filesystem errno strings (`EISDIR: illegal operation ...`, `EACCES:
 *      permission denied, open '/abs'`, `ENAMETOOLONG: name too long`) bubble up
 *      from the SDK file store when `--file`/`UPG_FILE` points somewhere odd or a
 *      file is unreadable. The bare `EISDIR`/`EACCES` prefix means nothing to a
 *      user.
 *   2. proper-lockfile throws `Lock file is already being held` when a second
 *      process is mid-write — which reads as an internal assertion, not a
 *      transient "try again" condition.
 *
 * Matched on the errno `code` (when present) and on the message, so it works
 * whether the throw carries `NodeJS.ErrnoException.code` or just a string. All of
 * these stay runtime errors (exit 1) — they are operational, not validation,
 * problems; only the message is improved.
 *
 * Returns the original message unchanged when nothing matches.
 */
export function friendlyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException | undefined)?.code

  if (code === 'EISDIR' || /^EISDIR\b/.test(message)) {
    const p = errnoPath(message)
    return p
      ? `Cannot read ${p}: it is a directory, not a .upg file.`
      : 'Cannot read that path: it is a directory, not a .upg file.'
  }
  if (code === 'EACCES' || code === 'EPERM' || /^EACCES\b|^EPERM\b/.test(message)) {
    const p = errnoPath(message)
    return p ? `Permission denied accessing ${p}.` : 'Permission denied accessing that path.'
  }
  if (code === 'ENAMETOOLONG' || /^ENAMETOOLONG\b/.test(message)) {
    const p = errnoPath(message)
    return p ? `Path too long: ${p}` : 'Path too long.'
  }
  if (/Lock file is already being held/i.test(message)) {
    return 'Another process is writing this graph; retry shortly.'
  }
  return message
}

/**
 * Standard catch-block terminator. Prints the message and exits with the
 * error's classified code (defaulting to runtime/1 for unclassified throws —
 * the common "file not found", "store failed" case). Validation/usage problems
 * should be raised as a `CliError` with the right code so they land on 2/3.
 *
 * Raw filesystem / lockfile failures are passed through `friendlyErrorMessage`
 * so the user sees a sentence, not `EISDIR: illegal operation ...`.
 *
 * Under `--json` ( D1) the error is emitted as a single-line JSON
 * envelope on STDOUT — `{"ok":false,"error":{"code":<exit>,"message":"..."}}` —
 * so a script that asked for JSON gets JSON on the error path too, never a bare
 * human sentence it cannot parse. The process still exits with the right code.
 */
export function die(err: unknown): never {
  const message = friendlyErrorMessage(err)
  const code = classify(err)
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n')
  } else {
    console.error(message)
  }
  process.exit(code)
}
