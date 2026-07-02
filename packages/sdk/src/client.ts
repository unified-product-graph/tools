/**
 * UPGClient: high-level, namespaced facade over UPGFileStore.
 *
 * This is the recommended entry point for application code that wants to
 * read or write a `.upg` file. Advanced consumers can drop down to the
 * lower-level primitives (`UPGFileStore`, `createNode`, `createEdge`, etc.)
 * which are also exported from `@unified-product-graph/sdk`.
 *
 * The client is async throughout because file I/O on a `.upg` file is
 * inherently async. Mutations are persisted to disk via `flush()` after
 * each call, so callers never need to manage save state explicitly.
 *
 * ```ts
 * import { UPGClient } from '@unified-product-graph/sdk'
 *
 * const upg = new UPGClient({ file: './product.upg' })
 *
 * // Nodes
 * await upg.nodes.create({ type: 'feature', title: 'Dark mode' })
 * await upg.nodes.list({ type: 'feature' })
 * await upg.nodes.get('node-id')
 * await upg.nodes.update('node-id', { status: 'active' })
 * await upg.nodes.delete('node-id')
 *
 * // Edges
 * await upg.edges.connect('src-id', 'tgt-id')
 * await upg.edges.list({ source: 'node-id' })
 *
 * // Graph-level
 * await upg.health()
 * await upg.search('dark mode')
 * await upg.verify()
 * ```
 */

import type { UPGBaseNode, UPGEdge, UPGEdgeType } from '@unified-product-graph/core'
import {
  UPG_EDGE_CATALOG,
  resolveAllEdges,
  pickCanonicalEdge,
  getValidChildren,
} from '@unified-product-graph/core'
import { UPGFileStore, type IntegrityReport } from './store.js'
import {
  createNode as createNodeOp,
  createEdge as createEdgeOp,
  deleteNode as deleteNodeOp,
  deleteEdge as deleteEdgeOp,
  listNodes as listNodesOp,
  getNode as getNodeOp,
  updateNode as updateNodeOp,
  batchCreateNodes as batchCreateNodesOp,
  computeGraphDigest,
  computeHealthScore,
  searchNodes,
  type CreateNodeArgs,
  type CreateEdgeArgs,
  type ListNodesOptions,
  type GraphDigest,
  type SearchResult,
  type GetNodeResult,
  type UpdateNodeArgs,
  type BatchCreateArgs,
  type BatchCreateResult,
} from './lib/tools.js'

export interface UPGClientOptions {
  /** Path to the .upg file on disk. */
  file: string
  /**
   * Skip auto-load on first operation (default: false).
   * When true, call `await client.load()` manually before any operation.
   */
  lazy?: boolean
}

// A type alias, not an empty extending interface: NodeListOptions IS
// ListNodesOptions today (kept as a distinct public name for the client's
// nodes.list surface). @typescript-eslint/no-empty-object-type flags the empty
// `extends` form; the alias is the equivalent that satisfies it.
export type NodeListOptions = ListNodesOptions

export interface EdgeListOptions {
  source?: string
  target?: string
  type?: UPGEdgeType
}

export interface HealthResult {
  score: number
  digest: GraphDigest
}

export interface SearchOptions {
  /** Maximum number of results (default: 20). */
  limit?: number
  /** Restrict to a single entity type. */
  type?: string
}

/** (S-02): integrity report + a top-level `ok` clean-check. */
export interface VerifyResult extends IntegrityReport {
  /** True when no integrity issues were detected. The clean-check. */
  ok: boolean
}

/** (S-04): a canonical edge resolution for a (source, target) pair. */
export interface EdgeResolution {
  /** The canonical edge type for the pair, in this direction. */
  type: UPGEdgeType
}

export class UPGClient {
  private readonly options: UPGClientOptions
  private store: UPGFileStore | null = null
  private loadPromise: Promise<void> | null = null
  /**
   *: when > 0, mutations DEFER their per-call auto-flush (one disk
   * write per `transaction()` block instead of per mutation). Nested
   * transactions are reference-counted; the outermost flushes once at the end.
   */
  private deferDepth = 0

  /** Node operations namespace. */
  readonly nodes: NodesAPI
  /** Edge operations namespace. */
  readonly edges: EdgesAPI
  /** Schema introspection facade: valid children + canonical edges. */
  readonly schema: SchemaAPI
  /** Product-metadata operations: update stage / title. */
  readonly product: ProductAPI

