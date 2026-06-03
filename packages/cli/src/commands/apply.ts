import { Command } from 'commander'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { applyFramework, applyFrameworkEnvelope } from '@unified-product-graph/sdk'
import { EXIT, die, violation } from '../lib/errors.js'

export const applyCommand = new Command('apply')
  .arguments('<framework-id> [entity-ids...]')
  .description(
    'Apply a framework to entities: creates a framework_exercise + an includes edge to each. ' +
      'An entity may carry its slot role inline as `id:role` (e.g. feat_x:pain_reliever).',
  )
  .option('--file <path>', 'Path to .upg file')
  .option('--title <title>', 'Human label for the exercise')
  .option('--status <status>', 'Lifecycle phase: draft | active | archived (default draft)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (frameworkId, entityIds: string[], opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      // Phase 3b-2: each entity arg is `id` or `id:slot_role` (UPG ids have no
      // colon), e.g. `apply value-proposition-canvas feat_x:pain_reliever`.
      const ids: string[] = []
      const slotRoles: Record<string, string> = {}
      for (const raw of entityIds ?? []) {
        const idx = raw.indexOf(':')
        if (idx > 0) {
          const id = raw.slice(0, idx)
          const role = raw.slice(idx + 1)
          ids.push(id)
          if (role) slotRoles[id] = role
        } else {
          ids.push(raw)
        }
      }

      let result
      try {
        result = applyFramework(store, {
          framework_id: frameworkId,
          title: opts.title,
          entity_ids: ids,
          slot_roles: Object.keys(slotRoles).length > 0 ? slotRoles : undefined,
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
        // Shared cross-surface envelope: identical to MCP apply_framework.
        process.stdout.write(JSON.stringify(applyFrameworkEnvelope(result), null, 2) + '\n')
      } else {
        const n = result.edges.length
        process.stderr.write(
          `Applied ${frameworkId}: exercise "${sanitizeForTerminal(result.exercise.title)}" includes ${n} entit${n === 1 ? 'y' : 'ies'}.\n`,
        )
        for (const w of result.warnings) process.stderr.write(`  warning: ${w}\n`)
        process.stdout.write(result.exercise.id + '\n')
      }
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
