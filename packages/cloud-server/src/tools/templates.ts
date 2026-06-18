/**
 * Template tools (cloud parity): browse the curated starter templates.
 *
 * Postgres-independent mirror of the local server's `list_templates` /
 * `get_template`. The template library is static data read through the SDK's
 * access layer (`@unified-product-graph/templates`), so cloud serves byte-
 * identical results to local — true parity, no `store` needed.
 */
import { listTemplates, getTemplate } from '@unified-product-graph/sdk'
import { type ToolHandler, text } from '../lib/server-context.js'

/**
 * List curated starter-template summaries, optionally filtered by industry / stage.
 *
 * @returns JSON: `{ templates: TemplateSummary[] }` — id, name, description, industries, stages, entity_count, entity_types.
 * @atomicity atomic (read-only)
 * @see get_template
 */
export const listTemplatesTool: ToolHandler = async (args) => {
  const industry = typeof args?.industry === 'string' && args.industry.length > 0 ? (args.industry as string) : undefined
  const stage = typeof args?.stage === 'string' && args.stage.length > 0 ? (args.stage as string) : undefined
  return text(JSON.stringify({ templates: listTemplates({ industry, stage }) }, null, 2))
}

/**
 * Get a curated starter template in full by id (entities, typed edges, prompts).
 *
 * @returns JSON: `{ template: TemplateSet }`, or `{ error, available }` when the id is unknown.
 * @atomicity atomic (read-only)
 * @see list_templates
 */
export const getTemplateTool: ToolHandler = async (args) => {
  const id = typeof args?.id === 'string' ? (args.id as string) : ''
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
