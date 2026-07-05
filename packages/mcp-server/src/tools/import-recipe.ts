/**
 * `get_import_recipe` — agent-native import guidance.
 *
 * The durable value of an import adapter was never the fetch (an MCP-native
 * host owns transport for free); it was always the mapping. This tool RETURNS
 * that mapping as a recipe the agent executes — it never touches the source
 * and never writes to the graph. It is the drift-prevention mechanism free-form
 * import lacks: the same source, imported twice, resolves to the same canonical
 * mapping instead of two divergent graphs.
 *
 * The recipe has three parts (per the agent-native-import ADR):
 *   (a) target schema slice — the UPG entity/edge types in play + their fields
 *       (always static, from spec);
 *   (b) the mapping — CURATED (a verbatim exported const table) when one exists
 *       for the source, else a schema-grounded SCAFFOLD (never free-generated
 *       over a curated table);
 *   (c) execution pointers — which write tools to call, in what order (static).
 *
 * The closest sibling is `get_catalog_entry` (kind: "template"): a `get_`-prefixed
 * read that returns a scaffold the agent then acts on.
 */

import { UPG_EDGE_CATALOG, isDeliberateOnlyEdge } from '@unified-product-graph/core'
import { buildEntitySchema } from '@unified-product-graph/mcp-tooling'
import {
  SOURCE_RECIPES,
  resolveSourceRecipe,
  listRecipeSlugs,
  producedEntityTypes,
  producedEdgeTypes,
  type SourceRecipe,
} from '@unified-product-graph/adapters/recipes'
import { text, type ToolHandler, type ToolResult } from '../lib/server-context.js'

// ─── Static pieces ────────────────────────────────────────────────────────────

/** Execution pointers — identical across every recipe (part c). */
const EXECUTION = {
  write_tools: ['batch_create_nodes', 'batch_create_edges'],
  steps: [
    'Classify each source record → a UPG entity type using the mapping (part b). Skip records that map to null (explicitly unmappable).',
    'Create the nodes first with batch_create_nodes (≤50 per call). Keep a source_id → new node id map as you go.',
    'Create edges with batch_create_edges, resolving each endpoint through that id map. Nodes must already exist, since edges reference node ids.',
    'Preserve provenance on every node: set source_id, source_type, external_tool (the source slug), and external_id where the source has a stable id.',
  ],
  notes: [
    'Within one batch_create_nodes call, chain parent→child via parent_ref ("$0", "$1", …) to avoid a second pass.',
    'Set mapping_confidence (high/medium/low) from the recipe confidence_map where present; surface low-confidence items for human review before writing.',
    'Deduplicate against the existing graph with search_nodes before creating: do not blindly append.',
  ],
} as const

/**
 * Schema-grounded scaffold heuristics for sources without a curated table. Not
 * a mapping — a starting frame the agent refines against the entity catalogue.
 */
