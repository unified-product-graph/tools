/**
 * `helm report`: graph health + structural diagnostics.
 *
 * Showcases:
 *   - upg.health()                 : single call returns score + rich digest
 *   - upg.verify()                 : integrity report (or null when clean)
 *   - upg.nodes.list()             : type-filtered read for "top N" surfaces
 *
 * Read-only; no flush, no disk writes. Cheap to call from a cron job, a
 * Slack bot, or a CI status check.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getClient } from '../upg.js'

export const reportCommand = new Command('report')
  .description('Print a health + structure report for the product graph.')
  .action(async (_opts, cmd) => {
    const file = cmd.parent?.opts().file as string | undefined
    const upg = getClient(file)

    const { score, digest } = await upg.health()
    const integrity = await upg.verify()
    const features = await upg.nodes.list({ type: 'feature' })

    // ── Header ───────────────────────────────────────────────────────────
    console.log()
    console.log(chalk.bold('🩺 Product graph report'))
    console.log(chalk.dim('─'.repeat(48)))

    // ── Health score ─────────────────────────────────────────────────────
    const scoreColor = score >= 70 ? chalk.green : score >= 40 ? chalk.yellow : chalk.red
    console.log(`  Health:    ${scoreColor(score + '/100')}`)
    console.log(`  Nodes:     ${digest.counts.total_nodes}`)
    console.log(`  Edges:     ${digest.counts.total_edges}`)
    console.log(`  Orphans:   ${digest.health.orphan_count}`)
    console.log(`  Features:  ${features.nodes.length}`)

    // ── Integrity check ──────────────────────────────────────────────────
    if (integrity === null) {
      console.log(`  Integrity: ${chalk.green('✓ clean')}`)
    } else {
      console.log(`  Integrity: ${chalk.yellow('⚠ issues detected')}`)
    }

    // ── Business-area coverage ───────────────────────────────────────────
    // digest.coverage is keyed by business-area id; skip the special
    // `stage_summary` key which carries a different shape.
    const coverageEntries = Object.entries(digest.coverage).filter(
      ([k]) => k !== 'stage_summary',
    )
    if (coverageEntries.length > 0) {
      console.log()
      console.log(chalk.bold('Coverage by business area'))
      for (const [area, region] of coverageEntries) {
        const count =
          region && typeof region === 'object' && 'count' in region
            ? Number((region as { count: number }).count)
            : 0
        const bar = '█'.repeat(Math.min(20, count))
        console.log(`  ${chalk.dim(area.padEnd(18))} ${chalk.cyan(bar)} ${count}`)
      }
    }

    // ── Top features (illustrates list + filter) ─────────────────────────
    if (features.nodes.length > 0) {
      console.log()
      console.log(chalk.bold('Features'))
      for (const f of features.nodes.slice(0, 5) as Array<{ title?: string }>) {
        console.log(`  ${chalk.dim('•')} ${f.title ?? '(untitled)'}`)
      }
      if (features.nodes.length > 5) {
        console.log(chalk.dim(`  … and ${features.nodes.length - 5} more`))
      }
    }

    console.log()
  })
