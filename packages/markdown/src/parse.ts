/**
 * Regex-based parser for .upg.md.
 * Extracts frontmatter, entity refs, edge refs, inline properties.
 */

import type {
  ParseResult,
  ParseError,
  ParseWarning,
  UPGMarkdownFrontmatter,
  EntityReference,
  EdgeReference,
  InlineProperty,
} from './types.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max lines a single reference can span (spec Section 7.5) */
const MAX_REF_LINES = 3

/** Frontmatter delimiter */
const FRONTMATTER_FENCE = '---'

// ─── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Matches fenced code blocks (```...```).
 * Used to create an exclusion mask so references inside code aren't parsed.
 */
const FENCED_CODE_BLOCK = /^```[\s\S]*?^```/gm

/**
 * Matches inline code spans (`...` or `` `...` ``).
 * Backtick-delimited spans are opaque to the reference parser.
 * Handles double-backtick spans and escaped content.
 */
const INLINE_CODE = /``[^`]+``|`[^`\n]+`/g

/**
 * Entity reference: [[+?type:id@product|modifiers]]
 * Captures: (1) creation flag, (2) type, (3) id, (4) product slug (optional), (5) modifiers
 *
 * This pattern is applied to code-stripped content to avoid matching
 * references inside code blocks.
 */
const ENTITY_REF = /\[\[(\+?)([\w]+):([\w-]+)(?:@([\w-]+))?(?:\|([^\]]*))?\]\]/g

/**
 * Edge reference: {{type:id@product → type:id@product|verb}} or with ->
 * Captures: (1) src type, (2) src id, (3) src product (optional),
 *           (4) tgt type, (5) tgt id, (6) tgt product (optional), (7) verb
 */
const EDGE_REF = /\{\{([\w]+):([\w-]+)(?:@([\w-]+))?\s*(?:→|->)\s*([\w]+):([\w-]+)(?:@([\w-]+))?\|([\w_]+)\}\}/g

/** Display text inside modifiers: "quoted text" */
const DISPLAY_TEXT = /"([^"]+)"/

/** Inline property: key:value (not quoted) */
const INLINE_PROP = /^([\w]+):(.+)$/

/** Valid entity type: lowercase + underscores */
const VALID_TYPE = /^[a-z][a-z_]*$/

/** Valid entity ID: lowercase + digits + underscores + hyphens */
const VALID_ID = /^[a-z][a-z0-9_-]*$/

/** Backslash-escaped brackets */
const ESCAPED_ENTITY_OPEN = /\\\[\\\[/g
const ESCAPED_ENTITY_CLOSE = /\\\]\\\]/g
const ESCAPED_EDGE_OPEN = /\\\{\\\{/g
const ESCAPED_EDGE_CLOSE = /\\\}\\\}/g

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

/**
 * Extract YAML frontmatter from document source.
 * Returns the parsed object and the remaining body.
 */
function parseFrontmatter(source: string): {
  frontmatter: UPGMarkdownFrontmatter | null
  body: string
  errors: ParseError[]
} {
  const errors: ParseError[] = []
  const trimmed = source.trimStart()

  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    errors.push({ code: 'MISSING_FRONTMATTER', message: 'Document must begin with YAML frontmatter (---)' })
    return { frontmatter: null, body: source, errors }
  }

  // Find the closing fence
  const afterOpen = trimmed.indexOf('\n') + 1
  const closeIndex = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, afterOpen)

  if (closeIndex === -1) {
    errors.push({ code: 'MISSING_FRONTMATTER', message: 'Frontmatter opening --- has no closing ---' })
    return { frontmatter: null, body: source, errors }
  }

  const yamlBlock = trimmed.slice(afterOpen, closeIndex)
  const body = trimmed.slice(closeIndex + FRONTMATTER_FENCE.length + 1).replace(/^\n/, '')

  // Parse YAML (lightweight: handles the fields we need without a full YAML parser)
  const frontmatter = parseSimpleYaml(yamlBlock)
  if (!frontmatter) {
    errors.push({ code: 'INVALID_FRONTMATTER_YAML', message: 'Could not parse YAML frontmatter' })
    return { frontmatter: null, body, errors }
  }

  // Validate required fields
  const required: Array<keyof UPGMarkdownFrontmatter> = [
    'title', 'upg_product', 'upg_version', 'entity_type', 'entity_id',
  ]
  for (const field of required) {
    if (!frontmatter[field]) {
      errors.push({
        code: 'MISSING_REQUIRED_FIELD',
        message: `Required frontmatter field '${field}' is missing or empty`,
      })
    }
  }

  if (frontmatter.entity_type && frontmatter.entity_type !== 'document') {
    errors.push({
      code: 'MISSING_REQUIRED_FIELD',
      message: `entity_type must be 'document', got '${frontmatter.entity_type}'`,
    })
  }

  return { frontmatter: frontmatter as UPGMarkdownFrontmatter, body, errors }
}

