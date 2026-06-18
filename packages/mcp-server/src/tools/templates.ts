/**
 * Template tools — browse the curated starter templates.
 *
 * Thin wrappers over the SDK's template access layer (`listTemplates` /
 * `getTemplate`), which reads `@unified-product-graph/templates`. The same data
 * powers the `/upg-new-from-template` skill, the `upg template` CLI command, and
 * the site gallery — one source of truth across every surface. Read-only and
 * stateless (no graph, no store), so the handlers are synchronous.
 */
import { listTemplates, getTemplate } from '@unified-product-graph/sdk'
import { text, type ToolHandler, type ToolResult } from '../lib/server-context.js'

/**
 * `list_templates` — curated starter-template summaries, optionally filtered by
 * industry / stage.
 *
 * @param industry optional industry filter (saas, marketplace, mobile, oss, agency)
 * @param stage optional stage filter (concept, validation, growth, mature)
 * @returns `{ templates: TemplateSummary[] }` — id, name, description, industries, stages, entity_count, entity_types
 * @atomicity atomic (read-only)
 */
export const listTemplatesTool: ToolHandler = (args: { industry?: unknown; stage?: unknown }): ToolResult => {
  const industry = typeof args?.industry === 'string' && args.industry.length > 0 ? args.industry : undefined
  const stage = typeof args?.stage === 'string' && args.stage.length > 0 ? args.stage : undefined
  return text(JSON.stringify({ templates: listTemplates({ industry, stage }) }, null, 2))
}

/**
 * `get_template` — the full pattern (entities, typed edges, prompts) by id.
 *
 * @param id template id (e.g. "saas-business-model"); run list_templates for the options
 * @returns `{ template: TemplateSet }`, or `{ error, available }` when the id is unknown
 * @atomicity atomic (read-only)
 */
export const getTemplateTool: ToolHandler = (args: { id?: unknown }): ToolResult => {
  const id = typeof args?.id === 'string' ? args.id : ''
  const template = getTemplate(id)
  if (!template) {
    return text(
      JSON.stringify(
        { error: `Unknown template: ${id || '(none)'}`, available: listTemplates().map((t) => t.id) },
        null,
        2,
      ),
    )
  }
  return text(JSON.stringify({ template }, null, 2))
}
