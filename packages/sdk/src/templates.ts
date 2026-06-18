/**
 * Template access layer.
 *
 * The SDK is the single place template data is read from `@unified-product-
 * graph/templates`; the CLI and both MCP servers derive from these functions
 * rather than depending on the templates package directly. Keeps the dependency
 * DAG clean (core, templates → sdk → cli/mcp/cloud) and gives one home for
 * template logic.
 */
import {
  ALL_TEMPLATES,
  STARTER_SEEDS,
  getTemplatesForIndustry,
  getTemplatesForStage,
  type TemplateSet,
  type EntityTemplate,
  type SeedNode,
  type StarterKey,
} from '@unified-product-graph/templates'

export {
  ALL_TEMPLATES,
  STARTER_SEEDS,
  getTemplatesForIndustry,
  getTemplatesForStage,
}
export type { TemplateSet, EntityTemplate, SeedNode, StarterKey }

/** The starter-graph roster keys for `upg init --template`. */
export const STARTER_KEYS = Object.keys(STARTER_SEEDS) as StarterKey[]

/** Lightweight template descriptor for pickers (no entity/edge payload). */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  industries: string[]
  stages: string[]
  /** Total nodes the template seeds (a type may repeat). */
  entity_count: number
  /** Distinct entity types, in first-appearance order. */
  entity_types: string[]
}

function uniqueEntityTypes(entities: readonly EntityTemplate[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entities) {
    if (!seen.has(e.type)) {
      seen.add(e.type)
      out.push(e.type)
    }
  }
  return out
}

function summarize(t: TemplateSet): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    industries: [...t.industries],
    stages: [...t.stages],
    entity_count: t.entities.length,
    entity_types: uniqueEntityTypes(t.entities),
  }
}

/**
 * List template summaries, optionally filtered by industry and/or stage.
 *
 * Filters are case-insensitive: the MCP `list_templates` tool is agent-facing
 * and a model may pass "SaaS", and `upg template list SaaS` should work too.
 * Normalising in the SDK fixes all three surfaces (CLI + both MCP servers) at
 * once.
 */
export function listTemplates(opts?: { industry?: string; stage?: string }): TemplateSummary[] {
  let sets = ALL_TEMPLATES
  if (opts?.industry) {
    const industry = opts.industry.toLowerCase()
    sets = sets.filter((t) => t.industries.some((i) => i.toLowerCase() === industry))
  }
  if (opts?.stage) {
    const stage = opts.stage.toLowerCase()
    sets = sets.filter((t) => (t.stages as readonly string[]).some((s) => s.toLowerCase() === stage))
  }
  return sets.map(summarize)
}

/** Full template payload (entities, typed edges, prompts) for instantiation. */
export function getTemplate(id: string): TemplateSet | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id)
}

/** Placeholder-free starter seeds for `upg init --template <key>`. */
export function getStarterSeeds(key: StarterKey): SeedNode[] {
  return STARTER_SEEDS[key] ?? []
}
