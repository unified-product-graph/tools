import { Command } from 'commander'
import { discoverUPGFile, loadStore, validateStatusAgainstLifecycle, validateTitle, parseDataOption } from '../lib/graph.js'
import { EXIT, die, violation, runtimeError } from '../lib/errors.js'

export const updateCommand = new Command('update')
  .arguments('<id>')
  .description('Update an entity. Unspecified fields are preserved.')
  .option('--file <path>', 'Path to .upg file')
  .option('--title <title>', 'New title')
  .option('--description <desc>', 'New description')
  .option('--status <status>', 'New status')
  .option('--tags <list>', 'Comma-separated tags. Replaces existing', (v) => v.split(','))
  .option('--data <json>', 'Type-specific fields as JSON. Merged into existing')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node = store.getNode(id)
      if (!node) {
        store.stopWatching()
        die(runtimeError(`Node not found: ${id}`))
      }

      // Validate --status against the lifecycle for THIS node's type before
      // writing — the writer must not be more permissive than the reader
      // (CLI-FEEDBACK #4).
      if (opts.status) {
        const warning = validateStatusAgainstLifecycle(node.type, opts.status)
        if (warning) { store.stopWatching(); die(violation(warning)) }
      }

      // A provided --title must not blank out the node ( / F1+F10).
      if (opts.title !== undefined) {
        const titleError = validateTitle(opts.title)
        if (titleError) { store.stopWatching(); die(violation(titleError)) }
      }

      const patch: Record<string, unknown> = {}
      if (opts.title) patch.title = opts.title
      if (opts.description) patch.description = opts.description
      if (opts.status) patch.status = opts.status
      if (opts.tags) patch.tags = opts.tags
      if (opts.data) {
        // Bad/oversized --data is a usage error (exit 3), unified across
        // create/update/score ( D2 / E5).
        try {
          patch.properties = parseDataOption(opts.data)
        } catch (err) {
          store.stopWatching()
          die(err)
        }
      }

      const updated = store.updateNode(id, patch)
      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify({ node: updated }, null, 2) + '\n')
      } else {
        // Human line to stderr (chrome); the id stays on stdout for scripts.
        process.stderr.write(`Updated: ${updated.type} "${updated.title}"\n`)
        process.stdout.write(updated.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
