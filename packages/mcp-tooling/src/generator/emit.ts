/**
 * Three-output emitter. Audited tools in, three artefacts out:
 *
 *   1. `<package>/TOOLS.md`: npm tarball, npmjs.com page.
 *   2. `apps/upg-site/content/generated/<...>.md`:
 *      unifiedproductgraph.org MCP page.
 *   3. `<package>/dist/tools-manifest.json`: typed JSON for CLI
 *      `--list-tools`, skill validators, agent introspection, harnesses.
 *
 * Deterministic: stable sort within each domain, timestamp-free body.
 * Two runs produce byte-identical output.
 *
 * Consumers pass their own `domains`, `domainLabels`, `domainBlurbs`,
 * `packageName`.
 */

import type { JSDocBlock } from './jsdoc-walker.js'
import type { ToolDefinition } from '../tool-definition.js'
import type { AuditedTool } from './audit.js'

// ─── Markdown emitter ──────────────────────────────────────────────────────

export interface MarkdownOptions {
  /** Header H1 line. */
  title: string
  /** Lead paragraph under the H1. */
  intro: string
  /** Domain order. Controls section ordering and TOC. */
  domains: readonly string[]
  /** Human-readable section header per domain. */
  domainLabels: Record<string, string>
  /** Optional one-line blurb under each section header. */
  domainBlurbs?: Record<string, string>
  /** Whether to include a small "generated" footer. Omitted from the
   *  npm-shipped TOOLS.md to keep it pristine on npmjs.com. */
  includeGeneratedFooter?: boolean
  /** Footer text when `includeGeneratedFooter` is true. */
  generatedFooter?: string
}

export function renderMarkdown(tools: AuditedTool[], opts: MarkdownOptions): string {
  const grouped = groupByDomain(tools)
  const lines: string[] = []

  lines.push(`# ${opts.title}`)
  lines.push('')
  lines.push(opts.intro)
  lines.push('')

  // Top-level table of contents (domains first).
  lines.push('## Contents')
  lines.push('')
  for (const domain of opts.domains) {
    const group = grouped.get(domain)
    if (!group || group.length === 0) continue
    const label = opts.domainLabels[domain] ?? domain
    lines.push(`- [${label}](#${domainAnchor(label)}): ${group.length} tool${group.length === 1 ? '' : 's'}`)
  }
  lines.push('')

  // Per-domain sections.
  for (const domain of opts.domains) {
    const group = grouped.get(domain)
    if (!group || group.length === 0) continue

    const label = opts.domainLabels[domain] ?? domain
    const blurb = opts.domainBlurbs?.[domain]

    lines.push(`## ${label}`)
    lines.push('')
    if (blurb) {
      lines.push(`_${blurb}_`)
      lines.push('')
    }

    // Per-domain TOC.
    for (const tool of group) {
      lines.push(`- [\`${tool.definition.name}\`](#${toolAnchor(tool.definition.name)})`)
    }
    lines.push('')

    // Per-tool sections.
    for (const tool of group) {
      lines.push(...renderToolSection(tool))
      lines.push('')
    }
  }

  if (opts.includeGeneratedFooter) {
    lines.push('---')
    lines.push('')
    lines.push(`_${opts.generatedFooter ?? 'Generated from JSDoc. Do not edit by hand.'}_`)
    lines.push('')
  }

  return lines.join('\n')
}

