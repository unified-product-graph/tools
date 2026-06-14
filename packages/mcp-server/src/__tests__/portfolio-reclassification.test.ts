/**
 * diff_classification + auto-emit end to end (UPG 0.11.0).
 *
 * Drives a real reclassification through the WRITE handler
 * (create_cross_product_edge) and reads it back through diff_classification —
 * proving the chokepoint auto-records the move and the read tool projects it
 * with resolved titles. Runs against a real tmp workspace; handlers read
 * process.cwd().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { diffClassification } from '../tools/portfolio-read.js'
import { createCrossProductEdge } from '../tools/workspace.js'

const AXIS_INCLUDES = 'classification_axis_includes_classification_value'
const CLASSIFY = 'competitor_classified_as_classification_value'

const RIVAL = {
  upg_version: '0.11',
  exported_at: '2026-06-14T00:00:00.000Z',
  source: { tool: 'test' },
  product: { id: 'p_rival', title: 'Rival Watch', stage: 'concept' },
  nodes: [{ id: 'n_acme', type: 'competitor', title: 'Acme' }],
  edges: [],
}

const PORTFOLIO = {
  upg_version: '0.11',
  exported_at: '2026-06-14T00:00:00.000Z',
  source: { tool: 'test' },
  type: 'portfolio',
  organization: { id: 'org1', title: 'Co' },
  product_areas: [],
  portfolios: [],
  products: [{ id: 'p_rival', file_path: '.upg/rival.upg', title: 'Rival Watch' }],
  registry: {
    nodes: [
      { id: 'ca_ai', type: 'classification_axis', title: 'AI Maturity' },
      { id: 'cv_integrated', type: 'classification_value', title: 'Integrated' },
      { id: 'cv_agentic', type: 'classification_value', title: 'Agentic' },
      { id: 'competitor_acme', type: 'competitor', title: 'Acme' },
    ],
    edges: [
      { id: 'ax1', source: 'ca_ai', target: 'cv_integrated', type: AXIS_INCLUDES },
      { id: 'ax2', source: 'ca_ai', target: 'cv_agentic', type: AXIS_INCLUDES },
    ],
  },
  cross_edges: [
    { id: 'io1', source: 'p_rival/n_acme', target: 'registry/competitor_acme', type: 'instance_of', source_product_id: 'p_rival', target_product_id: 'registry' },
  ],
}

function makeCtx(store: UPGFileStore): ToolContext {
  return { store, sessionContext: createSessionContext(), queryCache: createQueryCache(), sync: { readSyncState, writeSyncState, hashFile, syncFilePath } }
}
const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)
const classifyArgs = (value: string, assessed: string) => ({
  source_id: 'p_rival/n_acme',
  target_id: `registry/${value}`,
  type: CLASSIFY,
  properties: { confidence: { value: 4, label: 'high' }, assessed_on: assessed },
})

describe('diff_classification end to end (0.11.0)', () => {
  let cwd: string
  let prevCwd: string
  let ctx: ToolContext

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-diffclass-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'rival.upg'), JSON.stringify(RIVAL, null, 2))
    writeFileSync(join(cwd, '.upg', 'portfolio.upg'), JSON.stringify(PORTFOLIO, null, 2))
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', 'rival.upg'))
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  it('records a move written via create_cross_product_edge and projects it with titles', async () => {
    await createCrossProductEdge(classifyArgs('cv_integrated', '2026-06-01'), ctx)
    await createCrossProductEdge(classifyArgs('cv_agentic', '2026-09-01'), ctx)

    const b = bodyOf(await diffClassification({}, ctx))
    expect(b.total).toBe(1)
    expect(b.transitions[0]).toMatchObject({
      competitor: 'p_rival/n_acme',
      competitor_title: 'Acme',
      axis: 'ca_ai',
      from_value: 'cv_integrated',
      from_title: 'Integrated',
      to_value: 'cv_agentic',
      to_title: 'Agentic',
      observed_at: '2026-09-01',
    })
  })

  it('since filters out older transitions', async () => {
    await createCrossProductEdge(classifyArgs('cv_integrated', '2026-06-01'), ctx)
    await createCrossProductEdge(classifyArgs('cv_agentic', '2026-09-01'), ctx)

    expect(bodyOf(await diffClassification({ since: '2026-10-01' }, ctx)).total).toBe(0)
    expect(bodyOf(await diffClassification({ since: '2026-06-01' }, ctx)).total).toBe(1)
  })

  it('a first classification produces no transition', async () => {
    await createCrossProductEdge(classifyArgs('cv_integrated', '2026-06-01'), ctx)
    expect(bodyOf(await diffClassification({}, ctx)).total).toBe(0)
  })

  it('rejects a malformed since date', async () => {
    expect((await diffClassification({ since: 'not-a-date' }, ctx)).isError).toBe(true)
  })
})
