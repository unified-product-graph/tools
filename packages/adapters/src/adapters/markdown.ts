/**
 * Markdown Adapter
 *
 * Parses structured markdown files into UPG entities.
 *
 * Mapping rules:
 * - # Heading  → product or top-level entity
 * - ## Heading → child entity
 * - ### Heading → nested child
 * - Bullet points under a heading → description / properties
 * - Tags in [brackets] or #hashtags → tags
 * - Lines starting with "Type:" or "Status:" → parsed as metadata
 *
 * Entity type is inferred from keywords in the heading or explicit Type: metadata.
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import { resolveContainmentEdgeInferrable } from './resolve-pair-edge.js'
import type { AdapterConfig, ImportResult, SourceItem, UPGAdapter } from '../types.js'

// ─── Type inference ───────────────────────────────────────────────────────────

/** Map of keywords to UPG entity types: checked against lowercased heading text.
 *
 * Algorithm: sorted longest-first, so multi-word keys ("desired outcome",
 * "research insight", etc.) always beat single-word substrings ("outcome",
 * "research"). Add multi-word entries to defeat substring collisions: do NOT
 * change the sort-by-length-descending algorithm.
 *
 * Aligned with the canonical UPG entity catalogue: user_story vs
 * user_story, the persona / job / desired_outcome chain, and the
 * experiment_plan vs experiment_run split.
 */
const TYPE_KEYWORDS: Record<string, UPGEntityType> = {
  persona: 'persona',
  user: 'persona',
  audience: 'persona',
  feature: 'feature',
  capability: 'feature',
  epic: 'epic',
  // user_story splits into user_story (design artefact) and story_task
  // (work unit). Markdown docs describe the "As X I want Y" promise,
  // so headings like "Story", "User Story", and "Story Statement" map to
  // user_story. The longer multi-word keys must appear here so the
  // sort-by-length-descending pass sees them before the bare "story" substring.
  'story statement': 'user_story',
  'user story': 'user_story',
  story: 'user_story',
  // desired_outcome sits under the persona/job hierarchy.
  // "desired outcome" must appear before bare "outcome" to defeat substring hit.
  'desired outcome': 'desired_outcome',
  outcome: 'outcome',
  goal: 'objective',
  objective: 'objective',
  'key result': 'key_result',
  kpi: 'metric',
  metric: 'metric',
  competitor: 'competitor',
  alternative: 'competitor',
  opportunity: 'opportunity',
  problem: 'need',
  'pain point': 'need',
  need: 'need',
  // switching_cost is a canonical type alongside need in the persona chain.
  'switching cost': 'switching_cost',
  solution: 'solution',
  hypothesis: 'hypothesis',
  // experiment splits into experiment_plan (pre-evidence) and experiment_run
  // (post-evidence). Multi-word keys beat the bare "experiment" substring.
  'experiment plan': 'experiment_plan',
  'experiment run': 'experiment_run',
  // "ab test" / "a/b test" → experiment_run (each run is a concrete
  // execution). The slash variant is normalised to bare "a/b test"
  // by the toLowerCase() pass: both keys needed because "/" is preserved.
  'a/b test': 'experiment_run',
  'ab test': 'experiment_run',
  experiment: 'experiment',
  learning: 'learning',
  insight: 'insight',
  // "research insight" → insight (not research_study). Must appear before bare
  // "research" so the longer key wins the sort-by-length-descending pass.
  'research insight': 'insight',
  research: 'research_study',
  // design_decision is consolidated into decision (layer=design property).
  // "design decision" must appear before bare "decision" substring check.
  'design decision': 'decision',
  decision: 'decision',
  release: 'release',
  version: 'release',
  jtbd: 'job',
  job: 'job',
}

