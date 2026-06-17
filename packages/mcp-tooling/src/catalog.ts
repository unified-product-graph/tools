/**
 * Catalog helpers: alias resolution and an entity-schema builder.
 *
 * One code path answers `get_entity_schema('jtbd')` the same way on
 * local, cloud, and embedded servers (canonical `job` + `alias_of`
 * trail).
 *
 * Entity-type alias resolution (`resolveEntityType`, `UnknownEntityTypeError`,
 * `EntityTypeResolution`) now lives in `@unified-product-graph/core` so a
 * SINGLE `UnknownEntityTypeError` class is shared across the SDK and every
 * server (instance-safe `instanceof` across package boundaries). They are
 * re-exported here so existing mcp-tooling consumers keep their import path.
 *
 * This is the only module in `mcp-tooling` that depends on
 * `@unified-product-graph/core`. Importers that skip the catalog keep
 * using `./result.js`, `./tool-definition.js`, `./transport.js` core-free.
 */

import {
  UPG_EDGE_CATALOG,
  UPG_PROPERTY_SCHEMA,
  getDomainForType,
  getEntityModifierSummary,
  getGuideForDomain,
  getLifecycleForType,
  getPropertySchema,
  resolveEntityType,
  UnknownEntityTypeError,
  type EntityTypeResolution,
  type PropertyModifier,
  type UPGEntityType,
} from '@unified-product-graph/core'

// Re-export the shared entity-type resolution surface (defined in core) so
// existing mcp-tooling consumers keep importing it from `mcp-tooling`.
export { resolveEntityType, UnknownEntityTypeError }
export type { EntityTypeResolution }

/* ---------------------------------------------------------------------------
 * Entity-schema builder: `get_entity_schema` shared response shape
 * ------------------------------------------------------------------------- */

export interface EntitySchemaEdgeOut {
  edge_type: string
  target_type: string
  forward_verb: string
}

export interface EntitySchemaEdgeIn {
  edge_type: string
  source_type: string
  reverse_verb: string
}

export interface EntitySchemaDomainGuideAntiPattern {
  name?: string
  description: string
  affected_entity?: string
  remediation?: string
}

export interface EntitySchemaDomainGuide {
  anchor_entity: string
  creation_sequence: readonly string[]
  position_in_sequence: number
  anti_patterns: EntitySchemaDomainGuideAntiPattern[]
}

export interface EntitySchema {
  type: string
  alias_of?: { from: string; to: string }
  domain: { id: string; label: string } | null
  expected_properties: Record<string, unknown>
  /**
   * Properties that carry a provenance/volatility modifier, grouped by kind —
   * present only when the entity has at least one. `derived` = computed from
   * the graph (never hand-author); `snapshot` = a stale-stamped live reading
   * (pair with `*_as_of`); `volatile` = an environment pointer stripped on
   * export. Lets an agent see which `expected_properties` are not plain.
   */
  property_modifiers?: Record<PropertyModifier, string[]>
  edges_out: EntitySchemaEdgeOut[]
  edges_in: EntitySchemaEdgeIn[]
  phases?: string[]
  initial_phase?: string
  terminal_phases?: string[]
  domain_guide?: EntitySchemaDomainGuide
}

export interface BuildEntitySchemaOptions {
  /**
   * Include the domain guide slice (anchor entity, creation sequence,
   * relevant anti-patterns). Default `true`. Servers that need to keep
   * a smaller response shape (e.g. legacy embedders) can pass `false`.
   */
  include_domain_guide?: boolean
}

/**
 * Resolve an entity-type input and build the canonical
 * `get_entity_schema` response shape.
 *
 * Walks `UPG_EDGE_CATALOG` for `edges_out` and `edges_in` (the same
 * source the LSP uses for completions and diagnostics), surfaces the
 * domain and the domain guide when one exists, and folds in lifecycle
 * phases when the type is registered.
 *
 * Throws `UnknownEntityTypeError` for unknown or mistyped inputs.
 * Servers catch and translate to a `textError` envelope.
 */
