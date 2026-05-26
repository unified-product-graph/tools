import { Command } from 'commander'
import { discoverUPGFile, loadStore, inferEdgeType, edgeId } from '../lib/graph.js'

export const connectCommand = new Command('connect')
  .arguments('<source-id> <target-id>')
  .description('Create an edge between 2 nodes. Type is auto-inferred.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Edge type. Auto-inferred if omitted')
  .action(async (sourceId, targetId, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const source = store.getNode(sourceId)
      if (!source) { console.error(`Source node not found: ${sourceId}`); process.exit(1) }

      const target = store.getNode(targetId)
      if (!target) { console.error(`Target node not found: ${targetId}`); process.exit(1) }

      const edgeType = opts.type ?? inferEdgeType(source.type, target.type)

      store.addEdge({
        id: edgeId(),
        source: sourceId,
        target: targetId,
        type: edgeType,
      })

      await store.flush()
      store.stopWatching()

      console.log(`Connected: ${source.type} "${source.title}" → ${target.type} "${target.title}" (${edgeType})`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
