/**
 * get_import_recipe tests.
 *
 * Exercises the ACTUAL tool handler (the function the server dispatches to) plus
 * the recipe-registry data layer it reads:
 *   - list mode (no source) enumerates the curated sources;
 *   - a curated source returns its verbatim tables + a schema slice + execution;
 *   - a novel source returns the schema-grounded scaffold;
 *   - the deliberate-only invariant (insight_informs_opportunity) surfaces as a
 *     warning, never a silent write;
 *   - every mapped entity/edge type in the registry resolves against the spec
 *     (catches a stale adapter table before it reaches an agent).
 */
import { describe, it, expect } from 'vitest'
import { UPG_EDGE_CATALOG } from '@unified-product-graph/core'
import { buildEntitySchema } from '@unified-product-graph/mcp-tooling'
import {
  SOURCE_RECIPES,
  producedEntityTypes,
  producedEdgeTypes,
} from '@unified-product-graph/adapters/recipes'
import { getImportRecipe } from '../tools/import-recipe.js'
import type { ToolContext } from '../lib/server-context.js'

// The handler is read-only and never touches ctx; a bare cast is enough.
const CTX = {} as ToolContext

function call(source?: string): Record<string, unknown> {
  const result = getImportRecipe(source === undefined ? {} : { source }, CTX) as {
    content: Array<{ text: string }>
  }
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('get_import_recipe: list mode', () => {
  it('lists every curated source when no source is given', () => {
    const body = call()
    const sources = body.available_sources as Array<{ slug: string; label: string; description: string }>
    expect(Array.isArray(sources)).toBe(true)
    expect(sources.length).toBe(Object.keys(SOURCE_RECIPES).length)
    for (const s of sources) {
      expect(typeof s.slug).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.description).toBe('string')
    }
    expect(sources.map((s) => s.slug)).toContain('notion')
    expect(typeof body.usage).toBe('string')
  })
})

describe('get_import_recipe: curated', () => {
  it('serves Notion verbatim tables + schema slice + execution', () => {
    const body = call('notion')
    expect((body.source as Record<string, unknown>).recipe_kind).toBe('curated')
    expect((body.source as Record<string, unknown>).slug).toBe('notion')

    const mapping = body.mapping as { kind: string; tables: Record<string, unknown> }
    expect(mapping.kind).toBe('curated')
    // verbatim: the Notion database type map is the exact exported const
    const tables = mapping.tables as { entity_type_maps: Record<string, Record<string, string | null>> }
    expect(tables.entity_type_maps.database).toEqual(SOURCE_RECIPES.notion.tables.entity_type_maps.database)

    const schema = body.target_schema as { entity_types: unknown[]; edge_types: unknown[] }
    expect(schema.entity_types.length).toBeGreaterThan(0)
    expect(schema.edge_types.length).toBeGreaterThan(0)

    const exec = body.execution as { write_tools: string[]; steps: string[] }
    expect(exec.write_tools).toEqual(['batch_create_nodes', 'batch_create_edges'])
    expect(exec.steps.length).toBeGreaterThan(0)
  })

  it('warns that insight_informs_opportunity is deliberate-only, never auto-emitted', () => {
    const body = call('notion')
    const warnings = (body.warnings as string[]) ?? []
    expect(warnings.some((w) => w.includes('insight_informs_opportunity') && w.includes('deliberate-only'))).toBe(true)
    // and the edge is surfaced in the schema slice with the deliberate_only flag
    const edges = (body.target_schema as { edge_types: Array<{ edge_type: string; deliberate_only?: boolean }> }).edge_types
    const iio = edges.find((e) => e.edge_type === 'insight_informs_opportunity')
    expect(iio?.deliberate_only).toBe(true)
  })

  it('resolves a free-text description to the curated source', () => {
    const body = call('my notion workspace export')
    expect((body.source as Record<string, unknown>).slug).toBe('notion')
    expect((body.source as Record<string, unknown>).recipe_kind).toBe('curated')
  })
})

describe('get_import_recipe: scaffold', () => {
  it('returns a schema-grounded scaffold for a novel source', () => {
    const body = call('some bespoke internal CRM 9000')
    const src = body.source as Record<string, unknown>
    expect(src.recipe_kind).toBe('scaffold')
    expect(src.slug).toBeNull()

    expect((body.mapping as { kind: string }).kind).toBe('scaffold')
    const target = body.target_schema as { heuristics: unknown[]; next: string }
    expect(target.heuristics.length).toBeGreaterThan(0)
    expect(typeof target.next).toBe('string')
    // scaffold still carries the deliberate-only guardrail + a way back to curated
    expect((body.warnings as string[]).join(' ')).toContain('insight_informs_opportunity')
    expect(body.available_curated_sources).toBeTruthy()
  })
})

describe('recipe registry integrity', () => {
  it('every mapped entity type resolves against the current spec', () => {
    const bad: string[] = []
    for (const recipe of Object.values(SOURCE_RECIPES)) {
      for (const type of producedEntityTypes(recipe)) {
        try {
          buildEntitySchema(type, { include_domain_guide: false })
        } catch {
          bad.push(`${recipe.source}:${type}`)
        }
      }
    }
    expect(bad, `stale entity types in recipe tables: ${bad.join(', ')}`).toEqual([])
  })

  it('every mapped edge type exists in the spec edge catalog', () => {
    const bad: string[] = []
    for (const recipe of Object.values(SOURCE_RECIPES)) {
      for (const edge of producedEdgeTypes(recipe)) {
        if (!(edge in UPG_EDGE_CATALOG)) bad.push(`${recipe.source}:${edge}`)
      }
    }
    expect(bad, `stale edge types in recipe tables: ${bad.join(', ')}`).toEqual([])
  })
})