/** Infer a UPG entity type from a heading string */
function inferType(heading: string): UPGEntityType {
  const lower = heading.toLowerCase()

  // Check multi-word keywords first (longer matches take priority)
  const sorted = Object.entries(TYPE_KEYWORDS).sort(
    ([a], [b]) => b.length - a.length,
  )

  for (const [keyword, type] of sorted) {
    if (lower.includes(keyword)) return type
  }

  // Default: if it's a top-level heading, treat as product
  return 'product'
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Extract tags from text: matches [tag] and #tag patterns */
function extractTags(text: string): string[] {
  const tags: string[] = []

  // [bracket tags]
  const bracketMatches = text.matchAll(/\[([^\]]+)\]/g)
  for (const m of bracketMatches) {
    tags.push(m[1].trim())
  }

  // #hashtags (not ## markdown headings: only match mid-line or start with single #)
  const hashMatches = text.matchAll(/(?:^|\s)#([a-zA-Z][\w-]*)/g)
  for (const m of hashMatches) {
    tags.push(m[1].trim())
  }

  return [...new Set(tags)]
}

/** Extract metadata from "Key: Value" lines */
function extractMetadata(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(/^(\w[\w\s]*):\s*(.+)$/)
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '_')
      meta[key] = match[2].trim()
    }
  }
  return meta
}

