import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { UPGFileStore } from '@unified-product-graph/sdk'
import {
  TOOL_DEFINITIONS,
  getToolHandler,
} from './lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  textError,
  isCanonicalLens,
  type ToolContext,
  type ToolResult,
  type UPGLens,
} from './lib/server-context.js'

/**
 * Server `instructions` string surfaced to MCP clients in the initialise
 * handshake. Promotes `query` as the documented default for graph-wide reads.
 * Exported so tests can snapshot the literal. Drift here changes
 * how every connecting agent learns to use the server.
 */
export const SERVER_INSTRUCTIONS = [
  'Unified Product Graph (local) MCP. Reads and writes .upg files directly.',
  '',
  'Batching (50 per call, atomic):',
  '- 3+ nodes: batch_create_nodes, batch_update_nodes, batch_delete_nodes.',
  '- 3+ edges: batch_create_edges, batch_delete_edges.',
  '- Chain inside a batch via parent_ref ("$0", "$1") to reference earlier nodes.',
  '- Singles: create_node, update_node, delete_node, create_edge, delete_edge.',
  '',
  'Reads:',
  '- Traverse the graph: query (BFS, projection-aware). Default for "show me the graph".',
  '  query({ from: "persona", traverse: ["persona_pursues_job"], depth: 2, include: ["title"], edge_include: [] })',
  '- get_node: one node + its edges. get_nodes: batch by ID (max 50).',
  '- list_nodes: filter by type/status/tags/parent. DO NOT pass include_edges:true with limit > 50 (transport overflow); use compact_edges:true for ID-only edges.',
  '- export_edges({ types?: [...] }): flat { id, source, target, type } enumeration for migration passes.',
  '- search_nodes: fuzzy title/description match.',
  '- Overview: get_graph_digest (~500 tokens, counts + health), get_product_context (lens-aware summary).',
  '',
  'Edge migration: rename_edge_type({ from, to, flip?, dry_run? }): single transactional rename.',
  '',
  'Multi-product: list_local_products, switch_product, init_workspace.',
  '',
  'Schema: get_entity_schema returns valid parent→child hierarchy, properties, and edge types per type.',
  '',
  'Spec introspection (read @unified-product-graph/core without importing it):',
  '- Entity catalog: list_entity_types, get_entity_meta, list_type_labels, get_type_label, get_valid_children.',
  '- Edges: list_edge_types, get_edge_type, list_cross_edge_types, resolve_edge_for_pair (canonical edge for source→target).',
  '- Regions and lenses: list_regions, get_region, get_region_for_entity_type, list_lenses, get_lens (with visible_types).',
  '- Domains and rings: list_domains, get_domain_guide, list_domain_rings, get_domain_ring.',
  '- Frameworks: list_frameworks, get_framework, list_framework_categories, list_framework_structure_patterns.',
  '- Playbooks: list_playbooks, get_playbook (region-anchored creation sequences).',
  '- Health catalogs: list_anti_patterns, get_anti_pattern, list_benchmarks (kind: count | relationship | ratio | domain_activation).',
  '- Lifecycles and scales: list_lifecycles, get_lifecycle, list_scales, get_scale, list_product_stages (9-stage enum).',
  '- Migrations: list_type_migrations, list_edge_migrations, list_split_migrations.',
  '- Version: get_spec_version.',
  '',
  'Approach verbs (plan, inspect, prioritise, trace, reflect):',
  '- Return { approach_id, scope, generated_at, approach, params }. The LLM reads signature_hint and synthesises the structured projection against the live graph.',
  '- An approach is the path of arrival to a region (cartographic framing). Definition lookup: list_approaches, get_approach.',
].join('\n')

/**
 * Build a UPG MCP server bound to a `UPGFileStore`. The server registers
 * `tools/list` (returns the registry's wire definitions) and `tools/call`
 * (dispatches by tool name into `src/tools/*.ts` handlers via the registry).
 *
 * The handler context (`ToolContext`) is constructed once per server instance
 * and threaded through every dispatch. Handlers never see the SDK's `Server`
 * directly; they receive `(args, ctx)` and return `ToolResult`.
 */
