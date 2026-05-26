import { Command } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'

export const exportCommand = new Command('export')
  .description('Export entities as JSON, Markdown, or CSV.')
  .option('--file <path>', 'Path to .upg file')
  .option('--format <fmt>', 'json | md | csv. Defaults to json', 'json')
  .option('--type <type>', 'Filter by entity type')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      let nodes = store.getAllNodes()
      if (opts.type) nodes = nodes.filter((n) => n.type === opts.type)

      store.stopWatching()

      if (opts.format === 'json') {
        console.log(JSON.stringify(nodes.map((n) => ({
          id: n.id, type: n.type, title: n.title, description: n.description,
          status: n.status, tags: n.tags, properties: n.properties,
        })), null, 2))
      } else if (opts.format === 'csv') {
        console.log('id,type,title,status,tags')
        for (const n of nodes) {
          const tags = (n.tags ?? []).join(';')
          const title = n.title.replace(/"/g, '""')
          console.log(`"${n.id}","${n.type}","${title}","${n.status ?? ''}","${tags}"`)
        }
      } else if (opts.format === 'md') {
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
      console.error((err as Error).message)
      process.exit(2)
    }
  })
