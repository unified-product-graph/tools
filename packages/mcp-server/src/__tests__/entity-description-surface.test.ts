/**
 * R8 — an agent can find out what an entity type IS.
 *
 * `get_entity_schema` returned `type, domain, expected_properties, edges_out,
 * edges_in, domain_guide`. `get_catalog_entry({ kind: 'entity_meta' })`
 * returned `name, type_id, maturity, since, domain_id`. Neither carried a
 * description, byte-identical from 0.32.0 through 0.34.0 — while the server's
 * own instructions say "Before creating an entity or edge, call
 * `get_entity_schema` for the type".
 *
 * The descriptions existed and were gated: 0.32.1 added `check:editorial`,
 * which turns a release red until every type has an authored one. They lived in
 * the documentation site's build script, which is an application, so no
 * consumer of the format could reach them and the gate protected a surface no
 * agent could see. `UPG_ENTITY_DESCRIPTIONS` moves them into the spec package.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  UPG_TYPES,
  UPG_TYPE_LABELS,
  UPG_ENTITY_DESCRIPTIONS,
  getEntityDescription,
} from '@unified-product-graph/core'
import { getEntitySchema } from '../tools/schema.js'
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

async function makeStore(): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-entity-description-test-'))
  const filePath = join(dir, 'test.upg')
  const doc: UPGDocument = {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes: [],
    edges: [],
  }
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
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

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('the description table covers the catalogue (R8)', () => {
  it('every UPG_TYPES entry has a non-empty authored description', () => {
    const missing = UPG_TYPES.filter((t) => {
      const d = getEntityDescription(t)
      return typeof d !== 'string' || d.trim().length === 0
    })
    expect(missing).toEqual([])
  })

  it('does not carry the generator fallback text that 0.32.1 was written to catch', () => {
    // The EXACT string the docs generator used to emit for a type with no
    // entry, reconstructed per type rather than matched by a pattern: a real
    // description may legitimately end in the word "entity" (`research_plan`
    // does), and a loose regex would report it as a placeholder. `capture`
    // shipped with the genuine fallback in 0.32.0.
    // UPG_TYPE_LABELS is a LIST of label records, not a map, so index it once
    // rather than asserting a shape it does not have.
    const labelOf = new Map(UPG_TYPE_LABELS.map((l) => [l.id, l.canonical_label]))
    const fallbacks = Object.entries(UPG_ENTITY_DESCRIPTIONS).filter(([type, d]) => {
      const label = labelOf.get(type) ?? type
      return d === `A ${label.toLowerCase()} entity`
    })
    expect(fallbacks).toEqual([])
  })
})

describe('get_entity_schema returns the description (R8)', () => {
  let ctx: ToolContext

  beforeEach(async () => {
    ctx = makeCtx(await makeStore())
  })

  it('returns it for capture, the type 0.32.1 was written about', async () => {
    const schema = await parse(getEntitySchema({ type: 'capture' }, ctx))
    expect(schema.description).toBe(getEntityDescription('capture'))
    expect(schema.description.length).toBeGreaterThan(0)
  })

  it('returns it for a plain type too', async () => {
    const schema = await parse(getEntitySchema({ type: 'persona' }, ctx))
    expect(schema.description).toBe('An archetype representing a user segment')
  })

  it('keeps every field the shape carried before', async () => {
    const schema = await parse(getEntitySchema({ type: 'persona' }, ctx))
    for (const key of ['type', 'domain', 'expected_properties', 'edges_out', 'edges_in']) {
      expect(schema, key).toHaveProperty(key)
    }
  })
})

describe('get_catalog_entry(entity_meta) returns the description (R8)', () => {
  let ctx: ToolContext

  beforeEach(async () => {
    ctx = makeCtx(await makeStore())
  })

  it('returns it alongside the metadata', async () => {
    const meta = await parse(
      getCatalogEntry({ kind: 'entity_meta', id: 'capture' }, ctx),
    )
    expect(meta.description).toBe(getEntityDescription('capture'))
    expect(meta.name).toBe('capture')
    expect(meta.domain_id).toBeDefined()
  })

  it('agrees with get_entity_schema, so the two surfaces say one thing', async () => {
    for (const type of ['capture', 'persona', 'composition', 'metric']) {
      const schema = await parse(getEntitySchema({ type }, ctx))
      const meta = await parse(getCatalogEntry({ kind: 'entity_meta', id: type }, ctx))
      expect(meta.description, type).toBe(schema.description)
    }
  })
})