/** Parse a heading line, returning the level and text */
function parseHeading(line: string): { level: number; text: string } | null {
  const match = line.match(/^(#{1,6})\s+(.+)$/)
  if (!match) return null
  return { level: match[1].length, text: match[2].trim() }
}

// ─── Section tree ─────────────────────────────────────────────────────────────

interface Section {
  level: number
  heading: string
  bodyLines: string[]
  children: Section[]
}

/** Parse markdown text into a tree of sections based on heading hierarchy */
function parseIntoSections(markdown: string): Section[] {
  const lines = markdown.split('\n')
  const rootSections: Section[] = []
  const stack: Section[] = []

  for (const line of lines) {
    const heading = parseHeading(line)

    if (heading) {
      const section: Section = {
        level: heading.level,
        heading: heading.text,
        bodyLines: [],
        children: [],
      }

      // Find the right parent by popping sections at same or deeper level
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
        stack.pop()
      }

      if (stack.length === 0) {
        rootSections.push(section)
      } else {
        stack[stack.length - 1].children.push(section)
      }

      stack.push(section)
    } else if (stack.length > 0) {
      // Add body line to current section
      stack[stack.length - 1].bodyLines.push(line)
    }
  }

  return rootSections
}

// ─── Section → SourceItem conversion ──────────────────────────────────────────

function sectionToSourceItem(section: Section, filePath: string, index: number): SourceItem {
  const body = section.bodyLines
    .filter((l) => l.trim().length > 0)
    .join('\n')
    .trim()

  const metadata = extractMetadata(section.bodyLines)
  const tags = extractTags(body + ' ' + section.heading)

  return {
    source_id: `md:${filePath}:${index}`,
    source_type: `h${section.level}`,
    title: section.heading,
    content: body || undefined,
    metadata: {
      ...metadata,
      file: filePath,
      heading_level: section.level,
      ...(tags.length > 0 ? { tags } : {}),
    },
    children: section.children.map((child, i) =>
      sectionToSourceItem(child, filePath, index * 100 + i + 1),
    ),
  }
}

// ─── SourceItem → UPG entity conversion ───────────────────────────────────────

let nodeCounter = 0

function generateNodeId(): string {
  nodeCounter++
  return `md-import-${Date.now()}-${nodeCounter}`
}

function convertItemToNodes(
  item: SourceItem,
  parentId: string | null,
  nodes: UPGBaseNode[],
  edges: UPGEdge[],
  sourceMap: Record<string, string>,
  warnings: string[],
): void {
  const meta = (item.metadata ?? {}) as Record<string, unknown>
  const explicitType = meta.type as string | undefined
  const tags = (meta.tags as string[]) ?? []

  // Determine entity type
  let entityType: string
  if (explicitType && explicitType.trim()) {
    entityType = explicitType.trim().toLowerCase().replace(/\s+/g, '_')
  } else if (item.source_type === 'h1' && !parentId) {
    entityType = inferType(item.title)
  } else {
    entityType = inferType(item.title)
    // If still defaulting to product but this isn't a root heading, use a generic type
    if (entityType === 'product' && parentId) {
      entityType = 'feature'
      warnings.push(
        `Could not infer type for "${item.title}". Defaulting to "feature".`,
      )
    }
  }

  const nodeId = generateNodeId()
  sourceMap[item.source_id] = nodeId

  // Build description from bullet points (skip metadata lines)
  const descriptionLines = (item.content ?? '')
    .split('\n')
    .filter((l) => {
      const trimmed = l.trim()
      // Keep bullet points and regular text, skip metadata lines
      return trimmed.length > 0 && !trimmed.match(/^\w[\w\s]*:\s+.+$/)
    })

  const description = descriptionLines.join('\n').trim() || undefined

  const node: UPGBaseNode = {
    id: nodeId,
    type: entityType as UPGEntityType,
    title: item.title,
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(meta.status ? { status: meta.status as string } : {}),
    source_id: item.source_id,
    source_type: item.source_type,
    mapping_confidence: explicitType ? 'manual' : 'medium',
  }

  nodes.push(node)

  // Create parent-child edge: use the catalogue-aware resolver so we never
  // emit a type string that isn't registered. Falls back to the polymorphic
  // node_informs_node edge when the exact parent→child pair is absent.
  if (parentId) {
    const parentType = nodes.find((n) => n.id === parentId)?.type ?? 'product'
    const edgeType = resolveContainmentEdgeInferrable(parentType, entityType)
      ?? 'node_informs_node'
    const edge: UPGEdge = {
      id: `edge-${parentId}-${nodeId}`,
      source: parentId,
      target: nodeId,
      type: edgeType,
      mapping_confidence: edgeType === 'node_informs_node' ? 'low' : 'medium',
    }
    edges.push(edge)
  }

  // Recurse into children
  for (const child of item.children ?? []) {
    convertItemToNodes(child, nodeId, nodes, edges, sourceMap, warnings)
  }
}

// ─── Markdown Adapter ─────────────────────────────────────────────────────────

export class MarkdownAdapter implements UPGAdapter {
  name = 'markdown'
  label = 'Markdown'
  description = 'Parse structured markdown files into UPG entities'

  /**
   * List available content from markdown files.
   *
   * Config options:
   * - `content` (string): raw markdown content to parse (for single-string input)
   * - `files` (Array<{ path: string; content: string }>): multiple files with content
   */
  async list(config: AdapterConfig): Promise<SourceItem[]> {
    const items: SourceItem[] = []

    // Single content string
    if (typeof config.content === 'string') {
      const sections = parseIntoSections(config.content)
      const filePath = (config.path as string) ?? 'input.md'
      items.push(
        ...sections.map((s, i) => sectionToSourceItem(s, filePath, i + 1)),
      )
    }

    // Multiple files
    if (Array.isArray(config.files)) {
      for (const file of config.files as Array<{
        path: string
        content: string
      }>) {
        const sections = parseIntoSections(file.content)
        items.push(
          ...sections.map((s, i) => sectionToSourceItem(s, file.path, i + 1)),
        )
      }
    }

    return items
  }

  /**
   * Convert discovered source items into UPG nodes and edges.
   */
  async convert(items: SourceItem[], _config?: AdapterConfig): Promise<ImportResult> {
    // Reset counter for deterministic IDs within a single convert call
    nodeCounter = 0

    const nodes: UPGBaseNode[] = []
    const edges: UPGEdge[] = []
    const sourceMap: Record<string, string> = {}
    const warnings: string[] = []

    for (const item of items) {
      convertItemToNodes(item, null, nodes, edges, sourceMap, warnings)
    }

    return { nodes, edges, source_map: sourceMap, warnings }
  }
}
