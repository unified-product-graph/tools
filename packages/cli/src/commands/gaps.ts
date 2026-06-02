import { Command } from 'commander'
import { discoverUPGFile, loadStore, computeGraphDigest, BUSINESS_AREAS } from '../lib/graph.js'
import { upgHeader } from '../lib/formatter.js'
import { die } from '../lib/errors.js'

export const gapsCommand = new Command('gaps')
  .description('Report empty domains, broken chains, and sparse areas.')
  .option('--file <path>', 'Path to .upg file')
  .option('--domain <domain>', 'Focus on a specific domain')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const digest = computeGraphDigest(store)

      store.stopWatching()

      const gaps: Array<{ domain: string; type: string; suggestion: string }> = []

      for (const [domain, cov] of Object.entries(digest.coverage)) {
        if (opts.domain && opts.domain !== domain) continue
        if (!('types_missing' in cov)) continue // skip stage_summary (not a region)
        for (const type of cov.types_missing) {
          gaps.push({ domain, type, suggestion: `Add a ${type} entity to grow coverage in this domain` })
        }
      }

      // Chain gaps
      const chainGaps: Array<{ chain: string; connected: number; total: number }> = []
      const chainPairs: Array<[string, number, number]> = [
        ['persona → job', digest.chains.persona_with_job, digest.chains.persona_total],
        ['job → need', digest.chains.job_with_need, digest.chains.job_total],
        ['opportunity → solution', digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
        ['hypothesis → experiment', digest.chains.hypothesis_total - digest.chains.hypothesis_untested, digest.chains.hypothesis_total],
        ['experiment → learning', digest.chains.experiment_with_learning, digest.chains.experiment_total],
      ]
      for (const [name, connected, total] of chainPairs) {
        if (total > 0 && connected < total) {
          chainGaps.push({ chain: name, connected, total })
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ domain_gaps: gaps, chain_gaps: chainGaps }, null, 2))
        return
      }

      console.log(upgHeader('Gaps'))

      if (gaps.length === 0 && chainGaps.length === 0) {
        console.log('No significant gaps found.')
        return
      }

      if (gaps.length > 0) {
        console.log(`\nMissing entity types (${gaps.length}):\n`)
        let lastDomain = ''
        for (const g of gaps) {
          if (g.domain !== lastDomain) {
            console.log(`  ${BUSINESS_AREAS[g.domain]?.emoji ?? '?'} ${g.domain}:`)
            lastDomain = g.domain
          }
          console.log(`    - ${g.type}`)
        }
      }

      if (chainGaps.length > 0) {
        console.log(`\nBroken chains (${chainGaps.length}):\n`)
        for (const g of chainGaps) {
          console.log(`  ✗ ${g.chain}: ${g.connected}/${g.total} connected`)
        }
      }

      console.log()
    } catch (err) {
      die(err)
    }
  })
