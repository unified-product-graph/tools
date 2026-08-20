/**
 * Orphan warning names the type's ACTUAL containment parent, not the domain anchor.
 *
 * Regression for the agent-surface truth-drift audit (2026-07-11): a node created
 * with no parent got an orphan hint built from its domain *anchor* — so
 * `strategic_theme` (strategy-domain anchor `outcome`, but real parent
 * `strategic_pillar`) was told it "typically attaches under outcome", a parent it
 * has no containment edge to. The hint now resolves the real parent from
 * UPG_VALID_CHILDREN when the anchor is not itself a containment parent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { createNode } from '../tools/nodes.js'

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}
function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

describe('orphan warning names the real containment parent, not the domain anchor', () => {
  let store: UPGFileStore
  let dir: string
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-orphan-')))
    const filePath = join(dir, 'test.upg')
    const d: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p1', title: 'P', stage: 'growth' },
      nodes: [],
      edges: [],
    }
    writeFileSync(filePath, JSON.stringify(d, null, 2))
    store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('strategic_theme orphan hint names strategic_pillar (its real parent), not the strategy anchor outcome', async () => {
    const body = bodyOf(await createNode({ type: 'strategic_theme', title: 'Q3 Expansion' }, makeCtx(store)))
    const warning = String(body.warning ?? '')
    expect(warning).toMatch(/Orphan/)
    expect(warning).toMatch(/strategic_pillar/)
    // The pre-fix bug: naming the domain anchor `outcome`, which has no containment edge to strategic_theme.
    expect(warning).not.toMatch(/attaches under outcome/)
    // The named parent must be a real containment parent, so the canonical-edge suffix is present.
    expect(warning).toMatch(/canonical edge:/)
  })
})
