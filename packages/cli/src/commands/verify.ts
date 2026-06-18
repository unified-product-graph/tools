import { Command } from 'commander'
import { validateUPGDocument, CONTENT_DEPTH_WARNING_RULES } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore, computeGraphDigest, getOrphans, BUSINESS_AREAS, boundedFloat } from '../lib/graph.js'
import { EXIT, die, violation } from '../lib/errors.js'

export const verifyCommand = new Command('verify')
  .description('Structural validation. Exits 2 on violations for CI gates.')
  .option('--file <path>', 'Path to .upg file')
  .option('--no-orphans', 'Fail when orphan entities exist')
  .option('--no-broken-chains', 'Fail when any chain is incomplete')
  .option('--no-content-depth', 'Skip property-type, enum, and self-loop checks')
  // (a): a finite number in [0,1]. A bare `parseFloat` here let garbage
  // ("abc", "", "99", "Infinity") through as NaN, and `rate > NaN` is always
  // false, so a 100%-orphan graph PASSED the gate. boundedFloat rejects those
  // with a usage error (exit 3) at parse time.
  .option('--max-orphan-rate <n>', 'Maximum orphan rate, 0.0-1.0', boundedFloat(0, 1, '--max-orphan-rate'))
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

      // Structural validity. The SDK load path is now permissive (/629):
      // it records content-invalidity on the integrity report instead of
      // throwing, so reads and the delete/update that repairs a graph keep
      // working. `verify` must therefore surface those recorded errors itself. A
      // dangling edge, a missing node field, or a whitespace-only title lands in
      // `validation.errors` and is a policy violation (exit 2), restoring the
      // behaviour that used to come from load throwing "Invalid UPG document".
      const validation = validateUPGDocument(store.getDocument())
      if (validation.errors.length > 0) {
        const examples = validation.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ')
        const more = validation.errors.length > 3 ? ` (+${validation.errors.length - 3} more)` : ''
        violations.push({
          rule: 'invalid-document',
          message: `${validation.errors.length} document validation error(s). ${examples}${more}`,
        })
      }

      // Commander 13 stores a `--no-X` negation under `opts.x` (default true,
      // false when the flag is passed), NOT `opts.noX`. Reading `opts.noOrphans`
      // here always saw `undefined`, so `--no-orphans` — the documented CI gate —
      // was a silently dead flag (a 100%-orphan graph still exited 0). Match the
      // working `opts.contentDepth` pattern below. (UPG / adopt-qa P0-1)
      if (opts.orphans === false && orphans.length > 0) {
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

      // Same Commander 13 negation bug as --no-orphans above: read opts.brokenChains,
      // not opts.noBrokenChains, or this CI gate is silently dead. (adopt-qa P0-2)
      if (opts.brokenChains === false) {
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

      // Content-depth checks: property TYPE, property ENUM, and
      // self-loop edges. These are surfaced by the spec validator as WARNINGS
      // (never errors) so a drifted-but-readable graph still loads. `verify`
      // re-runs the validator on the loaded document and re-classifies the
      // tagged warnings as policy violations, so a CI gate fails (exit 2)
      // without the parser ever refusing to read the file.
      if (opts.contentDepth !== false) {
        const depthFindings = validation.warnings.filter(
          (w) => w.rule !== undefined && CONTENT_DEPTH_WARNING_RULES.has(w.rule),
        )
        // Aggregate per rule so one violation line summarises N findings, with
        // a few concrete examples, instead of flooding the output.
        const byRule = new Map<string, typeof depthFindings>()
        for (const f of depthFindings) {
          const list = byRule.get(f.rule as string) ?? []
          list.push(f)
          byRule.set(f.rule as string, list)
        }
        const RULE_LABEL: Record<string, string> = {
          'property-type': 'Property type mismatch',
          'property-enum': 'Property value outside its allowed set',
          'self-loop': 'Self-loop edge (source === target)',
        }
        for (const [rule, findings] of byRule) {
          const examples = findings
            .slice(0, 3)
            .map((f) => `${f.path}: ${f.message}`)
            .join('; ')
          const more = findings.length > 3 ? ` (+${findings.length - 3} more)` : ''
          violations.push({
            rule,
            message: `${RULE_LABEL[rule] ?? rule}: ${findings.length} finding(s). ${examples}${more}`,
          })
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

      // Violation = exit 2 (policy), matching the published exit-code table
      // and the help text. Previously this exited 1, contradicting the docs
      // (CLI-FEEDBACK #2).
      process.exit(passed ? EXIT.OK : EXIT.VIOLATION)
    } catch (err) {
      // A structurally invalid document (dangling edge, bad type) is itself a
      // validation violation → exit 2. Any other load failure (missing file,
      // unreadable path) is a runtime error → exit 1 (CLI-FEEDBACK #2/#6).
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('Invalid UPG document')) die(violation(msg))
      die(err)
    }
  })
