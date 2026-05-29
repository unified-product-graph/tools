/**
 * Atomicity contract regression test.
 *
 * The types in `src/atomicity-contracts.ts` are the canonical envelopes for
 * `migrate_type`, `migrate_properties`, `validate_graph`, `rename_edge_type`,
 * and `export_edges`. Every UPG MCP server conforms to these. This test
 * pins the shape; if a future PR mutates a field name, the test fails
 * before any consumer rebuilds.
 */

import { describe, it, expect } from 'vitest'
import type {
  MigrateTypeResult,
  RenameEdgeTypeResult,
  ExportEdgesResult,
  ValidateGraphResult,
  MigratePropertiesResult,
} from '../src/atomicity-contracts.js'

describe('atomicity contracts', () => {
  it('MigrateTypeResult: minimal apply envelope type-checks', () => {
    const fixture: MigrateTypeResult = {
      migrated_nodes: 3,
      migrated_edges: 2,
      edge_renames: [
        { id: 'edge-1', from: 'old_edge', to: 'new_edge', flipped: false },
      ],
      dropped_edges: [{ id: 'edge-2', from: 'retired_edge' }],
      unmapped_legacy_edges: [{ type: 'mystery_edge', count: 4 }],
      defaults_applied: { valence: 'pain' },
      dry_run: false,
    }
    expect(fixture.migrated_nodes).toBe(3)
    expect(fixture.dry_run).toBe(false)
  })

  it('MigrateTypeResult: dry-run envelope and null defaults type-check', () => {
    const fixture: MigrateTypeResult = {
      migrated_nodes: 0,
      migrated_edges: 0,
      edge_renames: [],
      dropped_edges: [],
      unmapped_legacy_edges: [],
      defaults_applied: null,
      dry_run: true,
    }
    expect(fixture.defaults_applied).toBeNull()
  })

  it('RenameEdgeTypeResult: dry-run + apply branches discriminate cleanly', () => {
    const dryRun: RenameEdgeTypeResult = {
      dry_run: true,
      from: 'old_type',
      to: 'new_type',
      flip: false,
      would_rename: 5,
      sample: [{ id: 'e1', source: 'a', target: 'b', type: 'old_type' }],
    }
    const apply: RenameEdgeTypeResult = {
      dry_run: false,
      from: 'old_type',
      to: 'new_type',
      flip: true,
      renamed: 5,
      ids: ['e1', 'e2'],
    }
    if (dryRun.dry_run) expect(dryRun.would_rename).toBe(5)
    if (!apply.dry_run) expect(apply.renamed).toBe(5)
  })

  it('ExportEdgesResult: types echo + optional mapping_confidence type-check', () => {
    const fixture: ExportEdgesResult = {
      edges: [
        { id: 'e1', source: 'a', target: 'b', type: 'persona_pursues_job' },
        {
          id: 'e2',
          source: 'c',
          target: 'd',
          type: 'opportunity_addresses_need',
          mapping_confidence: 'high',
        },
      ],
      total: 2,
      offset: 0,
      limit: 500,
      types: ['persona_pursues_job', 'opportunity_addresses_need'],
      _hash: 'abc123',
    }
    expect(fixture.edges).toHaveLength(2)
    expect(fixture.edges[1].mapping_confidence).toBe('high')
  })

  it('ValidateGraphResult: entity / edge / property drift suggestions discriminate', () => {
    const fixture: ValidateGraphResult = {
      summary: {
        spec_version: '0.2.14',
        scope: 'all',
        limit: 100,
        entity_drift: 1,
        edge_drift: 1,
        property_drift: 1,
        top_level_drift: 0,
        lifecycle_drift: 0,
        self_referential: 0,
      },
      entity_drift: [
        {
          id: 'n1',
          type: 'jtbd',
          title: 'Old type',
          suggested_migration: { kind: 'rename', to: 'job', via: "UPG_MIGRATIONS['0.2.0']" },
        },
        {
          id: 'n2',
          type: 'experiment',
          title: 'Split candidate',
          suggested_migration: {
            kind: 'split',
            to: ['experiment_plan', 'experiment_run'],
            via: "UPG_SPLIT_MIGRATIONS['0.2.6']",
          },
        },
      ],
      edge_drift: [
        {
          id: 'e1',
          type: 'old_edge',
          source: 'a',
          target: 'b',
          suggested_migration: {
            kind: 'rename',
            to: 'new_edge',
            flip: false,
            via: 'UPG_EDGE_MIGRATIONS',
          },
        },
      ],
      property_drift: [{ id: 'n3', type: 'persona', property: 'old_prop', via: 'UPG_PROPERTY_MIGRATIONS' }],
      _hash: 'xyz',
      // Payload-guard channel is part of the canonical contract,
      // not an `unknown`-cast side-channel.
      _warning: 'Approaching payload limit. Try narrower scope=entity_drift.',
      _payload_bytes: 142_000,
    }
    const first = fixture.entity_drift?.[0]?.suggested_migration
    if (first?.kind === 'rename') expect(first.to).toBe('job')
    expect(fixture._warning).toMatch(/payload/i)
    expect(fixture._payload_bytes).toBe(142_000)
  })

  it('MigratePropertiesResult: stub envelope type-checks ahead of implementation', () => {
    const fixture: MigratePropertiesResult = {
      migrated_nodes: 1,
      migrated_properties: 1,
      changes: [
        {
          id: 'n1',
          type: 'persona',
          kind: 'lift_property_to_top_level',
          from: 'old_prop',
          to: 'description',
          via: "UPG_PROPERTY_MIGRATIONS['0.2.7']",
        },
      ],
      dry_run: false,
    }
    expect(fixture.changes[0].kind).toBe('lift_property_to_top_level')
  })
})