/**
 * Lightweight YAML parser for frontmatter.
 * Handles: strings, numbers, booleans, arrays (flow and block), nested is flat.
 * Covers the frontmatter subset rather than the full YAML grammar.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {}
    const lines = yaml.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip empty lines and comments
      if (!line.trim() || line.trim().startsWith('#')) continue

      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) continue

      const key = line.slice(0, colonIndex).trim()
      let value: unknown = line.slice(colonIndex + 1).trim()

      // Remove surrounding quotes
      if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }

      // Flow-style array: [a, b, c]
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      }
      // Block-style array (next lines start with -)
      else if (value === '') {
        const items: string[] = []
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('-')) {
          i++
          items.push(lines[i].trim().slice(1).trim().replace(/^["']|["']$/g, ''))
        }
        if (items.length > 0) {
          value = items
        }
      }
      // Boolean
      else if (value === 'true') value = true
      else if (value === 'false') value = false
      // Number, but only when unquoted. Quoted values stay as strings.
      else if (typeof value === 'string' && !line.slice(colonIndex + 1).trim().startsWith('"') && /^-?\d+(\.\d+)?$/.test(value)) {
        value = parseFloat(value)
      }

      result[key] = value
    }

    return result
  } catch {
    return null
  }
}

// ─── Code block masking ───────────────────────────────────────────────────────

/**
 * Build an exclusion set of character ranges that are inside code blocks
 * or inline code spans. References in these ranges are not parsed.
 */
function buildCodeMask(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  // Fenced code blocks
  let match: RegExpExecArray | null
  const fenced = new RegExp(FENCED_CODE_BLOCK.source, 'gm')
  while ((match = fenced.exec(body)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }

  // Inline code spans
  const inline = new RegExp(INLINE_CODE.source, 'g')
  while ((match = inline.exec(body)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }

  return ranges
}

/** Check if a position falls inside any code range */
function isInCode(pos: number, mask: Array<[number, number]>): boolean {
  for (const [start, end] of mask) {
    if (pos >= start && pos < end) return true
  }
  return false
}

// ─── Line/column helpers ──────────────────────────────────────────────────────

/** Build a lookup array: lineStarts[i] = character offset where line i begins */
function buildLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** Given a character offset, return 1-based line number and 0-based column */
function offsetToPosition(offset: number, lineStarts: number[]): { line: number; column: number } {
  let lo = 0, hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - lineStarts[lo] }
}

// ─── Modifier parsing ─────────────────────────────────────────────────────────

/** Parse the modifier string (everything after type:id and the first |) */
function parseModifiers(raw: string | undefined): {
  properties: InlineProperty[]
  displayText?: string
} {
  if (!raw) return { properties: [] }

  const properties: InlineProperty[] = []
  let displayText: string | undefined

  // Split on | but respect quoted strings
  const parts = splitModifiers(raw)

  for (const part of parts) {
    const trimmed = part.trim()

    // Display text: "..."
    const dtMatch = trimmed.match(DISPLAY_TEXT)
    if (dtMatch) {
      displayText = dtMatch[1]
      continue
    }

    // Inline property: key:value
    const propMatch = trimmed.match(INLINE_PROP)
    if (propMatch) {
      properties.push({ key: propMatch[1], value: propMatch[2] })
      continue
    }
  }

  return { properties, displayText }
}

/** Split on | but don't split inside quoted strings */
function splitModifiers(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false

  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === '|' && !inQuotes) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}

// ─── Escape handling ──────────────────────────────────────────────────────────

/**
 * Replace escaped bracket sequences with placeholder characters so they
 * don't match reference patterns. We restore them after parsing.
 */
const ESC_ENTITY_OPEN = '\x00EO\x00'
const ESC_ENTITY_CLOSE = '\x00EC\x00'
const ESC_EDGE_OPEN = '\x00GO\x00'
const ESC_EDGE_CLOSE = '\x00GC\x00'

function escapeBackslashes(body: string): string {
  return body
    .replace(ESCAPED_ENTITY_OPEN, ESC_ENTITY_OPEN)
    .replace(ESCAPED_ENTITY_CLOSE, ESC_ENTITY_CLOSE)
    .replace(ESCAPED_EDGE_OPEN, ESC_EDGE_OPEN)
    .replace(ESCAPED_EDGE_CLOSE, ESC_EDGE_CLOSE)
}

// ─── Reference extraction ─────────────────────────────────────────────────────

