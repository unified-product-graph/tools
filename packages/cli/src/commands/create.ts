import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore, inferEdgeType, nodeId, edgeId, validateStatusAgainstLifecycle } from '../lib/graph.js'
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
      // Validate type. Unknown type is a runtime/bad-value error → exit 1.
      const domain = getDomainForType(type)
      if (!domain) {
        die(runtimeError(`Unknown entity type: "${type}". Use a valid UPG type (e.g. persona, job, feature).`))
      }

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
        try { node.properties = JSON.parse(opts.data) } catch {
          store.stopWatching()
          die(runtimeError('Invalid --data JSON'))
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
        const edgeType = inferEdgeType(parent.type, type)
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
