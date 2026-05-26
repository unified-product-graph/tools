import { describe, it, expect } from 'vitest'
import { nodeId, edgeId } from '../id-helpers.js'

// Cloud mints native Postgres UUIDs (the schema's id columns are UUID).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('ID generation', () => {
  describe('nodeId()', () => {
    it('generates a UUID (matches the upg.nodes.id UUID column)', () => {
      expect(nodeId()).toMatch(UUID_RE)
    })

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => nodeId()))
      expect(ids.size).toBe(100)
    })
  })

  describe('edgeId()', () => {
    it('generates a UUID (matches the upg.edges.id UUID column)', () => {
      expect(edgeId()).toMatch(UUID_RE)
    })

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => edgeId()))
      expect(ids.size).toBe(100)
    })
  })
})
