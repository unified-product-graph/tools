import { Command } from 'commander'
import { discoverUPGFile, loadStore, parseDataOption, validateScoreData } from '../lib/graph.js'
import { scoreEntity } from '@unified-product-graph/sdk'
import { EXIT, die, violation } from '../lib/errors.js'

export const scoreCommand = new Command('score')
  .arguments('<exercise-id> <entity-id>')
  .description("Record a framework's result for one entity on the exercise's includes edge.")
  .option('--file <path>', 'Path to .upg file')
  .requiredOption('--data <json>', 'Result as JSON, e.g. \'{"moscow":"must"}\' or \'{"reach":4,"impact":3,"confidence":4,"effort":2}\'')
  .option('--replace', 'Replace the edge properties instead of merging into them')
  .option('--json', 'Machine-readable JSON output')
  .action(async (exerciseId, entityId, opts) => {
    try {
      // Bad/oversized/non-object --data is a usage error (exit 3) with the SAME
      // message and code as create/update ( D2 / E5 / b).
      // parseDataOption now enforces the plain-object shape at the shared parse
      // point, so a stray array/primitive/null never reaches here.
      const values = parseDataOption(opts.data)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      //: validate the result payload against the exercise's framework
      // BEFORE writing. The SDK only warns (storage stays permissive), so the
      // CLI is the gate that REJECTS an invalid bucket, a value off the wrong
      // schema, a non-numeric/out-of-range score, or effort:0. Resolve the
      // framework the same way `apply`/the SDK do — the framework_id stamped on
      // the exercise node — and the scored entity's type for the right slot.
      const exerciseNode = store.getNode(exerciseId)
      const frameworkId = (exerciseNode?.properties as { framework_id?: string } | undefined)
        ?.framework_id
      const entityType = store.getNode(entityId)?.type
      const problems = validateScoreData(frameworkId, entityType, values)
      if (problems.length > 0) {
        store.stopWatching()
        die(
          violation(
            `Invalid --data for ${frameworkId ?? 'this'} exercise:\n` +
              problems.map((p) => `  - ${p}`).join('\n'),
          ),
        )
      }

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