function renderToolSection(tool: AuditedTool): string[] {
  const { definition, block } = tool
  const lines: string[] = []

  lines.push(`### \`${definition.name}\``)
  lines.push('')

  if (block.deprecated) {
    lines.push(`> **Deprecated.** ${block.deprecated}`)
    lines.push('')
  }

  // Prefer the registry description (the wire shape served by tools/list).
  // Fall back to the JSDoc body when the registry entry has no description.
  // The audit gate guarantees at least one is present. This ordering keeps
  // the generated MD a faithful render of the wire payload, so any drift
  // between the JSON registry and the JSDoc surfaces in the MD diff (and
  // the `--check` drift gate flags it).
  const renderedDescription = definition.description?.trim().length
    ? definition.description
    : block.description
  lines.push(renderedDescription)
  lines.push('')

  // Atomicity badge.
  if (block.atomicity) {
    lines.push(`**Atomicity:** \`${block.atomicity}\``)
    lines.push('')
  }

  // Arguments table.
  const props = (definition.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown[] }>
  const required = new Set(definition.inputSchema.required ?? [])
  if (Object.keys(props).length > 0) {
    lines.push('**Arguments:**')
    lines.push('')
    lines.push('| Name | Type | Required | Description |')
    lines.push('| ---- | ---- | -------- | ----------- |')
    for (const [name, schema] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
      const type = schema.enum ? schema.enum.map((v) => `\`${String(v)}\``).join(' \\| ') : (schema.type ?? 'unknown')
      const req = required.has(name) ? '✓' : ''
      const desc = (schema.description ?? '').replace(/\|/g, '\\|')
      lines.push(`| \`${name}\` | ${type} | ${req} | ${desc} |`)
    }
    lines.push('')
  } else {
    lines.push('_No arguments._')
    lines.push('')
  }

  if (block.returns) {
    lines.push('**Returns:**')
    lines.push('')
    lines.push(block.returns)
    lines.push('')
  }

  if (block.throws.length > 0) {
    lines.push('**Throws:**')
    lines.push('')
    for (const t of block.throws) lines.push(`- ${t}`)
    lines.push('')
  }

  if (block.warnings.length > 0) {
    lines.push('**Warnings (non-error surfaces):**')
    lines.push('')
    for (const w of block.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  if (block.examples.length > 0) {
    lines.push('**Examples:**')
    lines.push('')
    for (const ex of block.examples) {
      lines.push(ex)
      lines.push('')
    }
  }

  if (block.see.length > 0) {
    lines.push('**See also:** ' + block.see.map((s) => `\`${s}\``).join(', '))
    lines.push('')
  }

  if (block.since) {
    lines.push(`_Since ${block.since}._`)
    lines.push('')
  }

  return lines
}

// ─── JSON manifest emitter ────────────────────────────────────────────────

export interface ToolManifestEntry {
  name: string
  description: string
  domain: string
  inputSchema: ToolDefinition['inputSchema']
  returns?: string
  throws: string[]
  examples: string[]
  warnings: string[]
  atomicity?: string
  see: string[]
  since?: string
  deprecated?: string
  source: string
  symbol: string
}

export interface ToolManifest {
  schema_version: '2'
  package: string
  package_version: string
  tool_count: number
  domains: readonly string[]
  tools: ToolManifestEntry[]
}

export interface ManifestOptions {
  packageName: string
  packageVersion: string
  domains: readonly string[]
}

export function renderManifest(
  tools: AuditedTool[],
  opts: ManifestOptions,
): ToolManifest {
  const tools_out: ToolManifestEntry[] = []
  for (const domain of opts.domains) {
    const group = tools.filter((t) => t.domain === domain)
    for (const t of group.sort((a, b) => a.definition.name.localeCompare(b.definition.name))) {
      tools_out.push(toManifestEntry(t))
    }
  }
  return {
    schema_version: '2',
    package: opts.packageName,
    package_version: opts.packageVersion,
    tool_count: tools_out.length,
    domains: opts.domains,
    tools: tools_out,
  }
}

function toManifestEntry(t: AuditedTool): ToolManifestEntry {
  const { definition: d, block: b } = t
  const out: ToolManifestEntry = {
    name: d.name,
    description: d.description,
    domain: t.domain,
    inputSchema: d.inputSchema,
    throws: b.throws,
    examples: b.examples,
    warnings: b.warnings,
    see: b.see,
    source: b.source,
    symbol: b.symbol,
  }
  if (b.returns) out.returns = b.returns
  if (b.atomicity) out.atomicity = b.atomicity
  if (b.since) out.since = b.since
  if (b.deprecated) out.deprecated = b.deprecated
  return out
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function groupByDomain(tools: AuditedTool[]): Map<string, AuditedTool[]> {
  const out = new Map<string, AuditedTool[]>()
  for (const t of tools) {
    const list = out.get(t.domain) ?? []
    list.push(t)
    out.set(t.domain, list)
  }
  // Stable in-domain order: alphabetical by tool name.
  for (const list of out.values()) {
    list.sort((a, b) => a.definition.name.localeCompare(b.definition.name))
  }
  return out
}

function domainAnchor(label: string): string {
  return label.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
}

function toolAnchor(name: string): string {
  return name.replace(/_/g, '-').toLowerCase()
}
