/**
 * `upg dedupe` - find and merge duplicate nodes.
 *
 * Mirrors the MCP `deduplicate_nodes` handler exactly:
 *   - detection: same type + title (case-insensitive, trimmed)
 *   - merge: keep one node per group, redirect all incident edges to the keeper
 *   - --keep newest|oldest  (default: newest, matching MCP default)
 *   - --dry-run             (default ON - preview without writing)
 *   - --apply / --no-dry-run  commit the merge
 *   - --type <type>         scope to one entity type
 *   - --yes / -y            skip the TTY confirmation on --apply
 *   - --json                machine-readable output
 *   - --file <path>         target a specific .upg file
 *
 * Exit codes:
 *   0  success (including "no duplicates found")
 *   1  runtime / operation error
 *   2  policy violation (invalid --keep value)
 *   3  usage error (non-TTY without --yes on a mutating run)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { discoverUPGFile, loadStore, edgeId } from '../lib/graph.js'
import { formatNode, upgHeader, label, success, fail } from '../lib/formatter.js'
import { die, runtimeError, violation, usageError, EXIT } from '../lib/errors.js'
import { isTTY } from '../lib/output.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

// ── types ──────────────────────────────────────────────────────────────────

interface DuplicateGroup {
  title: string
  type: string
  count: number
  ids: string[]
}

// ── detection ──────────────────────────────────────────────────────────────

function detectDuplicates(nodes: UPGBaseNode[]): DuplicateGroup[] {
  const groups = new Map<string, UPGBaseNode[]>()
  for (const n of nodes) {
    const key = `${n.type}::${n.title.toLowerCase().trim()}`
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(n)
  }

  const duplicates: DuplicateGroup[] = []
  for (const [, group] of groups) {
    if (group.length < 2) continue
    duplicates.push({
      title: group[0].title,
      type: group[0].type,
      count: group.length,
      ids: group.map((n) => n.id),
    })
  }
  return duplicates
}

// ── command ────────────────────────────────────────────────────────────────

export const dedupeCommand = new Command('dedupe')
  .description(
    'Find and merge duplicate entities (same type + title, case-insensitive). ' +
    'Default: dry-run preview. Pass --apply (or --no-dry-run) to commit.',
  )
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Scope to one entity type')
  .option(
    '--keep <strategy>',
    'Which duplicate to keep: newest or oldest (default: newest)',
    'newest',
  )
  .option('--dry-run', 'Preview only - do not write (default: on)')
  .option('--apply', 'Commit the merge (equivalent to --no-dry-run)')
  .option('-y, --yes', 'Skip TTY confirmation prompt when --apply is set')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    file?: string
    type?: string
    keep: string
    dryRun?: boolean
    apply?: boolean
    yes?: boolean
    json?: boolean
  }) => {
    try {
      // Validate --keep early, before loading the store.
      const keepStrategy = opts.keep ?? 'newest'
      if (keepStrategy !== 'newest' && keepStrategy !== 'oldest') {
        die(violation(`Invalid --keep value: "${keepStrategy}". Use "newest" or "oldest".`))
      }

      // Resolve dry-run: default ON unless --apply or explicit --no-dry-run.
      // Commander exposes boolean flags as undefined (unset), true (present), or
      // false (--no-<flag> form). --apply is a convenience alias for --no-dry-run.
      const dryRun = opts.apply ? false : (opts.dryRun !== false)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      // Collect nodes, optionally filtered by type.
      let nodes = store.getAllNodes()
      if (opts.type) nodes = nodes.filter((n) => n.type === opts.type)

      const duplicates = detectDuplicates(nodes)

      // ── no duplicates ──────────────────────────────────────────────────

      if (duplicates.length === 0) {
        store.stopWatching()
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ duplicates: [], message: 'No duplicate entities found.' }, null, 2) + '\n',
          )
        } else {
          console.log(upgHeader('Dedupe'))
          console.log(chalk.dim('  No duplicate entities found.'))
          console.log()
        }
        process.exit(EXIT.OK)
      }

      // ── dry-run: report only ───────────────────────────────────────────

      if (dryRun) {
        const totalDuplicateNodes = duplicates.reduce((sum, d) => sum + d.count - 1, 0)
        store.stopWatching()

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                duplicates,
                total_groups: duplicates.length,
                total_duplicate_nodes: totalDuplicateNodes,
                dry_run: true,
                message: `Found ${duplicates.length} group${duplicates.length === 1 ? '' : 's'} of duplicates. Pass --apply to merge.`,
              },
              null,
              2,
            ) + '\n',
          )
        } else {
          console.log(upgHeader('Dedupe - Dry Run'))
          console.log(
            chalk.dim(
              `  ${duplicates.length} duplicate group${duplicates.length === 1 ? '' : 's'} ` +
              `(${totalDuplicateNodes} node${totalDuplicateNodes === 1 ? '' : 's'} to remove). ` +
              `Pass --apply to commit.`,
            ),
          )
          console.log()

          for (const group of duplicates) {
            console.log(
              `  ${chalk.bold(sanitizeForTerminal(group.type))}  ` +
              `"${chalk.white(sanitizeForTerminal(group.title))}"  ` +
              chalk.dim(`(${group.count} copies)`),
            )
            for (const id of group.ids) {
              const n = store.getNode(id)
              if (n) {
                console.log(`    ${chalk.dim(sanitizeForTerminal(id))}  ${formatNode(n)}`)
              } else {
                console.log(`    ${chalk.dim(sanitizeForTerminal(id))}`)
              }
            }
            console.log()
          }

          console.log(label(`  strategy: keep ${sanitizeForTerminal(keepStrategy)}`))
          console.log()
        }
        process.exit(EXIT.OK)
      }

      // ── apply: confirm then merge ──────────────────────────────────────

      const skipConfirm = Boolean(opts.yes)
      const interactive = isTTY() && Boolean(process.stdin.isTTY)

      const totalDuplicateNodes = duplicates.reduce((sum, d) => sum + d.count - 1, 0)

      if (!skipConfirm) {
        if (!interactive) {
          store.stopWatching()
          die(
            usageError(
              `Refusing to merge ${totalDuplicateNodes} node${totalDuplicateNodes === 1 ? '' : 's'} ` +
              `without confirmation in a non-interactive shell. Re-run with --yes (or -y).`,
            ),
          )
        }

        process.stderr.write('\n')
        process.stderr.write(
          `  Will merge ${totalDuplicateNodes} duplicate node${totalDuplicateNodes === 1 ? '' : 's'} ` +
          `across ${duplicates.length} group${duplicates.length === 1 ? '' : 's'} ` +
          `(keep: ${keepStrategy})\n`,
        )
        process.stderr.write('\n')

        const confirmed = await confirm({ message: 'Apply deduplication?' })
        if (!confirmed) {
          process.stderr.write(chalk.dim('  Cancelled.\n'))
          store.stopWatching()
          process.exit(EXIT.OK)
        }
      }

      // Perform the merge, mirroring the MCP handler exactly.
      let nodesRemoved = 0
      let edgesRedirected = 0

      for (const group of duplicates) {
        // Re-fetch from the live store (earlier groups may have removed nodes).
        const allInGroup = store.getAllNodes().filter((n) => group.ids.includes(n.id))

        // Sort order: for "newest", reverse insertion order (sort descending so
        // the later-inserted node leads, mirroring the MCP handler's `return -1`
        // sort); for "oldest", preserve insertion order (sort ascending).
        if (keepStrategy === 'oldest') {
          allInGroup.sort((a, b) => group.ids.indexOf(a.id) - group.ids.indexOf(b.id))
        } else {
          // newest: reverse (last in wins)
          allInGroup.sort((a, b) => group.ids.indexOf(b.id) - group.ids.indexOf(a.id))
        }

        if (allInGroup.length < 2) continue

        const keeper = allInGroup[0]
        const toRemove = allInGroup.slice(1)

        for (const dup of toRemove) {
          const edges = store.getEdgesForNode(dup.id)
          for (const edge of edges) {
            const redirected: UPGEdge = {
              id: edgeId(),
              source: edge.source === dup.id ? keeper.id : edge.source,
              target: edge.target === dup.id ? keeper.id : edge.target,
              type: edge.type,
            }
            // Skip self-loops (source === target after redirect).
            if (redirected.source !== redirected.target) {
              try {
                store.addEdge(redirected)
                edgesRedirected++
              } catch {
                // Skip edges that fail validation (duplicate, type mismatch, etc.)
              }
            }
          }
          store.removeNode(dup.id)
          nodesRemoved++
        }
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              merged: true,
              groups_merged: duplicates.length,
              nodes_removed: nodesRemoved,
              edges_redirected: edgesRedirected,
              strategy: keepStrategy,
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        console.log(upgHeader('Dedupe'))
        console.log(
          success(
            `Merged ${duplicates.length} group${duplicates.length === 1 ? '' : 's'}: ` +
            `${nodesRemoved} node${nodesRemoved === 1 ? '' : 's'} removed, ` +
            `${edgesRedirected} edge${edgesRedirected === 1 ? '' : 's'} redirected ` +
            `(kept: ${keepStrategy})`,
          ),
        )
        console.log()
      }

      process.exit(EXIT.OK)
    } catch (err) {
      die(err)
    }
  })
