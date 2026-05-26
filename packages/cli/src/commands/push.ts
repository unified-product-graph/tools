import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { discoverUPGFile } from '../lib/graph.js'
import { resolveApiKey } from '../lib/config.js'
import { uploadFile } from '../lib/cloud.js'

export const pushCommand = new Command('push')
  .description('Push the local graph to cloud.')
  .option('--file <path>', 'Path to .upg file')
  .option('--endpoint <url>', 'Cloud endpoint. Defaults to stored value')
  .option('--strategy <s>', 'create_new (default) | merge | replace', 'create_new')
  .option('--product-id <id>', 'Push to an existing cloud product')
  .option('--dry-run', 'Preview the push. Skips the upload')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const { endpoint, apiKey } = await resolveApiKey(opts.endpoint)
      const fileName = path.basename(filePath)

      const raw = await fs.readFile(filePath, 'utf-8')
      const doc = JSON.parse(raw)
      const nodeCount = doc.nodes?.length ?? 0
      const edgeCount = doc.edges?.length ?? 0
      const title = doc.product?.title ?? fileName

      // Check existing sync state
      const syncPath = filePath.replace('.upg', '.upg-sync')
      let existingSync: { product_id?: string } | null = null
      try {
        const syncRaw = await fs.readFile(syncPath, 'utf-8')
        existingSync = JSON.parse(syncRaw)
      } catch { /* no sync file */ }

      const productId = opts.productId ?? existingSync?.product_id
      const strategy = productId && opts.strategy === 'create_new' ? 'merge' : opts.strategy

      console.log()
      console.log(`  ${chalk.bold(title)} → ${chalk.dim(endpoint)}`)
      console.log(`  ${chalk.dim(`${nodeCount} nodes, ${edgeCount} edges, strategy: ${strategy}`)}`)

      if (opts.dryRun) {
        console.log(chalk.dim(`\n  --dry-run: no changes made.\n`))
        return
      }

      const spinner = ora({
        text: `Pushing ${nodeCount} nodes and ${edgeCount} edges...`,
        prefixText: ' ',
      }).start()

      const result = await uploadFile(
        { endpoint, apiKey },
        filePath,
        strategy,
        productId,
      )

      // Write .upg-sync
      const fileHash = crypto.createHash('sha256').update(raw).digest('hex')
      await fs.writeFile(syncPath, JSON.stringify({
        cloud_endpoint: endpoint,
        product_id: result.product_id,
        last_synced_at: new Date().toISOString(),
        node_id_map: result.node_id_map,
        edge_id_map: result.edge_id_map,
        last_snapshot_hash: fileHash,
      }, null, 2) + '\n', 'utf-8')

      spinner.succeed(`Pushed to cloud`)

      console.log()
      console.log(`  ${chalk.dim('Product')}   ${result.product_id}`)
      console.log(`  ${chalk.dim('Nodes')}     ${chalk.green(`+${result.nodes_created}`)}`)
      console.log(`  ${chalk.dim('Edges')}     ${chalk.green(`+${result.edges_created}`)}`)
      if (result.errors?.length > 0) {
        console.log(`  ${chalk.dim('Errors')}    ${chalk.red(String(result.errors.length))}`)
      }
      console.log(`  ${chalk.dim('Sync')}      ${path.basename(syncPath)}`)
      console.log()
    } catch (err) {
      console.error(chalk.red(`\n  ${(err as Error).message}\n`))
      process.exit(2)
    }
  })
