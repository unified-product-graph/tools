import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { die, violation, usageError } from '../lib/errors.js'

export const exportCommand = new Command('export')
  .description('Export entities as JSON, Markdown, or CSV.')
  .option('--file <path>', 'Path to .upg file')
  .option('--format <fmt>', 'json | md | csv. Defaults to json', 'json')
  .option('--type <type>', 'Filter by entity type')
  .action(async (opts) => {
    try {
      // Validate --format up front so an unknown value fails fast with a usage
      // error (exit 3) instead of silently emitting nothing on exit 0
      // (CLI-FEEDBACK M6). `markdown` is accepted as a friendly alias for `md`.
      const format = opts.format === 'markdown' ? 'md' : opts.format
      if (format !== 'json' && format !== 'md' && format !== 'csv') {
        throw usageError(
          `Unknown --format "${opts.format}". Expected one of: json, md, csv (markdown is accepted as md).`,
        )
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let nodes = store.getAllNodes()
      if (opts.type) nodes = nodes.filter((n) => n.type === opts.type)

      store.stopWatching()

      if (format === 'json') {
        console.log(JSON.stringify(nodes.map((n) => ({
          id: n.id, type: n.type, title: n.title, description: n.description,
          status: n.status, tags: n.tags, properties: n.properties,
        })), null, 2))
      } else if (format === 'csv') {
        console.log('id,type,title,status,tags')
        for (const n of nodes) {
          const tags = (n.tags ?? []).join(';')
          const title = n.title.replace(/"/g, '""')
          console.log(`"${n.id}","${n.type}","${title}","${n.status ?? ''}","${tags}"`)
        }
      } else if (format === 'md') {
        const byType: Record<string, typeof nodes> = {}
        for (const n of nodes) {
          const list = byType[n.type] ?? []
          list.push(n)
          byType[n.type] = list
        }
        for (const [type, typeNodes] of Object.entries(byType).sort()) {
          console.log(`\n## ${type} (${typeNodes.length})\n`)
          for (const n of typeNodes) {
            console.log(`- **${n.title}**${n.description ? `: ${n.description}` : ''}`)
          }
        }
      }
    } catch (err) {
      // Invalid document = validation violation (exit 2); other load failures
      // = runtime error (exit 1). Matches verify (CLI-FEEDBACK #6).
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('Invalid UPG document')) die(violation(msg))
      die(err)
    }
  })
