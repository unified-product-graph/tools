/**
 * return-shape — derive a structured return shape from a tool's authored
 * prose `@returns` string at BUILD time.
 *
 * The authored JSDoc `@returns` is the single source of truth. The site used
 * to parse it in the browser; this module promotes that derivation to the
 * generator so the manifest ships `return_shape` + `return_notes` ready to
 * render, and the site's client-side parser is demoted to a fallback for any
 * tool whose structured fields are absent.
 *
 * The parse is deliberately conservative: anything it can't confidently
 * structure leaves `shape` undefined and the prose flows into `notes`, so a
 * tool whose `@returns` doesn't follow the common shape never renders worse
 * than its raw prose. Logic is kept byte-for-byte aligned with the site
 * fallback in `apps/upg-site/src/lib/parse-tool-returns.ts`.
 */

export interface ReturnShape {
  /** Leading return shape, e.g. `{ node, edge?, warning? }`. Undefined if none. */
  shape?: string
  /** Explanatory sentences, each rendered as its own bullet. */
  notes: string[]
}

// Abbreviations that end in "." but don't end a sentence.
const ABBREV = /\b(e\.g|i\.e|vs|etc|cf|al|approx|no|fig|eq)\.$/i

function splitSentences(text: string): string[] {
  const rough = text.split(/(?<=\.)\s+(?=[A-Z`])/)
  const out: string[] = []
  for (const part of rough) {
    if (out.length > 0 && ABBREV.test(out[out.length - 1]!)) {
      out[out.length - 1] += ' ' + part
    } else {
      out.push(part)
    }
  }
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * Parse an authored `@returns` prose string into `{ shape?, notes }`.
 * Normalises JSDoc line-wrapping and the stray `" ."` that comment-wrapping
 * leaves behind, so the structured output is clean even when the source prose
 * carries a wrap artifact.
 */
export function parseReturnShape(raw: string): ReturnShape {
  const norm = raw
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim()

  const m = norm.match(
    /^(?:returns?\s+)?(?:an?\s+)?(?:json(?:\s+object)?|object)?\s*:?\s*`([^`]+)`\.?\s*/i,
  )

  let shape: string | undefined
  let rest = norm
  if (m && /^[{[]/.test(m[1]!.trim())) {
    shape = m[1]!.trim()
    rest = norm.slice(m[0].length).trim()
  }

  return { shape, notes: rest ? splitSentences(rest) : [] }
}
