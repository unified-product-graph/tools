/**
 * Notion end-to-end import audit (convert-only; list() needs the Notion MCP).
 *
 * Notion already uses the catalogue-aware containment resolver, so the audit
 * verifies the two fixes: per-type status validation (the global LIFECYCLE_STATUS
 * map emitted stages invalid for many target lifecycles) and the source URL
 * stored as canonical `external_ref` (was the off-schema `external_url`).
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { NotionAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new NotionAdapter() as unknown as AdapterLike

const ITEMS = [
  {
    source_id: 'epic-1',
    source_type: 'database_item',
    title: 'Authentication epic',
    metadata: { database_name: 'Epics', status: 'In Progress', url: 'https://notion.so/epic-1' },
    children: [
      { source_id: 'story-1', source_type: 'database_item', title: 'Login story', metadata: { database_name: 'User Stories', status: 'Done' } },
      { source_id: 'feat-1', source_type: 'database_item', title: 'MFA feature', metadata: { database_name: 'Features', status: 'Shipped' } },
    ],
  },
  { source_id: 'persona-1', source_type: 'database_item', title: 'The Builder', metadata: { database_name: 'Personas' } },
]

describe('Notion e2e — convert conformance', () => {
  it('produces a spec-conformant graph', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      expect(out.result.nodes.length).toBe(4)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('infers entity types from database names', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t['epic-1']).toBe('epic')
      expect(t['story-1']).toBe('user_story')
      expect(t['feat-1']).toBe('feature')
      expect(t['persona-1']).toBe('persona')
    } finally {
      await out.cleanup()
    }
  })

  it('validates status per type and stores the URL as external_ref', async () => {
    const out = await runImportE2E({ adapter: adapter(), items: ITEMS })
    try {
      const byId = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n]))
      expect(byId['epic-1'].status).toBe('in_progress') // valid epic phase
      expect(byId['feat-1'].status).toBe('shipped') // raw valid feature phase
      expect(byId['story-1'].status).toBeUndefined() // user_story is lifecycle-free
      const epicOnDisk = out.rawDoc.nodes.find((n) => n.source_id === 'epic-1') as Record<string, unknown>
      expect(epicOnDisk.external_ref).toBe('https://notion.so/epic-1')
    } finally {
      await out.cleanup()
    }
  })
})
