/**
 * Converts a ParseResult to TipTap JSONContent.
 * Entity refs become `upgEntityRef` inline atoms; edge refs become `upgEdgeRef`.
 */

import type { ParseResult, EntityReference, EdgeReference } from './types.js'

// ─── TipTap JSON types (subset we produce) ───────────────────────────────────

export interface TipTapNode {
  type: string
  attrs?: Record<string, unknown>
  content?: TipTapNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

export interface TipTapDocument {
  type: 'doc'
  content: TipTapNode[]
}

// ─── Reference position index ─────────────────────────────────────────────────

interface RefAtOffset {
  start: number
  end: number
  node: TipTapNode
}

/**
 * Build a sorted list of reference positions in the body text.
 * Each entry maps a character range to the TipTap node it should become.
 */
function buildRefPositions(result: ParseResult, body: string): RefAtOffset[] {
  const positions: RefAtOffset[] = []

  for (const ref of result.entityRefs) {
    const start = findRawInBody(body, ref.raw, ref.line)
    if (start === -1) continue

    positions.push({
      start,
      end: start + ref.raw.length,
      node: entityRefToTipTap(ref),
    })
  }

  for (const ref of result.edgeRefs) {
    const start = findRawInBody(body, ref.raw, ref.line)
    if (start === -1) continue

    positions.push({
      start,
      end: start + ref.raw.length,
      node: edgeRefToTipTap(ref),
    })
  }

  // Sort by position (ascending)
  positions.sort((a, b) => a.start - b.start)
  return positions
}

/**
 * Find the character offset of a raw reference string in the body,
 * using the line number hint for efficiency.
 */
function findRawInBody(body: string, raw: string, lineHint: number): number {
  const lines = body.split('\n')
  // lineHint is 1-based
  let offset = 0
  for (let i = 0; i < Math.min(lineHint - 1, lines.length); i++) {
    offset += lines[i].length + 1 // +1 for \n
  }

  // Search from the hinted line's start
  const idx = body.indexOf(raw, Math.max(0, offset - 10))
  return idx
}

// ─── Reference → TipTap node conversion ──────────────────────────────────────

function entityRefToTipTap(ref: EntityReference): TipTapNode {
  return {
    type: 'upgEntityRef',
    attrs: {
      entityType: ref.type,
      entityId: ref.id,
      isCreation: ref.isCreation,
      displayText: ref.displayText ?? null,
      properties: ref.properties.length > 0
        ? Object.fromEntries(ref.properties.map(p => [p.key, p.value]))
        : null,
      raw: ref.raw,
    },
  }
}

function edgeRefToTipTap(ref: EdgeReference): TipTapNode {
  return {
    type: 'upgEdgeRef',
    attrs: {
      sourceType: ref.source.type,
      sourceId: ref.source.id,
      targetType: ref.target.type,
      targetId: ref.target.id,
      verb: ref.verb,
      raw: ref.raw,
    },
  }
}

// ─── Markdown → TipTap inline content ─────────────────────────────────────────

/** Convert a text segment (no refs) into TipTap text nodes with marks */
function textToInlineNodes(text: string): TipTapNode[] {
  if (!text) return []

  const nodes: TipTapNode[] = []
  // Process bold (**text**), italic (*text*), code (`text`), links
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`|\[([^\]]+?)\]\(([^)]+?)\))/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[2]) {
      // Bold: **text**
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'bold' }] })
    } else if (match[3]) {
      // Italic: *text*
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'italic' }] })
    } else if (match[4]) {
      // Code: `text`
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'code' }] })
    } else if (match[5] && match[6]) {
      // Link: [text](url)
      nodes.push({
        type: 'text',
        text: match[5],
        marks: [{ type: 'link', attrs: { href: match[6] } }],
      })
    }

    lastIndex = match.index + match[0].length
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

// ─── Line-level markdown parsing ──────────────────────────────────────────────

interface LineClassification {
  type: 'heading' | 'bullet' | 'numbered' | 'code_fence' | 'hr' | 'table_row' | 'blockquote' | 'paragraph' | 'empty'
  level?: number       // heading level or list depth
  content: string      // the text content (stripped of markdown syntax)
  raw: string          // the original line
}

function classifyLine(line: string): LineClassification {
  const trimmed = line.trimEnd()

  // Empty line
  if (!trimmed) return { type: 'empty', content: '', raw: line }

  // Heading
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
  if (headingMatch) {
    return { type: 'heading', level: headingMatch[1].length, content: headingMatch[2], raw: line }
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return { type: 'hr', content: '', raw: line }
  }

  // Code fence
  if (trimmed.startsWith('```')) {
    return { type: 'code_fence', content: trimmed.slice(3).trim(), raw: line }
  }