const SCAFFOLD_HEURISTICS: Array<{ source_construct: string; likely_upg_type: string }> = [
  { source_construct: 'personas / user types / audiences', likely_upg_type: 'persona' },
  { source_construct: 'features / capabilities', likely_upg_type: 'feature' },
  { source_construct: 'epics / stories', likely_upg_type: 'epic / user_story' },
  { source_construct: 'tasks / to-dos / tickets', likely_upg_type: 'task' },
  { source_construct: 'bugs / defects', likely_upg_type: 'bug' },
  { source_construct: 'opportunities / problems / gaps', likely_upg_type: 'opportunity' },
  { source_construct: 'solutions / approaches', likely_upg_type: 'solution' },
  { source_construct: 'hypotheses / assumptions', likely_upg_type: 'hypothesis / assumption' },
  { source_construct: 'experiments / tests / validations', likely_upg_type: 'experiment' },
  { source_construct: 'research / interviews / studies', likely_upg_type: 'research_study' },
  { source_construct: 'insights / learnings', likely_upg_type: 'insight' },
  { source_construct: 'objectives / OKRs / goals', likely_upg_type: 'objective' },
  { source_construct: 'key results', likely_upg_type: 'key_result' },
  { source_construct: 'metrics / KPIs', likely_upg_type: 'metric' },
  { source_construct: 'competitors / alternatives', likely_upg_type: 'competitor' },
  { source_construct: 'feature requests / feedback', likely_upg_type: 'feature_request' },
  { source_construct: 'decisions / ADRs', likely_upg_type: 'decision' },
  { source_construct: 'notes / docs / meeting minutes', likely_upg_type: 'document' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compact per-type schema slice: fields + lifecycle, no domain guide. */
function schemaSliceForTypes(types: string[]): {
  entity_types: Array<{ type: string; fields: string[]; phases?: string[]; initial_phase?: string }>
  unknown_types: string[]
} {
  const entity_types: Array<{ type: string; fields: string[]; phases?: string[]; initial_phase?: string }> = []
  const unknown_types: string[] = []
  for (const type of types) {
    try {
      const schema = buildEntitySchema(type, { include_domain_guide: false })
      entity_types.push({
        type: schema.type,
        fields: Object.keys(schema.expected_properties),
        ...(schema.phases ? { phases: schema.phases } : {}),
        ...(schema.initial_phase ? { initial_phase: schema.initial_phase } : {}),
      })
    } catch {
      unknown_types.push(type)
    }
  }
  return { entity_types, unknown_types }
}

/** Metadata for each producible edge type, flagging deliberate-only edges. */
function edgeSliceForTypes(types: string[]): {
  edge_types: Array<{
    edge_type: string
    source_type: string
    target_type: string
    forward_verb: string
    deliberate_only?: true
  }>
  unknown_types: string[]
} {
  const edge_types: ReturnType<typeof edgeSliceForTypes>['edge_types'] = []
  const unknown_types: string[] = []
  for (const type of types) {
    const def = (UPG_EDGE_CATALOG as Record<string, { source_type: string; target_type: string; forward_verb: string }>)[type]
    if (!def) {
      unknown_types.push(type)
      continue
    }
    edge_types.push({
      edge_type: type,
      source_type: def.source_type,
      target_type: def.target_type,
      forward_verb: def.forward_verb,
      ...(isDeliberateOnlyEdge(type) ? { deliberate_only: true as const } : {}),
    })
  }
  return { edge_types, unknown_types }
}

/**
 * Deliberate-only warnings: every producible edge flagged `deliberate_only` in
 * the spec must be authored explicitly from real evidence, never auto-emitted
 * from a source relation. This generically covers `insight_informs_opportunity`
 * (the ADR's named invariant) and any future deliberate-only edge.
 */
function deliberateOnlyWarnings(edgeTypes: string[]): string[] {
  return edgeTypes
    .filter((t) => isDeliberateOnlyEdge(t))
    .map(
      (t) =>
        `Edge "${t}" is deliberate-only: it must be authored explicitly from real evidence, never auto-emitted from a source relation. If the source carries a matching relation, review each candidate before creating it — do NOT include it as a blind write instruction.`,
    )
}

function curatedRecipe(recipe: SourceRecipe): ToolResult {
  const entityTypes = producedEntityTypes(recipe)
  const edgeTypes = producedEdgeTypes(recipe)
  const entitySlice = schemaSliceForTypes(entityTypes)
  const edgeSlice = edgeSliceForTypes(edgeTypes)

  const warnings = deliberateOnlyWarnings(edgeTypes)
  if (entitySlice.unknown_types.length > 0) {
    warnings.push(`Mapping targets entity types absent from the current spec (skipped in the schema slice): ${entitySlice.unknown_types.join(', ')}.`)
  }
  if (edgeSlice.unknown_types.length > 0) {
    warnings.push(`Mapping targets edge types absent from the current spec: ${edgeSlice.unknown_types.join(', ')}.`)
  }

  return text(
    JSON.stringify(
      {
        source: {
          slug: recipe.source,
          label: recipe.label,
          description: recipe.description,
          recipe_kind: 'curated',
        },
        target_schema: {
          entity_types: entitySlice.entity_types,
          edge_types: edgeSlice.edge_types,
        },
        mapping: {
          kind: 'curated',
          note: 'Canonical mapping tables served verbatim from @unified-product-graph/adapters. These are the drift-prevention source of truth: apply them; do NOT free-generate an alternative mapping. Keys are source constructs; values are UPG types (null = explicitly unmappable, warn + skip).',
          tables: recipe.tables,
        },
        execution: EXECUTION,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      null,
      2,
    ),
  )
}

function scaffoldRecipe(input: string): ToolResult {
  return text(
    JSON.stringify(
      {
        source: {
          slug: null,
          label: input.trim(),
          recipe_kind: 'scaffold',
        },
        target_schema: {
          note: 'No curated mapping exists for this source. Map its records against the UPG entity catalogue using the heuristics below, then confirm each type before writing.',
          heuristics: SCAFFOLD_HEURISTICS,
          next: 'Call get_entity_schema (fields + valid edges per type), list_entity_types (the full catalogue), and resolve_edge_for_pair (the canonical edge for a source→target pair) to ground the mapping.',
        },
        mapping: {
          kind: 'scaffold',
          note: 'Schema-grounded scaffold, not a canonical mapping. Derive the source→UPG mapping from the heuristics + entity catalogue. A novel source imported repeatedly can later be promoted to a curated table (promote_to_canonical) so future imports stay consistent.',
        },
        execution: EXECUTION,
        warnings: [
          'Edge "insight_informs_opportunity" (and any other deliberate-only edge) must be authored explicitly from real evidence, never auto-emitted from a source relation. Emit a review candidate, not a blind write.',
        ],
        available_curated_sources: listRecipeSlugs(),
      },
      null,
      2,
    ),
  )
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Return an import recipe for a source: a target schema slice, the source→UPG
 * mapping (curated verbatim table when one exists, else a schema-grounded
 * scaffold), and the write tools to call in order. The agent — which already
 * holds the source bytes and the write tools — executes the writes; this tool
 * only returns guidance. With no `source`, lists the curated sources available.
 *
 * @param source Source slug or free-text description (e.g. "notion",
 *   "Linear issues", "a CSV of feature requests"). Optional — omit to list
 *   the curated sources.
 * @returns JSON: `{ source, target_schema, mapping, execution, warnings? }` for
 *   a resolved source; `{ available_sources, usage }` when `source` is omitted.
 *   A curated `mapping.kind` serves verbatim adapter tables; a `scaffold`
 *   returns catalogue-grounded heuristics. `warnings` surfaces every
 *   deliberate-only edge (e.g. `insight_informs_opportunity`) the mapping could
 *   produce, so it is never emitted as a silent write.
 * @atomicity atomic (read-only). Touches neither the source nor the graph.
 * @see get_catalog_entry
 * @see get_entity_schema
 * @see resolve_edge_for_pair
 * @see list_entity_types
 */
export const getImportRecipe: ToolHandler = (args): ToolResult => {
  const source = typeof args?.source === 'string' ? args.source : ''

  if (!source.trim()) {
    return text(
      JSON.stringify(
        {
          available_sources: listRecipeSlugs().map((slug) => ({
            slug,
            label: SOURCE_RECIPES[slug].label,
            description: SOURCE_RECIPES[slug].description,
          })),
          usage: 'Call get_import_recipe with a `source` (slug or free-text description). A source with a curated table returns it verbatim; any other source returns a schema-grounded scaffold.',
        },
        null,
        2,
      ),
    )
  }

  const recipe = resolveSourceRecipe(source)
  return recipe ? curatedRecipe(recipe) : scaffoldRecipe(source)
}
