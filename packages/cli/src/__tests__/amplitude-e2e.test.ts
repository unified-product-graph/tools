/**
 * Amplitude end-to-end import audit (convert-only adapter).
 *
 * Amplitude's list() requires a live API; its convert() is the whole import
 * story. Representative records run through convert → writeToUPGFile → reload,
 * then conformanceIssues() asserts the result is spec-clean (valid types,
 * valid per-type statuses, no off-schema fields, catalogued edges, clean
 * round-trip).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { AmplitudeAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new AmplitudeAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'chart1', source_type: 'amplitude_entity', title: 'Weekly Active Users', metadata: { entity_type: 'chart', status: 'active', current_value: 12500, target_value: 20000, unit: 'users' } },
  { source_id: 'funnel1', source_type: 'amplitude_entity', title: 'Signup Funnel', metadata: { entity_type: 'funnel', current_value: 0.34, target_value: 0.5, unit: '%' } },
  { source_id: 'ret1', source_type: 'amplitude_entity', title: '30-day Retention', metadata: { entity_type: 'retention', current_value: 28, target_value: 40, unit: '%' } },
  { source_id: 'coh1', source_type: 'amplitude_entity', title: 'Power Users', metadata: { entity_type: 'cohort' } },
  { source_id: 'exp1', source_type: 'amplitude_entity', title: 'Onboarding A/B Test', metadata: { entity_type: 'experiment', status: 'running' } },
  { source_id: 'ann1', source_type: 'amplitude_entity', title: 'v2 product launch', metadata: { entity_type: 'annotation' } },
]

describe('Amplitude e2e — convert conformance', () => {
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
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type]))
      expect(t['chart1']).toBe('metric')
      expect(t['funnel1']).toBe('metric')
      expect(t['ret1']).toBe('metric')
      expect(t['coh1']).toBe('market_segment')
      expect(t['exp1']).toBe('experiment')
      expect(t['ann1']).toBe('observation')
    } finally {
      await out.cleanup()
    }
  })

  it('preserves metric values under properties (survives the round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const metric = out.rawDoc.nodes.find((n) => n.source_id === 'chart1') as Record<string, unknown>
      expect(metric.properties).toMatchObject({ current_value: 12500, target_value: 20000, unit: 'users' })
      expect(metric.current_value).toBeUndefined()
      expect(metric.target_value).toBeUndefined()
      expect(metric.unit).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('metric values do not bleed onto non-metric nodes', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const cohort = out.rawDoc.nodes.find((n) => n.source_id === 'coh1') as Record<string, unknown>
      expect(cohort.properties).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })
})
