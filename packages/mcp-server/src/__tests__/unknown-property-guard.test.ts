/**
 * Tests for the unknown-property guard on create_node and update_node.
 *
 * Verifies:
 * - create_node warns when caller passes properties not in the entity schema
 * - create_node rejects (strict mode) when strict: true
 * - update_node warns when caller passes unknown properties
 * - update_node rejects (strict mode) when strict: true
 * - clean properties produce no warning / unknown_properties field
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createNode, updateNode } from '../tools/nodes.js'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(nodes: UPGDocument['nodes'] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes,
    edges: [],
  }
}

async function makeStore(nodes: UPGDocument['nodes'] = []): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-unknown-prop-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(nodes), null, 2))
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

async function parseResult(result: ReturnType<typeof createNode> | ReturnType<typeof updateNode>) {
  const r = (await Promise.resolve(result)) as { isError?: boolean; content: Array<{ text: string }> }
  if (r.isError) return { error: r.content[0].text }
  return JSON.parse(r.content[0].text)
}

// ── create_node — warn mode ───────────────────────────────────────────────────

describe('create_node — unknown-property guard', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('creates a persona with canonical properties and emits NO warning', async () => {
    const result = await parseResult(
      createNode(
        {
          type: 'persona',
          title: 'Sarah — PM',
          properties: { context: 'B2B SaaS startup', motivation: 'Ship fast' },
        },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })

  it('creates a persona with legacy "goals" property and surfaces a warning', async () => {
    const result = await parseResult(
      createNode(
        {
          type: 'persona',
          title: 'Marcus — Designer',
          properties: { context: 'Freelance', goals: ['Ship beautiful UI'], frustrations: ['Slow tools'] },
        },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toEqual(expect.arrayContaining(['goals', 'frustrations']))
    expect(result.warning).toMatch(/goals/)
    expect(result.warning).toMatch(/frustrations/)
    expect(result.warning).toMatch(/persona/)
  })

  it('strict mode: rejects persona with legacy "goals" property', async () => {
    const result = await parseResult(
      createNode(
        {
          type: 'persona',
          title: 'Priya — Founder',
          properties: { goals: ['Build fast'] },
          strict: true,
        },
        ctx,
      ),
    )
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/strict mode/)
    expect(result.error).toMatch(/goals/)
    // Node must NOT have been created
    const nodes = store.getAllNodes()
    expect(nodes.find((n) => n.title === 'Priya — Founder')).toBeUndefined()
  })

  it('strict mode: creates a persona with canonical properties (no rejection)', async () => {
    const result = await parseResult(
      createNode(
        {
          type: 'persona',
          title: 'Felix — Solo Founder',
          properties: { context: 'Pre-seed', is_primary: true },
          strict: true,
        },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })
})

// ── update_node — warn mode ───────────────────────────────────────────────────

describe('update_node — unknown-property guard', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  let personaId: string

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
    // Pre-create a persona to update
    const r = await parseResult(
      createNode({ type: 'persona', title: 'Test Persona', properties: { context: 'B2B' } }, ctx),
    )
    personaId = r.node.id
  })

  it('updates a persona with canonical properties and emits NO warning or unknown_properties', async () => {
    const result = await parseResult(
      updateNode(
        { node_id: personaId, properties: { motivation: 'Deliver value' } },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toBeUndefined()
    // No unknown-property warning; possibly lifecycle warning but not goals/frustrations
    if (result.warning) {
      expect(result.warning).not.toMatch(/goals/)
      expect(result.warning).not.toMatch(/frustrations/)
    }
  })

  it('updates with legacy "frustrations" property and surfaces a warning + unknown_properties', async () => {
    const result = await parseResult(
      updateNode(
        {
          node_id: personaId,
          properties: { frustrations: ['Slow onboarding', 'No mobile app'] },
        },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toEqual(['frustrations'])
    expect(result.warning).toMatch(/frustrations/)
  })

  it('strict mode: rejects update with unknown property', async () => {
    const result = await parseResult(
      updateNode(
        {
          node_id: personaId,
          properties: { goals: ['Get promoted'], frustrations: ['Too many meetings'] },
          strict: true,
        },
        ctx,
      ),
    )
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/strict mode/)
    // Node properties should be unchanged
    const node = store.getNode(personaId)
    expect(node?.properties?.goals).toBeUndefined()
  })

  it('strict mode: updates successfully when all properties are canonical', async () => {
    const result = await parseResult(
      updateNode(
        {
          node_id: personaId,
          properties: { tech_comfort: 'advanced' },
          strict: true,
        },
        ctx,
      ),
    )
    expect(result.node).toBeDefined()
    expect(result.unknown_properties).toBeUndefined()
  })
})
