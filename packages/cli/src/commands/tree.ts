import { Command } from 'commander'
import { discoverUPGFile, loadStore, sortByType } from '../lib/graph.js'
import { renderTree, upgHeader } from '../lib/formatter.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

export const treeCommand = new Command('tree')
  .arguments('[filter]')
  .description('Tree view of the graph. Filter by entity type or domain.')
  .option('--file <path>', 'Path to .upg file')
  .option('--id <id>', 'Subtree rooted at a specific node')
  .option('--depth <n>', 'Maximum depth. Defaults to 10', parseInt, 10)
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
        if (!node) { console.error(`Node not found: ${opts.id}`); process.exit(1) }
        roots = [node]
      } else if (filter) {
        const typeMatch = allNodes.filter((n) => n.type === filter)
        roots = typeMatch.length > 0 ? typeMatch : allNodes.filter((n) => !hasParent.has(n.id))
      } else {
        roots = allNodes.filter((n) => !hasParent.has(n.id))
      }

      store.stopWatching()

      roots = sortByType(roots)
      if (roots.length === 0) { console.log('No matching entities.'); return }

      console.log(upgHeader(filter ? `Tree · ${filter}` : 'Tree'))
      console.log(renderTree(roots, childrenOf, opts.depth))
      console.log()
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
