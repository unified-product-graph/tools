/**
 * Terminal output sanitisation.
 *
 * `.upg` is a SHARED interchange format: a graph you `list`/`find`/`tree` may
 * have been authored by someone else (imported, pulled from cloud, handed over).
 * A hostile title or description can embed raw terminal control bytes - ANSI
 * escape sequences (ESC, 0x1b), the BEL (0x07), carriage returns, etc. When the
 * CLI prints such a value verbatim, the terminal INTERPRETS those bytes: it can
 * clear the screen (ESC[2J), move the cursor (ESC[1;1H), recolour following
 * output, or spoof a fake prompt. That is a real attack surface for a tool whose
 * whole point is rendering data you did not write.
 *
 * The fix: before any human-facing value reaches the terminal, replace every
 * C0 control char (0x00-0x1F), C1 control char (0x80-0x9F), and DEL (0x7F) with
 * a visible, inert caret representation (ESC -> `^[`, BEL -> `^G`, DEL -> `^?`).
 * The bytes become legible text instead of terminal commands. TAB, newlines and
 * carriage returns inside a single field are folded to spaces so one node never
 * spans multiple visual rows or scrambles column alignment.
 *
 * This is applied ONLY to the human render path (see formatter.ts). The `--json`
 * path is untouched: JSON.stringify already emits control chars as `\uXXXX`,
 * which is safe and must stay byte-identical for machine consumers.
 *
 * Stored data is never mutated - sanitisation happens at print time only.
 */

/**
 * Map a single control character to caret notation.
 *   - C0 (0x00-0x1F): `^` + (code XOR 0x40). ESC(0x1b) -> `^[`, BEL(0x07) -> `^G`,
 *     NUL(0x00) -> `^@`. Matches `cat -v` conventions.
 *   - DEL (0x7F): `^?`.
 *   - C1 (0x80-0x9F): no portable caret form across terminals, so render as an
 *     inert visible escape token `\u00XX`.
 */
function caret(ch: string): string {
  const code = ch.charCodeAt(0)
  if (code === 0x7f) return '^?'
  if (code <= 0x1f) return '^' + String.fromCharCode(code + 0x40)
  // C1 controls (0x80-0x9F).
  return '\\u' + code.toString(16).padStart(4, '0')
}

// Dangerous control chars to caret-escape: C0 (0x00-0x1F) EXCEPT TAB/LF/CR
// (those are folded to spaces first, before this runs), plus DEL (0x7F) and C1
// (0x80-0x9F). 0x09 (TAB), 0x0A (LF), 0x0D (CR) are deliberately absent here.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g

// Whitespace control chars folded to a single space so one field stays on one
// visual line (a raw TAB or embedded newline otherwise breaks list alignment).
const WHITESPACE_RE = /[\t\n\r]+/g

/**
 * Make a string safe to print to a terminal. Converts control bytes that a
 * terminal would otherwise interpret into visible, inert caret notation, and
 * folds whitespace controls (TAB / newlines / CR) to single spaces so a single
 * field stays on one visual line.
 *
 * Idempotent for already-clean strings (no control chars -> returned unchanged).
 * Null/undefined are coerced to an empty string so call sites stay terse.
 */
export function sanitizeForTerminal(input: string | null | undefined): string {
  if (input == null) return ''
  return String(input).replace(WHITESPACE_RE, ' ').replace(CONTROL_RE, caret)
}
