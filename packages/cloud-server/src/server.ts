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

/**
 * Server `instructions` surfaced to MCP clients in the initialise handshake.
 * Opens with the ratified SEE/THINK/ACT/LEARN methodology preamble (VERBATIM,
 * identical to the local server — parity), then a cloud intro + facet-aware
 * spec-introspection note. Snapshotted by `__tests__/__fixtures__/`.
 */
export const SERVER_INSTRUCTIONS = [
  'How to work: the graph is a loop you advance, not a form you fill.',
  '- SEE. Orient before you write: get_graph_digest or get_product_context first.',
  '  A vague input is easy to over-structure into duplicates or orphans.',
  '- THINK. Before creating an entity or edge, call get_entity_schema for the type.',
  '  It gives the valid attachments and flags edges whose cross_product_scope crosses graphs.',
  '- ACT. Write atomically (batch_* with parent_ref chaining). Reach for the instrument',
  '  that fits: create_cross_product_edge for a graph-crossing edge, not create_edge.',
  '- LEARN. Close on evidence: validate_graph for drift, then a query that confirms',
  '  the graph answers the question. Each pass seeds the next SEE.',
  '',
  'Unified Product Graph (cloud) MCP. Postgres-backed product graphs over HTTP.',
  '',
  'Spec introspection: list_catalog({ kind }) lists a static spec catalog and get_catalog_entry({ kind, id }) reads one record (kinds: entity_types/edge_types/regions/domains/frameworks/lenses/lifecycles/playbooks/scales/anti_patterns/tree_patterns/templates/approaches/type_labels/status_values/product_stages/benchmarks/migrations...). get_entity_schema({ type }) gives the valid parent→child hierarchy, properties, and edge types (include: ["valid_children"] and/or ["region"], or resolve_edge_to: <target_type> for a pair). get_spec_version({ changelog: true }) folds in the spec changelog.',
].join('\n')

export function createServer(store: PgStore) {
  const server = new Server(
    { name: 'unified-product-graph-cloud', version: pkg.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
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
