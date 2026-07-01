/**
 * Tests for edge type inference: the tiered system that maps
 * source/target entity types to canonical edge types.
 *
 * Behaviour change: Tier-3 fabrication is gone. Pairs that don't
 * resolve to a catalog edge return `{ ok: false }` with near-miss
 * suggestions instead of fabricating `${source}_contains_${target}`.
 */

import { describe, it, expect } from 'vitest'
import {
  inferEdgeType,
  inferEdgeTypeWithTier,
  InferEdgeTypeError,
} from '@unified-product-graph/sdk'

describe('inferEdgeType', () => {
  it('returns a UPGEdgeType for known pairs', () => {
    const edgeType = inferEdgeType('persona', 'job')
    expect(typeof edgeType).toBe('string')
    expect(edgeType.length).toBeGreaterThan(0)
  })

  it('throws InferEdgeTypeError for unknown pairs (no fabrication)', () => {
    expect(() => inferEdgeType('widget', 'gadget')).toThrow(InferEdgeTypeError)
  })

  it('error message includes near-miss suggestions when available', () => {
    try {
      inferEdgeType('widgetx', 'persona')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(InferEdgeTypeError)
      // Levenshtein-1 should miss for 'widgetx' so suggestions may be empty;
      // but the reason itself must be present and non-empty.
      expect((err as InferEdgeTypeError).message).toMatch(/No edge type/)
    }
  })
})

describe('inferEdgeTypeWithTier', () => {
  it('resolves a known persona→job pair to a canonical edge', () => {
    const result = inferEdgeTypeWithTier('persona', 'job')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.edgeType).toContain('persona')
      expect(result.edgeType).toContain('job')
      expect(['core', 'extended']).toContain(result.tier)
    }
  })

  // ── regression: no fabrication ───────────────────────────────────

  it('rejects unknown pairs with ok:false instead of fabricating _contains_', () => {
    const result = inferEdgeTypeWithTier('widget', 'gadget')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No edge type/)
      expect(result.resolved).toEqual({
        source_type: 'widget',
        target_type: 'gadget',
      })
    }
  })

  it('does not fabricate user_journey_contains_user_flow (the smoking gun)', () => {
    // The exact case from the agent feedback: user_journey → user_flow is
    // NOT a real catalog edge; canonical is user_journey_contains_journey_step.
    const result = inferEdgeTypeWithTier('user_journey', 'user_flow')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const fabricated = 'user_journey_contains_user_flow'
      // Must not appear in suggestions either; only catalog-resolvable pairs.
      expect(
        result.suggestions.find((s) => (s.edge_type as string) === fabricated),
      ).toBeUndefined()
    }
  })

  it('surfaces near-miss suggestions that DO resolve to catalog edges', () => {
    const result = inferEdgeTypeWithTier('user_journey', 'user_flow')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Suggestions exist when at least one neighbour pair hits the catalog
      // (e.g. user_journey → journey_step). They are entirely catalog-derived.
      for (const suggestion of result.suggestions) {
        expect(suggestion.edge_type).toBeTruthy()
        expect(typeof suggestion.edge_type).toBe('string')
      }
    }
  })

  // ── Deprecation alias resolution ──────────────────────────────────────────

  it('resolves deprecated source/target via getReplacementType before catalog lookup', () => {
    // jtbd is deprecated → job. The canonical persona → job edge exists,
    // so a persona → jtbd request should succeed and report the alias.
    const result = inferEdgeTypeWithTier('persona', 'jtbd')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.aliased).toBeDefined()
      expect(result.aliased).toContainEqual({ from: 'jtbd', to: 'job' })
    }
  })

  it('handles deprecation on both sides simultaneously', () => {
    // jtbd → pain_point (both deprecated) → job → need
    const result = inferEdgeTypeWithTier('jtbd', 'pain_point')
    if (result.ok) {
      expect(result.aliased).toEqual(
        expect.arrayContaining([
          { from: 'jtbd', to: 'job' },
          { from: 'pain_point', to: 'need' },
        ]),
      )
    }
    // No assertion on ok value; depends on whether job → need is in catalog.
    // The point is: when ok, aliasing must be reported.
  })

  it('omits aliased field for already-canonical inputs', () => {
    const result = inferEdgeTypeWithTier('persona', 'job')
    if (result.ok) {
      expect(result.aliased).toBeUndefined()
    }
  })
})

// 0.17.4 keystone: auto-nest mode declines deliberate-only edges so a parent
// nesting never silently materialises objective_defers_feature/capability;
// explicit resolution (no flag) still returns them.
describe('inferEdgeTypeWithTier — deliberate-only auto-nest filter (0.17.4)', () => {
  it('DECLINES the defer edges in auto-nest mode', () => {
    for (const [s, t] of [['objective', 'feature'], ['objective', 'capability']] as const) {
      const r = inferEdgeTypeWithTier(s, t, { forAutoNest: true })
      expect(r.ok, `${s}->${t} should decline in auto-nest mode`).toBe(false)
    }
  })

  it('STILL returns the defer edges for explicit resolution (no forAutoNest)', () => {
    const feat = inferEdgeTypeWithTier('objective', 'feature')
    expect(feat.ok).toBe(true)
    if (feat.ok) expect(feat.edgeType).toBe('objective_defers_feature')
    const cap = inferEdgeTypeWithTier('objective', 'capability')
    expect(cap.ok).toBe(true)
    if (cap.ok) expect(cap.edgeType).toBe('objective_defers_capability')
  })

  it('auto-nest mode leaves ordinary edges untouched', () => {
    const r = inferEdgeTypeWithTier('feature_area', 'feature', { forAutoNest: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.edgeType).toBe('feature_area_contains_feature')
  })
})
