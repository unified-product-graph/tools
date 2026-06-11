import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, success, label } from '../lib/formatter.js'
import { die, usageError, violation } from '../lib/errors.js'
import { batchCreateNodes, batchUpdateNodes, type BatchNodeInput } from '@unified-product-graph/sdk'

/** Parse a --data payload as JSON, with a usage error (exit 3) on malformed input. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    die(usageError('--data is not valid JSON.'))
  }
}

export const batchCommand = new Command('batch')
  .description('Atomic batch operations: create, update, or delete many entities in one call.')

batchCommand
  .command('create')
  .description('Create many nodes (and optional edges) atomically. --data is a node array or { nodes, edges }.')
  .requiredOption('--data <json>', 'JSON array of nodes, or { nodes: [...], edges: [...] }')
  .option('--file <path>', 'Path to .upg file')
  .option('--dry-run', 'Validate the whole batch without writing')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const parsed = parseJson(opts.data)
      const args = Array.isArray(parsed)
        ? { nodes: parsed as BatchNodeInput[] }
        : (parsed as { nodes: BatchNodeInput[]; edges?: unknown[] })
      if (!Array.isArray(args.nodes)) die(usageError('--data must be a node array or an object with a `nodes` array.'))

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const result = batchCreateNodes(store, { nodes: args.nodes, edges: args.edges as never, validateOnly: !!opts.dryRun })

      if (!result.ok) { store.stopWatching(); die(violation(result.error)) }
      if (!opts.dryRun) await store.flush()
      store.stopWatching()

      if (opts.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return }
      process.stderr.write(upgHeader('Batch create') + '\n')
      if ('count' in result) {
        process.stdout.write(`  ${success(`${opts.dryRun ? 'Would create' : 'Created'} ${result.count} node${result.count === 1 ? '' : 's'}.`)}\n`)
        if (result.edges?.length) process.stdout.write(`  ${label(`+ ${result.edges.length} edge${result.edges.length === 1 ? '' : 's'}`)}\n`)
      }
      for (const w of (('warnings' in result && result.warnings) || [])) process.stderr.write(`  ${label(`warn: ${w}`)}\n`)
    } catch (err) { die(err) }
  })

batchCommand
  .command('update')
  .description('Update many nodes atomically. --data is an array of { id, ...fields }.')
  .requiredOption('--data <json>', 'JSON array of updates, each { id, ...fields }')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const updates = parseJson(opts.data)
      if (!Array.isArray(updates)) die(usageError('--data must be an array of updates.'))

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const result = batchUpdateNodes(store, updates as never)
      if (!result.ok) { store.stopWatching(); die(violation(result.error)) }
      await store.flush()
      store.stopWatching()

      if (opts.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return }
      const count = 'updated' in result && Array.isArray(result.updated) ? result.updated.length : (updates as unknown[]).length
      process.stderr.write(upgHeader('Batch update') + '\n')
      process.stdout.write(`  ${success(`Updated ${count} node${count === 1 ? '' : 's'}.`)}\n`)
    } catch (err) { die(err) }
  })

batchCommand
  .command('delete')
  .description('Delete many nodes (and their edges) by id.')
  .requiredOption('--ids <list>', 'Comma-separated node ids', (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--file <path>', 'Path to .upg file')
  .option('-y, --yes', 'Confirm the deletion (required)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const ids: string[] = opts.ids
      if (ids.length === 0) die(usageError('--ids must list at least one node id.'))
      if (!opts.yes) die(violation(`Refusing to delete ${ids.length} node(s) without --yes.`))

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const missing = ids.filter((id) => !store.getNode(id))
      if (missing.length > 0) { store.stopWatching(); die(violation(`Unknown node id(s): ${missing.join(', ')}`)) }

      let removedEdges = 0
      for (const id of ids) removedEdges += store.removeNode(id).removedEdgeIds.length
      await store.flush()
      store.stopWatching()

      if (opts.json) { process.stdout.write(JSON.stringify({ deleted: ids, removed_edges: removedEdges }, null, 2) + '\n'); return }
      process.stderr.write(upgHeader('Batch delete') + '\n')
      process.stdout.write(`  ${success(`Deleted ${ids.length} node${ids.length === 1 ? '' : 's'}`)} ${label(`(+ ${removedEdges} edge${removedEdges === 1 ? '' : 's'})`)}\n`)
    } catch (err) { die(err) }
  })
