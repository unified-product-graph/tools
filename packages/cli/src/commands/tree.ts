import { Command } from 'commander'
import { discoverUPGFile, loadStore, sortByType } from '../lib/graph.js'
import { renderTree, upgHeader } from '../lib/formatter.js'
import { die, runtimeError } from '../lib/errors.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

interface TreeJsonNode {
  id: string
  type: string
  title: string
  status?: string
  children: TreeJsonNode[]
}

export const treeCommand = new Command('tree')
  .arguments('[filter]')
  .description('Tree view of the graph. Filter by entity type or domain.')
  .option('--file <path>', 'Path to .upg file')
  .option('--id <id>', 'Subtree rooted at a specific node')
  .option('--depth <n>', 'Maximum depth. Defaults to 10', parseInt, 10)
  .option('--json', 'Machine-readable nested JSON output')
  .action(async (filter, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const allNodes = store.getAllNodes()
      const allEdges = store.getAllEdges()
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]))

      // Build parent→children index
      const childrenMap = new Map<string, string[]>()
      const hasParent = new Set<string>()
      for (const edge of allEdges) {
        const children = childrenMap.get(edge.source) ?? []
        children.push(edge.target)
        childrenMap.set(edge.source, children)
        hasParent.add(edge.target)
      }

      const childrenOf = (id: string): UPGBaseNode[] => {
        const children = (childrenMap.get(id) ?? [])
          .map((cid) => nodeMap.get(cid))
          .filter((n): n is UPGBaseNode => n !== undefined)
        return sortByType(children)
      }

      let roots: UPGBaseNode[]

      if (opts.id) {
        const node = nodeMap.get(opts.id)
        if (!node) { store.stopWatching(); die(runtimeError(`Node not found: ${opts.id}`)) }
        roots = [node]
      } else if (filter) {
        const typeMatch = allNodes.filter((n) => n.type === filter)
        roots = typeMatch.length > 0 ? typeMatch : allNodes.filter((n) => !hasParent.has(n.id))
      } else {
        roots = allNodes.filter((n) => !hasParent.has(n.id))
      }

      store.stopWatching()

      roots = sortByType(roots)

      if (opts.json) {
        // Emit the nested structure (CLI-FEEDBACK #7). Guard against cycles so
        // a self/back edge can't recurse forever.
        const build = (node: UPGBaseNode, depth: number, seen: Set<string>): TreeJsonNode => {
          const entry: TreeJsonNode = { id: node.id, type: node.type, title: node.title, status: node.status, children: [] }
          if (depth >= opts.depth || seen.has(node.id)) return entry
          const next = new Set(seen).add(node.id)
          entry.children = childrenOf(node.id).map((c) => build(c, depth + 1, next))
          return entry
        }
        const tree = roots.map((r) => build(r, 0, new Set()))
        process.stdout.write(JSON.stringify(tree, null, 2) + '\n')
        return
      }

      if (roots.length === 0) { process.stderr.write('No matching entities.\n'); return }

      process.stderr.write(upgHeader(filter ? `Tree - ${filter}` : 'Tree') + '\n')
      process.stdout.write(renderTree(roots, childrenOf, opts.depth) + '\n')
    } catch (err) {
      die(err)
    }
  })
