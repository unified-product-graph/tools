import { Command } from 'commander'
import { discoverUPGFile, loadStore, parseDataOption } from '../lib/graph.js'
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
      // Bad/oversized --data is a usage error (exit 3) with the SAME message
      // and code as create/update ( D2 / E5).
      const parsed = parseDataOption(opts.data)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        die(usageError('--data must be a JSON object of property to value, e.g. \'{"moscow":"must"}\''))
      }
      const values = parsed as Record<string, unknown>

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