/**
 * Resolve the package version from package.json at runtime so the MCP server
 * manifest never drifts from the published npm version. Falls back to the
 * pinned literal if package.json can't be read (e.g. unusual install layout).
 */
function resolvePackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // dist/server.js → ../package.json
    const pkgPath = path.resolve(here, '..', 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    /* fall through */
  }
  return '0.5.0'
}

export const SERVER_VERSION = resolvePackageVersion()

/**
 * Batch-4 #20: tools that mutate the ACTIVE product's graph (its `nodes[]` /
 * `edges[]`). Their successful responses echo `active_product` so a forgotten
 * `switch_product` can't silently write into the wrong graph, and they honour
 * an optional `expect_product` guard that aborts on a mismatch — cheap
 * insurance for multi-product sessions and parallel agents sharing the server.
 *
 * Portfolio-document writes (`create_area`, cross-product edges) and
 * product-lifecycle tools (`create_product`, `switch_product`) are
 * intentionally excluded: they do not target the active product's graph.
 */
export const ACTIVE_PRODUCT_WRITE_TOOLS = new Set<string>([
  'create_node', 'update_node', 'delete_node',
  'batch_create_nodes', 'batch_update_nodes', 'batch_delete_nodes',
  'create_edge', 'delete_edge', 'move_node', 'batch_move_nodes',
  'batch_create_edges', 'batch_delete_edges',
  'migrate_type', 'migrate_status', 'migrate_properties',
  'deduplicate_nodes', 'rename_edge_type', 'repair_dangling_edges',
])

export interface ActiveProductIdentity {
  id: string | null
  title: string | null
  file: string | null
}

export function activeProductIdentity(store: UPGFileStore): ActiveProductIdentity {
  const product = store.getProduct() as { id?: string; title?: string } | undefined
  let file: string | null = null
  try {
    const fp = store.getFilePath()
    if (fp) file = path.basename(fp)
  } catch {
    /* no file bound */
  }
  return { id: product?.id ?? null, title: product?.title ?? null, file }
}

/** True when `expect` names the active product by id, title, file, or file stem. */
export function matchesActiveProduct(expect: string, ident: ActiveProductIdentity): boolean {
  if (ident.id && expect === ident.id) return true
  if (ident.title && expect === ident.title) return true
  if (ident.file && (expect === ident.file || expect === ident.file.replace(/\.upg$/, ''))) return true
  return false
}

/**
 * Inject `active_product: { id, title }` into a write tool's JSON response.
 * Best-effort: leaves non-JSON or non-object bodies untouched.
 */
export function withActiveProductEcho(result: ToolResult, store: UPGFileStore): ToolResult {
  const first = result.content[0]
  if (!first || first.type !== 'text') return result
  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    return result
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result
  const ident = activeProductIdentity(store)
  ;(parsed as Record<string, unknown>).active_product = { id: ident.id, title: ident.title }
  return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] }
}

/**
 * Idempotent dispatch for mutating MCP calls (batch-write duplicate-delivery
 * fix). A re-delivered tool call (same JSON-RPC request id, e.g. a transport
 * resend) must not execute twice and write a second copy. `run` memoises the
 * in-flight/finished result per request id and replays it, so a re-delivery is
 * a no-op that returns the original response. The cached value is the PROMISE,
 * so a re-delivery arriving while the first is still in flight awaits the same
 * execution rather than starting a second. Bounded by count (oldest evicted);
 * an undefined key (no request id) is never memoised. One instance per server
 * instance == per stdio session.
 */
export function createIdempotentDispatch<T>(max = 256) {
  const ledger = new Map<string, Promise<T>>()
  return {
    has(key: string): boolean {
      return ledger.has(key)
    },
    get size(): number {
      return ledger.size
    },
    run(key: string | undefined, exec: () => Promise<T>): Promise<T> {
      if (key === undefined) return exec()
      const existing = ledger.get(key)
      if (existing) return existing
      const p = exec()
      ledger.set(key, p)
      if (ledger.size > max) {
        const oldest = ledger.keys().next().value
        if (oldest !== undefined) ledger.delete(oldest)
      }
      return p
    },
  }
}

