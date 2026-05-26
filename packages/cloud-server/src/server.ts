/**
 * UPG cloud MCP server over stdio. Builds the runtime context and
 * dispatches every `tools/call` through `src/lib/tool-registry.ts`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { PgStore } from './store/pg-store.js'
import type { CloudContext } from './lib/server-context.js'
import { textError } from './lib/server-context.js'
import { TOOL_DEFINITIONS, getToolHandler } from './lib/tool-registry.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

export function createServer(store: PgStore) {
  const server = new Server(
    { name: 'unified-product-graph-cloud', version: pkg.version },
    { capabilities: { tools: {} } },
  )

  const ctx: CloudContext = { store }

  // ── tools/list ────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS }
  })

  // ── tools/call ────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params

    const handler = getToolHandler(name)
    const result = handler
      ? await handler(args as Record<string, unknown>, ctx)
      : textError(`Unknown tool: ${name}`)
    // ToolResult is structurally identical to the SDK's CallToolResult variant
    // of ServerResult, but the SDK's union has an index signature this narrower
    // type doesn't satisfy. Cast at the boundary so handlers can stay typed.
    return result as { content: typeof result.content; isError?: true }
  })

  // ── Transport ─────────────────────────────────────────────────────────────

  return {
    async start() {
      const transport = new StdioServerTransport()
      await server.connect(transport)
    },
  }
}
