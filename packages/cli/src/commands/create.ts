import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore, inferEdgeType, nodeId, edgeId, validateStatusAgainstLifecycle, validateTitle, parseDataOption, wrapEdgeInferenceError } from '../lib/graph.js'
import { getDomainForType, type UPGBaseNode, type UPGEdgeType } from '@unified-product-graph/core'
import { EXIT, die, violation, runtimeError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const createCommand = new Command('create')
  .arguments('<type> <title>')
  .description('Create an entity. Type is validated against the spec.')
  .option('--file <path>', 'Path to .upg file')
  .option('--parent <id>', 'Parent node ID. Auto-creates an edge')
  .option('--status <status>', 'Lifecycle status. Defaults to active')
  .option('--data <json>', 'Type-specific fields as JSON')
  .option('--tags <list>', 'Comma-separated tags', (v) => v.split(','))
  .option('--json', 'Machine-readable JSON output')
  .action(async (type, title, opts) => {
    try {
      // Validate type. An unknown entity type is a validation/policy problem
      // (exit 2), matching `create --status <bad>` and `new` ( D2).
      const domain = getDomainForType(type)
      if (!domain) {
        die(violation(`Unknown entity type: "${type}". Use a valid UPG type (e.g. persona, job, feature).`))
      }

      // Reject blank titles at the write boundary ( / F1+F10). An empty
      // or whitespace-only title persists an invalid node that then bricks every
      // later read and the delete/update that could repair it.
      const titleError = validateTitle(title)
      if (titleError) die(violation(titleError))

      // Validate --status against the entity lifecycle BEFORE writing, so the
      // writer is never more permissive than health/verify (CLI-FEEDBACK #4).
      if (opts.status) {
        const warning = validateStatusAgainstLifecycle(type, opts.status)
        if (warning) die(violation(warning))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node: UPGBaseNode = {
        id: nodeId(),
        type,
        title,
      }
      if (opts.status) node.status = opts.status
      if (opts.tags) node.tags = opts.tags
      if (opts.data) {
        // Bad/oversized --data is a usage error (exit 3), unified across
        // create/update/score ( D2 / E5).
        try {
          node.properties = parseDataOption(opts.data) as UPGBaseNode['properties']
        } catch (err) {
          store.stopWatching()
          die(err)
        }
      }

      store.addNode(node)

      // Auto-create edge if parent specified.
      let edge: { id: string; source: string; target: string; type: UPGEdgeType } | undefined
      if (opts.parent) {
        const parent = store.getNode(opts.parent)
        if (!parent) {
          await store.flush()
          store.stopWatching()
          die(runtimeError(`Parent node not found: ${opts.parent}`))
        }
        let edgeType: UPGEdgeType
        try {
          edgeType = inferEdgeType(parent.type, type)
        } catch (err) {
          // Incompatible parent/child pair: wrap the leaked catalog string in a
          // user-facing message ( E4). Policy violation → exit 2.
          await store.flush()
          store.stopWatching()
          die(wrapEdgeInferenceError(err))
        }
        edge = { id: edgeId(), source: opts.parent, target: node.id, type: edgeType }
        store.addEdge(edge)
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        // Data on stdout. Scripts read .node.id, never the human ✓ line.
        process.stdout.write(JSON.stringify({ node, edge: edge ?? null }, null, 2) + '\n')
      } else {
        // Chrome on stderr (TTY-styled), so `upg create … | …` stays clean.
        const line = isTTY()
          ? chalk.green('✓') + ` Created ${chalk.dim(type)} "${chalk.white(title)}"  ${chalk.dim(node.id)}`
          : `Created ${type} "${title}" ${node.id}`
        process.stderr.write(line + '\n')
        // The new id is the one machine-relevant datum; emit it on stdout too
        // so a quick `$(upg create … | tail -1)` works without --json.
        process.stdout.write(node.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