  constructor(options: UPGClientOptions) {
    this.options = options
    this.nodes = new NodesAPI(this)
    this.edges = new EdgesAPI(this)
    this.schema = new SchemaAPI()
    this.product = new ProductAPI(this)
  }

  /** @internal True while inside a `transaction()` block (defer flushes). */
  get deferringFlush(): boolean {
    return this.deferDepth > 0
  }

  /** @internal Flush unless we're inside a transaction. */
  async maybeFlush(): Promise<void> {
    if (this.deferDepth > 0) return
    await this.flush()
  }

  /**
   *: run a batch of mutations with a SINGLE disk write at the end.
   * Inside the callback, every `nodes.create` / `edges.connect` / etc. defers
   * its auto-flush; the block flushes once on success. On throw the partial
   * in-memory changes are still flushed (the `.upg` is the source of truth and
   * mutations are already applied to the store) and the error re-thrown.
   *
   * ```ts
   * await upg.transaction(async () => {
   *   const a = await upg.nodes.create({ type: 'persona', title: 'A' })
   *   await upg.nodes.create({ type: 'job', title: 'J', parent_id: a.node.id })
   * }) // one flush here
   * ```
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.deferDepth++
    try {
      const result = await fn()
      return result
    } finally {
      this.deferDepth--
      if (this.deferDepth === 0) await this.flush()
    }
  }

  /**
   * Load the .upg file. Called automatically on first operation unless
   * `{ lazy: true }` was set. Safe to call multiple times; repeated calls
   * are coalesced. If load fails (transient I/O, parse error, etc.) the
   * promise is rejected AND the cached promise is cleared, so the next
   * call retries from scratch rather than re-throwing the stale error.
   */
  async load(): Promise<void> {
    if (this.store && !this.loadPromise) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      try {
        const store = new UPGFileStore()
        await store.load(this.options.file)
        this.store = store
      } catch (err) {
        // Clear the cached promise so the next call retries instead of
        // returning a permanently-rejected promise. The error still
        // propagates to *this* caller.
        this.loadPromise = null
        throw err
      }
    })()
    return this.loadPromise
  }

  /** Internal: get the loaded store, loading on demand. */
  async getStore(): Promise<UPGFileStore> {
    if (!this.store) await this.load()
    if (!this.store) throw new Error('UPGClient: store failed to load')
    return this.store
  }

  /** Persist pending changes to disk. Called automatically after mutations. */
  async flush(): Promise<void> {
    const store = await this.getStore()
    await store.flush()
  }

  /** Compute a health score (0–100) plus the underlying graph digest. */
  async health(): Promise<HealthResult> {
    const store = await this.getStore()
    const digest = computeGraphDigest(store)
    return { score: computeHealthScore(digest), digest }
  }

  /** Search nodes by free-text query. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const store = await this.getStore()
    return searchNodes(store, query, {
      limit: options.limit ?? 20,
      ...(options.type ? { type: options.type } : {}),
    })
  }

  /**
   * Verify integrity of the loaded graph.
   *
   * (S-02): returns a report object with a top-level `ok: boolean` —
   * `ok: true` means no integrity issues. The clean-check is `(await
   * upg.verify()).ok`, NOT `if (await upg.verify())` (the report object is
   * always truthy; the old JSDoc wrongly claimed it returned `null` when
   * clean, so a naive truthiness check reported false problems).
   *
   * @returns `{ ok, tampered, quarantined, orphanedEdges }`. `ok` is the
   * single clean-check; the other fields explain WHY when `ok` is false.
   */
  async verify(): Promise<VerifyResult> {
    const store = await this.getStore()
    const report = store.getIntegrityReport()
    if (!report) {
      // No report computed yet (should not happen post-load) → treat as clean.
      return { ok: true, tampered: false, quarantined: [], orphanedEdges: 0, contentValidationErrors: [] }
    }
    const ok =
      !report.tampered &&
      report.orphanedEdges === 0 &&
      report.quarantined.length === 0 &&
      report.contentValidationErrors.length === 0
    return { ok, ...report }
  }

  /**
   * Diff against a previous version. Not yet implemented; tracked in
   * follow-up. Will return a structured changeset between the
   * current graph and the named ref (git revision or snapshot id).
   */
  async diff(_ref: string): Promise<never> {
    throw new Error(
      'UPGClient.diff() is not yet implemented. Use the CLI (`upg diff <ref>`) for now.',
    )
  }

  /** Release file watchers and free resources. */
  async close(): Promise<void> {
    if (!this.store) return
    await this.store.flush()
    this.store = null
    this.loadPromise = null
  }
}

class NodesAPI {
  constructor(private readonly client: UPGClient) {}

