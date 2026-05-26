/**
 * UPG Cloud MCP Server
 *
 * Usage: upg-cloud-server
 *   --database-url postgres://user:pass@host:5432/db  (or UPG_DATABASE_URL env)
 *
 * A Postgres-backed MCP server for the Unified Product Graph.
 * Self-hostable, open source.
 */

import { parseArgs } from 'node:util'
import { Pool } from 'pg'
import { PgStore } from './store/pg-store.js'
import { WebhookDispatcher } from './lib/webhook-dispatcher.js'
import { createServer } from './server.js'

async function main() {
  const { values } = parseArgs({
    options: {
      'database-url': { type: 'string', short: 'd' },
    },
  })

  const databaseUrl = values['database-url'] || process.env.UPG_DATABASE_URL
  if (!databaseUrl) {
    process.stderr.write(
      'Usage: upg-cloud-server --database-url postgres://...\n' +
      '  Or set UPG_DATABASE_URL environment variable\n'
    )
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  // Test connection
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    process.stderr.write(`Database connection failed: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const store = new PgStore(pool)
  // Wire webhook delivery: mutations emit events post-commit; the
  // dispatcher fans them out to registered webhooks (fire-and-forget).
  const dispatcher = new WebhookDispatcher(pool)
  store.setEventSink((event) => dispatcher.emit(event))
  const server = createServer(store)
  await server.start()

  process.stderr.write('UPG Cloud MCP server running\n')

  const shutdown = async () => {
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
