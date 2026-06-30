/**
 * Same-department advisory for team_contains_team nesting (0.17.2, team_org).
 *
 * A sub-team nested under a parent team should share that parent's department.
 * The edge writers (create_edge / batch_create_edges) attach a NON-BLOCKING
 * warning when the nesting genuinely crosses a department boundary (both teams
 * have a department parent and those sets are disjoint), and stay silent when
 * the org map is merely incomplete (a team has no department parent yet). The
 * edge is always written; this never blocks.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEdge, UPGEntityType, UPGEdgeType } from '@unified-product-graph/core'
import { createEdge, batchCreateEdges } from '../tools/edges.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

const node = (id: string, type: string): UPGBaseNode => ({ id, type: type as UPGEntityType, title: id })
const edge = (id: string, source: string, target: string, type: string): UPGEdge => ({
  id, source, target, type: type as UPGEdgeType,
})

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[]): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Org Fixture', stage: 'concept' },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-team-nesting-'))
  const filePath = join(dir, 'test.upg')
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

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text)

describe('team_contains_team same-department advisory', () => {
  // dept_a contains parent + sub_same; dept_b contains sub_other; sub_orphan has no dept.
  const baseNodes = [
    node('dept_a', 'department'),
    node('dept_b', 'department'),
    node('parent', 'team'),
    node('sub_same', 'team'),
    node('sub_other', 'team'),
    node('sub_orphan', 'team'),
  ]
  const baseEdges = [
    edge('e1', 'dept_a', 'parent', 'department_contains_team'),
    edge('e2', 'dept_a', 'sub_same', 'department_contains_team'),
    edge('e3', 'dept_b', 'sub_other', 'department_contains_team'),
  ]

  it('writes the edge with no warning when both teams share a department', async () => {
    const store = await loadStore(makeDoc(baseNodes, baseEdges))
    const res = parse(createEdge({ source_id: 'parent', target_id: 'sub_same', type: 'team_contains_team' }, makeCtx(store)))
    expect(res.edge?.type).toBe('team_contains_team')
    expect(res.warning).toBeUndefined()
  })

  it('warns (but still writes) when the nesting crosses a department boundary', async () => {
    const store = await loadStore(makeDoc(baseNodes, baseEdges))
    const res = parse(createEdge({ source_id: 'parent', target_id: 'sub_other', type: 'team_contains_team' }, makeCtx(store)))
    expect(res.edge?.type).toBe('team_contains_team')
    expect(res.warning).toMatch(/cross-department/i)
    // The edge is actually persisted, not rejected.
    expect(store.getAllEdges().some((e) => e.type === 'team_contains_team')).toBe(true)
  })

  it('stays silent when a team has no department parent yet (incomplete org map)', async () => {
    const store = await loadStore(makeDoc(baseNodes, baseEdges))
    const res = parse(createEdge({ source_id: 'parent', target_id: 'sub_orphan', type: 'team_contains_team' }, makeCtx(store)))
    expect(res.edge?.type).toBe('team_contains_team')
    expect(res.warning).toBeUndefined()
  })

  it('does not warn on unrelated edge types', async () => {
    const store = await loadStore(makeDoc(baseNodes, baseEdges))
    const res = parse(createEdge({ source_id: 'dept_a', target_id: 'sub_other', type: 'department_contains_team' }, makeCtx(store)))
    expect(res.warning).toBeUndefined()
  })

  it('collects cross-department warnings in batch_create_edges', async () => {
    const store = await loadStore(makeDoc(baseNodes, baseEdges))
    const res = parse(batchCreateEdges({
      edges: [
        { source_id: 'parent', target_id: 'sub_same', type: 'team_contains_team' },
        { source_id: 'parent', target_id: 'sub_other', type: 'team_contains_team' },
      ],
    }, makeCtx(store)))
    expect(res.count).toBe(2)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toMatch(/cross-department/i)
  })
})
