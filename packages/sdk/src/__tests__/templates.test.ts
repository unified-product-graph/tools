/**
 * SDK template access layer — the single source the CLI and both MCP servers
 * derive from. Locks the contract those surfaces depend on.
 */
import { describe, it, expect } from 'vitest'
import {
  listTemplates,
  getTemplate,
  getStarterSeeds,
  STARTER_KEYS,
} from '../templates.js'

describe('listTemplates', () => {
  it('returns every template with no filter', () => {
    const all = listTemplates()
    expect(all.length).toBeGreaterThan(0)
    for (const t of all) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.entity_count).toBeGreaterThan(0)
      expect(t.entity_types.length).toBeGreaterThan(0)
    }
  })

  it('filters by industry case-insensitively', () => {
    const lower = listTemplates({ industry: 'saas' })
    expect(lower.length).toBeGreaterThan(0)
    expect(lower.every((t) => t.industries.includes('saas'))).toBe(true)
    // an agent (or a user) may pass "SaaS" — must match the same set
    expect(listTemplates({ industry: 'SaaS' }).map((t) => t.id)).toEqual(lower.map((t) => t.id))
    expect(listTemplates({ industry: 'SAAS' }).map((t) => t.id)).toEqual(lower.map((t) => t.id))
  })

  it('filters by stage case-insensitively', () => {
    // canonical UPG_PRODUCT_STAGES (templates migrated idea→concept,
    // mvp→validation, scale→mature; growth unchanged)
    const lower = listTemplates({ stage: 'validation' })
    expect(lower.length).toBeGreaterThan(0)
    expect(listTemplates({ stage: 'Validation' }).map((t) => t.id)).toEqual(lower.map((t) => t.id))
  })

  it('returns empty for an unknown industry (no throw)', () => {
    expect(listTemplates({ industry: 'nope' })).toEqual([])
  })
})

describe('getTemplate', () => {
  it('returns the full payload (entities + typed edges + prompts) for a known id', () => {
    const tpl = getTemplate('saas-business-model')
    expect(tpl).toBeDefined()
    expect(tpl!.entities.length).toBeGreaterThan(0)
    expect((tpl!.edges ?? []).every((e) => typeof e.type === 'string' && e.type.length > 0)).toBe(true)
  })

  it('returns undefined for an unknown id', () => {
    expect(getTemplate('does-not-exist')).toBeUndefined()
  })
})

describe('starter seeds', () => {
  it('exposes the roster keys incl. blank', () => {
    expect(STARTER_KEYS).toContain('blank')
    expect(STARTER_KEYS).toContain('agency')
  })

  it('blank is empty; non-blank seeds carry valid-looking nodes', () => {
    expect(getStarterSeeds('blank')).toEqual([])
    const saas = getStarterSeeds('saas')
    expect(saas.length).toBeGreaterThan(0)
    expect(saas.every((n) => n.type && n.title)).toBe(true)
  })
})