function extractEntityRefs(
  body: string,
  codeMask: Array<[number, number]>,
  lineStarts: number[],
): { refs: EntityReference[]; warnings: ParseWarning[] } {
  const refs: EntityReference[] = []
  const warnings: ParseWarning[] = []

  const pattern = new RegExp(ENTITY_REF.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(body)) !== null) {
    if (isInCode(match.index, codeMask)) continue

    const [raw, creationFlag, type, id, productSlug, modifiers] = match
    const pos = offsetToPosition(match.index, lineStarts)

    // Check line span
    const endPos = offsetToPosition(match.index + raw.length, lineStarts)
    if (endPos.line - pos.line >= MAX_REF_LINES) {
      warnings.push({
        code: 'MULTILINE_EXCEEDS_LIMIT',
        message: `Entity reference spans ${endPos.line - pos.line + 1} lines (max ${MAX_REF_LINES})`,
        line: pos.line,
      })
      continue
    }

    const { properties, displayText } = parseModifiers(modifiers)

    refs.push({
      type,
      id,
      ...(productSlug ? { product: productSlug } : {}),
      isCreation: creationFlag === '+',
      properties,
      displayText,
      line: pos.line,
      column: pos.column,
      raw,
    })
  }

  return { refs, warnings }
}

function extractEdgeRefs(
  body: string,
  codeMask: Array<[number, number]>,
  lineStarts: number[],
): { refs: EdgeReference[]; warnings: ParseWarning[] } {
  const refs: EdgeReference[] = []
  const warnings: ParseWarning[] = []

  const pattern = new RegExp(EDGE_REF.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(body)) !== null) {
    if (isInCode(match.index, codeMask)) continue

    const [raw, srcType, srcId, srcProduct, tgtType, tgtId, tgtProduct, verb] = match
    const pos = offsetToPosition(match.index, lineStarts)

    refs.push({
      source: { type: srcType, id: srcId, ...(srcProduct ? { product: srcProduct } : {}) },
      target: { type: tgtType, id: tgtId, ...(tgtProduct ? { product: tgtProduct } : {}) },
      verb,
      line: pos.line,
      column: pos.column,
      raw,
    })
  }

  return { refs, warnings }
}

// ─── Unclosed reference detection ─────────────────────────────────────────────

function detectUnclosedRefs(body: string, lineStarts: number[]): ParseWarning[] {
  const warnings: ParseWarning[] = []

  // Look for [[ without ]] within 3 lines
  const openEntity = /\[\[(?!\[)/g
  let match: RegExpExecArray | null

  while ((match = openEntity.exec(body)) !== null) {
    const pos = offsetToPosition(match.index, lineStarts)
    // Check if there's a ]] within the next 3 lines
    const searchEnd = lineStarts[Math.min(pos.line + MAX_REF_LINES - 1, lineStarts.length - 1)] ?? body.length
    const slice = body.slice(match.index, searchEnd)

    // If we find a proper entity ref match, skip it; the extractor already handled it.
    if (/\[\[[\+]?[\w]+:[\w-]+/.test(slice) && slice.includes(']]')) continue

    // No closing ]] found in range. Warn only when the fragment looks like an attempted ref.
    if (/\[\[\w/.test(slice) && !slice.includes(']]')) {
      warnings.push({
        code: 'UNCLOSED_ENTITY_REF',
        message: `Possible unclosed entity reference at line ${pos.line}`,
        line: pos.line,
      })
    }
  }

  return warnings
}

// ─── Main parse function ──────────────────────────────────────────────────────

/**
 * Parse a .upg.md document.
 *
 * Extracts frontmatter, entity references, and edge references.
 * Resolution against a graph is the caller's responsibility via the resolver.
 *
 * @param source - The complete .upg.md file content
 * @returns ParseResult with frontmatter, body, refs, warnings, and errors
 */
export function parse(source: string): ParseResult {
  const allErrors: ParseError[] = []
  const allWarnings: ParseWarning[] = []

  // 1. Frontmatter
  const { frontmatter, body: rawBody, errors: fmErrors } = parseFrontmatter(source)
  allErrors.push(...fmErrors)

  // 2. Escape handling
  const body = escapeBackslashes(rawBody)

  // 3. Code block masking
  const codeMask = buildCodeMask(body)

  // 4. Line starts for position tracking
  const lineStarts = buildLineStarts(body)

  // 5. Extract entity references
  const { refs: entityRefs, warnings: entityWarnings } = extractEntityRefs(body, codeMask, lineStarts)
  allWarnings.push(...entityWarnings)

  // 6. Extract edge references
  const { refs: edgeRefs, warnings: edgeWarnings } = extractEdgeRefs(body, codeMask, lineStarts)
  allWarnings.push(...edgeWarnings)

  // 7. Detect unclosed references
  const unclosedWarnings = detectUnclosedRefs(body, lineStarts)
  allWarnings.push(...unclosedWarnings)

  return {
    frontmatter: frontmatter ?? ({} as UPGMarkdownFrontmatter),
    body: rawBody,
    entityRefs,
    edgeRefs,
    warnings: allWarnings,
    errors: allErrors,
  }
}
