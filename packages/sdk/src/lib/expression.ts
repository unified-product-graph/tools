/**
 * Safe arithmetic expression evaluator for framework `computed_properties`.
 *
 * Framework expressions are simple math over property names, e.g.
 *   `(reach * impact * confidence) / effort`
 *   `(user_value + time_criticality + risk_reduction) / job_size`
 *
 * This evaluator is intentionally narrow: NO `eval`, NO `new Function`, NO
 * named functions. The grammar is:
 *
 *   expr      := term (('+' | '-') term)*
 *   term      := factor (('*' | '/' | '%') factor)*
 *   factor    := unary ('^' factor)?
 *   unary     := '-' unary | primary
 *   primary   := NUMBER | IDENTIFIER | '(' expr ')'
 *
 * Identifiers resolve against a `Record<string, number>` passed by the caller.
 * Missing identifiers cause a typed failure result; division/modulo by zero
 * also fail. Callers always check `ok` before reading `value`.
 *
 * The evaluator is pure: no globals, no I/O, no closures over the caller's
 * scope. Same input always produces the same output.
 */

export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; error: string; missing?: string[] }

interface Token {
  kind: 'number' | 'ident' | 'op' | 'lparen' | 'rparen'
  value: string
  pos: number
}

const OP_CHARS = new Set(['+', '-', '*', '/', '%', '^'])

function tokenize(input: string): Token[] | { error: string } {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen', value: '(', pos: i })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen', value: ')', pos: i })
      i++
      continue
    }
    if (OP_CHARS.has(c)) {
      tokens.push({ kind: 'op', value: c, pos: i })
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i
      let seenDot = false
      while (j < input.length) {
        const cc = input[j]
        if (cc >= '0' && cc <= '9') {
          j++
        } else if (cc === '.' && !seenDot) {
          seenDot = true
          j++
        } else {
          break
        }
      }
      tokens.push({ kind: 'number', value: input.slice(i, j), pos: i })
      i = j
      continue
    }
    // Identifier: ASCII letters/underscore, may include digits after first char
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1
      while (j < input.length) {
        const cc = input[j]
        if (
          (cc >= 'a' && cc <= 'z') ||
          (cc >= 'A' && cc <= 'Z') ||
          (cc >= '0' && cc <= '9') ||
          cc === '_'
        ) {
          j++
        } else {
          break
        }
      }
      tokens.push({ kind: 'ident', value: input.slice(i, j), pos: i })
      i = j
      continue
    }
    return { error: `Unexpected character "${c}" at position ${i}` }
  }
  return tokens
}

class Parser {
  private pos = 0
  constructor(
    private tokens: Token[],
    private scope: Record<string, number>,
  ) {}

  // Track missing identifiers for diagnostic reporting
  missing: Set<string> = new Set()

  parse(): EvalResult {
    if (this.tokens.length === 0) {
      return { ok: false, error: 'Empty expression' }
    }
    try {
      const value = this.parseExpr()
      if (this.pos < this.tokens.length) {
        const t = this.tokens[this.pos]
        return {
          ok: false,
          error: `Unexpected token "${t.value}" at position ${t.pos}`,
        }
      }
      if (this.missing.size > 0) {
        return {
          ok: false,
          error: `Missing variables: ${[...this.missing].join(', ')}`,
          missing: [...this.missing],
        }
      }
      if (!Number.isFinite(value)) {
        return { ok: false, error: 'Expression produced non-finite result (division by zero?)' }
      }
      return { ok: true, value }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (this.missing.size > 0) {
        return {
          ok: false,
          error: message,
          missing: [...this.missing],
        }
      }
      return { ok: false, error: message }
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private consume(): Token {
    return this.tokens[this.pos++]
  }

  private parseExpr(): number {
    let left = this.parseTerm()
    while (this.pos < this.tokens.length) {
      const t = this.peek()
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.consume()
        const right = this.parseTerm()
        left = t.value === '+' ? left + right : left - right
      } else {
        break
      }
    }
    return left
  }

  private parseTerm(): number {
    let left = this.parseFactor()
    while (this.pos < this.tokens.length) {
      const t = this.peek()
      if (
        t?.kind === 'op' &&
        (t.value === '*' || t.value === '/' || t.value === '%')
      ) {
        this.consume()
        const right = this.parseFactor()
        if ((t.value === '/' || t.value === '%') && right === 0) {
          throw new Error(`Division by zero at position ${t.pos}`)
        }
        if (t.value === '*') left = left * right
        else if (t.value === '/') left = left / right
        else left = left % right
      } else {
        break
      }
    }
    return left
  }

  private parseFactor(): number {
    const base = this.parseUnary()
    const t = this.peek()
    if (t?.kind === 'op' && t.value === '^') {
      this.consume()
      const exp = this.parseFactor() // right-associative
      return Math.pow(base, exp)
    }
    return base
  }

  private parseUnary(): number {
    const t = this.peek()
    if (t?.kind === 'op' && t.value === '-') {
      this.consume()
      return -this.parseUnary()
    }
    if (t?.kind === 'op' && t.value === '+') {
      this.consume()
      return this.parseUnary()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): number {
    const t = this.consume()
    if (!t) throw new Error('Unexpected end of expression')
    if (t.kind === 'number') {
      const n = Number.parseFloat(t.value)
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid number "${t.value}" at position ${t.pos}`)
      }
      return n
    }
    if (t.kind === 'ident') {
      const v = this.scope[t.value]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        this.missing.add(t.value)
        return 0 // continue parsing so we collect all missing idents
      }
      return v
    }
    if (t.kind === 'lparen') {
      const v = this.parseExpr()
      const close = this.consume()
      if (!close || close.kind !== 'rparen') {
        throw new Error(`Expected ')' at position ${close?.pos ?? t.pos}`)
      }
      return v
    }
    throw new Error(`Unexpected token "${t.value}" at position ${t.pos}`)
  }
}

/**
 * Evaluate an arithmetic expression with identifiers resolved against `scope`.
 *
 * Returns a typed success/failure result. When the expression references
 * identifiers absent from `scope`, the returned `missing` array lists them.
 *
 * @example
 *   evaluateExpression('(a + b) * c', { a: 2, b: 3, c: 4 })
 *   // → { ok: true, value: 20 }
 *
 * @example
 *   evaluateExpression('a / b', { a: 1, b: 0 })
 *   // → { ok: false, error: 'Division by zero ...' }
 *
 * @example
 *   evaluateExpression('reach * impact', { reach: 5 })
 *   // → { ok: false, error: 'Missing variables: impact', missing: ['impact'] }
 */
export function evaluateExpression(
  expression: string,
  scope: Record<string, number>,
): EvalResult {
  const tokensResult = tokenize(expression)
  if ('error' in tokensResult) {
    return { ok: false, error: tokensResult.error }
  }
  const parser = new Parser(tokensResult, scope)
  return parser.parse()
}
