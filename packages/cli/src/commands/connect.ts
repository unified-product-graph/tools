import { Command } from 'commander'
import { discoverUPGFile, loadStore, inferEdgeType, edgeId } from '../lib/graph.js'
import { EXIT, die, runtimeError, violation } from '../lib/errors.js'
import type { UPGEdgeType } from '@unified-product-graph/core'

export const connectCommand = new Command('connect')
  .arguments('<source-id> <target-id>')
  .description('Create an edge between 2 nodes. Type is auto-inferred.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Edge type. Auto-inferred if omitted')
  .option('--json', 'Machine-readable JSON output')
  .action(async (sourceId, targetId, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const source = store.getNode(sourceId)
      if (!source) { store.stopWatching(); die(runtimeError(`Source node not found: ${sourceId}`)) }

      const target = store.getNode(targetId)
      if (!target) { store.stopWatching(); die(runtimeError(`Target node not found: ${targetId}`)) }

      let edgeType: string
      if (opts.type) {
        edgeType = opts.type
      } else {
        try {
          edgeType = inferEdgeType(source.type, target.type)
        } catch (err) {
          // Incompatible pair: a policy violation → exit 2 (CLI-FEEDBACK #6).
          store.stopWatching()
          die(violation(err instanceof Error ? err.message : String(err)))
        }
      }

      const edge = { id: edgeId(), source: sourceId, target: targetId, type: edgeType as UPGEdgeType }
      store.addEdge(edge)

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify({ edge }, null, 2) + '\n')
      } else {
        process.stderr.write(
          `Connected: ${source.type} "${source.title}" -> ${target.type} "${target.title}" (${edgeType})\n`,
        )
        process.stdout.write(edge.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
