import { Command } from 'commander'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { discoverUPGFile, loadStore, inferEdgeType, edgeId, wrapEdgeInferenceError } from '../lib/graph.js'
import { isKnownEdgeType } from '../lib/inference.js'
import { EXIT, die, violation } from '../lib/errors.js'
import type { UPGEdge, UPGEdgeType } from '@unified-product-graph/core'

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

      // (c): a referenced node that does not exist is a policy violation
      // (exit 2), not a runtime error (exit 1). connect already rejects an
      // incompatible inferred pair at exit 2 and the help promises rejection at
      // exit 2, so a missing endpoint lands on the same code for consistency.
      const source = store.getNode(sourceId)
      if (!source) { store.stopWatching(); die(violation(`Source node not found: ${sourceId}`)) }

      const target = store.getNode(targetId)
      if (!target) { store.stopWatching(); die(violation(`Target node not found: ${targetId}`)) }

      let edgeType: string
      if (opts.type) {
        // (b): an explicit --type must be a real edge type. Reject an
        // unknown type at exit 2 (policy violation) rather than persisting a
        // non-canonical edge that trips the schema-drift summary on every read.
        if (!isKnownEdgeType(opts.type)) {
          store.stopWatching()
          die(
            violation(
              `Unknown edge type: "${opts.type}". ` +
                `Drop --type to auto-infer the canonical edge, or run \`upg connect --help\` ` +
                `(and \`list_edge_types\` via the MCP server / docs) for valid types.`,
            ),
          )
        }
        edgeType = opts.type
      } else {
        try {
          edgeType = inferEdgeType(source.type, target.type)
        } catch (err) {
          // Incompatible pair: a policy violation → exit 2 (CLI-FEEDBACK #6).
          // wrapEdgeInferenceError replaces the leaked catalog string with a
          // user-facing message ( E4).
          store.stopWatching()
          die(wrapEdgeInferenceError(err))
        }
      }

      // (cross-cluster seam with the SDK): `store.addEdge` dedups on
      // (source, target, type) and RETURNS the canonical edge — the existing one
      // on a repeat connect, the freshly-built one otherwise. We mint a fresh id
      // up front, so we MUST report the returned edge's id, not our local one;
      // otherwise a duplicate connect prints a fresh id that does not exist in
      // the graph. (`?? built` keeps this correct against an older SDK whose
      // addEdge still returns void — the local edge IS the stored one there.)
      const built: UPGEdge = { id: edgeId(), source: sourceId, target: targetId, type: edgeType as UPGEdgeType }
      // The cast spans both SDK signatures: the current base typed `addEdge` as
      // returning `void`, Geordi's branch returns the canonical `UPGEdge`.
      // Treating the result as `UPGEdge | undefined` lets this compile against
      // either and resolve to the real stored edge once the dedup SDK composes
      // (an older void-returning addEdge yields undefined → fall back to `built`,
      // which IS the stored edge there).
      const stored = store.addEdge(built) as unknown as UPGEdge | undefined
      const edge: UPGEdge = stored ?? built

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify({ edge }, null, 2) + '\n')
      } else {
        process.stderr.write(
          `Connected: ${source.type} "${sanitizeForTerminal(source.title)}" -> ${target.type} "${sanitizeForTerminal(target.title)}" (${edgeType})\n`,
        )
        process.stdout.write(edge.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