  /**
   * Create a node. The `type` is validated against the UPG entity catalog:
   * deprecated aliases are accepted with a warning, genuinely unknown types
   * throw `UnknownEntityTypeError`. An invalid `status` (not in the type's
   * lifecycle phases) throws `WriteValidationError`. Unknown properties are
   * stored with a warning unless `{ strict: true }`.
   */
  async create(args: CreateNodeArgs) {
    const store = await this.client.getStore()
    const result = createNodeOp(store, args)
    await this.client.maybeFlush()
    return result
  }

  /**
   *: create many nodes atomically in one call. Wraps the
   * `batchCreateNodes` free function, so it supports `parent_ref` chaining
   * (`"$0"`, `"$1"`) and an optional explicit `edges[]` array — all-or-nothing,
   * one disk write. Returns `{ ok: false, error }` on validation failure
   * (NOTHING is written) instead of throwing.
   */
  async createMany(args: BatchCreateArgs): Promise<BatchCreateResult> {
    const store = await this.client.getStore()
    const result = batchCreateNodesOp(store, args)
    if (result.ok) await this.client.maybeFlush()
    return result
  }

  /** List nodes, optionally filtered by type / status / tag. */
  async list(options: NodeListOptions = {}) {
    const store = await this.client.getStore()
    return listNodesOp(store, options)
  }

  /**
   * Get a single node by id.
   *
   * (S-08): pass `{ withEdges: true }` to get the full
   * `{ node, edges_out, edges_in }` shape the underlying `getNode` already
   * computes (default `get(id)` returns just the node, as before, for
   * back-compat). See also `inspect(id)`.
   */
  async get(id: string): Promise<UPGBaseNode | undefined>
  async get(id: string, opts: { withEdges: true }): Promise<GetNodeResult | undefined>
  async get(
    id: string,
    opts?: { withEdges?: boolean },
  ): Promise<UPGBaseNode | GetNodeResult | undefined> {
    const store = await this.client.getStore()
    const result = getNodeOp(store, { node_id: id })
    if (!result) return undefined
    return opts?.withEdges ? result : result.node
  }

  /**
   * (S-08): deep-dive a node with its connections —
   * `{ node, edges_out, edges_in }`. Returns `undefined` if not found.
   */
  async inspect(id: string): Promise<GetNodeResult | undefined> {
    const store = await this.client.getStore()
    return getNodeOp(store, { node_id: id }) ?? undefined
  }

  /**
   * Update a node by id. Validated with the same posture as `create`
   *: invalid `status` throws `WriteValidationError`; unknown
   * properties warn (or throw in `strict`).
   *
   *: pass `unset_properties: [...]` to DELETE property keys — writing
   * `{ properties: { key: null } }` only stores a literal null, it can't remove
   * the key. `unset_properties` runs after the `properties` merge.
   *
   * The legacy `update(id, { status, properties, ... })` form still works (the
   * second arg is treated as the patch).
   */
  async update(
    id: string,
    patch: Partial<UPGBaseNode> & { unset_properties?: string[]; strict?: boolean },
  ): Promise<UPGBaseNode> {
    const store = await this.client.getStore()
    const args: UpdateNodeArgs = {
      node_id: id,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.properties !== undefined ? { properties: patch.properties } : {}),
      ...(patch.unset_properties !== undefined ? { unset_properties: patch.unset_properties } : {}),
      ...(patch.strict !== undefined ? { strict: patch.strict } : {}),
    }
    const result = updateNodeOp(store, args)
    await this.client.maybeFlush()
    return result.node
  }

  /** Delete a node and all incident edges. */
  async delete(id: string) {
    const store = await this.client.getStore()
    const result = deleteNodeOp(store, { node_id: id })
    await this.client.maybeFlush()
    return result
  }
}

class EdgesAPI {
  constructor(private readonly client: UPGClient) {}

