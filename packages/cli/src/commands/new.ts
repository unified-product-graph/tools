/**
 * `upg new <type> <title>` — create a node AND auto-link it to where the cursor
 * stands, edge + direction inferred (CLI-DESIGN-SPEC §2, Move 2; §3).
 *
 * No `--parent`, no `--edge-type`: the cursor is one end of the edge, the new
 * node is the other, and the catalog decides the relationship + direction. We
 * always SHOW what was inferred. On a genuinely ambiguous pair we prompt for a
 * VERB on a TTY, or refuse to guess on a pipe (require `--as <verb|n>`).
 *
 * The new node becomes the cursor (depth-first authoring). With no cursor set,
 * `new` just creates an anchor and parks the cursor on it.
 *
 * `<type>` is REQUIRED in this wave; type-optional inference (`sort`) is a later
 * wave (noted in the report).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { select } from '@inquirer/prompts'
import { getDomainForType, type UPGBaseNode, type UPGEdgeType } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore, nodeId, edgeId, validateTitle } from '../lib/graph.js'
import { allEdgesForCli } from '../lib/schema-facade.js'
import { resolveCursor } from '../lib/cursor.js'
import { writeSession } from '../lib/session.js'
import { inferEdge, chooseEdge, edgeVerb, candidateMenu } from '../lib/inference.js'
import { EXIT, die, violation, usageError } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'

export const newCommand = new Command('new')
  .arguments('<type> <title>')
  .description('Create a node and auto-link it to the cursor (edge + direction inferred).')
  .option('--file <path>', 'Path to .upg file')
  .option('--at <id>', 'Link to this node instead of the cursor (stateless)')
  .option('--as <verb|n>', 'Pick the relationship on an ambiguous pair (verb or 1-based index)')
  .option('--status <status>', 'Lifecycle status')
  .option('--json', 'Machine-readable JSON output')
  .action(async (type, title, opts) => {
    try {
      // Validate the type up front. An unknown entity type is a validation/
      // policy problem (exit 2), matching `create` ( D2).
      if (!getDomainForType(type)) {
        die(violation(`Unknown entity type: "${type}". Use a valid UPG type (e.g. persona, job, feature).`))
      }

      // Reject blank titles at the write boundary ( / F1+F10), same as `create`.
      const titleError = validateTitle(title)
      if (titleError) die(violation(titleError))

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const anchor = resolveCursor(store, filePath, opts.at)

      // Resolve linkage BEFORE creating, so a cancelled prompt never leaves an
      // orphan node behind.
      let chosenEdge: UPGEdgeType | undefined
      let flipped = false
      const inf = anchor ? inferEdge(anchor.type, type, allEdgesForCli) : null

      if (anchor && inf) {
        flipped = inf.flipped
        const result = await chooseEdge(inf.candidates, {
          as: opts.as,
          isTTY: isTTY() && Boolean(process.stdin.isTTY),
          prompt: async (cands) =>
            select<string>({
              message: `How does ${inf.sourceType} relate to ${inf.targetType}?`,
              choices: cands.map((t, i) => ({ name: `${edgeVerb(t)}  (${t})`, value: String(i + 1) })),
            }).catch(() => undefined),
        })
        switch (result.kind) {
          case 'chosen':
            chosenEdge = result.type
            break
          case 'ambiguous-non-tty':
            store.stopWatching()
            process.stderr.write(
              `${result.candidates.length} ways to relate ${inf.sourceType} → ${inf.targetType}; refusing to guess on a pipe.\n` +
                candidateMenu(result.candidates) + '\n  re-run with --as <verb|number>\n',
            )
            process.exit(EXIT.USAGE)
            break
          case 'bad-selection':
            store.stopWatching()
            die(usageError(`--as "${result.selection}" matched none of: ${result.candidates.map(edgeVerb).join(', ')}`))
            break
          case 'cancelled':
            store.stopWatching()
            process.stderr.write('cancelled; nothing created\n')
            process.exit(EXIT.OK)
        }
      }

      // Create the node.
      const node: UPGBaseNode = { id: nodeId(), type, title }
      if (opts.status) node.status = opts.status
      store.addNode(node)

      // Link it (when we have an anchor + a canonical edge).
      let edge: { id: string; source: string; target: string; type: UPGEdgeType } | undefined
      if (anchor && inf && chosenEdge) {
        const [src, tgt] = flipped ? [node.id, anchor.id] : [anchor.id, node.id]
        edge = { id: edgeId(), source: src, target: tgt, type: chosenEdge }
        store.addEdge(edge)
      }

      await store.flush()
      store.stopWatching()

      // The new node becomes the cursor.
      writeSession(filePath, { cursor: node.id })

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              node,
              edge: edge ?? null,
              inferred: edge ? { verb: edgeVerb(edge.type), edge_type: edge.type, flipped } : null,
            },
            null,
            2,
          ) + '\n',
        )
        process.exit(EXIT.OK)
      }

      if (!anchor) {
        process.stderr.write(`✓ ${chalk.bold(type)} "${title}" created ${chalk.dim('(no cursor; this is now your anchor)')}\n`)
      } else if (!inf) {
        process.stderr.write(`✓ ${chalk.bold(type)} "${title}" created. ${chalk.yellow(`(no canonical edge to ${anchor.type}; left unlinked)`)}\n`)
      } else if (edge) {
        const rel = flipped
          ? `${type} ${chalk.green('—' + edgeVerb(edge.type) + '→')} ${anchor.type}`
          : `${anchor.type} ${chalk.green('—' + edgeVerb(edge.type) + '→')} ${type}`
        process.stderr.write(`✓ ${chalk.bold(type)} ${chalk.cyan(`"${title}"`)} created and linked: ${rel}\n`)
        if (flipped) process.stderr.write(chalk.dim('   (linked in the canonical direction)\n'))
      }
      process.stdout.write(node.id + '\n')
      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
