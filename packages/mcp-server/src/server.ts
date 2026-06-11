import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
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

/**
 * Portfolio / registry / cross-product writers. These do NOT target the active
 * product's graph (so they are excluded from ACTIVE_PRODUCT_WRITE_TOOLS and the
 * expect_product guard), but they DO mint ids / append to a portfolio document,
 * so a re-delivery duplicates them just the same. They are folded into
 * MUTATING_TOOLS so content-level dedup covers them too.
 */
export const PORTFOLIO_WRITE_TOOLS = new Set<string>([
  'create_product', 'create_area', 'apply_framework', 'migrate_cross_edges',
  'create_cross_product_edge', 'batch_create_cross_product_edges', 'delete_cross_product_edge',
  'define_canonical_entity', 'batch_define_canonical_entity',
  'register_instance', 'batch_register_instance',
  'promote_to_canonical', 'update_canonical_entity', 'link_area_to_audience',
])

/**
 * Every tool that mutates persisted state (active graph OR portfolio document).
 * Content-level idempotency (the fresh-id duplicate-delivery defence) is scoped
 * to this set. Reads are deliberately NEVER deduped: a deduped read could return
 * stale state. Over-covering a write is harmless (a real second call with an
 * identical payload is the rare case the allow_duplicate escape hatch exists
 * for); deduping a read would be a NEW bug, so when in doubt a tool is left out.
 */
