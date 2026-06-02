import { Command } from 'commander'
import { discoverUPGFile, loadStore, searchNodes } from '../lib/graph.js'
import { formatNode, upgHeader } from '../lib/formatter.js'
import { die } from '../lib/errors.js'

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
        process.stderr.write(`No results for "${query}".\n`)
        return
      }

      process.stderr.write(upgHeader('Search') + '\n')
      process.stderr.write(`  ${results.length} result(s) for "${query}":\n\n`)
      for (const { node } of results) console.log(formatNode(node, '  '))
    } catch (err) {
      die(err)
    }
  })
