/**
 * Figma end-to-end import audit (convert-only adapter).
 *
 * Conformance is the audit. Fixes verified here: Figma identifiers nested under
 * properties (were top-level → dropped), per-type status validation, and
 * catalogue-driven edges (file→frame/component no longer force product/
 * design_system-sourced edges from a `document` node).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { FigmaAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new FigmaAdapter() as unknown as AdapterLike

const ITEMS = [
  { source_id: 'file1', source_type: 'figma', title: 'Entopo Design System', metadata: { entity_type: 'file', file_key: 'abc123', status: 'active', thumbnail_url: 'https://figma.com/t/abc' } },
  { source_id: 'frame1', source_type: 'figma', title: 'Dashboard', metadata: { entity_type: 'frame', parent_id: 'file1', parent_type: 'file', node_id: '1:2', status: 'active' } },
  { source_id: 'frame2', source_type: 'figma', title: 'Graph view', metadata: { entity_type: 'frame', parent_id: 'file1', parent_type: 'file', node_id: '1:3' } },
  { source_id: 'frame3', source_type: 'figma', title: 'Onboarding welcome', metadata: { entity_type: 'frame', parent_id: 'frame2', parent_type: 'frame', node_id: '1:4' } },
  { source_id: 'cs1', source_type: 'figma', title: 'Card / Variants', metadata: { entity_type: 'component_set', parent_id: 'file1', parent_type: 'file' } },
  { source_id: 'comp2', source_type: 'figma', title: 'Card / Large', metadata: { entity_type: 'component', parent_id: 'cs1', parent_type: 'component_set' } },
  { source_id: 'comp3', source_type: 'figma', title: 'NavBar', metadata: { entity_type: 'component', parent_id: 'frame1', parent_type: 'frame', component_description: 'Top nav' } },
  { source_id: 'proto1', source_type: 'figma', title: 'Onboarding flow', metadata: { entity_type: 'prototype' } },
  { source_id: 'frame4', source_type: 'figma', title: 'Onboarding step 2', metadata: { entity_type: 'frame', parent_id: 'proto1', parent_type: 'prototype', status: 'archived' } },
  { source_id: 'var1', source_type: 'figma', title: 'Color/Brand', metadata: { entity_type: 'variable' } },
]

describe('Figma e2e — convert conformance', () => {
  it('produces a spec-conformant graph (types, statuses, edge endpoints, properties)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('nests Figma identifiers under properties (survive the round-trip)', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const file = out.rawDoc.nodes.find((n) => n.source_id === 'file1') as Record<string, unknown>
      expect(file.properties).toMatchObject({ file_key: 'abc123', thumbnail_url: 'https://figma.com/t/abc' })
      expect(file.file_key).toBeUndefined()
    } finally {
      await out.cleanup()
    }
  })

  it('emits catalogue-correct design edges where they exist', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const sm = out.result.source_map
      const has = (type: string, s: string, t: string) =>
        out.result.edges.some((e) => e.type === type && e.source === sm[s] && e.target === sm[t])
      expect(has('screen_navigates_to_screen', 'frame2', 'frame3')).toBe(true)
      expect(has('design_component_composes_design_component', 'cs1', 'comp2')).toBe(true)
      expect(has('screen_renders_design_component', 'frame1', 'comp3')).toBe(true)
      expect(has('prototype_simulates_screen', 'proto1', 'frame4')).toBe(true)
    } finally {
      await out.cleanup()
    }
  })
})