export const MUTATING_TOOLS = new Set<string>([
  ...ACTIVE_PRODUCT_WRITE_TOOLS,
  ...PORTFOLIO_WRITE_TOOLS,
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

/** The tools/call result shape the dispatcher returns (a ToolResult variant). */
export type CallResult = { content: ToolResult['content']; isError?: true }

/** Count window for the content-dedup ledger (most recent N distinct payloads). */
export const CONTENT_DEDUP_MAX = 64

/**
 * Content-keyed dedup ledger: the second layer of the duplicate-delivery
 * defence. The request-id ledger (createIdempotentDispatch) only catches a
 * resend that REUSES the JSON-RPC request id. A client/transport that re-issues
 * a mutating call with a FRESH request id slips past it and writes a second copy
 * with new ids (the 0.9.22 gap). This ledger closes it: it remembers the RESULT
 * of each recent successful mutating call keyed by its payload, so an identical
 * mutating payload seen again within the window replays the original result
 * instead of executing a second time.
 *
 * Bounded by COUNT (the most recent `max` distinct payloads), not wall-clock:
 * the observed replay lands on the next mutating call, so a sliding count window
 * catches it without the "what timeout?" guesswork a time window needs. Only
 * SUCCESSFUL results are recorded (a transient error must stay retryable), and
 * `record` refreshes recency so a repeated payload is not evicted early.
 */
export function createContentDedup<T>(max = CONTENT_DEDUP_MAX) {
  const ledger = new Map<string, T>()
  return {
    has(key: string): boolean {
      return ledger.has(key)
    },
    get(key: string): T | undefined {
      return ledger.get(key)
    },
    record(key: string, value: T): void {
      if (ledger.has(key)) ledger.delete(key)
      ledger.set(key, value)
      if (ledger.size > max) {
        const oldest = ledger.keys().next().value
        if (oldest !== undefined) ledger.delete(oldest)
      }
    },
    delete(key: string): void {
      ledger.delete(key)
    },
    get size(): number {
      return ledger.size
    },
  }
}

/** Stable JSON stringify (object keys sorted recursively) so arg key ORDER never changes the dedup identity. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/**
 * The content-dedup key for a mutating call: (tool, active-product, payload).
 * `allow_duplicate` is stripped before hashing so toggling the escape hatch
 * never changes the identity of the underlying mutation.
 */
export function contentDedupKey(name: string, store: UPGFileStore, args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k !== 'allow_duplicate') rest[k] = v
  }
  const productId = activeProductIdentity(store).id ?? ''
  return createHash('sha256')
    .update(name + ' ' + productId + ' ' + stableStringify(rest))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Build the tools/call dispatcher: resolve the handler, run the active-product
 * guard, apply BOTH idempotency layers (request-id ledger for same-id resends,
 * content-dedup for fresh-id re-delivery), and log. Exported so tests drive a
 * real handler + store through the exact dispatch path the stdio server uses,
 * with no transport. Returns the dispatch fn plus the ledgers (for assertions).
 */
export function createDispatcher(ctx: ToolContext, opts: { logFile?: string } = {}) {
  const requestLedger = createIdempotentDispatch<CallResult>()
  // Promise-memoised so CONCURRENT identical mutating calls share one execution
  // (a re-delivery overlapping the original would otherwise both miss a
  // record-after-exec cache and both write — the 0.9.23 race).
  const contentLedger = createContentDedup<Promise<CallResult>>()
  const logFile = opts.logFile

  async function dispatch(
    name: string,
    args: Record<string, unknown>,
    reqKey: string | undefined,
  ): Promise<CallResult> {
    // Diagnostic: log EVERY incoming tools/call at the dispatch boundary, before
    // any dedup, so a re-delivery is visible even when a ledger swallows it.
    // `argsHash` correlates two deliveries of the same mutation.
    if (logFile) {
      fs.appendFileSync(
        logFile,
        JSON.stringify({
          ev: 'recv', ts: Date.now(), pid: process.pid, tool: name,
          reqKey: reqKey ?? null,
          argsHash: MUTATING_TOOLS.has(name) ? contentDedupKey(name, ctx.store, args) : null,
        }) + '\n',
      )
    }
    if (reqKey !== undefined && requestLedger.has(reqKey) && logFile) {
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ev: 'replay', ts: Date.now(), tool: name, requestId: reqKey }) + '\n',
      )
    }

    return requestLedger.run(reqKey, async (): Promise<CallResult> => {
      const t0 = logFile ? Date.now() : 0

      // Batch-4 #20: expect_product guard on active-product writes.
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

      // The handler execution (+ active-product echo + log). Shared by the
      // direct path and the content-dedup path so both run identical logic.
      const exec = async (): Promise<CallResult> => {
        const handler = getToolHandler(name)
        let result = handler ? await handler(args, ctx) : textError(`Unknown tool: ${name}`)
        if (isActiveWrite && !result.isError) result = withActiveProductEcho(result, ctx.store)
        if (logFile) {
          fs.appendFileSync(logFile, JSON.stringify({ ts: t0, tool: name, params: args, result, durationMs: Date.now() - t0 }) + '\n')
        }
        return result as CallResult
      }

      // Content-level idempotency: a re-delivered mutating call carrying a FRESH
      // request id (invisible to the request-id ledger above) replays the
      // original result instead of writing a duplicate. `allow_duplicate: true`
      // opts out for a deliberate identical re-create.
      if (MUTATING_TOOLS.has(name) && args.allow_duplicate !== true) {
        const ckey = contentDedupKey(name, ctx.store, args)
        const inflight = contentLedger.get(ckey)
        if (inflight) {
          if (logFile) {
            fs.appendFileSync(logFile, JSON.stringify({ ev: 'content-dedup', ts: Date.now(), tool: name, ckey }) + '\n')
          }
          return inflight
        }
        // Memoise the in-flight PROMISE before awaiting, so a concurrent
        // identical re-delivery shares this execution instead of starting a
        // second. Evict on error so a transient failure stays retryable; keep a
        // success so a later (sequential) re-delivery replays the original.
        const p = exec()
        contentLedger.record(ckey, p)
        try {
          const result = await p
          if (result.isError) contentLedger.delete(ckey)
          return result
        } catch (err) {
          contentLedger.delete(ckey)
          throw err
        }
      }

      return exec()
    })
  }

  return { dispatch, requestLedger, contentLedger }
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

  // ── tools/call ────────────────────────────────────────────────────────────
  // Two-layer duplicate-delivery defence (see createDispatcher): the request-id
  // ledger no-ops a same-id resend; content-dedup no-ops a fresh-id re-delivery
  // (the 0.9.22 gap). All dispatch logic lives in createDispatcher so tests can
  // exercise the exact path without a transport.
  const { dispatch } = createDispatcher(ctx, { logFile: process.env.UPG_MCP_LOG })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reqKey =
      extra && extra.requestId !== undefined && extra.requestId !== null
        ? String(extra.requestId)
        : undefined
    const { name, arguments: args = {} } = request.params
    return dispatch(name, (args ?? {}) as Record<string, unknown>, reqKey)
  })

  return {
    async start() {
      const transport = new StdioServerTransport()
      await server.connect(transport)
    },
  }
}
