/**
 * Coda Adapter Tests
 *
 * Covers table name inference, lookup column edge emission,
 * status normalisation, metric field preservation, warning emission,
 * and full-fixture catalogue validation.
 *
 * All emitted edge types must be in the UPG catalogue.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { CodaAdapter, inferTableType, CODA_TABLE_TYPE_MAP, CODA_STATUS_MAP } from '../adapters/coda.js'
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

function makeRow(
  id: string,
  title: string,
  tableName: string,
  overrides: Partial<Record<string, unknown>> = {},
): SourceItem {
  return {
    source_id: id,
    source_type: 'table_row',
    title,
    metadata: {
      table_name: tableName,
      ...overrides,
    },
  }
}

const adapter = new CodaAdapter()

// ─── inferTableType() ─────────────────────────────────────────────────────────

describe('inferTableType: direct matches', () => {
  it('Opportunities → opportunity', () => {
    expect(inferTableType('Opportunities')).toBe('opportunity')
  })

  it('Features → feature', () => {
    expect(inferTableType('Features')).toBe('feature')
  })

  it('OKRs → objective', () => {
    expect(inferTableType('OKRs')).toBe('objective')
  })

  it('Key Results → key_result', () => {
    expect(inferTableType('Key Results')).toBe('key_result')
  })

  it('Hypotheses → hypothesis', () => {
    expect(inferTableType('Hypotheses')).toBe('hypothesis')
  })

  it('Bugs → bug', () => {
    expect(inferTableType('Bugs')).toBe('bug')
  })

  it('Releases → release', () => {
    expect(inferTableType('Releases')).toBe('release')
  })

  it('Research → research_study', () => {
    expect(inferTableType('Research')).toBe('research_study')
  })
})

describe('inferTableType: singular/plural handling', () => {
  it('Feature (singular) → feature', () => {
    expect(inferTableType('Feature')).toBe('feature')
  })

  it('Opportunity (singular) → opportunity', () => {
    expect(inferTableType('Opportunity')).toBe('opportunity')
  })

  it('Personas → persona', () => {
    expect(inferTableType('Personas')).toBe('persona')
  })

  it('Experiment (singular) → experiment', () => {
    expect(inferTableType('Experiment')).toBe('experiment')
  })
})

describe('inferTableType: explicitly unmappable tables', () => {
  it('Views → null (explicitly unmappable)', () => {
    expect(inferTableType('Views')).toBeNull()
  })

  it('Automations → null', () => {
    expect(inferTableType('Automations')).toBeNull()
  })

  it('Buttons → null', () => {
    expect(inferTableType('Buttons')).toBeNull()
  })
})

describe('inferTableType: unknown table returns undefined', () => {
  it('unknown table name returns undefined', () => {
    expect(inferTableType('My Random Table')).toBeUndefined()
  })

  it('empty string returns undefined', () => {
    expect(inferTableType('')).toBeUndefined()
  })
})

// ─── Table name → entity type (adapter.convert) ───────────────────────────────

describe('CodaAdapter: table name → entity type', () => {
  it('Opportunities table rows map to opportunity with high confidence', async () => {
    const items: SourceItem[] = [makeRow('r1', 'Users struggle with onboarding', 'Opportunities')]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('opportunity')
    expect(result.nodes[0].mapping_confidence).toBe('high')
    expect(result.nodes[0].external_tool).toBe('coda')
  })

  it('Features table rows map to feature with medium confidence', async () => {
    const items: SourceItem[] = [makeRow('r1', 'Progressive onboarding wizard', 'Features')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('feature')
    expect(result.nodes[0].mapping_confidence).toBe('medium')
  })

  it('OKRs table rows map to objective', async () => {
    const items: SourceItem[] = [makeRow('r1', 'Grow retention by 20%', 'OKRs')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('objective')
  })

  it('unknown table name defaults to document with warning', async () => {
    const items: SourceItem[] = [makeRow('r1', 'My item', 'Project Tracker')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('document')
    expect(result.nodes[0].mapping_confidence).toBe('low')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Project Tracker')
    expect(warnText).toContain('defaulted to "document"')
  })
})

// ─── Explicitly unmappable table (views) ─────────────────────────────────────

describe('CodaAdapter: unmappable table types', () => {
  it('rows from a Views table are skipped with a warning', async () => {
    const items: SourceItem[] = [
      makeRow('v1', 'Features by status', 'Views'),
      makeRow('r1', 'Real feature', 'Features'),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].type).toBe('feature')
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('Views')
    expect(warnText).toContain('skipped')
  })
})

// ─── Status normalisation ─────────────────────────────────────────────────────

describe('CodaAdapter: status normalisation (per-type, lifecycle-validated)', () => {
  it("'done' on a Features row is omitted (feature lifecycle has no 'done' phase)", async () => {
    // feature lifecycle: proposed | in_progress | shipped | archived
    const items: SourceItem[] = [makeRow('r1', 'Shipped feature', 'Features', { status: 'done' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it("'In Progress' on Features resolves to 'in_progress' (valid feature phase)", async () => {
    const items: SourceItem[] = [makeRow('r1', 'Active item', 'Features', { status: 'In Progress' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('in_progress')
  })

  it("'Backlog' on Tasks resolves to 'backlog' (0.32.0: WORK_ITEM gained the phase)", async () => {
    // task lifecycle: backlog | todo | in_progress | in_review | done | cancelled
    // Previously flattened to `todo`, because there was nowhere else to put it.
    // The two are not the same claim: `todo` is committed and not started,
    // `backlog` is not committed at all.
    const items: SourceItem[] = [makeRow('r1', 'Backlog item', 'Tasks', { status: 'Backlog' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('backlog')
  })

  it("'Cancelled' on Opportunities is omitted (opportunity lifecycle has no terminal cancel)", async () => {
    // opportunity lifecycle: identified | validated | deferred
    const items: SourceItem[] = [makeRow('r1', 'Dropped idea', 'Opportunities', { status: 'Cancelled' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })

  it("'Shipped' on Releases resolves to 'shipped' (valid release phase)", async () => {
    // release lifecycle: planned | in_progress | shipped
    const items: SourceItem[] = [makeRow('r1', 'Shipped release', 'Releases', { status: 'Shipped' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBe('shipped')
  })

  it('unknown status is omitted when it does not match the type lifecycle', async () => {
    const items: SourceItem[] = [makeRow('r1', 'Item', 'Tasks', { status: 'waiting-for-design' })]
    const result = await adapter.convert(items)
    expect(result.nodes[0].status).toBeUndefined()
  })
})

// ─── Metric / key_result numeric field preservation ───────────────────────────

describe('CodaAdapter: metric and key_result value fields', () => {
  it('Metrics table nests current_value, target_value, unit under properties (not top-level)', async () => {
    const items: SourceItem[] = [
      makeRow('m1', 'Activation Rate', 'Metrics', {
        current_value: 38,
        target_value: 60,
        unit: '%',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('metric')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
    expect(node.unit).toBeUndefined()
    expect(node.properties).toMatchObject({ current_value: 38, target_value: 60, unit: '%' })
  })

  it('Key Results table nests numeric fields under properties (not top-level)', async () => {
    const items: SourceItem[] = [
      makeRow('kr1', 'NPS improvement', 'Key Results', {
        current_value: 20,
        target_value: 45,
        unit: 'points',
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].type).toBe('key_result')
    const node = result.nodes[0] as Record<string, unknown>
    expect(node.current_value).toBeUndefined()
    expect(node.target_value).toBeUndefined()
    expect(node.unit).toBeUndefined()
    expect(node.properties).toMatchObject({ current_value: 20, target_value: 45, unit: 'points' })
  })
})

// ─── Lookup column edge emission ──────────────────────────────────────────────

describe('CodaAdapter: lookup column edge emission', () => {
  it('feature with Release lookup emits release_contains_feature edge', async () => {
    const items: SourceItem[] = [
      makeRow('rel1', 'v2.0', 'Releases'),
      makeRow('feat1', 'Progressive wizard', 'Features', {
        lookup_fields: [
          { column_name: 'Release', target_row_id: 'rel1', target_table: 'Releases' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'release_contains_feature')
    const edge = result.edges.find((e) => e.type === 'release_contains_feature')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
  })

  it('story with Epic lookup emits epic_specified_by_user_story edge', async () => {
    const items: SourceItem[] = [
      makeRow('epic1', 'Onboarding epic', 'Epics'),
      makeRow('story1', 'As a user I can...', 'Stories', {
        lookup_fields: [
          { column_name: 'Epic', target_row_id: 'epic1', target_table: 'Epics' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'epic_specified_by_user_story')
    const edge = result.edges.find((e) => e.type === 'epic_specified_by_user_story')
    expect(edge).toBeDefined()
  })

  it('solution with Opportunity lookup emits opportunity_drives_solution edge', async () => {
    const items: SourceItem[] = [
      makeRow('opp1', 'Users stuck in onboarding', 'Opportunities'),
      makeRow('sol1', 'Guided setup wizard', 'Solutions', {
        lookup_fields: [
          { column_name: 'Opportunity', target_row_id: 'opp1', target_table: 'Opportunities' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'opportunity_drives_solution')
    const edge = result.edges.find((e) => e.type === 'opportunity_drives_solution')
    expect(edge).toBeDefined()
  })

  it('feature with Initiative lookup falls back to node_informs_node (no canonical initiative-feature edge)', async () => {
    // resolvePairEdge(initiative, feature) is null in the catalogue → generic link.
    const items: SourceItem[] = [
      makeRow('init1', 'Onboarding revamp', 'Initiatives'),
      makeRow('feat1', 'Wizard step 1', 'Features', {
        lookup_fields: [
          { column_name: 'Initiative', target_row_id: 'init1', target_table: 'Initiatives' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'initiative fallback')
    const edge = result.edges.find((e) => e.type === 'node_informs_node')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('low')
    // The wrong-endpoint initiative_drives_outcome must NOT appear
    expect(result.edges.find((e) => e.type === 'initiative_drives_outcome')).toBeUndefined()
  })

  it('metric with Key Result lookup emits key_result_quantified_by_metric edge', async () => {
    const items: SourceItem[] = [
      makeRow('kr1', 'Activation NPS', 'Key Results'),
      makeRow('m1', 'NPS score', 'Metrics', {
        lookup_fields: [
          { column_name: 'Key Result', target_row_id: 'kr1', target_table: 'Key Results' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'key_result_quantified_by_metric')
    const edge = result.edges.find((e) => e.type === 'key_result_quantified_by_metric')
    expect(edge).toBeDefined()
  })

  it('edges are resolved by node type, not column name: Task→Feature lookup emits feature_decomposes_into_task', async () => {
    // The resolver is catalogue-driven on the node-type pair, so the column
    // label is irrelevant: a Tasks row pointing at a Features row resolves to
    // the canonical feature_decomposes_into_task edge (source=feature, target=task).
    const items: SourceItem[] = [
      makeRow('r1', 'Target', 'Features'),
      makeRow('r2', 'Source', 'Tasks', {
        lookup_fields: [
          { column_name: 'Related Feature', target_row_id: 'r1', target_table: 'Features' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    assertAllEdgesCatalogued(result.edges, 'task-feature catalogue edge')
    const edge = result.edges.find((e) => e.type === 'feature_decomposes_into_task')
    expect(edge).toBeDefined()
    expect(edge?.mapping_confidence).toBe('medium')
    const featNode = result.nodes.find((n) => n.source_id === 'r1')
    const taskNode = result.nodes.find((n) => n.source_id === 'r2')
    expect(edge?.source).toBe(featNode?.id)
    expect(edge?.target).toBe(taskNode?.id)
  })

  it('lookup pointing to a row not in the import set emits a warning and skips edge', async () => {
    const items: SourceItem[] = [
      makeRow('feat1', 'Feature without parent', 'Features', {
        lookup_fields: [
          { column_name: 'Release', target_row_id: 'rel-external', target_table: 'Releases' },
        ],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.edges).toHaveLength(0)
    const warnText = result.warnings?.join(' ') ?? ''
    expect(warnText).toContain('rel-external')
    expect(warnText).toContain('not in import set')
  })
})

// ─── Formula / button column warnings ────────────────────────────────────────

describe('CodaAdapter: formula and button column warnings', () => {
  it('has_formula_columns flag emits a warning once per table', async () => {
    const items: SourceItem[] = [
      makeRow('r1', 'Row 1', 'Features', { has_formula_columns: true }),
      makeRow('r2', 'Row 2', 'Features', { has_formula_columns: true }),
    ]
    const result = await adapter.convert(items)
    const formulaWarnings = (result.warnings ?? []).filter((w) => w.includes('formula'))
    // Warning should be emitted exactly once (deduplicated by table name)
    expect(formulaWarnings).toHaveLength(1)
    expect(formulaWarnings[0]).toContain('formula columns')
  })

  it('has_button_columns flag emits a warning once per table', async () => {
    const items: SourceItem[] = [
      makeRow('r1', 'Row 1', 'Tasks', { has_button_columns: true }),
    ]
    const result = await adapter.convert(items)
    const buttonWarnings = (result.warnings ?? []).filter((w) => w.includes('button'))
    expect(buttonWarnings).toHaveLength(1)
    expect(buttonWarnings[0]).toContain('UI elements')
  })
})

// ─── Source map + external identifiers ───────────────────────────────────────

describe('CodaAdapter: source_map and external identifiers', () => {
  it('source_map has an entry for each converted row', async () => {
    const items: SourceItem[] = [
      makeRow('row-001', 'Feature A', 'Features'),
      makeRow('row-002', 'Feature B', 'Features'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['row-001']).toBeDefined()
    expect(result.source_map['row-002']).toBeDefined()
  })

  it('skipped rows (views) are NOT in source_map', async () => {
    const items: SourceItem[] = [
      makeRow('view-01', 'Features by status', 'Views'),
    ]
    const result = await adapter.convert(items)
    expect(result.source_map['view-01']).toBeUndefined()
  })

  it('external_tool is always coda', async () => {
    const items: SourceItem[] = [makeRow('r1', 'Item', 'Features')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_tool).toBe('coda')
  })

  it('external_id defaults to source_id', async () => {
    const items: SourceItem[] = [makeRow('coda-row-999', 'Item', 'Features')]
    const result = await adapter.convert(items)
    expect(result.nodes[0].external_id).toBe('coda-row-999')
  })
})

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('CodaAdapter: tags', () => {
  it('tags from metadata are attached to the node', async () => {
    const items: SourceItem[] = [
      makeRow('r1', 'Tagged feature', 'Features', {
        tags: ['q2', 'growth', 'onboarding'],
      }),
    ]
    const result = await adapter.convert(items)
    expect(result.nodes[0].tags).toEqual(['q2', 'growth', 'onboarding'])
  })
})

// ─── Full fixture: assertAllEdgesCatalogued ───────────────────────────────────

describe('CodaAdapter: full fixture, all emitted edges are catalogued', () => {
  it('assertAllEdgesCatalogued passes for a realistic multi-table import', async () => {
    const items: SourceItem[] = [
      // Strategy layer
      makeRow('obj1', 'Grow activation to 60%', 'OKRs'),
      makeRow('kr1', 'Activation rate', 'Key Results'),
      makeRow('init1', 'Onboarding revamp', 'Initiatives'),
      makeRow('m1', 'Weekly active rate', 'Metrics', {
        current_value: 38,
        target_value: 60,
        unit: '%',
        lookup_fields: [
          { column_name: 'Key Result', target_row_id: 'kr1', target_table: 'Key Results' },
        ],
      }),
      // Discovery layer
      makeRow('opp1', 'Users stuck at step 3', 'Opportunities'),
      makeRow('sol1', 'Guided setup wizard', 'Solutions', {
        lookup_fields: [
          { column_name: 'Opportunity', target_row_id: 'opp1', target_table: 'Opportunities' },
        ],
      }),
      // Delivery layer
      makeRow('rel1', 'v2.0', 'Releases'),
      makeRow('epic1', 'Onboarding epic', 'Epics'),
      makeRow('feat1', 'Step-by-step wizard', 'Features', {
        lookup_fields: [
          { column_name: 'Release', target_row_id: 'rel1', target_table: 'Releases' },
        ],
      }),
      makeRow('story1', 'As a new user I can complete setup', 'Stories', {
        lookup_fields: [
          { column_name: 'Epic', target_row_id: 'epic1', target_table: 'Epics' },
        ],
      }),
      // Research layer
      makeRow('persona1', 'Growth-stage PM', 'Personas'),
    ]

    const result = await adapter.convert(items)

    // All nodes created
    expect(result.nodes.length).toBeGreaterThan(0)

    // All edges are in the UPG catalogue
    assertAllEdgesCatalogued(result.edges, 'CodaAdapter full fixture')

    // Expected edges
    expect(result.edges.find((e) => e.type === 'key_result_quantified_by_metric')).toBeDefined()
    expect(result.edges.find((e) => e.type === 'opportunity_drives_solution')).toBeDefined()
    expect(result.edges.find((e) => e.type === 'release_contains_feature')).toBeDefined()
    expect(result.edges.find((e) => e.type === 'epic_specified_by_user_story')).toBeDefined()
  })
})

// ─── CODA_TABLE_TYPE_MAP spot-checks ─────────────────────────────────────────

describe('CODA_TABLE_TYPE_MAP: spot checks', () => {
  it('contains entry for okrs → objective', () => {
    expect(CODA_TABLE_TYPE_MAP['okrs']).toBe('objective')
  })

  it('contains entry for hypotheses → hypothesis', () => {
    expect(CODA_TABLE_TYPE_MAP['hypotheses']).toBe('hypothesis')
  })

  it('contains null entry for views', () => {
    expect(CODA_TABLE_TYPE_MAP['views']).toBeNull()
  })
})

// ─── CODA_STATUS_MAP spot-checks ─────────────────────────────────────────────

describe('CODA_STATUS_MAP: spot checks (intermediate candidates, validated per-type at convert time)', () => {
  it("maps 'done' to candidate 'done'", () => {
    expect(CODA_STATUS_MAP['done']).toBe('done')
  })

  it("maps 'backlog' to candidate 'backlog' (0.32.0, was 'todo')", () => {
    expect(CODA_STATUS_MAP['backlog']).toBe('backlog')
  })

  it("maps 'cancelled' to candidate 'abandoned'", () => {
    expect(CODA_STATUS_MAP['cancelled']).toBe('abandoned')
  })
})
