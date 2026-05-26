import { Command } from 'commander'
import { discoverUPGFile, loadStore, computeGraphDigest, getOrphans, BUSINESS_AREAS } from '../lib/graph.js'

export const verifyCommand = new Command('verify')
  .description('Structural validation. Exits 1 on violations for CI gates.')
  .option('--file <path>', 'Path to .upg file')
  .option('--no-orphans', 'Fail when orphan entities exist')
  .option('--no-broken-chains', 'Fail when any chain is incomplete')
  .option('--max-orphan-rate <n>', 'Maximum orphan rate, 0.0–1.0', parseFloat)
  .option('--require-domains <list>', 'Comma-separated domains that must hold entities', (v) => v.split(','))
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const digest = computeGraphDigest(store)
      const orphans = getOrphans(store)
      const orphanRate = digest.health.orphan_rate

      const violations: Array<{ rule: string; message: string }> = []

      if (opts.noOrphans === false && orphans.length > 0) {
        violations.push({
          rule: 'no-orphans',
          message: `${orphans.length} orphan entities found (${Math.round(orphanRate * 100)}% of graph)`,
        })
      }

      if (opts.maxOrphanRate !== undefined && orphanRate > opts.maxOrphanRate) {
        violations.push({
          rule: 'max-orphan-rate',
          message: `Orphan rate ${Math.round(orphanRate * 100)}% exceeds maximum ${Math.round(opts.maxOrphanRate * 100)}%`,
        })
      }

      if (opts.noBrokenChains === false) {
        const chainPairs: Array<[string, number, number]> = [
          ['persona → job', digest.chains.persona_with_job, digest.chains.persona_total],
          ['job → need', digest.chains.job_with_need, digest.chains.job_total],
          ['opportunity → solution', digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
        ]
        for (const [name, connected, total] of chainPairs) {
          if (total > 0 && connected < total) {
            violations.push({ rule: 'no-broken-chains', message: `Chain "${name}": ${connected}/${total} connected` })
          }
        }
      }

      if (opts.requireDomains) {
        for (const domain of opts.requireDomains) {
          const cov = digest.coverage[domain]
          if (!cov) {
            violations.push({ rule: 'require-domains', message: `Unknown domain: "${domain}"` })
          } else if (cov.covered === 0) {
            violations.push({ rule: 'require-domains', message: `Domain "${domain}" has no entities` })
          }
        }
      }

      const passed = violations.length === 0

      store.stopWatching()

      if (opts.json) {
        console.log(JSON.stringify({ passed, violations }, null, 2))
      } else if (passed) {
        console.log('✓ All checks passed')
      } else {
        console.log(`✗ ${violations.length} violation(s) found:\n`)
        for (const v of violations) {
          console.log(`  ✗ [${v.rule}] ${v.message}`)
        }
        console.log()
      }

      process.exit(passed ? 0 : 1)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
