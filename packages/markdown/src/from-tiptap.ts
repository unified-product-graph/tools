/**
 * Converts TipTap JSONContent back to .upg.md source.
 * Reverse of to-tiptap.ts; closes the round-trip.
 */

import type { UPGMarkdownFrontmatter } from './types.js'
import type { TipTapNode, TipTapDocument } from './to-tiptap.js'

// ─── Frontmatter serialisation ────────────────────────────────────────────────

function serialiseFrontmatter(fm: UPGMarkdownFrontmatter): string {
  const lines: string[] = ['---']

  // Required fields first
  lines.push(`title: "${fm.title}"`)
  lines.push(`upg_product: ${fm.upg_product}`)
  lines.push(`upg_version: "${fm.upg_version}"`)
  lines.push(`entity_type: ${fm.entity_type}`)
  lines.push(`entity_id: ${fm.entity_id}`)

  // Optional fields
  if (fm.author) lines.push(`author: ${fm.author}`)
  if (fm.created_at) lines.push(`created_at: ${fm.created_at}`)
  if (fm.updated_at) lines.push(`updated_at: ${fm.updated_at}`)
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.join(', ')}]`)
  }
  if (fm.status) lines.push(`status: ${fm.status}`)
  if (fm.composition_pattern) lines.push(`composition_pattern: ${fm.composition_pattern}`)
  if (fm.graph_source) lines.push(`graph_source: ${fm.graph_source}`)

  lines.push('---')
  return lines.join('\n')
}

// ─── Inline content → markdown ────────────────────────────────────────────────

function inlineToMarkdown(nodes: TipTapNode[] | undefined): string {
  if (!nodes) return ''

  return nodes.map(node => {
    // UPG Entity Reference
    if (node.type === 'upgEntityRef') {
      return entityRefToMarkdown(node)
    }

    // UPG Edge Reference
    if (node.type === 'upgEdgeRef') {
      return edgeRefToMarkdown(node)
    }

    // Text node (possibly with marks)
    if (node.type === 'text' && node.text) {
      let text = node.text
      if (node.marks) {
        for (const mark of node.marks) {
          switch (mark.type) {
            case 'bold':
              text = `**${text}**`
              break
            case 'italic':
              text = `*${text}*`
              break
            case 'code':
              text = `\`${text}\``
              break
            case 'link':
              text = `[${text}](${mark.attrs?.href ?? ''})`
              break
          }
        }
      }
      return text
    }

    // Fallback: try to recurse
    if (node.content) {
      return inlineToMarkdown(node.content)
    }

    return ''
  }).join('')
}

function entityRefToMarkdown(node: TipTapNode): string {
  const attrs = node.attrs ?? {}

  // If raw is preserved, use it
  if (attrs.raw && typeof attrs.raw === 'string') return attrs.raw

  const creation = attrs.isCreation ? '+' : ''
  const base = `${creation}${attrs.entityType}:${attrs.entityId}`

  const parts: string[] = []

  // Inline properties
  if (attrs.properties && typeof attrs.properties === 'object') {
    for (const [key, value] of Object.entries(attrs.properties as Record<string, string>)) {
      parts.push(`${key}:${value}`)
    }
  }

  // Display text
  if (attrs.displayText) {
    parts.push(`"${attrs.displayText}"`)
  }

  if (parts.length > 0) {
    return `[[${base}|${parts.join('|')}]]`
  }
  return `[[${base}]]`
}

function edgeRefToMarkdown(node: TipTapNode): string {
  const attrs = node.attrs ?? {}

  // If raw is preserved, use it
  if (attrs.raw && typeof attrs.raw === 'string') return attrs.raw

  return `{{${attrs.sourceType}:${attrs.sourceId} → ${attrs.targetType}:${attrs.targetId}|${attrs.verb}}}`
}

// ─── Block-level → markdown ───────────────────────────────────────────────────

function blockToMarkdown(node: TipTapNode, depth: number = 0): string {
  switch (node.type) {
    case 'heading': {
      const level = (node.attrs?.level as number) ?? 2
      const prefix = '#'.repeat(level)
      return `${prefix} ${inlineToMarkdown(node.content)}`
    }

    case 'paragraph': {
      return inlineToMarkdown(node.content)
    }

    case 'bulletList': {
      return (node.content ?? [])
        .map(item => {
          const content = item.content?.[0]
          return `${'  '.repeat(depth)}- ${inlineToMarkdown(content?.content)}`
        })
        .join('\n')
    }

    case 'orderedList': {
      return (node.content ?? [])
        .map((item, i) => {
          const content = item.content?.[0]
          return `${'  '.repeat(depth)}${i + 1}. ${inlineToMarkdown(content?.content)}`
        })
        .join('\n')
    }

    case 'codeBlock': {
      const lang = node.attrs?.language ?? ''
      const code = node.content?.[0]?.text ?? ''
      return `\`\`\`${lang}\n${code}\n\`\`\``
    }

    case 'blockquote': {
      return (node.content ?? [])
        .map(child => `> ${blockToMarkdown(child, depth)}`)
        .join('\n')
    }

    case 'horizontalRule': {
      return '---'
    }

    case 'table': {
      const rows = node.content ?? []
      if (rows.length === 0) return ''

      const renderedRows = rows.map(row => {
        const cells = (row.content ?? []).map(cell => {
          const para = cell.content?.[0]
          return inlineToMarkdown(para?.content)
        })
        return `| ${cells.join(' | ')} |`
      })

      // Insert separator after first row (header)
      if (renderedRows.length > 0) {
        const headerCells = rows[0].content ?? []
        const separator = `| ${headerCells.map(() => '---').join(' | ')} |`
        renderedRows.splice(1, 0, separator)
      }

      return renderedRows.join('\n')
    }

    default: {
      // Unknown block; fall back to rendering inline content.
      if (node.content) {
        return inlineToMarkdown(node.content)
      }
      return ''
    }
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

export interface FromTipTapOptions {
  /** Frontmatter to include at the top of the file */
  frontmatter: UPGMarkdownFrontmatter
}

/**
 * Convert TipTap JSONContent to .upg.md source.
 *
 * The reverse of toTipTapJSON. Produces a valid .upg.md file with
 * YAML frontmatter and entity/edge references in the body.
 *
 * @param doc - TipTap document JSON
 * @param options - Frontmatter and export options
 * @returns Complete .upg.md file content
 */
export function fromTipTapJSON(
  doc: TipTapDocument,
  options: FromTipTapOptions,
): string {
  const fm = serialiseFrontmatter(options.frontmatter)

  const bodyBlocks = (doc.content ?? []).map(node => blockToMarkdown(node))

  // Join blocks with double newlines (standard markdown paragraph separation)
  const body = bodyBlocks
    .filter(block => block !== '')
    .join('\n\n')

  return `${fm}\n\n${body}\n`
}
