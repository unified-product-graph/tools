/**
 * R6 — the read surface and the write surface answer a renamed edge type the
 * same way.
 *
 * `create_edge({ type: 'project_delivers_epic' })` named the replacement.
 * `get_catalog_entry({ kind: 'edge_type', id: 'project_delivers_epic' })`
 * answered "Unknown edge type: project_delivers_epic" flat, even though the
 * rename is registered in `UPG_EDGE_MIGRATIONS` and visible through
 * `list_catalog({ kind: 'edge_migrations' })`.
 *
 * That is backwards. The server's own instructions tell an agent to introspect
 * before it writes, so the agent that obeyed hit a dead end and only the agent
 * that wrote blind got the hint.
 *
 * Both surfaces now call one function, and a REGISTERED rename outranks the
 * fuzzy name match that used to answer for it by luck.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { UPG_EDGE_MIGRATIONS, UPG_EDGE_CATALOG } from '@unified-product-graph/core'
import { createNode } from '../tools/nodes.js'
import { createEdge } from '../tools/edges.js'
import { getCatalogEntry } from '../tools/catalog.js'
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

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes: [],
    edges: [],
  }
}

async function makeStore(): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-edge-hint-parity-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function raw(result: unknown): Promise<string> {
  const r = (await Promise.resolve(result)) as { content: Array<{ text: string }> }
  return r.content[0].text
}

/**
 * Registered renames whose OLD name is genuinely gone from the catalogue.
 *
 * A handful of renames name a `from` that is still a live catalogue type. For
 * those the catalogue wins and the tool returns the definition, which is
 * correct: a type that exists answers with itself, and only a type that does
 * not exist needs to be told where it went.
 */
const RETIRED_RENAMES: Array<[string, string]> = Object.values(UPG_EDGE_MIGRATIONS)
  .flat()
  .filter((m) => m.kind === 'rename')
  .filter((m) => !(m.from in (UPG_EDGE_CATALOG as Record<string, unknown>)))
  .map((m) => [m.from, m.to] as [string, string])

describe('get_catalog_entry consults UPG_EDGE_MIGRATIONS (R6)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('names the replacement for project_delivers_epic', async () => {
    const text = await raw(
      getCatalogEntry({ kind: 'edge_type', id: 'project_delivers_epic' }, ctx),
    )
    expect(text).toContain('did_you_mean: "project_delivers_work_item"')
    expect(text).toContain('UPG_EDGE_MIGRATIONS')
  })

  it('names the replacement for planning_cycle_schedules_user_story', async () => {
    const text = await raw(
      getCatalogEntry(
        { kind: 'edge_type', id: 'planning_cycle_schedules_user_story' },
        ctx,
      ),
    )
    expect(text).toContain('did_you_mean: "planning_cycle_schedules_work_item"')
  })

  it('answers for EVERY retired rename, not just the two that were reported', async () => {
    expect(RETIRED_RENAMES.length).toBeGreaterThan(0)
    for (const [from, to] of RETIRED_RENAMES) {
      const text = await raw(getCatalogEntry({ kind: 'edge_type', id: from }, ctx))
      expect(text, `rename ${from} -> ${to}`).toContain(`did_you_mean: "${to}"`)
    }
  })

  it('lets the CATALOGUE win when a renamed name is still a live type', async () => {
    const live = Object.values(UPG_EDGE_MIGRATIONS)
      .flat()
      .filter((m) => m.kind === 'rename')
      .filter((m) => m.from in (UPG_EDGE_CATALOG as Record<string, unknown>))
    for (const m of live) {
      const parsed = JSON.parse(
        await raw(getCatalogEntry({ kind: 'edge_type', id: m.from }, ctx)),
      )
      expect(parsed.type, `${m.from} is still catalogued`).toBe(m.from)
    }
  })

  it('still returns the definition for a live catalogue type', async () => {
    const text = await raw(
      getCatalogEntry({ kind: 'edge_type', id: 'persona_pursues_job' }, ctx),
    )
    const parsed = JSON.parse(text)
    expect(parsed.type).toBe('persona_pursues_job')
    expect(parsed.forward_verb).toBeDefined()
  })

  it('still refuses a type that is neither catalogued nor renamed', async () => {
    const text = await raw(
      getCatalogEntry({ kind: 'edge_type', id: 'zzz_not_a_real_edge_zzz' }, ctx),
    )
    expect(text).toContain('is not in UPG_EDGE_CATALOG')
  })
})

describe('the two surfaces agree, byte for byte (R6)', () => {
  it('create_edge and get_catalog_entry return the same did_you_mean clause', async () => {
    const store = await makeStore()
    const ctx = makeCtx(store)

    const project = JSON.parse(
      await raw(createNode({ type: 'project', title: 'P' }, ctx)),
    ).node.id
    const task = JSON.parse(await raw(createNode({ type: 'task', title: 'T' }, ctx))).node.id

    const write = await raw(
      createEdge(
        { source_id: project, target_id: task, type: 'project_delivers_epic' },
        ctx,
      ),
    )
    const read = await raw(
      getCatalogEntry({ kind: 'edge_type', id: 'project_delivers_epic' }, ctx),
    )

    const clause = /did_you_mean: "[^"]+" \([^)]*\)/
    const fromWrite = write.match(clause)?.[0]
    const fromRead = read.match(clause)?.[0]
    expect(fromWrite).toBeDefined()
    expect(fromRead).toBe(fromWrite)
  })
})
