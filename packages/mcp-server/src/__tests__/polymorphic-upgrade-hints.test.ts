/**
 * Tests for the `polymorphic_with_typed_alternative` drift class added by
 * UPG-507. This class is opt-in via `include_polymorphic_upgrades: true`.
 *
 * Decision context: Captain chose Option B — polymorphic edges are kept as a
 * deliberate feature (they let consumers express connections we haven't yet
 * catalogued), but when a typed alternative exists for the actual
 * source/target pair the validator surfaces it as an advisory "info" hint.
 *
 * Edge families covered by the class:
 *   - node_owned_by_person/team/role/stakeholder/department (ownership)
 *   - node_belongs_to_bounded_context (containment)
 *   - node_constrains_node (constraint)
 *   - node_informs_node, node_inspires_node (semantic generics)
 *   - decision_influences_node, decision_constrained_by_node,
 *     decision_produces_node (decision-to-anything)
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type {
  UPGDocument,
  UPGBaseNode,
  UPGEdge,
  UPGEntityType,
  UPGEdgeType,
} from '@unified-product-graph/core'
import { validateGraph } from '../tools/validation.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'poly-upgrade-hints fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-poly-hints-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

// ─── Test 1: no typed alternative → no hint ──────────────────────────────────

describe('polymorphic_with_typed_alternative — no typed alternative', () => {
  it('emits no hint when no typed alternative exists for the pair', async () => {
    // node_owned_by_person(persona, person): the pair persona:person has no
    // typed alternative in the catalog (only the polymorphic node:person edge),
    // so no upgrade hint should be emitted.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'per1', type: 'persona' as UPGEntityType, title: 'Main Persona' },
          { id: 'prs1', type: 'person' as UPGEntityType, title: 'Alice' },
        ],
        [
          {
            id: 'e1',
            source: 'per1',
            target: 'prs1',
            type: 'node_owned_by_person' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.polymorphic_with_typed_alternative).toEqual([])
    expect(body.summary.polymorphic_upgrade_hints).toBe(0)
  })
})

// ─── Test 2: typed alternative exists → hint emitted ─────────────────────────

describe('polymorphic_with_typed_alternative — node_relates (via node_informs_node)', () => {
  it('emits a hint when feature → hypothesis has the typed feature_tests_hypothesis', async () => {
    // node_informs_node(feature, hypothesis): the pair feature:hypothesis has
    // feature_tests_hypothesis as a typed alternative. A hint should fire.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'f1', type: 'feature' as UPGEntityType, title: 'Dark Mode' },
          { id: 'h1', type: 'hypothesis' as UPGEntityType, title: 'Users prefer dark mode' },
        ],
        [
          {
            id: 'e2',
            source: 'f1',
            target: 'h1',
            type: 'node_informs_node' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.polymorphic_with_typed_alternative).toHaveLength(1)
    expect(body.summary.polymorphic_upgrade_hints).toBe(1)

    const hint = body.polymorphic_with_typed_alternative[0]
    expect(hint.id).toBe('e2')
    expect(hint.polymorphic_type).toBe('node_informs_node')
    expect(hint.source_type).toBe('feature')
    expect(hint.target_type).toBe('hypothesis')
    expect(hint.suggested_typed_alternatives).toContain('feature_tests_hypothesis')
    expect(hint.severity).toBe('info')
    expect(hint.rationale).toMatch(/node_informs_node/)
    expect(hint.rationale).toMatch(/feature_tests_hypothesis/)
  })
})

// ─── Test 3: typed constraint alternative ────────────────────────────────────

describe('polymorphic_with_typed_alternative — node_constrains_node with typed alt', () => {
  it('emits a hint when constraint → feature has constraint_constrains_feature', async () => {
    // node_constrains_node(constraint, feature): the pair constraint:feature has
    // constraint_constrains_feature as a typed alternative.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'c1', type: 'constraint' as UPGEntityType, title: 'Budget cap' },
          { id: 'feat1', type: 'feature' as UPGEntityType, title: 'Premium export' },
        ],
        [
          {
            id: 'e3',
            source: 'c1',
            target: 'feat1',
            type: 'node_constrains_node' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.polymorphic_with_typed_alternative).toHaveLength(1)
    expect(body.summary.polymorphic_upgrade_hints).toBe(1)

    const hint = body.polymorphic_with_typed_alternative[0]
    expect(hint.id).toBe('e3')
    expect(hint.polymorphic_type).toBe('node_constrains_node')
    expect(hint.source_type).toBe('constraint')
    expect(hint.target_type).toBe('feature')
    expect(hint.suggested_typed_alternatives).toContain('constraint_constrains_feature')
    expect(hint.severity).toBe('info')
  })
})

// ─── Test 4: default call does NOT include polymorphic hints ─────────────────

describe('polymorphic_with_typed_alternative — not included by default', () => {
  it('default validate_graph call does not include polymorphic_with_typed_alternative', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'f1', type: 'feature' as UPGEntityType, title: 'Dark Mode' },
          { id: 'h1', type: 'hypothesis' as UPGEntityType, title: 'Users prefer dark' },
        ],
        [
          {
            id: 'e1',
            source: 'f1',
            target: 'h1',
            type: 'node_informs_node' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    // The field must not be present at all when include_polymorphic_upgrades is not set
    expect(body.polymorphic_with_typed_alternative).toBeUndefined()
    expect(body.summary.polymorphic_upgrade_hints).toBeUndefined()
  })
})

// ─── Test 5: explicit include_polymorphic_upgrades: true includes hints ───────

describe('polymorphic_with_typed_alternative — explicit opt-in', () => {
  it('includes hints when include_polymorphic_upgrades: true is passed', async () => {
    const store = await loadStore(
      makeDoc(
        [
          { id: 'f1', type: 'feature' as UPGEntityType, title: 'Dark Mode' },
          { id: 'h1', type: 'hypothesis' as UPGEntityType, title: 'Users prefer dark' },
        ],
        [
          {
            id: 'e1',
            source: 'f1',
            target: 'h1',
            type: 'node_informs_node' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    // Should be present and contain the hint
    expect(Array.isArray(body.polymorphic_with_typed_alternative)).toBe(true)
    expect(body.polymorphic_with_typed_alternative.length).toBeGreaterThan(0)
  })
})

// ─── Test 6: ownership — typed alternative exists ────────────────────────────

describe('polymorphic_with_typed_alternative — owned_by with typed alternative', () => {
  it('emits a hint when constraint → team has constraint_owned_by_team', async () => {
    // node_owned_by_team(constraint, team): the pair constraint:team has
    // constraint_owned_by_team as a typed alternative.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'c1', type: 'constraint' as UPGEntityType, title: 'Budget cap' },
          { id: 't1', type: 'team' as UPGEntityType, title: 'Platform team' },
        ],
        [
          {
            id: 'e4',
            source: 'c1',
            target: 't1',
            type: 'node_owned_by_team' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    expect(body.polymorphic_with_typed_alternative).toHaveLength(1)

    const hint = body.polymorphic_with_typed_alternative[0]
    expect(hint.polymorphic_type).toBe('node_owned_by_team')
    expect(hint.source_type).toBe('constraint')
    expect(hint.target_type).toBe('team')
    expect(hint.suggested_typed_alternatives).toContain('constraint_owned_by_team')
    expect(hint.severity).toBe('info')
    expect(hint.rationale).toMatch(/ownership/)
  })
})

// ─── Test 7: polymorphic hints are independent from the valid flag ────────────

describe('polymorphic_with_typed_alternative — does not affect valid', () => {
  it('polymorphic_with_typed_alternative count does not change the valid flag', async () => {
    // Build a graph that is otherwise drift-clean. Use a pair that has a typed
    // alternative so the hint fires, then verify that the summary count for
    // polymorphic_upgrade_hints is populated while the regular drift counts
    // are all zero (the hint is independent of valid).
    //
    // Note: because UPG-520 edge_type_pair_drift fires when a polymorphic edge
    // type (source_type='node') is wired between non-'node' typed entities, we
    // skip the drift block here and check only that the hint count is present.
    const store = await loadStore(
      makeDoc(
        [
          { id: 'f1', type: 'feature' as UPGEntityType, title: 'Search' },
          { id: 'h1', type: 'hypothesis' as UPGEntityType, title: 'Search improves retention' },
        ],
        [
          {
            id: 'e1',
            source: 'f1',
            target: 'h1',
            type: 'node_informs_node' as UPGEdgeType,
          },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      {
        include_polymorphic_upgrades: true,
        skip_drift: true,
        skip_anti_patterns: true,
      },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    // Hint exists
    expect(body.polymorphic_with_typed_alternative.length).toBeGreaterThan(0)
    // Summary carries the count
    expect(body.summary.polymorphic_upgrade_hints).toBeGreaterThan(0)
    // valid is true because skip_drift suppresses all drift classes, and the
    // polymorphic hint array has no bearing on the valid flag
    expect(body.valid).toBe(true)
  })
})

// ─── Test 8: multiple polymorphic edges — only those with typed alts fire ─────

describe('polymorphic_with_typed_alternative — mixed graph', () => {
  it('only emits hints for pairs that have typed alternatives', async () => {
    // 3 edges:
    //   node_informs_node(feature, hypothesis)   → hint (feature_tests_hypothesis exists)
    //   node_owned_by_person(persona, person)    → no hint (persona:person has no typed alt)
    //   node_constrains_node(constraint, feature) → hint (constraint_constrains_feature exists)
    const store = await loadStore(
      makeDoc(
        [
          { id: 'f1', type: 'feature' as UPGEntityType, title: 'Feature' },
          { id: 'h1', type: 'hypothesis' as UPGEntityType, title: 'Hypothesis' },
          { id: 'per1', type: 'persona' as UPGEntityType, title: 'Persona' },
          { id: 'prs1', type: 'person' as UPGEntityType, title: 'Person' },
          { id: 'c1', type: 'constraint' as UPGEntityType, title: 'Constraint' },
        ],
        [
          { id: 'e1', source: 'f1', target: 'h1', type: 'node_informs_node' as UPGEdgeType },
          { id: 'e2', source: 'per1', target: 'prs1', type: 'node_owned_by_person' as UPGEdgeType },
          { id: 'e3', source: 'c1', target: 'f1', type: 'node_constrains_node' as UPGEdgeType },
        ],
      ),
    )
    const ctx = makeCtx(store)
    const result = await validateGraph(
      { include_polymorphic_upgrades: true, skip_anti_patterns: true },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)
    // e1 and e3 should fire; e2 (persona:person) should not
    expect(body.polymorphic_with_typed_alternative).toHaveLength(2)
    expect(body.summary.polymorphic_upgrade_hints).toBe(2)

    const ids = body.polymorphic_with_typed_alternative.map((h: { id: string }) => h.id)
    expect(ids).toContain('e1')
    expect(ids).toContain('e3')
    expect(ids).not.toContain('e2')
  })
})