  /**
   * Connect two nodes with a directed edge `source → target`.
   *
   * **Edge type is INFERRED from `(source.type, target.type)` when `type` is
   * omitted — and DIRECTION MATTERS.** `solution → feature` resolves to
   * `solution_becomes_feature`; the reverse has no canonical edge. **Most type
   * pairs have NO canonical edge** — for those `connect` returns an ERROR
   * OBJECT, it does NOT throw:
   *
   *   - success → `{ edge, warning? }`
   *   - failure → `{ error, no_canonical_edge_for? }`
   *
   * So handle the result as a union (inspect `.error`), not with try/catch.
   * Passing an explicit `type` does NOT override direction: the type's declared
   * source/target must still match the nodes (a "wrong-way" link is
   * inexpressible — reorient the call). Use `upg.edges.resolve(srcType,
   * tgtType)` or `upg.schema.edgeFor(a, b)` to discover the right edge/direction
   * up front.
   */
  async connect(sourceId: string, targetId: string, opts: Partial<CreateEdgeArgs> = {}) {
    const store = await this.client.getStore()
    const args: CreateEdgeArgs = {
      source_id: sourceId,
      target_id: targetId,
      ...opts,
    }
    const result = createEdgeOp(store, args)
    // Only flush when an edge was actually created (success branch).
    if ('edge' in result) await this.client.maybeFlush()
    return result
  }

  /**
   * (S-04): resolve the canonical edge type for a directed
   * `(sourceType → targetType)` pair, WITHOUT touching the graph. Returns
   * `{ type }` or `null` when the pair has no canonical edge. Direction
   * matters — `resolve('feature','solution')` and `resolve('solution',
   * 'feature')` differ.
   */
  resolve(sourceType: string, targetType: string): EdgeResolution | null {
    const type = pickCanonicalEdge(sourceType, targetType)
    return type ? { type } : null
  }

  /** List edges, optionally filtered by source / target / type. */
  async list(options: EdgeListOptions = {}): Promise<UPGEdge[]> {
    const store = await this.client.getStore()
    let edges = store.getAllEdges()
    if (options.source) edges = edges.filter((e) => e.source === options.source)
    if (options.target) edges = edges.filter((e) => e.target === options.target)
    if (options.type) edges = edges.filter((e) => e.type === options.type)
    return edges
  }

  /** Delete an edge by id. */
  async delete(id: string) {
    const store = await this.client.getStore()
    const result = deleteEdgeOp(store, { edge_id: id })
    await this.client.maybeFlush()
    return result
  }
}

/**
 * (S-04): schema introspection facade. Answers the questions an author
 * has to answer to build a VALID graph — "what can attach to a feature?",
 * "which edge connects A→B?" — from the object you're already holding, instead
 * of separately importing `@unified-product-graph/core`. All methods are pure
 * (catalog reads); no graph state.
 */
class SchemaAPI {
  /** Canonical edge types LEAVING `sourceType` (every `source → *` edge). */
  edgesFrom(sourceType: string): Array<{ type: UPGEdgeType; target_type: string }> {
    const out: Array<{ type: UPGEdgeType; target_type: string }> = []
    for (const [key, def] of Object.entries(UPG_EDGE_CATALOG)) {
      if (def.source_type !== sourceType) continue
      if (def.source_type === '*' || def.target_type === '*') continue
      out.push({ type: key as UPGEdgeType, target_type: def.target_type as string })
    }
    return out
  }

  /** Entity types that may be hierarchy children of `type`. */
  validChildren(type: string): readonly string[] {
    return getValidChildren(type)
  }

  /**
   * Canonical edge for a directed `(a → b)` pair, or `null`. Alias of
   * `upg.edges.resolve(...).type`, surfaced on `schema` for discoverability.
   * Direction matters.
   */
  edgeFor(a: string, b: string): UPGEdgeType | null {
    return pickCanonicalEdge(a, b)
  }

  /** Every catalogued edge for a directed `(a → b)` pair (may be > 1). */
  allEdgesFor(a: string, b: string): UPGEdgeType[] {
    return resolveAllEdges(a, b)
  }
}

/**
 *: product-metadata operations. The graph viewer showed `stage:
 * unknown` because there was no way to set the product's stage through the
 * client (only by editing the `.upg` JSON or the workspace-bootstrap
 * `createProduct` free function). `product.update({ stage, title })` fixes that.
 */
class ProductAPI {
  constructor(private readonly client: UPGClient) {}

  /** Read the current product metadata. */
  async get(): Promise<{ id?: string; title?: string; stage?: string } & Record<string, unknown>> {
    const store = await this.client.getStore()
    return store.getProduct() as { id?: string; title?: string; stage?: string } & Record<string, unknown>
  }

  /**
   * Update product metadata (`stage`, `title`, and any additional fields).
   * Merges over the existing product object and persists. Returns the updated
   * product.
   */
  async update(
    patch: { stage?: string; title?: string } & Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const store = await this.client.getStore()
    const doc = store.getDocument()
    doc.product = { ...doc.product, ...patch } as typeof doc.product
    store.markDirty()
    await this.client.maybeFlush()
    return doc.product as unknown as Record<string, unknown>
  }
}
