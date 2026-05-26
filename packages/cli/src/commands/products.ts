import { Command } from 'commander'
import { resolveApiKey } from '../lib/config.js'
import { callTool } from '../lib/cloud.js'

export const productsCommand = new Command('products')
  .description('List your cloud products.')
  .option('--endpoint <url>', 'Cloud endpoint. Defaults to stored value')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const { endpoint, apiKey } = await resolveApiKey(opts.endpoint)

      const result = await callTool(
        { endpoint, apiKey },
        'list_products',
        {}
      )

      // Response may be a flat array or { products: [...] }
      const products = (Array.isArray(result) ? result : (result as { products?: unknown[] }).products ?? []) as Array<{
        id: string; title: string; slug?: string; description?: string
      }>

      if (opts.json) {
        console.log(JSON.stringify(products, null, 2))
        return
      }

      if (products.length === 0) {
        console.log('No products found.')
        return
      }

      console.log(`\n${products.length} product(s) on ${endpoint}:\n`)
      for (const p of products) {
        const desc = p.description ? ` · ${p.description.slice(0, 60)}${p.description.length > 60 ? '...' : ''}` : ''
        console.log(`  ${p.title}${desc}`)
        console.log(`    id: ${p.id}`)
      }
      console.log()
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
