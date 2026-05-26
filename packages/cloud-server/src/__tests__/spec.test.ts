/**
 * Spec-introspection tools — cloud mirror of (round 1) + 
 * (round 2) + (round 3) + (approach verbs)..
 *
 * All spec handlers ignore `ctx` (they're pure reads from
 * @unified-product-graph/core), so `{}` is passed as the context arg throughout.
 * Mirrors the structure of packages/upg-mcp-server/src/__tests__/spec-tools.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  UPG_PLAYBOOKS,
  UPG_APPROACHES,
  UPG_DOMAIN_GUIDES,
  UPG_DOMAINS,
  UPG_FRAMEWORKS,
  UPG_EDGE_CATALOG,
  UPG_REGIONS,
  UPG_LENSES,
  UPG_TYPE_LABELS,
  UPG_CROSS_EDGE_TYPES,
  UPG_VERSION,
  MARKDOWN_FORMAT_VERSION,
  UPG_VALID_CHILDREN,
  UPG_ENTITY_META,
  UPG_ENTITY_TO_DOMAIN,
  UPG_ANTI_PATTERNS,
  UPG_COUNT_BENCHMARKS,
  UPG_RELATIONSHIP_BENCHMARKS,
  UPG_RATIO_BENCHMARKS,
  UPG_DOMAIN_ACTIVATION,
  UPG_PRODUCT_STAGES,
  resolveContainmentEdge,
  resolveLabel,
  getVisibleTypes,
  getLens,
} from '@unified-product-graph/core'
import {
  listPlaybooks,
  getPlaybook,
  listApproaches,
  getApproach,
  plan,
  inspect,
  prioritise,
  trace,
  reflect,
  listDomains,
  getDomainGuide,
  listFrameworks,
  getFramework,
  listEdgeTypes,
  getEdgeType,
  listRegions,
  getRegion,
  getRegionForEntity,
  getSpecVersion,
  resolveEdgeForPair,
  listCrossEdgeTypes,
  listLenses,
  getLensTool,
  listTypeLabels,
  getTypeLabel,
  getValidChildrenTool,
  listEntityTypes,
  getEntityMeta,
  listAntiPatterns,
  getAntiPattern,
  listBenchmarks,
  listProductStages,
} from '../tools/spec.js'
import type { ToolResult } from '../lib/server-context.js'

// ctx is unused by all spec handlers — {} as any satisfies the CloudContext shape.
function call(
  handler: (args: Record<string, unknown>, ctx: never) => ToolResult | Promise<ToolResult>,
  args: Record<string, unknown> = {},
): { ok: boolean; body: unknown; raw: ToolResult } {
  const result = handler(args, {} as never) as ToolResult
  if (result.isError) return { ok: false, body: result.content[0].text, raw: result }
  return { ok: true, body: JSON.parse(result.content[0].text), raw: result }
}

// ── Playbooks ─────────────────────────────────────────────────────

describe('list_playbooks / get_playbook', () => {
  it('list_playbooks returns every canonical playbook by default', () => {
    const { ok, body } = call(listPlaybooks, {})
    expect(ok).toBe(true)
    const b = body as { count: number; playbooks: unknown[] }
    expect(b.count).toBe(UPG_PLAYBOOKS.length)
    expect(b.playbooks).toHaveLength(UPG_PLAYBOOKS.length)
  })

  it('list_playbooks ships 23 playbooks at v0.3.0', () => {
    const { body } = call(listPlaybooks, {})
    const b = body as { count: number }
    expect(b.count).toBe(23)
  })

  it('list_playbooks filters by canonical_only (W1 invariant — exactly 10)', () => {
    const { body } = call(listPlaybooks, { canonical_only: true })
    const b = body as { count: number; playbooks: Array<{ is_canonical?: boolean }> }
    expect(b.count).toBe(UPG_REGIONS.length)
    expect(b.count).toBe(10)
    expect(b.playbooks.every((p) => p.is_canonical === true)).toBe(true)
  })

  it('list_playbooks filters by region', () => {
    const { body } = call(listPlaybooks, { region: 'business_gtm_growth' })
    const b = body as { playbooks: Array<{ region: string }> }
    expect(b.playbooks.length).toBeGreaterThan(0)
    expect(b.playbooks.every((p) => p.region === 'business_gtm_growth')).toBe(true)
  })

  it('list_playbooks filters by framework_id', () => {
    const { body } = call(listPlaybooks, { framework_id: 'business-model-canvas' })
    const b = body as { playbooks: Array<{ id: string; framework_id?: string }> }
    expect(b.playbooks).toHaveLength(1)
    expect(b.playbooks[0].id).toBe('playbook:business-model-bmc')
    expect(b.playbooks[0].framework_id).toBe('business-model-canvas')
  })

  it('get_playbook returns the canonical record by id', () => {
    const sample = UPG_PLAYBOOKS[0]
    const { ok, body } = call(getPlaybook, { id: sample.id })
    expect(ok).toBe(true)
    expect((body as { id: string }).id).toBe(sample.id)
    expect((body as { creation_sequence: unknown[] }).creation_sequence).toEqual(sample.creation_sequence)
  })

  it('get_playbook errors on missing id', () => {
    expect(call(getPlaybook, {}).ok).toBe(false)
  })

  it('get_playbook errors on unknown id', () => {
    const { ok, raw } = call(getPlaybook, { id: 'playbook:does-not-exist' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown playbook id/)
  })
})

// ── Approaches ────────────────────────────────────────────────────

describe('list_approaches / get_approach', () => {
  it('list_approaches returns exactly 5 approaches', () => {
    const { ok, body } = call(listApproaches, {})
    expect(ok).toBe(true)
    const b = body as { count: number; approaches: Array<{ id: string }> }
    expect(b.count).toBe(5)
    expect(b.approaches.map((a) => a.id)).toEqual([
      'plan',
      'inspect',
      'prioritise',
      'trace',
      'reflect',
    ])
    expect(UPG_APPROACHES).toHaveLength(5)
  })

  it('list_approaches filters by framework_id', () => {
    const { ok, body } = call(listApproaches, { framework_id: 'rice-scoring' })
    expect(ok).toBe(true)
    const b = body as { count: number; approaches: Array<{ id: string }> }
    expect(b.count).toBe(1)
    expect(b.approaches[0].id).toBe('prioritise')
  })

  it('get_approach returns the canonical record by bare-verb id', () => {
    const { ok, body } = call(getApproach, { id: 'plan' })
    expect(ok).toBe(true)
    const b = body as { id: string; question_answered: string; signature_hint: string }
    expect(b.id).toBe('plan')
    expect(b.question_answered).toMatch(/build next/i)
    expect(b.signature_hint).toMatch(/coverage_score/)
  })

  it('get_approach errors on missing id', () => {
    expect(call(getApproach, {}).ok).toBe(false)
  })

  it('get_approach errors on unknown id with helpful message', () => {
    const { ok, raw } = call(getApproach, { id: 'survey' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown approach id/)
    expect(raw.content[0].text).toMatch(/plan, inspect, prioritise, trace, reflect/)
  })
})

// ── Approach verbs ───────────────────

describe('plan / inspect / prioritise / trace / reflect — definition lookups', () => {
  it('plan returns the family-resemblance envelope with the Plan approach', () => {
    const { ok, body } = call(plan, { region: 'users_needs' })
    expect(ok).toBe(true)
    const b = body as {
      approach_id: string
      scope: string
      generated_at: string
      approach: { id: string; label: string }
      params: { region: string }
    }
    expect(b.approach_id).toBe('plan')
    expect(b.scope).toBe('users_needs')
    expect(b.approach.id).toBe('plan')
    expect(b.approach.label).toBe('Plan')
    expect(b.params.region).toBe('users_needs')
    expect(b.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('plan accepts no region (whole-graph) and echoes scope null', () => {
    const { body } = call(plan, {})
    const b = body as { scope: unknown; params: { region: unknown } }
    expect(b.scope).toBeNull()
    expect(b.params.region).toBeNull()
  })

  it('inspect accepts region OR entities scope', () => {
    const r = call(inspect, { region: 'business_gtm_growth' }).body as {
      approach_id: string
      scope: string
    }
    expect(r.approach_id).toBe('inspect')
    expect(r.scope).toBe('business_gtm_growth')

    const e = call(inspect, { entities: ['n1', 'n2'] }).body as { scope: string[] }
    expect(e.scope).toEqual(['n1', 'n2'])
  })

  it('prioritise requires candidates AND framework_id', () => {
    expect(call(prioritise, {}).ok).toBe(false)
    expect(call(prioritise, { candidates: ['n1'] }).ok).toBe(false)
    expect(call(prioritise, { framework_id: 'rice-scoring' }).ok).toBe(false)
    expect(call(prioritise, { candidates: [], framework_id: 'rice-scoring' }).ok).toBe(false)
  })

  it('prioritise returns the envelope + framework metadata when valid', () => {
    const { ok, body } = call(prioritise, {
      candidates: ['feature:a', 'feature:b'],
      framework_id: 'rice-scoring',
    })
    expect(ok).toBe(true)
    const b = body as {
      approach_id: string
      scope: string[]
      params: { candidates: string[]; framework_id: string }
      framework_resolved: { id: string; name: string } | null
    }
    expect(b.approach_id).toBe('prioritise')
    expect(b.scope).toEqual(['feature:a', 'feature:b'])
    expect(b.framework_resolved?.id).toBe('rice-scoring')
  })

  it('prioritise returns null framework_resolved on unknown framework_id', () => {
    const { body } = call(prioritise, {
      candidates: ['n1'],
      framework_id: 'not-a-framework',
    })
    const b = body as { framework_resolved: unknown }
    expect(b.framework_resolved).toBeNull()
  })

  it('trace requires anchor and path', () => {
    expect(call(trace, {}).ok).toBe(false)
    expect(call(trace, { anchor: 'persona:1' }).ok).toBe(false)
    expect(call(trace, { path: ['persona', 'job'] }).ok).toBe(false)
  })

  it('trace rejects edges_override of mismatched length', () => {
    const { ok, raw } = call(trace, {
      anchor: 'persona:1',
      path: ['persona', 'job', 'feature'],
      edges_override: ['persona_pursues_job'],
    })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/edges_override length/)
  })

  it('trace returns the envelope with anchor + path echoed', () => {
    const { ok, body } = call(trace, {
      anchor: 'persona:1',
      path: ['persona', 'job', 'feature'],
    })
    expect(ok).toBe(true)
    const b = body as {
      approach_id: string
      scope: string
      params: { anchor: string; path: string[]; edges_override: unknown }
    }
    expect(b.approach_id).toBe('trace')
    expect(b.scope).toBe('persona:1')
    expect(b.params.path).toEqual(['persona', 'job', 'feature'])
    expect(b.params.edges_override).toBeNull()
  })

  it('reflect accepts no mode (open reflection)', () => {
    const { ok, body } = call(reflect, {})
    expect(ok).toBe(true)
    const b = body as {
      approach_id: string
      params: { scope: unknown; mode: unknown }
    }
    expect(b.approach_id).toBe('reflect')
    expect(b.params.mode).toBeNull()
  })

  it('reflect accepts each canonical mode', () => {
    for (const mode of ['assumptions', 'alternatives', 'blind-spots', 'load-bearing']) {
      const { ok, body } = call(reflect, { mode })
      expect(ok).toBe(true)
      expect((body as { params: { mode: string } }).params.mode).toBe(mode)
    }
  })

  it('reflect rejects an invalid mode with helpful message', () => {
    const { ok, raw } = call(reflect, { mode: 'open' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Invalid mode/)
    expect(raw.content[0].text).toMatch(/assumptions, alternatives, blind-spots, load-bearing/)
  })

  it('every approach handler stamps approach_id, scope, generated_at', () => {
    const calls = [
      call(plan, {}),
      call(inspect, {}),
      call(prioritise, { candidates: ['n1'], framework_id: 'rice-scoring' }),
      call(trace, { anchor: 'n1', path: ['persona'] }),
      call(reflect, {}),
    ]
    for (const c of calls) {
      expect(c.ok).toBe(true)
      const b = c.body as { approach_id: string; generated_at: string; approach: unknown }
      expect(b.approach_id).toBeTypeOf('string')
      expect(b.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(b.approach).toBeDefined()
    }
  })
})

// ── Domains ─────────────────────────────────────────────────────────────────

describe('list_domains / get_domain_guide', () => {
  it('list_domains returns every canonical guide id by default', () => {
    const { body } = call(listDomains, {})
    const b = body as {
      count: number
      domains: Array<{ domain_id: string; anchor_entity: string }>
    }
    expect(b.count).toBe(UPG_DOMAIN_GUIDES.length)
    const ids = new Set(b.domains.map((d) => d.domain_id))
    for (const g of UPG_DOMAIN_GUIDES) expect(ids.has(g.domain_id)).toBe(true)
  })

  it('list_domains with_guide_only: false returns every atomic domain', () => {
    const { ok, body } = call(listDomains, { with_guide_only: false })
    expect(ok).toBe(true)
    const b = body as {
      count: number
      domains: Array<{ domain_id: string; has_guide: boolean }>
    }
    expect(b.count).toBe(UPG_DOMAINS.length)
    const guideIds = new Set<string>(UPG_DOMAIN_GUIDES.map((g) => g.domain_id))
    for (const row of b.domains) {
      expect(row.has_guide).toBe(guideIds.has(row.domain_id))
    }
  })

  it('get_domain_guide returns the full guide', () => {
    const sample = UPG_DOMAIN_GUIDES.find((g) => g.domain_id === 'market_intelligence')
    expect(sample).toBeDefined()
    if (!sample) return
    const { body } = call(getDomainGuide, { domain_id: 'market_intelligence' })
    const guide = body as typeof sample
    expect(guide.domain_id).toBe('market_intelligence')
    expect(guide.anchor_entity).toBe(sample.anchor_entity)
    expect(guide.creation_sequence).toEqual(sample.creation_sequence)
  })

  it('get_domain_guide errors on missing or unknown domain_id', () => {
    expect(call(getDomainGuide, {}).ok).toBe(false)
    const { ok, raw } = call(getDomainGuide, { domain_id: 'not_a_domain' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown domain_id/)
  })
})

// ── Frameworks ──────────────────────────────────────────────────────────────

describe('list_frameworks / get_framework', () => {
  it('list_frameworks paginates with a default limit of 50', () => {
    const { body } = call(listFrameworks, {})
    const b = body as { total: number; count: number; next_cursor?: string }
    expect(b.total).toBe(UPG_FRAMEWORKS.length)
    expect(b.count).toBe(Math.min(50, UPG_FRAMEWORKS.length))
    if (UPG_FRAMEWORKS.length > 50) {
      expect(b.next_cursor).toBeTruthy()
    }
  })

  it('list_frameworks respects limit and clamps at 200', () => {
    const small = call(listFrameworks, { limit: 10 }).body as { count: number }
    expect(small.count).toBe(10)
    const huge = call(listFrameworks, { limit: 5000 }).body as { count: number }
    expect(huge.count).toBeLessThanOrEqual(200)
  })

  it('list_frameworks pagination walks the full set', () => {
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const args: Record<string, unknown> = { limit: 100 }
      if (cursor) args.cursor = cursor
      const body = call(listFrameworks, args).body as {
        frameworks: Array<{ id: string }>
        next_cursor?: string
      }
      for (const f of body.frameworks) seen.add(f.id)
      cursor = body.next_cursor
      pages += 1
      if (pages > 50) throw new Error('runaway pagination')
    } while (cursor)
    expect(seen.size).toBe(UPG_FRAMEWORKS.length)
  })

  it('list_frameworks filters by category before pagination', () => {
    const { body } = call(listFrameworks, { category: 'strategy', limit: 200 })
    const b = body as { total: number; frameworks: Array<{ category: string }> }
    const expected = UPG_FRAMEWORKS.filter((f) => f.category === 'strategy')
    expect(b.total).toBe(expected.length)
    expect(b.frameworks.every((f) => f.category === 'strategy')).toBe(true)
  })

  it('get_framework returns the full record', () => {
    const sample = UPG_FRAMEWORKS[0]
    const { body } = call(getFramework, { id: sample.id })
    expect((body as { id: string }).id).toBe(sample.id)
    expect((body as { education: unknown }).education).toEqual(sample.education)
  })

  it('get_framework errors on missing or unknown id', () => {
    expect(call(getFramework, {}).ok).toBe(false)
    expect(call(getFramework, { id: 'no-such-framework' }).ok).toBe(false)
  })
})

// ── Edge types ───────────────────────────────────────────────────────────────

describe('list_edge_types / get_edge_type', () => {
  it('list_edge_types returns every catalogue entry by default', () => {
    const { body } = call(listEdgeTypes, {})
    const b = body as { count: number; edges: Array<{ type: string }> }
    expect(b.count).toBe(Object.keys(UPG_EDGE_CATALOG).length)
    expect(new Set(b.edges.map((e) => e.type)).size).toBe(b.count)
  })

  it('list_edge_types filters by source_type', () => {
    const { body } = call(listEdgeTypes, { source_type: 'persona' })
    const edges = (body as { edges: Array<{ source_type: string }> }).edges
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.source_type === 'persona')).toBe(true)
  })

  it('get_edge_type returns the catalogue entry by key', () => {
    const [type, def] = Object.entries(UPG_EDGE_CATALOG)[0]
    const { body } = call(getEdgeType, { type })
    expect((body as { type: string }).type).toBe(type)
    expect((body as { forward_verb: string }).forward_verb).toBe(
      (def as { forward_verb: string }).forward_verb,
    )
  })

  it('get_edge_type errors on missing or unknown type', () => {
    expect(call(getEdgeType, {}).ok).toBe(false)
    expect(call(getEdgeType, { type: 'not_an_edge' }).ok).toBe(false)
  })
})

// ── Spec version ──────────────────────────────────────────────────

describe('get_spec_version', () => {
  it('returns the canonical version block', () => {
    const { ok, body } = call(getSpecVersion, {})
    expect(ok).toBe(true)
    const b = body as {
      upg_version: string
      markdown_format_version: string
      entity_count: number
      edge_count: number
      domain_count: number
      region_count: number
    }
    expect(b.upg_version).toBe(UPG_VERSION)
    expect(b.markdown_format_version).toBe(MARKDOWN_FORMAT_VERSION)
    expect(b.region_count).toBe(UPG_REGIONS.length)
    expect(b.edge_count).toBe(Object.keys(UPG_EDGE_CATALOG).length)
    expect(b.entity_count).toBeGreaterThan(0)
    expect(b.domain_count).toBeGreaterThan(0)
  })
})

// ── Regions ───────────────────────────────────────────────────────

describe('list_regions / get_region / get_region_for_entity_type', () => {
  it('list_regions returns all canonical regions', () => {
    const { ok, body } = call(listRegions, {})
    expect(ok).toBe(true)
    const b = body as {
      count: number
      regions: Array<{ id: string; order: number; entity_count: number }>
    }
    expect(b.count).toBe(UPG_REGIONS.length)
    expect(b.regions).toHaveLength(UPG_REGIONS.length)
    expect(b.regions.map((r) => r.order)).toEqual(UPG_REGIONS.map((r) => r.order))
    for (let i = 0; i < UPG_REGIONS.length; i++) {
      expect(b.regions[i].entity_count).toBe(UPG_REGIONS[i].entities.length)
    }
  })

  it('get_region returns the full canonical record', () => {
    const sample = UPG_REGIONS[0]
    const { body } = call(getRegion, { id: sample.id })
    const r = body as typeof sample
    expect(r.id).toBe(sample.id)
    expect(r.anchor).toEqual(sample.anchor)
    expect(r.entities).toEqual(sample.entities)
    expect(r.intra_edges).toEqual(sample.intra_edges)
    expect(r.boundary_edges).toEqual(sample.boundary_edges)
  })

  it('get_region errors on missing or unknown id', () => {
    expect(call(getRegion, {}).ok).toBe(false)
    const { ok, raw } = call(getRegion, { id: 'not_a_region' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown region id/)
  })

  it('get_region_for_entity_type resolves the containing region', () => {
    const sample = UPG_REGIONS[0]
    const memberType = sample.entities[0].type
    const { body } = call(getRegionForEntity, { entity_type: memberType })
    expect((body as { id: string }).id).toBe(sample.id)
  })

  it('get_region_for_entity_type errors on unknown entity_type', () => {
    expect(call(getRegionForEntity, {}).ok).toBe(false)
    const { ok, raw } = call(getRegionForEntity, { entity_type: 'not_a_real_type' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/No region contains entity_type/)
  })
})

// ── Edge resolver ─────────────────────────────────────────────────

describe('resolve_edge_for_pair', () => {
  it('resolves a known catalogued pair to its canonical edge type', () => {
    const [type, def] = Object.entries(UPG_EDGE_CATALOG)[0] as [
      string,
      { source_type: string; target_type: string },
    ]
    const { body } = call(resolveEdgeForPair, {
      source_type: def.source_type,
      target_type: def.target_type,
    })
    const b = body as { edge_type: string | null }
    expect(b.edge_type).toBe(resolveContainmentEdge(def.source_type, def.target_type))
    expect(typeof type).toBe('string')
  })

  it('returns edge_type null for an uncatalogued pair', () => {
    const { body } = call(resolveEdgeForPair, {
      source_type: 'not_a_type_x',
      target_type: 'not_a_type_y',
    })
    expect((body as { edge_type: string | null }).edge_type).toBeNull()
  })

  it('errors on missing source_type or target_type', () => {
    expect(call(resolveEdgeForPair, {}).ok).toBe(false)
    expect(call(resolveEdgeForPair, { source_type: 'persona' }).ok).toBe(false)
    expect(call(resolveEdgeForPair, { target_type: 'feature' }).ok).toBe(false)
  })
})

// ── Cross-edge types ──────────────────────────────────────────────

describe('list_cross_edge_types', () => {
  it('returns the canonical cross-edge types', () => {
    const { ok, body } = call(listCrossEdgeTypes, {})
    expect(ok).toBe(true)
    const b = body as { count: number; types: readonly string[] }
    expect(b.count).toBe(UPG_CROSS_EDGE_TYPES.length)
    expect(b.types).toEqual(UPG_CROSS_EDGE_TYPES)
  })
})

// ── Lenses ────────────────────────────────────────────────────────

describe('list_lenses / get_lens', () => {
  it('list_lenses returns 8 canonical lenses', () => {
    const { ok, body } = call(listLenses, {})
    expect(ok).toBe(true)
    const b = body as { count: number; lenses: Array<{ id: string }> }
    expect(b.count).toBe(UPG_LENSES.length)
    expect(new Set(b.lenses.map((l) => l.id)).size).toBe(UPG_LENSES.length)
  })

  it('get_lens returns the full record plus resolved visible_types', () => {
    const sample = UPG_LENSES[0]
    const { ok, body } = call(getLensTool, { id: sample.id })
    expect(ok).toBe(true)
    const b = body as { id: string; visible_types: string[] }
    expect(b.id).toBe(sample.id)
    expect(b.visible_types).toEqual(getVisibleTypes(getLens(sample.id)!))
  })

  it('get_lens errors on missing or unknown id', () => {
    expect(call(getLensTool, {}).ok).toBe(false)
    const { ok, raw } = call(getLensTool, { id: 'not_a_lens' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown lens id/)
  })
})

// ── Type labels ───────────────────────────────────────────────────

describe('list_type_labels / get_type_label', () => {
  it('list_type_labels paginates with a default limit of 100', () => {
    const { body } = call(listTypeLabels, {})
    const b = body as { total: number; count: number; next_cursor?: string }
    expect(b.total).toBe(UPG_TYPE_LABELS.length)
    expect(b.count).toBe(Math.min(100, UPG_TYPE_LABELS.length))
    if (UPG_TYPE_LABELS.length > 100) expect(b.next_cursor).toBeTruthy()
  })

  it('list_type_labels clamps limit at 500', () => {
    const huge = call(listTypeLabels, { limit: 5000 }).body as { count: number }
    expect(huge.count).toBeLessThanOrEqual(500)
  })

  it('list_type_labels pagination walks the full set', () => {
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const args: Record<string, unknown> = { limit: 200 }
      if (cursor) args.cursor = cursor
      const body = call(listTypeLabels, args).body as {
        labels: Array<{ id: string }>
        next_cursor?: string
      }
      for (const l of body.labels) seen.add(l.id)
      cursor = body.next_cursor
      pages += 1
      if (pages > 50) throw new Error('runaway pagination')
    } while (cursor)
    expect(seen.size).toBe(UPG_TYPE_LABELS.length)
  })

  it('get_type_label returns the canonical entry plus resolved label', () => {
    const sample = UPG_TYPE_LABELS[0]
    const { body } = call(getTypeLabel, { entity_type: sample.id })
    const b = body as { id: string; canonical_label: string; resolved_label: string }
    expect(b.id).toBe(sample.id)
    expect(b.canonical_label).toBe(sample.canonical_label)
    expect(b.resolved_label).toBe(resolveLabel(sample.id))
  })

  it('get_type_label errors on missing or unknown entity_type', () => {
    expect(call(getTypeLabel, {}).ok).toBe(false)
    const { ok, raw } = call(getTypeLabel, { entity_type: 'not_a_type' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown entity_type/)
  })
})

// ── Hierarchy ─────────────────────────────────────────────────────

describe('get_valid_children', () => {
  it('returns the canonical valid children for a known parent type', () => {
    const parent = Object.keys(UPG_VALID_CHILDREN)[0]
    const expected = UPG_VALID_CHILDREN[parent]
    const { body } = call(getValidChildrenTool, { parent_type: parent })
    const b = body as { parent_type: string; valid_children: string[] }
    expect(b.parent_type).toBe(parent)
    expect(b.valid_children).toEqual(expected)
  })

  it('returns an empty array for unknown parent_type', () => {
    const { body } = call(getValidChildrenTool, { parent_type: 'not_a_type_zzz' })
    expect((body as { valid_children: string[] }).valid_children).toEqual([])
  })

  it('errors on missing parent_type', () => {
    expect(call(getValidChildrenTool, {}).ok).toBe(false)
  })
})

// ── Entity types + meta ───────────────────────────────────────────

describe('list_entity_types / get_entity_meta', () => {
  it('list_entity_types paginates with default limit 50', () => {
    const { ok, body } = call(listEntityTypes, {})
    expect(ok).toBe(true)
    const b = body as { total: number; count: number; next_cursor?: string }
    expect(b.total).toBe(UPG_ENTITY_META.length)
    expect(b.count).toBe(Math.min(50, UPG_ENTITY_META.length))
    if (UPG_ENTITY_META.length > 50) expect(b.next_cursor).toBeTruthy()
  })

  it('list_entity_types clamps limit at 200', () => {
    const huge = call(listEntityTypes, { limit: 5000 }).body as { count: number }
    expect(huge.count).toBeLessThanOrEqual(200)
  })

  it('list_entity_types filters by maturity', () => {
    const { body } = call(listEntityTypes, { maturity: 'deprecated', limit: 200 })
    const b = body as { total: number; types: Array<{ maturity: string }> }
    const expected = UPG_ENTITY_META.filter((m) => m.maturity === 'deprecated')
    expect(b.total).toBe(expected.length)
    expect(b.types.every((t) => t.maturity === 'deprecated')).toBe(true)
  })

  it('list_entity_types deprecated:true keeps only deprecated types', () => {
    const { body } = call(listEntityTypes, { deprecated: true, limit: 200 })
    const b = body as { types: Array<{ maturity: string }> }
    expect(b.types.every((t) => t.maturity === 'deprecated')).toBe(true)
  })

  it('list_entity_types deprecated:false excludes deprecated and removed', () => {
    const { body } = call(listEntityTypes, { deprecated: false, limit: 500 })
    const b = body as { types: Array<{ maturity: string }> }
    expect(b.types.every((t) => t.maturity !== 'deprecated' && t.maturity !== 'removed')).toBe(true)
  })

  it('list_entity_types filters by domain', () => {
    const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>
    const { body } = call(listEntityTypes, { domain: 'user', limit: 200 })
    const b = body as { types: Array<{ name: string; domain_id: string | null }> }
    expect(b.types.length).toBeGreaterThan(0)
    expect(b.types.every((t) => t.domain_id === 'user')).toBe(true)
    expect(typeToDomain['persona']).toBe('user')
    expect(b.types.some((t) => t.name === 'persona')).toBe(true)
  })

  it('get_entity_meta returns the canonical record + domain_id', () => {
    const { body } = call(getEntityMeta, { name: 'persona' })
    const b = body as {
      name: string
      type_id: string
      maturity: string
      domain_id: string | null
    }
    expect(b.name).toBe('persona')
    expect(b.type_id).toBe('ent_016')
    expect(b.maturity).toBe('stable')
    expect(b.domain_id).toBe('user')
  })

  it('get_entity_meta surfaces replacement for deprecated types', () => {
    const { body } = call(getEntityMeta, { name: 'pain_point' })
    const b = body as { maturity: string; replacement?: string }
    expect(b.maturity).toBe('deprecated')
    expect(b.replacement).toBe('need')
  })

  it('get_entity_meta errors on missing or unknown name', () => {
    expect(call(getEntityMeta, {}).ok).toBe(false)
    const { ok, raw } = call(getEntityMeta, { name: 'not_a_real_type' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown entity type/)
  })
})

// ── Anti-patterns ─────────────────────────────────────────────────

describe('list_anti_patterns / get_anti_pattern', () => {
  it('list_anti_patterns returns every curated entry by default', () => {
    const { ok, body } = call(listAntiPatterns, {})
    expect(ok).toBe(true)
    const b = body as { total: number; count: number; anti_patterns: Array<{ id: string }> }
    expect(b.total).toBe(UPG_ANTI_PATTERNS.length)
    expect(b.count).toBe(Math.min(50, UPG_ANTI_PATTERNS.length))
  })

  it('list_anti_patterns filters by severity', () => {
    const { body } = call(listAntiPatterns, { severity: 'high', limit: 200 })
    const b = body as { total: number; anti_patterns: Array<{ severity: string }> }
    const expected = UPG_ANTI_PATTERNS.filter((p) => p.severity === 'high')
    expect(b.total).toBe(expected.length)
    expect(b.anti_patterns.every((p) => p.severity === 'high')).toBe(true)
  })

  it('list_anti_patterns filters by stage', () => {
    const { body } = call(listAntiPatterns, { stage: 'launch', limit: 200 })
    const b = body as { anti_patterns: Array<{ stages: readonly string[] }> }
    expect(b.anti_patterns.every((p) => p.stages.includes('launch'))).toBe(true)
  })

  it('list_anti_patterns clamps limit at 200', () => {
    const huge = call(listAntiPatterns, { limit: 5000 }).body as { count: number }
    expect(huge.count).toBeLessThanOrEqual(200)
  })

  it('get_anti_pattern returns the full curated body', () => {
    const sample = UPG_ANTI_PATTERNS[0]
    const { body } = call(getAntiPattern, { id: sample.id })
    const b = body as typeof sample
    expect(b.id).toBe(sample.id)
    expect(b.severity).toBe(sample.severity)
    expect(b.structured_condition).toEqual(sample.structured_condition)
    expect(b.stages).toEqual(sample.stages)
  })

  it('get_anti_pattern errors on missing or unknown id', () => {
    expect(call(getAntiPattern, {}).ok).toBe(false)
    const { ok, raw } = call(getAntiPattern, { id: 'not-a-real-pattern' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown anti-pattern id/)
  })
})

// ── Benchmarks ────────────────────────────────────────────────────

describe('list_benchmarks', () => {
  it('errors when kind is missing', () => {
    expect(call(listBenchmarks, {}).ok).toBe(false)
  })

  it('errors when kind is unknown', () => {
    const { ok, raw } = call(listBenchmarks, { kind: 'not_a_kind' })
    expect(ok).toBe(false)
    expect(raw.content[0].text).toMatch(/Unknown kind/)
  })

  it('kind=count returns UPG_COUNT_BENCHMARKS', () => {
    const { ok, body } = call(listBenchmarks, { kind: 'count' })
    expect(ok).toBe(true)
    const b = body as { kind: string; total: number; count: number }
    expect(b.kind).toBe('count')
    expect(b.total).toBe(UPG_COUNT_BENCHMARKS.length)
    expect(b.count).toBe(UPG_COUNT_BENCHMARKS.length)
  })

  it('kind=count filters by domain', () => {
    const { body } = call(listBenchmarks, { kind: 'count', domain: 'strategy' })
    const b = body as { benchmarks: Array<{ domain: string }> }
    expect(b.benchmarks.length).toBeGreaterThan(0)
    expect(b.benchmarks.every((bm) => bm.domain === 'strategy')).toBe(true)
  })

  it('kind=relationship returns UPG_RELATIONSHIP_BENCHMARKS', () => {
    const { body } = call(listBenchmarks, { kind: 'relationship' })
    const b = body as { kind: string; total: number; benchmarks: unknown[] }
    expect(b.kind).toBe('relationship')
    expect(b.total).toBe(UPG_RELATIONSHIP_BENCHMARKS.length)
    expect(b.benchmarks).toHaveLength(UPG_RELATIONSHIP_BENCHMARKS.length)
  })

  it('kind=ratio returns UPG_RATIO_BENCHMARKS', () => {
    const { body } = call(listBenchmarks, { kind: 'ratio' })
    const b = body as { kind: string; total: number; benchmarks: unknown[] }
    expect(b.kind).toBe('ratio')
    expect(b.total).toBe(UPG_RATIO_BENCHMARKS.length)
    expect(b.benchmarks).toHaveLength(UPG_RATIO_BENCHMARKS.length)
  })

  it('kind=domain_activation returns UPG_DOMAIN_ACTIVATION', () => {
    const { body } = call(listBenchmarks, { kind: 'domain_activation' })
    const b = body as { kind: string; total: number; benchmarks: unknown[] }
    expect(b.kind).toBe('domain_activation')
    expect(b.total).toBe(UPG_DOMAIN_ACTIVATION.length)
    expect(b.benchmarks).toHaveLength(UPG_DOMAIN_ACTIVATION.length)
  })

  it('kind=domain_activation filters by domain', () => {
    const { body } = call(listBenchmarks, { kind: 'domain_activation', domain: 'strategy' })
    const b = body as { benchmarks: Array<{ domain_id: string }> }
    expect(b.benchmarks.length).toBeGreaterThan(0)
    expect(b.benchmarks.every((bm) => bm.domain_id === 'strategy')).toBe(true)
  })
})

// ── Product stages ────────────────────────────────────────────────

describe('list_product_stages', () => {
  it('returns the canonical 9-stage enum in order', () => {
    const { ok, body } = call(listProductStages, {})
    expect(ok).toBe(true)
    const b = body as { count: number; stages: readonly string[] }
    expect(b.count).toBe(UPG_PRODUCT_STAGES.length)
    expect(b.count).toBe(9)
    expect(b.stages).toEqual(UPG_PRODUCT_STAGES)
    expect(b.stages[0]).toBe('concept')
    expect(b.stages[b.stages.length - 1]).toBe('sunset')
  })
})
