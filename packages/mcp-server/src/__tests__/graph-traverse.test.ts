/**
 * Unit tests for the shared traversal core (`traverseGraph`), the algorithm
 * `portfolio_query` runs per product. Exercised over an in-memory GraphReader
 * so the BFS, edge-type filtering, projection, and truncation are covered
 * independent of the file store. Mirrors the `query` tool's inline loop.
 */
import { describe, it, expect } from 'vitest'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { traverseGraph, type GraphReader } from '../lib/graph-traverse.js'

function makeReader(nodes: UPGBaseNode[], edges: UPGEdge[]): GraphReader {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const byNode = new Map<string, UPGEdge[]>()
  for (const e of edges) {
    for (const id of [e.source, e.target]) {
      const arr = byNode.get(id) ?? []
      arr.push(e)
      byNode.set(id, arr)
    }
  }
  return {
    getNode: (id) => nodeMap.get(id),
    getAllNodes: () => nodes,
    getEdgesForNode: (id) => byNode.get(id) ?? [],
  }
}

const NODES: UPGBaseNode[] = [
  { id: 'p1', type: 'persona', title: 'Solo Builder', description: 'd', properties: { seniority: 'senior' } },
  { id: 'j1', type: 'job', title: 'Ship a feature' },
  { id: 'j2', type: 'job', title: 'Validate an idea' },
  { id: 'need1', type: 'need', title: 'Faster iteration' },
]
const EDGES: UPGEdge[] = [
  { id: 'e1', source: 'p1', target: 'j1', type: 'persona_pursues_job' },
  { id: 'e2', source: 'p1', target: 'j2', type: 'persona_pursues_job' },
  { id: 'e3', source: 'j1', target: 'need1', type: 'job_surfaces_need' },
]

describe('traverseGraph', () => {
  const reader = makeReader(NODES, EDGES)

  it('errors when neither from nor from_id is given', () => {
    const out = traverseGraph(reader, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/Provide either/)
  })

  it('errors when from_id is not present', () => {
    const out = traverseGraph(reader, { from_id: 'ghost' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/Node not found/)
  })

  it('returns an empty subgraph when no node matches the start type', () => {
    const out = traverseGraph(reader, { from: 'competitor' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result).toMatchObject({ total_nodes: 0, total_edges: 0, truncated: false })
  })

  it('follows one typed edge from a type at depth 1', () => {
    const out = traverseGraph(reader, { from: 'persona', traverse: ['persona_pursues_job'], depth: 1 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const ids = out.result.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['j1', 'j2', 'p1'])
    expect(out.result.total_edges).toBe(2)
  })

  it('chains edge types across levels', () => {
    const out = traverseGraph(reader, {
      from: 'persona',
      traverse: ['persona_pursues_job', 'job_surfaces_need'],
      depth: 2,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nodes.map((n) => n.id).sort()).toEqual(['j1', 'j2', 'need1', 'p1'])
  })

  it('honours edge_include: [] to drop edges', () => {
    const out = traverseGraph(reader, { from: 'persona', edge_include: [] })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.edges).toEqual([])
  })

  it('projects requested fields and filters properties', () => {
    const out = traverseGraph(reader, {
      from: 'persona',
      depth: 0,
      include: ['title', 'description', 'properties'],
      property_include: ['seniority'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const p1 = out.result.nodes.find((n) => n.id === 'p1')!
    expect(p1.title).toBe('Solo Builder')
    expect(p1.description).toBe('d')
    expect(p1.properties).toEqual({ seniority: 'senior' })
  })

  it('truncates and flags depth when the node limit is hit', () => {
    const out = traverseGraph(reader, { from: 'persona', limit: 1 })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.total_nodes).toBe(1)
      expect(out.result.truncated).toBe(true)
    }
  })
})
