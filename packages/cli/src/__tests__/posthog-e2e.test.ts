/**
 * PostHog end-to-end import audit (convert-only adapter).
 *
 * PostHog's list() requires a live API; its convert() is the whole import story,
 * so spec conformance IS the audit. Representative records run through
 * convert → writeToUPGFile → reload, then conformanceIssues() asserts the result
 * is spec-clean (valid types, valid per-type statuses, no off-schema fields,
 * catalogued edges, clean round-trip).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { PostHogAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new PostHogAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'flag1', source_type: 'posthog', title: 'Collaborative editing flag', metadata: { entity_type: 'feature_flag', status: 'rollout', key: 'collab-editing', rollout_pct: 25, flag_type: 'temporary', tags: ['beta'] } },
  { source_id: 'exp1', source_type: 'posthog', title: 'Onboarding step reduction A/B', metadata: { entity_type: 'experiment', status: 'running', hypothesis: 'Fewer onboarding steps lifts 7-day activation' } },
  { source_id: 'ins1', source_type: 'posthog', title: '7-day activation rate', metadata: { entity_type: 'insight', current_value: 34.2, target_value: 45, unit: '%' } },
  { source_id: 'coh1', source_type: 'posthog', title: 'Power users', metadata: { entity_type: 'cohort' } },
  { source_id: 'sur1', source_type: 'posthog', title: 'Post-onboarding NPS', metadata: { entity_type: 'survey', status: 'complete' } },
  { source_id: 'nb1', source_type: 'posthog', title: 'Activation funnel analysis', metadata: { entity_type: 'notebook', status: 'draft' } },
]

describe('PostHog e2e — convert conformance', () => {
  it('produces a spec-conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps the core analytics types correctly', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t.flag1).toBe('feature_flag')
      expect(t.exp1).toBe('experiment')
      expect(t.ins1).toBe('metric')
      expect(t.coh1).toBe('market_segment')
      expect(t.sur1).toBe('customer_feedback')
      expect(t.nb1).toBe('document')
    } finally {
      await out.cleanup()
    }
  })

  it('preserves metric values under properties (survives the round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const metric = out.rawDoc.nodes.find((n) => n.source_id === 'ins1') as Record<string, unknown>
      expect(metric.properties).toMatchObject({ current_value: 34.2, target_value: 45, unit: '%' })
    } finally {
      await out.cleanup()
    }
  })

  it('maps a feature flag to feature_flag with its own lifecycle and identity under properties', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const flag = out.rawDoc.nodes.find((n) => n.source_id === 'flag1') as Record<string, unknown>
      expect(flag.type).toBe('feature_flag')
      // 'rollout' is a valid feature_flag phase (off | rollout | on)
      expect(flag.status).toBe('rollout')
      // The flag's identity is preserved, not collapsed into a feature node
      expect(flag.properties).toMatchObject({ key: 'collab-editing', rollout_pct: 25, flag_type: 'temporary' })
    } finally {
      await out.cleanup()
    }
  })
})
