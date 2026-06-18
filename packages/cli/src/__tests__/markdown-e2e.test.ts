/**
 * Markdown end-to-end import audit.
 *
 * Markdown is the one adapter with no external API to drift against — it parses
 * .md text in-memory — so it is fully verifiable. This runs a realistic product
 * doc through the full production path (list → convert → writeToUPGFile → reload)
 * and asserts spec conformance: valid entity types, catalogued edges, a clean
 * round-trip to a reloadable .upg.
 */

import { describe, it, expect } from 'vitest'
import { UPG_EDGE_TYPES } from '@unified-product-graph/core'
import { MarkdownAdapter } from '@unified-product-graph/adapters'
import { runImportE2E, conformanceIssues, type AdapterLike } from './helpers/import-e2e.js'

const EDGE_TYPES = new Set<string>(UPG_EDGE_TYPES)
const adapter = () => new MarkdownAdapter() as unknown as AdapterLike

const DOC = [
  '# Acme Analytics',
  '',
  'A self-serve analytics product for small teams.',
  '',
  '## Increase new-user activation',
  'Type: outcome',
  '',
  '### Activation rate',
  'Type: metric',
  '',
  '## Users abandon onboarding',
  'Type: opportunity',
  '',
  '### Guided setup wizard',
  'Type: solution',
  '',
  '## The Builder',
  'Type: persona',
  '',
  '### Set up analytics without a data team',
  'Type: job',
  '',
].join('\n')

describe('Markdown e2e — product doc → valid reloadable .upg', () => {
  async function run() {
    return runImportE2E({ adapter: adapter(), config: { content: DOC } })
  }

  it('imports the doc as a conformant graph (round-trip clean)', async () => {
    const out = await run()
    try {
      expect(out.result.nodes.length).toBeGreaterThan(0)
      expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
    } finally {
      await out.cleanup()
    }
  })

  it('infers the expected entity types from headings + Type: hints', async () => {
    const out = await run()
    try {
      const types = new Set(out.result.nodes.map((n) => n.type))
      for (const t of ['outcome', 'metric', 'opportunity', 'solution', 'persona', 'job']) {
        expect(types.has(t), `expected a ${t} node`).toBe(true)
      }
    } finally {
      await out.cleanup()
    }
  })

  it('persists every node + edge to disk and reloads them all', async () => {
    const out = await run()
    try {
      expect(out.rawDoc.nodes.length).toBe(out.result.nodes.length)
      expect(out.reloadError).toBeNull()
      expect(out.reloadedNodes).toHaveLength(out.rawDoc.nodes.length)
    } finally {
      await out.cleanup()
    }
  })
})
