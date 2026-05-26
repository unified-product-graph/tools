import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'node:fs'
import { discoverUPGFile, loadStore, computeGraphDigest, computeHealthScore, BUSINESS_AREAS } from '../lib/graph.js'
import { scoreBar, scoreColor, success, fail, label, upgHeader } from '../lib/formatter.js'
import type { UPGFileStore } from '../lib/graph.js'
import type { GraphDigest } from '../lib/graph.js'

function renderDashboard(digest: GraphDigest, score: number) {
  const domainsCovered = Object.values(digest.coverage).filter((c) => 'covered' in c && c.covered > 0).length

  console.log(upgHeader('Health'))
  console.log(`  ${chalk.bold('Score')}  ${scoreColor(score)}/100  ${scoreBar(score)}`)
  console.log()
  console.log(`  ${label('Product')}   ${chalk.white(digest.product.title)}`)
  console.log(`  ${label('Nodes')}     ${chalk.bold(String(digest.counts.total_nodes))}  ${label('Edges')}  ${chalk.bold(String(digest.counts.total_edges))}`)
  console.log(`  ${label('Orphans')}   ${digest.health.orphan_count} ${label(`(${Math.round(digest.health.orphan_rate * 100)}%)`)}`)
  console.log(`  ${label('Domains')}   ${domainsCovered}/${Object.keys(BUSINESS_AREAS).length}`)
  console.log(`  ${label('Validate')}  ${Math.round(digest.health.validation_rate * 100)}%`)
  console.log()

  console.log(`  ${chalk.bold('Domains')}`)
  for (const [domain, cov] of Object.entries(digest.coverage)) {
    if (!('covered' in cov)) continue // skip stage_summary (not a region)
    const emoji = BUSINESS_AREAS[domain]?.emoji ?? '?'
    if (cov.covered > 0) {
      console.log(`  ${success(`${emoji} ${domain}`)}  ${chalk.dim(cov.types_present.join(', '))}`)
    } else {
      console.log(`  ${fail(`${emoji} ${domain}`)}  ${chalk.dim('(empty)')}`)
    }
  }
  console.log()

  console.log(`  ${chalk.bold('Chains')}`)
  const chainPairs: Array<[string, number, number]> = [
    ['persona → job', digest.chains.persona_with_job, digest.chains.persona_total],
    ['job → need', digest.chains.job_with_need, digest.chains.job_total],
    ['opportunity → solution', digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
    ['hypothesis → experiment', digest.chains.hypothesis_total - digest.chains.hypothesis_untested, digest.chains.hypothesis_total],
    ['experiment → learning', digest.chains.experiment_with_learning, digest.chains.experiment_total],
  ]
  for (const [name, connected, total] of chainPairs) {
    if (total === 0) continue
    if (connected === total) {
      console.log(`  ${success(name)}  ${chalk.dim(`${connected}/${total}`)}`)
    } else {
      console.log(`  ${fail(name)}  ${chalk.dim(`${connected}/${total}`)}`)
    }
  }
  console.log()
}

export const healthCommand = new Command('health')
  .description('Score the graph 0–100. Gate CI with --min-score.')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .option('--min-score <n>', 'Exit 1 if score is below this threshold', parseInt)
  .option('--format <fmt>', 'text | badge. Defaults to text')
  .option('--watch', 'Live dashboard. Re-renders when the .upg file changes')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const digest = computeGraphDigest(store)
      const score = computeHealthScore(digest)

      if (opts.json) {
        console.log(JSON.stringify({ score, ...digest }, null, 2))
        store.stopWatching()
      } else if (opts.format === 'badge') {
        const color = score >= 70 ? 'brightgreen' : score >= 40 ? 'yellow' : 'red'
        const badge = `![UPG Health](https://img.shields.io/badge/UPG_Health-${score}%25-${color})`
        console.log()
        console.log(chalk.dim('  Badge markdown (paste into README):'))
        console.log()
        console.log(`  ${badge}`)
        console.log()
        store.stopWatching()
      } else if (opts.watch) {
        // Watch mode: re-render on file change
        renderDashboard(digest, score)
        console.log(chalk.dim('  Watching for changes... (Ctrl+C to stop)\n'))

        fs.watchFile(filePath, { interval: 1000 }, async () => {
          try {
            const freshStore = await loadStore(filePath)
            const freshDigest = computeGraphDigest(freshStore)
            const freshScore = computeHealthScore(freshDigest)
            freshStore.stopWatching()

            process.stdout.write('\x1B[2J\x1B[0f')  // clear screen
            renderDashboard(freshDigest, freshScore)
            console.log(chalk.dim(`  Updated at ${new Date().toLocaleTimeString()}. Watching... (Ctrl+C to stop)\n`))
          } catch { /* file might be mid-write */ }
        })

        store.stopWatching()
        // Keep process alive
        await new Promise(() => {})
      } else {
        renderDashboard(digest, score)
        store.stopWatching()
      }

      if (opts.minScore !== undefined && score < opts.minScore) {
        if (!opts.json) {
          console.error(chalk.red(`  Health score ${score} is below minimum ${opts.minScore}\n`))
        }
        process.exit(1)
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message))
      process.exit(2)
    }
  })
