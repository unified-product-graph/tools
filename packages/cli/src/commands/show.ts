import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { resolveNodeRef } from '../lib/cursor.js'
import { die, violation, usageError } from '../lib/errors.js'
import { UPG_FRAMEWORKS_BY_ID } from '@unified-product-graph/core'

const INCLUDES = 'framework_exercise_includes_node'

/** Format one stored score value for a table cell. */
function cell(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export const showCommand = new Command('show')
  .arguments('<exercise>')
  .description('Show a framework exercise: each included entity and the scores recorded on its edge.')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .action(async (ref: string, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const node = resolveNodeRef(store, ref)
      if (!node) {
        store.stopWatching()
        throw usageError(`No node matches "${ref}".`)
      }
      if (node.type !== 'framework_exercise') {
        store.stopWatching()
        throw usageError(
          `"${node.title}" is a ${node.type}, not a framework_exercise. ` +
            '`show` displays exercise scores; use `list`/`tree` for other nodes.',
        )
      }

      const frameworkId = (node.properties as { framework_id?: string } | undefined)?.framework_id
      const framework = frameworkId ? UPG_FRAMEWORKS_BY_ID[frameworkId] : undefined

      // includes edges (exercise -> entity), each carrying that entity's result.
      const edges = store
        .getEdgesForNode(node.id)
        .filter((e) => e.type === INCLUDES && e.source === node.id)
      const rows = edges.map((e) => {
        const entity = store.getNode(e.target)
        return {
          entity_id: e.target,
          title: entity?.title ?? e.target,
          type: entity?.type,
          scores: (e.properties ?? {}) as Record<string, unknown>,
        }
      })

      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            { exercise_id: node.id, title: node.title, framework_id: frameworkId, included: rows },
            null,
            2,
          ) + '\n',
        )
        return
      }

      // ── Human table ──────────────────────────────────────────────────────
      const fwLabel = framework ? `${framework.name} (${frameworkId})` : frameworkId ?? 'no framework'
      console.log(
        chalk.bold(node.title) + chalk.dim(`  ·  ${fwLabel}  ·  ${rows.length} included`),
      )
      if (rows.length === 0) {
        console.log(chalk.dim('  No entities scored yet. Use `upg score <exercise> <entity> --data ...`'))
        return
      }

      // Column order: the framework's declared inputs (+ computed) first, then any
      // extra recorded keys, so a RICE/MoSCoW table reads in the natural order.
      const declared: string[] = []
      if (framework) {
        const rp = (framework.data as { required_properties?: Record<string, Array<{ property?: string }>> })
          .required_properties
        for (const props of Object.values(rp ?? {})) {
          for (const p of props) if (p.property && !declared.includes(p.property)) declared.push(p.property)
        }
        const cp = (framework.data as { computed_properties?: Array<{ property?: string }> }).computed_properties
        for (const c of cp ?? []) if (c.property && !declared.includes(c.property)) declared.push(c.property)
      }
      const present = new Set(rows.flatMap((r) => Object.keys(r.scores)))
      const cols = [
        ...declared.filter((k) => present.has(k)),
        ...[...present].filter((k) => !declared.includes(k)).sort(),
      ]

      const headers = ['Entity', ...cols]
      const table = rows.map((r) => [r.title, ...cols.map((k) => cell(r.scores[k]))])
      const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)))
      const fmtRow = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join('  ')

      console.log()
      console.log('  ' + chalk.dim(fmtRow(headers)))
      for (const row of table) console.log('  ' + fmtRow(row))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('Invalid UPG document')) die(violation(msg))
      die(err)
    }
  })