  // Bullet list
  const bulletMatch = trimmed.match(/^(\s*)[*-]\s+(.*)$/)
  if (bulletMatch) {
    const indent = bulletMatch[1].length
    return { type: 'bullet', level: Math.floor(indent / 2), content: bulletMatch[2], raw: line }
  }

  // Numbered list
  const numberedMatch = trimmed.match(/^(\s*)\d+\.\s+(.*)$/)
  if (numberedMatch) {
    const indent = numberedMatch[1].length
    return { type: 'numbered', level: Math.floor(indent / 2), content: numberedMatch[2], raw: line }
  }

  // Table row
  if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
    return { type: 'table_row', content: trimmed, raw: line }
  }

  // Blockquote
  const bqMatch = trimmed.match(/^>\s?(.*)$/)
  if (bqMatch) {
    return { type: 'blockquote', content: bqMatch[1], raw: line }
  }

  // Default: paragraph
  return { type: 'paragraph', content: trimmed, raw: line }
}

// ─── Inline content with refs spliced in ──────────────────────────────────────

/**
 * Given a line of text and its character offset in the body, produce
 * TipTap inline nodes with entity/edge refs spliced in at the right positions.
 */
function lineToInlineContent(
  lineText: string,
  lineOffset: number,
  refPositions: RefAtOffset[],
): TipTapNode[] {
  const lineEnd = lineOffset + lineText.length
  const nodes: TipTapNode[] = []

  // Find refs that fall within this line
  const lineRefs = refPositions.filter(r => r.start >= lineOffset && r.start < lineEnd)

  if (lineRefs.length === 0) {
    return textToInlineNodes(lineText)
  }

  let cursor = 0

  for (const ref of lineRefs) {
    const relStart = ref.start - lineOffset
    const relEnd = ref.end - lineOffset

    // Text before the ref
    if (relStart > cursor) {
      nodes.push(...textToInlineNodes(lineText.slice(cursor, relStart)))
    }

    // The ref node
    nodes.push(ref.node)

    cursor = relEnd
  }

  // Text after the last ref
  if (cursor < lineText.length) {
    nodes.push(...textToInlineNodes(lineText.slice(cursor)))
  }

  return nodes
}

// ─── Main conversion ──────────────────────────────────────────────────────────

/**
 * Convert a parsed .upg.md document to TipTap JSONContent.
 *
 * The resulting JSON can be loaded directly into a TipTap editor that has
 * the `upgEntityRef` and `upgEdgeRef` node extensions registered.
 *
 * @param result - ParseResult from parse()
 * @returns TipTap document JSON
 */
