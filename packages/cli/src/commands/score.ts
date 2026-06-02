import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { scoreEntity } from '@unified-product-graph/sdk'
import { EXIT, die, violation, usageError } from '../lib/errors.js'

export const scoreCommand = new Command('score')
  .arguments('<exercise-id> <entity-id>')
  .description("Record a framework's result for one entity on the exercise's includes edge.")
  .option('--file <path>', 'Path to .upg file')
  .requiredOption('--data <json>', 'Result as JSON, e.g. \'{"moscow":"must"}\' or \'{"reach":800,"impact":3}\'')
  .option('--replace', 'Replace the edge properties instead of merging into them')
  .option('--json', 'Machine-readable JSON output')
  .action(async (exerciseId, entityId, opts) => {
    try {
      let values: Record<string, unknown>
      try {
        values = JSON.parse(opts.data)
      } catch {
        die(usageError(`--data must be valid JSON. Got: ${opts.data}`))
      }
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        die(usageError('--data must be a JSON object of property → value, e.g. \'{"moscow":"must"}\''))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const result = scoreEntity(store, {
        exercise_id: exerciseId,
        entity_id: entityId,
        values,
        replace: opts.replace,
      })
      if ('error' in result) {
        store.stopWatching()
        die(violation(result.error))
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        process.stderr.write(`Scored ${entityId} in exercise ${exerciseId}.\n`)
        for (const w of result.warnings) process.stderr.write(`  warning: ${w}\n`)
        process.stdout.write(result.edge.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
