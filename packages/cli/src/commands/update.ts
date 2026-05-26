import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'

export const updateCommand = new Command('update')
  .arguments('<id>')
  .description('Update an entity. Unspecified fields are preserved.')
  .option('--file <path>', 'Path to .upg file')
  .option('--title <title>', 'New title')
  .option('--description <desc>', 'New description')
  .option('--status <status>', 'New status')
  .option('--tags <list>', 'Comma-separated tags. Replaces existing', (v) => v.split(','))
  .option('--data <json>', 'Type-specific fields as JSON. Merged into existing')
  .action(async (id, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node = store.getNode(id)
      if (!node) {
        console.error(`Node not found: ${id}`)
        process.exit(1)
      }

      const patch: Record<string, unknown> = {}
      if (opts.title) patch.title = opts.title
      if (opts.description) patch.description = opts.description
      if (opts.status) patch.status = opts.status
      if (opts.tags) patch.tags = opts.tags
      if (opts.data) {
        try { patch.properties = JSON.parse(opts.data) } catch {
          console.error('Invalid --data JSON'); process.exit(1)
        }
      }

      const updated = store.updateNode(id, patch)
      await store.flush()
      store.stopWatching()

      console.log(`Updated: ${updated.type} "${updated.title}"`)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
