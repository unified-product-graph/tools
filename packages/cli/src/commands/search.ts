import { Command } from 'commander'
import { discoverUPGFile, loadStore, searchNodes } from '../lib/graph.js'
import { formatNode, upgHeader } from '../lib/formatter.js'

export const searchCommand = new Command('search')
  .arguments('<query>')
  .description('Fuzzy text search across titles and descriptions.')
  .option('--file <path>', 'Path to .upg file')
  .option('--type <type>', 'Filter results by entity type')
  .option('--json', 'Machine-readable JSON output')
  .action(async (query, opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const results = searchNodes(store, query, {
        type: opts.type,
        fields: ['title', 'description', 'tags'],
      })

      store.stopWatching()

      if (opts.json) {
        console.log(JSON.stringify(results.map((s) => ({
          id: s.node.id, type: s.node.type, title: s.node.title, score: s.score,
        })), null, 2))
        return
      }

      if (results.length === 0) {
        console.log(`No results for "${query}".`)
        return
      }

      console.log(upgHeader('Search'))
      console.log(`  ${results.length} result(s) for "${query}":\n`)
      for (const { node } of results) console.log(formatNode(node, '  '))
      console.log()
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
