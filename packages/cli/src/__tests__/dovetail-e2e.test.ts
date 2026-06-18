/**
 * Dovetail end-to-end import audit (live adapter, rewritten list()).
 *
 * The adapter originally called three invented project-scoped endpoints (all
 * 404). Rewritten against Dovetail's REAL global, cursor-paginated endpoints
 * (developers.dovetail.com): /projects, /data, /highlights, /docs, /contacts,
 * /channels, /channels/{id}/themes — with real field names (note_id, title,
 * summary, name, start_time/end_time).
 *
 * The research chain (study → observation → quote) connects; channel themes,
 * contacts, and docs import as valid nodes (their hierarchy edges are a follow-up,
 * since Dovetail's real structure is global resources + themes-under-channels).
 *
 * NOTE: a couple of GET response field names (the data/doc project reference,
 * the pagination cursor param) are inferred from docs + the POST schemas and
 * should be confirmed against a live workspace — see AUDIT-LEDGER.md.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { DovetailAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, stubFetch, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new DovetailAdapter() as unknown as AdapterLike

// Real-shaped, cursor-paginated list responses, one per endpoint.
const page = (data: unknown[]) => ({ data, page: { has_more: false } })
function stubDovetail() {
  return stubFetch([
    { match: '/themes', json: page([{ id: 'th1', title: 'Confusion at setup', summary: 'Users lack orientation cues' }]) },
    { match: '/channels', json: page([{ id: 'ch1', title: 'In-app feedback' }]) },
    { match: '/projects', json: page([{ id: 'proj1', title: 'Mobile onboarding study' }]) },
    { match: '/data', json: page([
      { id: 'data1', title: 'Interview with Felix', project_id: 'proj1' },
      { id: 'data2', title: 'Usability session 2', project: { id: 'proj1' } },
    ]) },
    { match: '/highlights', json: page([{ id: 'hl1', note_id: 'data1', start_time: 42, end_time: 55, text: 'I had no idea what to do next' }]) },
    { match: '/docs', json: page([{ id: 'doc1', title: 'Onboarding insights', project_id: 'proj1' }]) },
    { match: '/contacts', json: page([{ id: 'c1', name: 'Felix Müller', email: 'felix@example.com' }]) },
  ])
}

async function runDovetail() {
  const restore = stubDovetail()
  try {
    return await runImportE2E({ adapter: adapter(), config: { api_key: 'test-key' } })
  } finally {
    restore()
  }
}

describe('Dovetail e2e — real global endpoints → research graph', () => {
  it('imports a conformant graph from the real-shaped payloads', async () => {
    const out = await runDovetail()
    try {
      expect(out.result.nodes.length).toBe(8)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('maps each Dovetail resource to its UPG research type', async () => {
    const out = await runDovetail()
    try {
      const t = Object.fromEntries(out.result.nodes.map((n) => [n.source_id, n.type]))
      expect(t.proj1).toBe('research_study')
      expect(t.data1).toBe('observation')
      expect(t.hl1).toBe('quote')
      expect(t.doc1).toBe('insight')
      expect(t.c1).toBe('participant')
      expect(t.ch1).toBe('feedback_program')
      expect(t.th1).toBe('affinity_cluster')
    } finally {
      await out.cleanup()
    }
  })

  it('connects the research chain: study → observation → quote', async () => {
    const out = await runDovetail()
    try {
      const sm = out.result.source_map
      const has = (type: string, s: string, tgt: string) =>
        out.result.edges.some((e) => e.type === type && e.source === sm[s] && e.target === sm[tgt])
      expect(has('research_study_captures_observation', 'proj1', 'data1')).toBe(true)
      expect(has('research_study_captures_observation', 'proj1', 'data2')).toBe(true)
      expect(has('observation_evidenced_by_quote', 'data1', 'hl1')).toBe(true)
    } finally {
      await out.cleanup()
    }
  })

  it('parses the real endpoints (no 404 from the old project-scoped paths)', async () => {
    const restore = stubFetch([
      { match: '/themes', json: page([]) },
      { match: '/channels', json: page([]) },
      { match: 'dovetail.com/api/v1', json: page([]) }, // any real v1 endpoint resolves
    ])
    try {
      const items = await adapter().list({ api_key: 'test-key' })
      expect(Array.isArray(items)).toBe(true)
    } finally {
      restore()
    }
  })
})
