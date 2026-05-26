import { Command } from 'commander'
import { execSync } from 'node:child_process'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

export const diffCommand = new Command('diff')
  .description('Compare the current .upg against a git ref. For PR reviews.')
  .option('--file <path>', 'Path to .upg file')
  .option('--since <ref>', 'Git ref to compare against. Defaults to HEAD~1', 'HEAD~1')
  .option('--summary', 'One line per change')
  .option('--stat', 'Counts only, like git diff --stat')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const nodes = store.getAllNodes()
      const edges = store.getAllEdges()
      const nodeMap = new Map(nodes.map((n) => [n.id, n]))

      // Get the old version from git
      let oldDoc: { nodes?: UPGBaseNode[]; edges?: Array<{ id: string; source: string; target: string; type: string }> } | null = null
      try {
        const cwd = process.cwd()
        const relativePath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath
        const oldRaw = execSync(`git show ${opts.since}:${relativePath}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        oldDoc = JSON.parse(oldRaw)
      } catch { /* file did not exist at that ref */ }

      const oldNodes = new Map((oldDoc?.nodes ?? []).map((n) => [n.id, n]))
      const currentMap = new Map(nodes.map((n) => [n.id, n]))

      const added: UPGBaseNode[] = []
      const updated: Array<{ node: UPGBaseNode; changed: string[] }> = []
      const deleted: UPGBaseNode[] = []

      for (const [id, node] of currentMap) {
        const old = oldNodes.get(id)
        if (!old) {
          added.push(node)
        } else {
          const changed: string[] = []
          if (old.title !== node.title) changed.push('title')
          if (old.description !== node.description) changed.push('description')
          if (old.status !== node.status) changed.push('status')
          if (JSON.stringify(old.tags) !== JSON.stringify(node.tags)) changed.push('tags')
          if (JSON.stringify(old.properties) !== JSON.stringify(node.properties)) changed.push('properties')
          if (changed.length > 0) updated.push({ node, changed })
        }
      }

      for (const [id, node] of oldNodes) {
        if (!currentMap.has(id)) deleted.push(node)
      }

      const oldEdgeIds = new Set(oldDoc?.edges?.map((e) => e.id) ?? [])
      const currentEdgeIds = new Set(edges.map((e) => e.id))
      const edgesAdded = edges.filter((e) => !oldEdgeIds.has(e.id)).length
      const edgesDeleted = [...oldEdgeIds].filter((id) => !currentEdgeIds.has(id)).length

      store.stopWatching()

      if (opts.json) {
        console.log(JSON.stringify({
          added: added.map((n) => ({ id: n.id, type: n.type, title: n.title })),
          updated: updated.map((u) => ({ id: u.node.id, type: u.node.type, title: u.node.title, changed: u.changed })),
          deleted: deleted.map((n) => ({ id: n.id, type: n.type, title: n.title })),
          edges_added: edgesAdded, edges_deleted: edgesDeleted, since: opts.since,
        }, null, 2))
        return
      }

      if (opts.stat) {
        console.log(`${added.length} added, ${updated.length} updated, ${deleted.length} deleted, ${edgesAdded} edges added, ${edgesDeleted} edges deleted`)
        return
      }

      const totalChanges = added.length + updated.length + deleted.length
      if (totalChanges === 0 && edgesAdded === 0 && edgesDeleted === 0) {
        console.log('No changes.')
        return
      }

      console.log(`\n${added.length} added, ${updated.length} updated, ${deleted.length} deleted, ${edgesAdded} edges added\n`)

      for (const node of added) {
        const parentEdge = edges.find((e) => e.target === node.id)
        const parentNode = parentEdge ? nodeMap.get(parentEdge.source) : null
        const parentLabel = parentNode ? ` (parent: ${parentNode.title})` : ''
        console.log(`  + ${node.type.padEnd(16)} "${node.title}"${parentLabel}`)
      }
      for (const { node, changed } of updated) {
        console.log(`  ~ ${node.type.padEnd(16)} "${node.title}" · ${changed.join(', ')} updated`)
      }
      for (const node of deleted) {
        console.log(`  - ${node.type.padEnd(16)} "${node.title}" (deleted)`)
      }
      console.log()
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
