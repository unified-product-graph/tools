/**
 * Miro end-to-end import audit (convert-only adapter).
 *
 * convert() is the full import story (list() needs a live API), so spec
 * conformance is the audit: valid types per the UPG catalogue, no off-schema
 * fields, edges whose type AND endpoint types match the catalogue, and
 * source_id traceability through the .upg round-trip.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { MiroAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new MiroAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'obs1', source_type: 'miro', title: 'Users tap back on step 3', metadata: { entity_type: 'sticky_note', frame_label: 'Observations' } },
  { source_id: 'ins1', source_type: 'miro', title: 'Drop-off caused by slow load', metadata: { entity_type: 'sticky_note', frame_label: 'Insights' } },
  { source_id: 'opp1', source_type: 'miro', title: 'Reduce time to first value', metadata: { entity_type: 'sticky_note', frame_label: 'Opportunities' } },
  { source_id: 'out1', source_type: 'miro', title: 'Improve 7-day retention', metadata: { entity_type: 'sticky_note', frame_label: 'Outcomes' } },
  { source_id: 'sol1', source_type: 'miro', title: 'Progressive disclosure onboarding', metadata: { entity_type: 'sticky_note', frame_label: 'Solutions' } },
  { source_id: 'hyp1', source_type: 'miro', title: 'Shorter onboarding raises D7 by 12%', metadata: { entity_type: 'sticky_note', frame_label: 'Hypotheses' } },
  { source_id: 'asm1', source_type: 'miro', title: 'Users complete onboarding on mobile', metadata: { entity_type: 'sticky_note', frame_label: 'Assumptions' } },
  { source_id: 'per1', source_type: 'miro', title: 'Power user, technical background', metadata: { entity_type: 'sticky_note', frame_label: 'Personas' } },
  { source_id: 'cmp1', source_type: 'miro', title: 'Linear', metadata: { entity_type: 'sticky_note', frame_label: 'Competitors' } },
  { source_id: 'fea1', source_type: 'miro', title: 'Inline entity editor', metadata: { entity_type: 'sticky_note', frame_label: 'Features' } },
  { source_id: 'job1', source_type: 'miro', title: 'Track my product decisions over time', metadata: { entity_type: 'sticky_note', frame_label: 'Jobs' } },
  { source_id: 'ned1', source_type: 'miro', title: 'See what changed since last session', metadata: { entity_type: 'sticky_note', frame_label: 'Needs' } },
  { source_id: 'raw1', source_type: 'miro', title: 'Raw note without frame', metadata: { entity_type: 'sticky_note' } },
  { source_id: 'crd1', source_type: 'miro', title: 'Follow up on drop-off analysis', metadata: { entity_type: 'card' } },
  { source_id: 'mmn1', source_type: 'miro', title: 'Core theme: Onboarding', metadata: { entity_type: 'mindmap_node', frame_label: 'Insights' } },
  { source_id: 'obs2', source_type: 'miro', title: 'Observation inside cluster', metadata: { entity_type: 'sticky_note', frame_label: 'Observations', parent_id: 'raw1' } },
]

describe('Miro e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, no off-schema fields)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps all MIRO_FRAME_TYPE_MAP branches to correct UPG types', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id as string, n.type as string]))
      expect(t.obs1).toBe('observation')
      expect(t.ins1).toBe('insight')
      expect(t.opp1).toBe('opportunity')
      expect(t.out1).toBe('outcome')
      expect(t.sol1).toBe('solution')
      expect(t.hyp1).toBe('hypothesis')
      expect(t.asm1).toBe('assumption')
      expect(t.per1).toBe('persona')
      expect(t.cmp1).toBe('competitor')
      expect(t.fea1).toBe('feature')
      expect(t.job1).toBe('job')
      expect(t.ned1).toBe('need')
      expect(t.raw1).toBe('observation')
      expect(t.crd1).toBe('task')
      expect(t.mmn1).toBe('insight')
    } finally {
      await out.cleanup()
    }
  })

  it('emits node_informs_node for parent-child pairs (heuristic Miro structure)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.edges.length).toBeGreaterThan(0)
      for (const e of out.result.edges) {
        expect(e.type as string).toBe('node_informs_node')
      }
    } finally {
      await out.cleanup()
    }
  })
})
