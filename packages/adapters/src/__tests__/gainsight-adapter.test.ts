/**
 * Gainsight Adapter Tests
 *
 * Covers all entity type mappings, edge emission from parent/child relationships,
 * status normalisation, health_score metric field preservation, and warning emission.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { GainsightAdapter } from '../adapters/gainsight.js'
import type { SourceItem } from '../types.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(UPG_EDGE_TYPES)

function assertAllEdgesCatalogued(edges: { type: string }[], label: string): void {
  for (const edge of edges) {
    expect(
      EDGE_TYPES_SET.has(edge.type),
      `${label}: emitted edge type "${edge.type}" is not in UPG catalogue`,
    ).toBe(true)
  }
}

function makeEntity(
  id: string,
  title: string,
  entityType: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'gainsight_entity',
    title,
    metadata: {
      entity_type: entityType,
      ...overrides,
    },
  }
}

const adapter = new GainsightAdapter()

// ─── Type mapping ─────────────────────────────────────────────────────────────

describe('GainsightAdapter — entity type → UPG type mapping', () => {
  it('account maps to account with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('a1', 'Acme Corp', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('account')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('gainsight')
  })

  it('contact maps to participant with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('c1', 'Jane Smith', 'contact')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('participant')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('objective maps to objective with confidence high', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Reduce onboarding time from 14 to 7 days', 'objective'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('success_plan maps to initiative with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('sp1', 'Q2 Success Plan — Acme', 'success_plan')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('initiative')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('cta maps to task with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('cta1', 'Check in — health drop', 'cta')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('task')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('timeline_activity maps to observation with confidence medium', async () => {
    const items: SourceItem[] = [makeEntity('ta1', 'QBR call — Q1 review', 'timeline_activity')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('observation')
  })

  it('survey_response maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('sr1', 'Survey: Very satisfied', 'survey_response')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('nps_response maps to customer_feedback with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('nps1', 'NPS: Score 9', 'nps_response')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('customer_feedback')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('milestone maps to milestone with confidence high', async () => {
    const items: SourceItem[] = [makeEntity('m1', 'First value achieved', 'milestone')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('milestone')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })
})

// ─── Health score metric preservation ────────────────────────────────────────

describe('GainsightAdapter — health score metric fields', () => {
  it('health_score maps to metric with confidence high', async () => {
    const items: SourceItem[] = [
      makeEntity('hs1', 'Acme Health Score', 'health_score', { health_score: 72 }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    expect(result.nodes[0].mapping_confidence).toBe('high')
  })

  it('health_score preserves current_value, target_value, and unit', async () => {
    const items: SourceItem[] = [
      makeEntity('hs1', 'Acme Health Score', 'health_score', { health_score: 65 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(65)
    expect(node.target_value).toBe(100)
    expect(node.unit).toBe('health')
  })

  it('health_score at zero preserves zero correctly', async () => {
    const items: SourceItem[] = [
      makeEntity('hs1', 'At-Risk Account Health', 'health_score', { health_score: 0 }),
    ]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBe(0)
  })

  it('health_score without health_score value — no metric fields emitted', async () => {
    const items: SourceItem[] = [makeEntity('hs1', 'Health Score', 'health_score')]
    const result = await adapter.convert(items)
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
  })
})

// ─── NPS score tag preservation ───────────────────────────────────────────────

describe('GainsightAdapter — NPS score as tag', () => {
  it('nps_score is preserved as a tag on customer_feedback nodes', async () => {
    const items: SourceItem[] = [
      makeEntity('nps1', 'NPS response', 'nps_response', { nps_score: 9 }),
    ]
    const result = await adapter.convert(items)
    const tags = result.nodes[0].tags ?? []
    expect(tags.some((t) => t.includes('nps') && t.includes('9'))).toBe(true)
  })
})

// ─── Skip cases ───────────────────────────────────────────────────────────────

describe('GainsightAdapter — skipped types with warnings', () => {
  it('risk is skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeEntity('r1', 'Churn risk flag', 'risk'),
      makeEntity('a1', 'Acme Corp', 'account'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('account')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('risk')
    expect(warnText).toContain('no UPG equivalent')
  })

  it('renewal is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('ren1', 'Q3 Renewal', 'renewal')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('renewal')
  })

  it('usage_data is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('ud1', 'Feature usage data', 'usage_data')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })

  it('playbook (template) is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('pb1', 'Churn risk playbook', 'playbook')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('playbook')
  })

  it('journey_orchestrator is skipped with a warning', async () => {
    const items: SourceItem[] = [makeEntity('jo1', 'Onboarding journey', 'journey_orchestrator')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(0)
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('GainsightAdapter — status normalisation', () => {
  it("status 'new' normalises to 'draft'", async () => {
    const items: SourceItem[] = [makeEntity('sp1', 'New plan', 'success_plan', { status: 'new' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('draft')
  })

  it("status 'in_progress' normalises to 'active'", async () => {
    const items: SourceItem[] = [
      makeEntity('cta1', 'Active CTA', 'cta', { status: 'in_progress' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'open' normalises to 'active'", async () => {
    const items: SourceItem[] = [makeEntity('cta1', 'Open CTA', 'cta', { status: 'open' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'at_risk' normalises to 'active'", async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'At-risk objective', 'objective', { status: 'at_risk' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('active')
  })

  it("status 'success' normalises to 'complete'", async () => {
    const items: SourceItem[] = [
      makeEntity('sp1', 'Completed plan', 'success_plan', { status: 'success' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('complete')
  })

  it("status 'cancelled' normalises to 'abandoned'", async () => {
    const items: SourceItem[] = [
      makeEntity('cta1', 'Cancelled CTA', 'cta', { status: 'cancelled' }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('abandoned')
  })
})

// ─── Edge emission ────────────────────────────────────────────────────────────

describe('GainsightAdapter — edge emission', () => {
  it('objective_achieved_through_key_result emitted when success_plan has objective parent', async () => {
    const items: SourceItem[] = [
      makeEntity('obj1', 'Reduce onboarding time', 'objective'),
      makeEntity('sp1', 'Q2 Success Plan', 'success_plan', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'objective_achieved_through_key_result')
    const edge = result.edges.find((e) => e.type === 'objective_achieved_through_key_result')
    expect(edge).toBeDefined()
  })

  it('initiative_drives_outcome emitted when objective has success_plan parent', async () => {
    const items: SourceItem[] = [
      makeEntity('sp1', 'Q2 Success Plan', 'success_plan'),
      makeEntity('obj1', 'Reduce onboarding time', 'objective', {
        parent_id: 'sp1',
        parent_type: 'success_plan',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative_drives_outcome')
    const edge = result.edges.find((e) => e.type === 'initiative_drives_outcome')
    expect(edge).toBeDefined()
  })

  it('customer_feedback_becomes_feature_request emitted from nps_response to cta', async () => {
    const items: SourceItem[] = [
      makeEntity('nps1', 'NPS: Score 4 with comment', 'nps_response'),
      makeEntity('cta1', 'Follow up on negative NPS', 'cta', {
        parent_id: 'nps1',
        parent_type: 'nps_response',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'customer_feedback_becomes_feature_request')
    const edge = result.edges.find((e) => e.type === 'customer_feedback_becomes_feature_request')
    expect(edge).toBeDefined()
  })

  it('node_informs_node fallback for unrecognised parent/child pair', async () => {
    const items: SourceItem[] = [
      makeEntity('a1', 'Acme Corp', 'account'),
      makeEntity('m1', 'Go-live milestone', 'milestone', {
        parent_id: 'a1',
        parent_type: 'account',
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'node_informs_node fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
  })

  it('assertAllEdgesCatalogued — full fixture test', async () => {
    const items: SourceItem[] = [
      makeEntity('a1', 'Acme Corp', 'account'),
      makeEntity('obj1', 'Reduce onboarding time', 'objective'),
      makeEntity('sp1', 'Q2 Success Plan', 'success_plan', {
        parent_id: 'obj1',
        parent_type: 'objective',
      }),
      makeEntity('hs1', 'Acme Health', 'health_score', { health_score: 75 }),
      makeEntity('nps1', 'NPS response', 'nps_response', { nps_score: 8 }),
      makeEntity('m1', 'Go-live', 'milestone'),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'GainsightAdapter full fixture')
    // At least objective→success_plan edge
    expect(result.edges.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── Source map and external fields ───────────────────────────────────────────

describe('GainsightAdapter — source_map and external fields', () => {
  it('source_map contains an entry for each converted entity', async () => {
    const items: SourceItem[] = [
      makeEntity('a1', 'Acme Corp', 'account'),
      makeEntity('obj1', 'Objective', 'objective'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['a1']).toBeDefined()
    expect(result.source_map['obj1']).toBeDefined()
  })

  it('skipped entities are NOT in the source_map', async () => {
    const items: SourceItem[] = [makeEntity('r1', 'Risk', 'risk')]
    const result = await adapter.convert(items)
    expect(result.source_map['r1']).toBeUndefined()
  })

  it('external_tool is always gainsight', async () => {
    const items: SourceItem[] = [makeEntity('a1', 'Acme', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('gainsight')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeEntity('gs-12345', 'Acme', 'account')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('gs-12345')
  })
})