export function toTipTapJSON(result: ParseResult): TipTapDocument {
  const { body } = result
  const refPositions = buildRefPositions(result, body)
  const lines = body.split('\n')
  const content: TipTapNode[] = []

  let i = 0
  let bodyOffset = 0

  while (i < lines.length) {
    const line = lines[i]
    const cls = classifyLine(line)

    switch (cls.type) {
      case 'empty': {
        // Skip empty lines (TipTap handles spacing)
        break
      }

      case 'heading': {
        const inlineContent = lineToInlineContent(cls.content, bodyOffset + line.indexOf(cls.content), refPositions)
        content.push({
          type: 'heading',
          attrs: { level: cls.level },
          content: inlineContent,
        })
        break
      }

      case 'hr': {
        content.push({ type: 'horizontalRule' })
        break
      }

      case 'code_fence': {
        // Collect all lines until closing fence
        const lang = cls.content || null
        const codeLines: string[] = []
        i++
        while (i < lines.length && !lines[i].trimEnd().startsWith('```')) {
          codeLines.push(lines[i])
          bodyOffset += lines[i].length + 1
          i++
        }
        content.push({
          type: 'codeBlock',
          attrs: lang ? { language: lang } : {},
          content: codeLines.length > 0
            ? [{ type: 'text', text: codeLines.join('\n') }]
            : [],
        })
        break
      }

      case 'bullet':
      case 'numbered': {
        // Collect consecutive list items of the same type
        const listType = cls.type === 'bullet' ? 'bulletList' : 'orderedList'
        const items: TipTapNode[] = []

        while (i < lines.length) {
          const itemCls = classifyLine(lines[i])
          if (itemCls.type !== cls.type) break

          const itemInline = lineToInlineContent(
            itemCls.content,
            bodyOffset + lines[i].indexOf(itemCls.content),
            refPositions,
          )
          items.push({
            type: 'listItem',
            content: [{ type: 'paragraph', content: itemInline }],
          })

          bodyOffset += lines[i].length + 1
          i++
        }

        content.push({ type: listType, content: items })
        continue // don't increment i again
      }

      case 'blockquote': {
        // Collect consecutive blockquote lines
        const bqContent: TipTapNode[] = []

        while (i < lines.length) {
          const bqCls = classifyLine(lines[i])
          if (bqCls.type !== 'blockquote') break

          const bqInline = lineToInlineContent(
            bqCls.content,
            bodyOffset + lines[i].indexOf(bqCls.content),
            refPositions,
          )
          bqContent.push({ type: 'paragraph', content: bqInline })

          bodyOffset += lines[i].length + 1
          i++
        }

        content.push({ type: 'blockquote', content: bqContent })
        continue
      }

      case 'table_row': {
        // Collect table rows, skip separator rows
        const rows: string[][] = []
        let isHeader = true

        while (i < lines.length) {
          const rowCls = classifyLine(lines[i])
          if (rowCls.type !== 'table_row') break

          const cells = lines[i]
            .slice(1, -1) // strip outer |
            .split('|')
            .map(c => c.trim())

          // Skip separator rows (---|----|---)
          if (cells.every(c => /^-+:?$|^:?-+:?$/.test(c))) {
            bodyOffset += lines[i].length + 1
            i++
            isHeader = false
            continue
          }

          rows.push(cells)
          bodyOffset += lines[i].length + 1
          i++
        }

        if (rows.length > 0) {
          const tableContent: TipTapNode[] = rows.map((cells, rowIdx) => ({
            type: 'tableRow',
            content: cells.map(cell => ({
              type: rowIdx === 0 && isHeader ? 'tableHeader' : 'tableCell',
              content: [{ type: 'paragraph', content: textToInlineNodes(cell) }],
            })),
          }))

          content.push({ type: 'table', content: tableContent })
        }

        continue
      }

      case 'paragraph': {
        // Collect consecutive paragraph lines (soft line breaks)
        let paragraphText = cls.content
        let paragraphOffset = bodyOffset

        // Peek ahead for continuation lines
        while (i + 1 < lines.length) {
          const nextCls = classifyLine(lines[i + 1])
          if (nextCls.type !== 'paragraph') break
          i++
          bodyOffset += lines[i - 1 < 0 ? 0 : i].length + 1
          paragraphText += ' ' + nextCls.content
        }

        const inlineContent = lineToInlineContent(paragraphText, paragraphOffset, refPositions)
        if (inlineContent.length > 0) {
          content.push({ type: 'paragraph', content: inlineContent })
        }
        break
      }
    }

    bodyOffset += line.length + 1
    i++
  }

  // Ensure at least one node
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] })
  }

  return { type: 'doc', content }
}
