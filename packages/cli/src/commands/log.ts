import { Command } from 'commander'
import chalk from 'chalk'
import { resolveApiKey } from '../lib/config.js'
import { callTool } from '../lib/cloud.js'
import { upgHeader } from '../lib/formatter.js'

export const logCommand = new Command('log')
  .description('Recent activity log for a cloud product.')
  .option('--endpoint <url>', 'Cloud endpoint. Defaults to stored value')
  .option('--product-id <id>', 'Cloud product ID')
  .option('--limit <n>', 'Number of entries. Defaults to 20', parseInt, 20)
  .option('--entity <id>', 'Filter by entity ID')
  .option('--action <type>', 'create | update | delete')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const { endpoint, apiKey } = await resolveApiKey(opts.endpoint)

      const args: Record<string, unknown> = { limit: opts.limit }
      if (opts.productId) args.product_id = opts.productId
      if (opts.entity) args.entity_id = opts.entity
      if (opts.action) args.action = opts.action

      const result = await callTool(
        { endpoint, apiKey },
        'get_change_log',
        args
      ) as Array<{
        action: string
        entity_type: string
        entity_label?: string
        entity_subtype?: string
        changed_fields?: string[]
        description?: string
        agent_name?: string
        user_email?: string
        created_at: string
      }>

      const entries = Array.isArray(result) ? result : []

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }

      console.log(upgHeader('Log'))

      if (entries.length === 0) {
        console.log('  No activity found.\n')
        return
      }

      for (const entry of entries) {
        const time = new Date(entry.created_at).toLocaleString()
        const actionColor = entry.action === 'create' ? chalk.green
          : entry.action === 'delete' ? chalk.red
          : chalk.yellow
        const action = actionColor(entry.action.padEnd(8))
        const type = chalk.dim((entry.entity_subtype ?? entry.entity_type).padEnd(16))
        const label = chalk.white(entry.entity_label ?? '(unknown)')
        const who = entry.agent_name
          ? chalk.dim(`[${entry.agent_name}]`)
          : entry.user_email
          ? chalk.dim(`[${entry.user_email}]`)
          : ''

        console.log(`  ${chalk.dim(time)}  ${action} ${type} ${label} ${who}`)

        if (entry.changed_fields?.length) {
          console.log(`  ${chalk.dim(' '.repeat(22) + 'changed: ' + entry.changed_fields.join(', '))}`)
        }
        if (entry.description) {
          console.log(`  ${chalk.dim(' '.repeat(22) + '→ ' + entry.description)}`)
        }
      }
      console.log()
    } catch (err) {
      console.error(chalk.red((err as Error).message))
      process.exit(2)
    }
  })
