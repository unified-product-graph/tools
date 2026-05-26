/**
 * `helm connect <feature> <job>` — link a feature to the job it addresses.
 *
 * Showcases:
 *   - upg.search()                — type-narrowed read with limit
 *   - parallel reads via Promise.all
 *   - upg.edges.connect()         — edge type inference from source + target
 *
 * The user types human-readable names; Helm resolves them to IDs and lets
 * the SDK infer the edge type. For (feature → job) the SDK picks the
 * canonical `feature_addresses_job` out of 800+ catalog entries with no
 * lookup at the call site.
 *
 * Try (against the bundled demo.upg):
 *   helm connect "Saved searches" "Discover unique"
 *   helm connect "Dark mode" "Discover unique" --source-type feature --target-type job
 *
 * Pass --source-type / --target-type to connect any two node kinds —
 * the SDK will infer the right edge or fail with a clear "no canonical
 * edge" error if the pair isn't in the catalog.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getClient } from '../upg.js'

export const connectCommand = new Command('connect')
  .description('Connect a feature to the job it addresses (or any two nodes by name).')
  .argument('<feature>', 'Feature title (or any source node title)')
  .argument('<job>', 'Job title (or any target node title)')
  .option('--source-type <type>', 'Restrict source search to this type', 'feature')
  .option('--target-type <type>', 'Restrict target search to this type', 'job')
  .action(async (
    featureTitle: string,
    personaTitle: string,
    opts: { sourceType: string; targetType: string },
    cmd,
  ) => {
    const file = cmd.parent?.opts().file as string | undefined
    const upg = getClient(file)

    // Two reads in parallel. Reads don't mutate the store, so this is safe.
    const [features, personas] = await Promise.all([
      upg.search(featureTitle, { type: opts.sourceType, limit: 1 }),
      upg.search(personaTitle, { type: opts.targetType, limit: 1 }),
    ])

    if (features.length === 0) {
      console.error(chalk.red('✗'), `No ${opts.sourceType} found matching`, chalk.bold(featureTitle))
      process.exit(1)
    }
    if (personas.length === 0) {
      console.error(chalk.red('✗'), `No ${opts.targetType} found matching`, chalk.bold(personaTitle))
      process.exit(1)
    }

    // SearchResult is { node, score, match_field } — node is the real entity.
    const source = features[0].node
    const target = personas[0].node

    // No `type` passed to connect() — the SDK consults UPG_EDGE_CATALOG and
    // picks the canonical edge type for (source.type → target.type).
    // For (feature → persona) that's `feature_targets_persona`.
    const result = await upg.edges.connect(source.id, target.id)

    if ('error' in result) {
      console.error(chalk.red('✗'), result.error)
      process.exit(1)
    }

    console.log(chalk.green('✓'), 'Connected')
    console.log(chalk.dim(`  ${source.title}`), chalk.cyan('→'), chalk.dim(target.title))
    console.log(chalk.dim(`  via:  ${result.edge.type}`))
    if (result.warning) {
      console.log(chalk.yellow('  ⚠'), chalk.dim(result.warning))
    }
  })
