/**
 * Copilot tool execution. Same operations as MCP server tools, operating
 * directly on UPGFileStore.
 *
 * This bridges the Gemini function calling format to the store API.
 * When lib/tools.ts is fully extracted, this file can import directly.
 */

import type { UPGFileStore } from './graph.js'
import { computeGraphDigest, computeHealthScore, searchNodes, sortByType, BUSINESS_AREAS } from './graph.js'
import type { UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'

function normalizeType(input: string): string {
  return input.toLowerCase().replace(/[\s-]+/g, '_')
}

export function executeTool(store: UPGFileStore, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'list_nodes': {
      const type = args.type ? normalizeType(args.type as string) : undefined
      const status = args.status as string | undefined
      const parentId = args.parent_id as string | undefined
      const limit = Math.min((args.limit as number) ?? 20, 50)

      let nodes = store.getAllNodes()
      if (type) nodes = nodes.filter((n) => n.type === type)
      if (status) nodes = nodes.filter((n) => n.status === status)
      if (parentId) {
        const childIds = new Set(
          store.getEdgesForNode(parentId).filter((e) => e.source === parentId).map((e) => e.target)
        )
        nodes = nodes.filter((n) => childIds.has(n.id))
      }

      if (nodes.length === 0) return `No ${type ?? ''} entities found.`
      return sortByType(nodes).slice(0, limit).map((n) =>
        `${n.type}: "${n.title}"${n.status ? ` [${n.status}]` : ''} (${n.id.slice(0, 8)})`
      ).join('\n') + (nodes.length > limit ? `\n... +${nodes.length - limit} more` : '') + `\n\nTotal: ${nodes.length}`
    }

    case 'search_nodes': {
      const query = args.query as string
      if (!query) return 'Missing query.'

      // Also try as a type name
      const asType = normalizeType(query)
      const typeNodes = store.getAllNodes().filter((n) => n.type === asType)
      if (typeNodes.length > 0) {
        return sortByType(typeNodes).slice(0, 15).map((n) =>
          `${n.type}: "${n.title}"${n.status ? ` [${n.status}]` : ''}`
        ).join('\n') + `\n\nTotal: ${typeNodes.length}`
      }

      const results = searchNodes(store, query, {
        type: args.type ? normalizeType(args.type as string) : undefined,
        limit: 15,
      })
      if (results.length === 0) return 'No results found.'
      return results.map((r) =>
        `${r.node.type}: "${r.node.title}"${r.node.status ? ` [${r.node.status}]` : ''} (matched: ${r.match_field})`
      ).join('\n')
    }

    case 'get_node': {
      const id = args.id as string
      if (!id) return 'Missing node ID.'
      const node = store.getNode(id)
      if (!node) return `Node not found: ${id}`
      const edges = store.getEdgesForNode(id)
      const children = edges.filter((e) => e.source === id).map((e) => {
        const child = store.getNode(e.target)
        return child ? `  → ${child.type}: "${child.title}"` : null
      }).filter(Boolean)
      const parents = edges.filter((e) => e.target === id).map((e) => {
        const parent = store.getNode(e.source)
        return parent ? `  ← ${parent.type}: "${parent.title}"` : null
      }).filter(Boolean)

      const lines = [
        `Type: ${node.type}`,
        `Title: ${node.title}`,
        node.description ? `Description: ${node.description}` : null,
        node.status ? `Status: ${node.status}` : null,
        node.tags?.length ? `Tags: ${node.tags.join(', ')}` : null,
        children.length ? `\nChildren (${children.length}):\n${children.join('\n')}` : null,
        parents.length ? `\nParents (${parents.length}):\n${parents.join('\n')}` : null,
      ].filter(Boolean)
      return lines.join('\n')
    }

    case 'get_graph_digest': {
      const digest = computeGraphDigest(store)
      const score = computeHealthScore(digest)
      const lines = [
        `Health Score: ${score}/100`,
        `Nodes: ${digest.counts.total_nodes}, Edges: ${digest.counts.total_edges}`,
        `Orphans: ${digest.health.orphan_count} (${Math.round(digest.health.orphan_rate * 100)}%)`,
        '',
        'Domain Coverage:',
      ]
      for (const [domain, cov] of Object.entries(digest.coverage)) {
        // `coverage` carries a `stage_summary` (CoverageStageSummary) alongside the
        // per-region entries; skip it: only CoverageRegion has type coverage fields.
        if (!('types_present' in cov)) continue
        lines.push(`  ${cov.covered > 0 ? '✓' : '✗'} ${domain}: ${cov.types_present.join(', ') || '(empty)'}`)
        if (cov.types_missing.length > 0) lines.push(`    missing: ${cov.types_missing.join(', ')}`)
      }
      lines.push('', 'Chains:')
      const chains: Array<[string, number, number]> = [
        ['persona → job', digest.chains.persona_with_job, digest.chains.persona_total],
        ['job → need', digest.chains.job_with_need, digest.chains.job_total],
        ['opportunity → solution', digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
      ]
      for (const [name, connected, total] of chains) {
        if (total > 0) lines.push(`  ${connected === total ? '✓' : '✗'} ${name}: ${connected}/${total}`)
      }
      lines.push('', 'Top entity types:')
      const sorted = Object.entries(digest.counts.by_type).sort((a, b) => b[1] - a[1]).slice(0, 10)
      for (const [type, count] of sorted) lines.push(`  ${type}: ${count}`)
      return lines.join('\n')
    }

    case 'get_tree': {
      const type = args.type ? normalizeType(args.type as string) : 'persona'
      const allNodes = store.getAllNodes()
      const allEdges = store.getAllEdges()
      const roots = allNodes.filter((n) => n.type === type)
      if (roots.length === 0) return `No ${type} entities found.`

      const childMap = new Map<string, string[]>()
      for (const e of allEdges) {
        const arr = childMap.get(e.source) ?? []
        arr.push(e.target)
        childMap.set(e.source, arr)
      }
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]))

      const lines: string[] = []
      for (const root of sortByType(roots)) {
        lines.push(`${root.type}: "${root.title}"`)
        const children = (childMap.get(root.id) ?? []).map((id) => nodeMap.get(id)).filter(Boolean) as UPGBaseNode[]
        for (const child of sortByType(children).slice(0, 8)) {
          lines.push(`  └─ ${child.type}: "${child.title}"`)
          const grandchildren = (childMap.get(child.id) ?? []).map((id) => nodeMap.get(id)).filter(Boolean) as UPGBaseNode[]
          for (const gc of sortByType(grandchildren).slice(0, 3)) {
            lines.push(`      └─ ${gc.type}: "${gc.title}"`)
          }
          if (grandchildren.length > 3) lines.push(`      └─ ... +${grandchildren.length - 3} more`)
        }
        if (children.length > 8) lines.push(`  └─ ... +${children.length - 8} more`)
      }
      return lines.join('\n')
    }

    case 'create_node': {
      const type = args.type ? normalizeType(args.type as string) : undefined
      const title = args.title as string
      if (!type || !title) return 'Missing type or title.'

      const { nodeId, edgeId, inferEdgeType } = require('./graph.js')
      const node: UPGBaseNode = { id: nodeId(), type: type as UPGEntityType, title }
      if (args.description) node.description = args.description as string
      if (args.status) node.status = args.status as string
      store.addNode(node)

      if (args.parent_id) {
        const parent = store.getNode(args.parent_id as string)
        if (parent) {
          store.addEdge({ id: edgeId(), source: args.parent_id as string, target: node.id, type: inferEdgeType(parent.type, type) })
        }
      }
      store.flush()
      return `Created ${type} "${title}" (ID: ${node.id})`
    }

    default:
      return `Unknown tool: ${name}`
  }
}
