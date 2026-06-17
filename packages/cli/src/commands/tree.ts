import { Command } from 'commander'
import { discoverUPGFile, loadStore, sortByType } from '../lib/graph.js'
import { renderTree, renderAssembledTree, upgHeader, label, heading } from '../lib/formatter.js'
import { die, runtimeError, usageError } from '../lib/errors.js'
import type { UPGBaseNode } from '@unified-product-graph/core'
import { getTreePattern, UPG_TREE_PATTERNS, UPG_TYPES_SET, UPG_DOMAINS, getDomainForType } from '@unified-product-graph/core'
import { assembleTree } from '@unified-product-graph/sdk'

interface TreeJsonNode {
  id: string
  type: string
  title: string
  status?: string
  /** True when this node was already expanded under an earlier parent (DAG); its children are omitted here. */
  shared?: boolean
  children: TreeJsonNode[]
}

export const treeCommand = new Command('tree')
  .arguments('[filter]')
  .description('Tree view of the graph. Filter by entity type or domain, or assemble a named pattern.')
  .option('--file <path>', 'Path to .upg file')
  .option('--id <id>', 'Subtree rooted at a specific node')
  .option('--pattern <id>', 'Assemble a named tree pattern (ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star)')
  .option('--depth <n>', 'Maximum depth. Defaults to 10', parseInt, 10)
  .option('--json', 'Machine-readable nested JSON output')
  .action(async (filter, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      // Pattern mode: the server-owned named shapes (ost/okr/user/...) assembled
      // by the shared SDK assembler. Drift-proof + DAG-honest + gap-aware.
      if (opts.pattern) {
        const pattern = getTreePattern(opts.pattern)
        if (!pattern) {
          store.stopWatching()
          die(usageError(`Unknown pattern: ${opts.pattern}. One of: ${UPG_TREE_PATTERNS.map((p) => p.id).join(', ')}.`))
          return
        }
        const result = assembleTree(store, pattern, { depth: opts.depth })
        store.stopWatching()
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          return
        }
        process.stderr.write(upgHeader(`Tree - ${pattern.label}`) + '\n')
        if (result.anchor_resolved_from) {
          // Two reasons a fallback fires: the anchor type is ABSENT, or it is
          // PRESENT but a fallback root surfaces more of the pattern (e.g.
          // services that nest under a bounded_context). Say which, so the note
          // never contradicts the nodes rendered right below it.
          const note = result.anchor_present
            ? `${result.anchor_type} present, but ${result.anchor_used} surfaces more of the tree; rooted there.`
            : `No ${result.anchor_type} found; rooted on ${result.anchor_used}.`
          process.stderr.write(`  ${label(note)}\n`)
        }
        if (result.roots.length === 0) {
          process.stderr.write(`  ${label(`No ${result.anchor_type} (or fallback) to root the ${pattern.id} tree.`)}\n`)
          return
        }
        process.stdout.write(renderAssembledTree(result.roots) + '\n')
        if (result.gaps.length > 0) {
          process.stderr.write(`\n  ${heading('Gaps')} ${label(`(${result.gaps.length})`)}\n`)
          for (const g of result.gaps.slice(0, 20)) {
            process.stderr.write(`  ${label(`- ${g.type} "${g.title}" is missing: ${g.missing.join(', ')}`)}\n`)
          }
        }
        process.stderr.write(`\n  ${label(`${result.stats.nodes} nodes, ${result.stats.levels} levels`)}`)
        process.stderr.write(result.stats.shared_refs > 0 ? `${label(`, ${result.stats.shared_refs} shared`)}\n` : '\n')
        return
      }

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
        // A filter is an entity type or a domain id. An unknown token must NOT
        // silently fall back to the full tree mislabeled as "<filter>" (field
        // report §10.7) — it errors so a typo is caught, not hidden.
        const typeMatch = allNodes.filter((n) => n.type === filter)
        if (typeMatch.length > 0) {
          roots = typeMatch
        } else if (UPG_TYPES_SET.has(filter)) {
          // Valid entity type, just none present. Clean, not the whole graph.
          store.stopWatching()
          process.stderr.write(`No "${filter}" entities in this graph.\n`)
          return
        } else if (UPG_DOMAINS.some((d) => d.id === filter)) {
          // Domain filter: every node whose type belongs to this domain, rooted
          // at the domain's natural entry points (nodes with no in-domain parent).
          const inDomain = allNodes.filter((n) => getDomainForType(n.type)?.id === filter)
          if (inDomain.length === 0) {
            store.stopWatching()
            process.stderr.write(`No entities in the "${filter}" domain in this graph.\n`)
            return
          }
          const inDomainIds = new Set(inDomain.map((n) => n.id))
          const childOfDomainPeer = new Set<string>()
          for (const e of allEdges) {
            if (inDomainIds.has(e.source) && inDomainIds.has(e.target)) childOfDomainPeer.add(e.target)
          }
          const domainRoots = inDomain.filter((n) => !childOfDomainPeer.has(n.id))
          roots = domainRoots.length > 0 ? domainRoots : inDomain
        } else {
          store.stopWatching()
          die(usageError(
            `Unknown tree filter: "${filter}". Expected an entity type (\`upg spec types\`) ` +
            `or a domain (\`upg spec domains\`). For one node use --id; for the whole graph run \`upg tree\` with no filter.`,
          ))
          return
        }
      } else {
        roots = allNodes.filter((n) => !hasParent.has(n.id))
      }

      store.stopWatching()

      roots = sortByType(roots)

      if (opts.json) {
        // Emit the nested structure (CLI-FEEDBACK #7). Guard against cycles so
        // a self/back edge can't recurse forever.
        // DAG-honest: expand each node's subtree once; a node met again is a
        // `shared` reference with no children (mirrors the server assembleTree).
        const expanded = new Set<string>()
        const build = (node: UPGBaseNode, depth: number): TreeJsonNode => {
          const entry: TreeJsonNode = { id: node.id, type: node.type, title: node.title, status: node.status, children: [] }
          if (expanded.has(node.id)) { entry.shared = true; return entry }
          expanded.add(node.id)
          if (depth >= opts.depth) return entry
          entry.children = childrenOf(node.id).map((c) => build(c, depth + 1))
          return entry
        }
        const tree = roots.map((r) => build(r, 0))
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
