import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { applyFramework } from '@unified-product-graph/sdk'
import { EXIT, die, violation } from '../lib/errors.js'

export const applyCommand = new Command('apply')
  .arguments('<framework-id> [entity-ids...]')
  .description('Apply a framework to entities: creates a framework_exercise + an includes edge to each.')
  .option('--file <path>', 'Path to .upg file')
  .option('--title <title>', 'Human label for the exercise')
  .option('--status <status>', 'Lifecycle phase: draft | active | archived (default draft)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (frameworkId, entityIds: string[], opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let result
      try {
        result = applyFramework(store, {
          framework_id: frameworkId,
          title: opts.title,
          entity_ids: entityIds ?? [],
          status: opts.status,
        })
      } catch (err) {
        // Unknown framework / invalid input is a policy problem → exit 2.
        store.stopWatching()
        die(violation(err instanceof Error ? err.message : String(err)))
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        const n = result.edges.length
        process.stderr.write(
          `Applied ${frameworkId}: exercise "${result.exercise.title}" includes ${n} entit${n === 1 ? 'y' : 'ies'}.\n`,
        )
        for (const w of result.warnings) process.stderr.write(`  warning: ${w}\n`)
        process.stdout.write(result.exercise.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
