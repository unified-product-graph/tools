/**
 * `upg link <a> <b>` — connect two existing nodes; edge type + direction
 * inferred, auto-flipped to the canonical orientation (CLI-DESIGN-SPEC §2,
 * Move 3). Prompts ONLY on genuine ambiguity, offering candidates as VERBS,
 * never edge-type strings. On a non-TTY it refuses to guess (require `--as`,
 * or drop to the explicit Tier-3 `upg connect <src> <tgt> --type <t>`).
 *
 * `<a>` / `<b>` resolve by id or title.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { select } from '@inquirer/prompts'
import type { UPGEdgeType } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore, edgeId } from '../lib/graph.js'
import { allEdgesForCli } from '../lib/schema-facade.js'
import { resolveNodeRef } from '../lib/cursor.js'
import { inferEdge, chooseEdge, edgeVerb, candidateMenu } from '../lib/inference.js'
import { EXIT, die, usageError, violation } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const linkCommand = new Command('link')
  .arguments('<a> <b>')
  .description('Connect two nodes; edge type + direction inferred (auto-flips to canonical).')
  .option('--file <path>', 'Path to .upg file')
  .option('--as <verb|n>', 'Pick the relationship on an ambiguous pair (verb or 1-based index)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (aRef, bRef, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const a = resolveNodeRef(store, aRef)
      const b = resolveNodeRef(store, bRef)
      if (!a || !b) {
        // (c): an unresolvable endpoint is a policy violation (exit 2),
        // matching `connect` and the "no canonical edge" branch below. (A
        // genuinely ambiguous title still surfaces as a usage error via the
        // AmbiguousTitleError thrown inside resolveNodeRef.)
        store.stopWatching()
        die(violation(`Could not resolve ${!a ? `"${aRef}"` : ''}${!a && !b ? ' and ' : ''}${!b ? `"${bRef}"` : ''}.`))
      }

      const inf = inferEdge(a.type, b.type, allEdgesForCli)
      if (!inf) {
        // No canonical edge in either direction — a policy violation, like
        // `connect` on an incompatible pair (exit 2).
        store.stopWatching()
        die(violation(`No canonical edge between ${a.type} and ${b.type}. Reorient, or use \`upg connect\` with an explicit --type.`))
      }

      // Map the canonical (source → target) types back to the resolved nodes.
      const [srcNode, tgtNode] = inf.flipped ? [b, a] : [a, b]

      const result = await chooseEdge(inf.candidates, {
        as: opts.as,
        isTTY: isTTY() && Boolean(process.stdin.isTTY),
        prompt: async (cands) =>
          select<string>({
            message: `How does ${inf.sourceType} relate to ${inf.targetType}?`,
            choices: cands.map((t, i) => ({ name: `${edgeVerb(t)}  (${t})`, value: String(i + 1) })),
          }).catch(() => undefined),
      })

      let chosen: UPGEdgeType
      switch (result.kind) {
        case 'chosen':
          chosen = result.type
          break
        case 'ambiguous-non-tty':
          store.stopWatching()
          process.stderr.write(
            `${result.candidates.length} ways to relate ${inf.sourceType} → ${inf.targetType}; refusing to guess on a pipe.\n` +
              candidateMenu(result.candidates) + '\n  re-run with --as <verb|number>, or use `upg connect --type <t>`\n',
          )
          process.exit(EXIT.USAGE)
          return
        case 'bad-selection':
          store.stopWatching()
          die(usageError(`--as "${result.selection}" matched none of: ${result.candidates.map(edgeVerb).join(', ')}`))
          return
        case 'cancelled':
          store.stopWatching()
          process.stderr.write('cancelled; nothing linked\n')
          process.exit(EXIT.OK)
          return
      }

      const edge = { id: edgeId(), source: srcNode.id, target: tgtNode.id, type: chosen }
      store.addEdge(edge)
      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ edge, inferred: { verb: edgeVerb(chosen), edge_type: chosen, flipped: inf.flipped } }, null, 2) + '\n',
        )
        process.exit(EXIT.OK)
      }

      process.stderr.write(`✓ linked  ${srcNode.type} ${chalk.green('—' + edgeVerb(chosen) + '→')} ${tgtNode.type}\n`)
      if (inf.flipped) {
        process.stderr.write(chalk.dim(`   (you named them ${a.type}-first; flipped to the canonical direction)\n`))
      }
      process.stdout.write(edge.id + '\n')
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