export function createServer(store: UPGFileStore) {
  const server = new Server(
    { name: 'unified-product-graph', version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  // ── Build the runtime context shared by every handler ────────────────────
  const sessionContext = createSessionContext()
  const queryCache = createQueryCache()
  const ctx: ToolContext = {
    store,
    sessionContext,
    queryCache,
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }

  // ── Load persisted lens from product properties ──────────────────────────
  {
    const doc = store.getDocument()
    const persistedLens = (doc.product as unknown as Record<string, unknown> | undefined)?.lens as UPGLens | undefined
    // (Seam 4 / DT-LENS-5): restore against the canonical 8 lenses,
    // not the stale hardcoded 4 (which used the non-existent id "design").
    if (persistedLens && isCanonicalLens(persistedLens)) {
      sessionContext.lens = persistedLens
    }
  }

  // ── tools/list ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS }
  })

  // ── Idempotency ledger (batch-write duplicate-delivery fix) ─────────────────
  // A mutating tool call (e.g. batch_create_nodes) can be DELIVERED MORE THAN
  // ONCE: a transport-level resend re-runs the handler, which mints fresh ids
  // and writes a second copy. The duplicate often lands a few calls later, so a
  // post-write recount can't catch it. `idempotency.run` memoises the result per
  // JSON-RPC request id and replays it, so a re-delivery is a no-op.
  type CallResult = { content: ToolResult['content']; isError?: true }
  const idempotency = createIdempotentDispatch<CallResult>()

  // ── tools/call ────────────────────────────────────────────────────────────
  const logFile = process.env.UPG_MCP_LOG
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reqKey =
      extra && extra.requestId !== undefined && extra.requestId !== null
        ? String(extra.requestId)
        : undefined

    if (reqKey !== undefined && idempotency.has(reqKey) && logFile) {
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ts: Date.now(), tool: request.params.name, requestId: reqKey, replay: true }) + '\n',
      )
    }

    return idempotency.run(reqKey, async (): Promise<CallResult> => {
      const { name, arguments: args = {} } = request.params
      const handler = getToolHandler(name)
      const t0 = logFile ? Date.now() : 0

      // Batch-4 #20: expect_product guard on active-product writes — abort before
      // the handler runs if the active product isn't the one the caller expected.
      const isActiveWrite = ACTIVE_PRODUCT_WRITE_TOOLS.has(name)
      if (isActiveWrite && typeof args.expect_product === 'string' && args.expect_product.length > 0) {
        const ident = activeProductIdentity(ctx.store)
        if (!matchesActiveProduct(args.expect_product, ident)) {
          const guard = textError(
            `expect_product guard: active product is "${ident.title ?? ident.id ?? '(unknown)'}"` +
            `${ident.id ? ` (id: ${ident.id})` : ''}, but this call expected "${args.expect_product}". ` +
            `Refusing to write. Run switch_product to the intended product first, or drop expect_product.`,
          )
          if (logFile) {
            fs.appendFileSync(logFile, JSON.stringify({ ts: t0, tool: name, params: args, result: guard, durationMs: 0 }) + '\n')
          }
          return guard as CallResult
        }
      }

      let result = handler ? await handler(args, ctx) : textError(`Unknown tool: ${name}`)

      // Batch-4 #20: echo the active product on successful active-product writes.
      if (isActiveWrite && !result.isError) {
        result = withActiveProductEcho(result, ctx.store)
      }
      if (logFile) {
        const entry = JSON.stringify({ ts: t0, tool: name, params: args, result, durationMs: Date.now() - t0 })
        fs.appendFileSync(logFile, entry + '\n')
      }
      // ToolResult is structurally identical to the SDK's CallToolResult variant
      // of ServerResult, but the SDK's union has an index signature my narrower
      // type doesn't satisfy. Cast at the boundary so handlers can stay typed.
      return result as CallResult
    })
  })

  return {
    async start() {
      const transport = new StdioServerTransport()
      await server.connect(transport)
    },
  }
}