export function buildEntitySchema(
  rawType: unknown,
  options: BuildEntitySchemaOptions = {},
): EntitySchema {
  const includeDomainGuide = options.include_domain_guide ?? true

  const resolved = resolveEntityType(rawType)
  const entityType = resolved.canonical

  const domain = getDomainForType(entityType)

  const edgesOut: EntitySchemaEdgeOut[] = []
  const edgesIn: EntitySchemaEdgeIn[] = []
  for (const [edgeKey, def] of Object.entries(UPG_EDGE_CATALOG)) {
    if (def.source_type === entityType) {
      edgesOut.push({
        edge_type: edgeKey,
        target_type: def.target_type,
        forward_verb: def.forward_verb,
      })
    }
    if (def.target_type === entityType) {
      edgesIn.push({
        edge_type: edgeKey,
        source_type: def.source_type,
        reverse_verb: def.reverse_verb,
      })
    }
  }

  const propertySchema = getPropertySchema(entityType)
  const modifierSummary = getEntityModifierSummary(entityType)

  const schema: EntitySchema = {
    type: entityType,
    ...(resolved.alias ? { alias_of: resolved.alias } : {}),
    domain: domain ? { id: domain.id, label: domain.label } : null,
    expected_properties: propertySchema ?? {},
    ...(modifierSummary ? { property_modifiers: modifierSummary } : {}),
    edges_out: edgesOut,
    edges_in: edgesIn,
  }

  const lifecycle = getLifecycleForType(entityType)
  if (lifecycle) {
    schema.phases = lifecycle.phases.map((p) => p.id)
    schema.initial_phase = lifecycle.initial_phase
    schema.terminal_phases = [...lifecycle.terminal_phases]
  }

  if (includeDomainGuide && domain) {
    const guide = getGuideForDomain(domain.id)
    if (guide) {
      const normalise = (ap: unknown): EntitySchemaDomainGuideAntiPattern => {
        if (typeof ap === 'string') return { description: ap }
        const o = (ap as Record<string, unknown>) ?? {}
        const desc = typeof o.description === 'string' ? o.description : ''
        const out: EntitySchemaDomainGuideAntiPattern = { description: desc }
        if (typeof o.name === 'string') out.name = o.name
        if (typeof o.affected_entity === 'string') out.affected_entity = o.affected_entity
        if (typeof o.remediation === 'string') out.remediation = o.remediation
        return out
      }
      const allAntiPatterns = guide.anti_patterns.map(normalise)

      const needle = entityType.replace(/_/g, ' ').toLowerCase()
      const mentions = allAntiPatterns.filter(
        (ap) => ap.affected_entity === entityType || ap.description.toLowerCase().includes(needle),
      )
      const relevant = mentions.length > 0 ? mentions : allAntiPatterns.slice(0, 3)

      schema.domain_guide = {
        anchor_entity: guide.anchor_entity,
        creation_sequence: guide.creation_sequence,
        position_in_sequence: guide.creation_sequence.indexOf(entityType as UPGEntityType),
        anti_patterns: relevant,
      }
    }
  }

  return schema
}

/* ---------------------------------------------------------------------------
 * Entity-fields builder: `get_entity_fields` shared response shape
 * ------------------------------------------------------------------------- */

/**
 * Format a single property entry from `UPG_PROPERTY_SCHEMA` into the
 * legacy `<type-hint> — <description>` string the cloud
 * `get_entity_fields` wire shape uses. Enum values render as quoted
 * alternatives (`'a' | 'b' | 'c'`), arrays as `<elem>[]`, everything
 * else as the bare JSON-schema `type`.
 *
 * Centralised in `@unified-product-graph/mcp-tooling` so every server
 * encodes the format once. The local server omits `get_entity_fields`
 * (its `get_entity_schema` returns the richer `expected_properties`
 * map). This helper is the dedicated bridge that keeps the cloud and
 * embedded responses in lockstep with `UPG_PROPERTY_SCHEMA`.
 */
function formatPropertyHint(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return 'any'
  const p = prop as Record<string, unknown>
  const desc = typeof p.description === 'string' ? p.description : ''

  let hint: string
  if (Array.isArray(p.enum) && p.enum.length > 0) {
    hint = (p.enum as unknown[]).map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ')
  } else if (p.type === 'array') {
    const items = (p.items as Record<string, unknown> | undefined) ?? {}
    const elem = typeof items.type === 'string' ? items.type : 'any'
    hint = `${elem}[]`
  } else if (typeof p.type === 'string') {
    hint = p.type
  } else {
    hint = 'any'
  }

  return desc ? `${hint} — ${desc}` : hint
}

/**
 * Build the `Record<string, string>` field map for a single entity type
 * by walking `UPG_PROPERTY_SCHEMA[type]`. Returns `undefined` when the
 * type has no canonical property schema (for example, v0.1 names that
 * map to a v0.2 canonical). Callers resolve aliases via
 * `resolveEntityType` first.
 */
export function buildEntityFields(type: string): Record<string, string> | undefined {
  // Defensive: some bundlers (notably Turbopack) have been observed to
  // drop named imports from workspace-linked `"type": "module"` packages
  // during ESM interop. If `UPG_PROPERTY_SCHEMA` didn't resolve, degrade
  // to "schema unavailable" rather than crashing the caller's module
  // evaluation.
  if (!UPG_PROPERTY_SCHEMA) return undefined
  const schema = UPG_PROPERTY_SCHEMA[type as UPGEntityType] as
    | Record<string, unknown>
    | undefined
  if (!schema) return undefined
  const out: Record<string, string> = {}
  for (const [name, prop] of Object.entries(schema)) {
    out[name] = formatPropertyHint(prop)
  }
  return out
}

/**
 * Build the full `{ [type]: { [field]: hint } }` map across every entity
 * type that has a canonical property schema. Used by the cloud route to
 * derive its `ENTITY_FIELDS` export from `@unified-product-graph/core`
 * at module load. One source, zero hand-maintained drift.
 */
export function buildAllEntityFields(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  // Defensive: see `buildEntityFields` above. If the named import dropped,
  // return an empty map. Consumers already handle missing types.
  if (!UPG_PROPERTY_SCHEMA) return out
  for (const type of Object.keys(UPG_PROPERTY_SCHEMA)) {
    const fields = buildEntityFields(type)
    if (fields) out[type] = fields
  }
  return out
}
