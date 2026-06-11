/**
 * A3 (0.9.14): parent_id / parent_ref lateral-edge warning.
 *
 * A parent whose (parent_type -> child_type) pair has no canonical containment
 * edge still resolves a lateral edge (or none) and writes it silently. The create
 * path now warns (never refuses), on the single write and on batch validate_only.
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
import { createNode, batchCreateNodes } from '../tools/nodes.js'

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

describe('A3: parent_id lateral-edge warning (0.9.14)', () => {
  let store: UPGFileStore
  let dir: string
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'upg-a3-')))
    const filePath = join(dir, 'test.upg')
    const d: UPGDocument = {
      upg_version: '0.2',
      exported_at: new Date().toISOString(),
      source: { tool: 'test' },
      product: { id: 'p1', title: 'P', stage: 'growth' },
      nodes: [
        { id: 'm1', type: 'mission', title: 'Mission' },
        { id: 'o1', type: 'objective', title: 'Objective' },
      ],
      edges: [],
    }
    writeFileSync(filePath, JSON.stringify(d, null, 2))
    store = new UPGFileStore()
    await store.load(filePath)
    store.stopWatching()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('warns when create_node parent_id is not a containment parent (strategic_theme under mission)', async () => {
    const body = bodyOf(await createNode({ type: 'strategic_theme', title: 'Bet', parent_id: 'm1' }, makeCtx(store)))
    expect(String(body.warning ?? '')).toMatch(/containment/i)
  })

  it('does NOT emit a lateral-parent warning for a valid containment parent (key_result under objective)', async () => {
    const body = bodyOf(await createNode({ type: 'key_result', title: 'KR', parent_id: 'o1' }, makeCtx(store)))
    expect(String(body.warning ?? '')).not.toMatch(/lateral|not containment|containment parent/i)
  })

  it('batch validate_only surfaces the lateral-parent warning for a parent_ref chain', () => {
    const body = bodyOf(
      batchCreateNodes(
        {
          validate_only: true,
          nodes: [
            { type: 'mission', title: 'M2' },
            { type: 'strategic_theme', title: 'Theme', parent_ref: '$0' },
          ],
        },
        makeCtx(store),
      ),
    )
    expect(JSON.stringify(body.warnings ?? [])).toMatch(/not a containment parent/i)
  })

  it('batch does NOT warn for a valid containment parent_ref chain', () => {
    const body = bodyOf(
      batchCreateNodes(
        {
          validate_only: true,
          nodes: [
            { type: 'objective', title: 'O2' },
            { type: 'key_result', title: 'KR2', parent_ref: '$0' },
          ],
        },
        makeCtx(store),
      ),
    )
    expect(JSON.stringify(body.warnings ?? [])).not.toMatch(/not a containment parent/i)
  })
})
