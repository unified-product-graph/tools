/**
 * Tests for the shared catalog helpers — alias resolution + the canonical
 * `get_entity_schema` builder. Pins the contract that every UPG MCP
 * server consumes the same code path.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveEntityType,
  UnknownEntityTypeError,
  buildEntitySchema,
} from '../src/catalog.js'
import { UPG_TYPES_SET } from '@unified-product-graph/core'

describe('resolveEntityType', () => {
  it('returns canonical types unchanged with no alias trail', () => {
    const result = resolveEntityType('persona')
    expect(result.canonical).toBe('persona')
    expect(result.alias).toBeUndefined()
  })

  it('aliases deprecated synonyms to their canonical replacement', () => {
    // jtbd → job — pins the canonical alias path.
    const result = resolveEntityType('jtbd')
    expect(result.canonical).toBe('job')
    expect(result.alias).toEqual({ from: 'jtbd', to: 'job' })
    expect(UPG_TYPES_SET.has(result.canonical)).toBe(true)
  })

  it('throws UnknownEntityTypeError with edit-1 suggestions for typos', () => {
    expect(() => resolveEntityType('persoma')).toThrow(UnknownEntityTypeError)
    try {
      resolveEntityType('persoma')
    } catch (err) {
      const e = err as UnknownEntityTypeError
      expect(e.rawType).toBe('persoma')
      expect(e.suggestions).toContain('persona')
    }
  })

  it('throws UnknownEntityTypeError with no suggestions when input is empty', () => {
    expect(() => resolveEntityType('')).toThrow(UnknownEntityTypeError)
    expect(() => resolveEntityType(null)).toThrow(UnknownEntityTypeError)
    expect(() => resolveEntityType(undefined)).toThrow(UnknownEntityTypeError)
  })
})

describe('buildEntitySchema', () => {
  it('returns the canonical schema for a known type', () => {
    const schema = buildEntitySchema('persona')
    expect(schema.type).toBe('persona')
    expect(schema.alias_of).toBeUndefined()
    expect(schema.domain).toBeTruthy()
    // Persona has outbound edges (e.g. persona_pursues_job) — must be at
    // least one in edges_out via UPG_EDGE_CATALOG.
    expect(schema.edges_out.length).toBeGreaterThan(0)
    for (const edge of schema.edges_out) {
      expect(typeof edge.edge_type).toBe('string')
      expect(typeof edge.target_type).toBe('string')
      expect(typeof edge.forward_verb).toBe('string')
    }
  })

  it('surfaces alias_of when called with a deprecated type', () => {
    const schema = buildEntitySchema('jtbd')
    expect(schema.type).toBe('job')
    expect(schema.alias_of).toEqual({ from: 'jtbd', to: 'job' })
  })

  it('throws UnknownEntityTypeError for unknown inputs', () => {
    expect(() => buildEntitySchema('not_a_real_type_zzz')).toThrow(UnknownEntityTypeError)
  })

  it('omits domain_guide when include_domain_guide is false', () => {
    const schema = buildEntitySchema('persona', { include_domain_guide: false })
    expect(schema.domain_guide).toBeUndefined()
  })

  it('includes domain_guide by default when one exists for the domain', () => {
    const schema = buildEntitySchema('persona')
    // persona belongs to a domain with a guide — should be populated.
    if (schema.domain) {
      expect(schema.domain_guide).toBeDefined()
      if (schema.domain_guide) {
        expect(typeof schema.domain_guide.anchor_entity).toBe('string')
        expect(Array.isArray(schema.domain_guide.creation_sequence)).toBe(true)
        expect(Array.isArray(schema.domain_guide.anti_patterns)).toBe(true)
      }
    }
  })
})
