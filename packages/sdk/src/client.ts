/**
 * UPGClient — high-level, namespaced facade over UPGFileStore.
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
import { UPGFileStore } from './store.js'
import {
  createNode as createNodeOp,
  createEdge as createEdgeOp,
  deleteNode as deleteNodeOp,
  deleteEdge as deleteEdgeOp,
  listNodes as listNodesOp,
  getNode as getNodeOp,
  computeGraphDigest,
  computeHealthScore,
  searchNodes,
  type CreateNodeArgs,
  type CreateEdgeArgs,
  type ListNodesOptions,
  type GraphDigest,
  type SearchResult,
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

export interface NodeListOptions extends ListNodesOptions {}

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

export class UPGClient {
  private readonly options: UPGClientOptions
  private store: UPGFileStore | null = null
  private loadPromise: Promise<void> | null = null

  /** Node operations namespace. */
  readonly nodes: NodesAPI
  /** Edge operations namespace. */
  readonly edges: EdgesAPI

  constructor(options: UPGClientOptions) {
    this.options = options
    this.nodes = new NodesAPI(this)
    this.edges = new EdgesAPI(this)
  }

  /**
   * Load the .upg file. Called automatically on first operation unless
   * `{ lazy: true }` was set. Safe to call multiple times — repeated calls
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
   * Verify integrity of the loaded graph. Returns the integrity report from
   * the last load + any in-memory mutation checks. `null` indicates no
   * integrity issues were detected.
   */
  async verify() {
    const store = await this.getStore()
    return store.getIntegrityReport()
  }

  /**
   * Diff against a previous version. Not yet implemented — tracked in
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
   * Create a node. The `type` is validated against the UPG entity catalog —
   * deprecated aliases are accepted with a warning, genuinely unknown types
   * throw `UnknownEntityTypeError`.
   */
  async create(args: CreateNodeArgs) {
    const store = await this.client.getStore()
    const result = createNodeOp(store, args)
    await store.flush()
    return result
  }

  /** List nodes, optionally filtered by type / status / tag. */
  async list(options: NodeListOptions = {}) {
    const store = await this.client.getStore()
    return listNodesOp(store, options)
  }

  /** Get a single node by id. Returns `undefined` if not found. */
  async get(id: string): Promise<UPGBaseNode | undefined> {
    const store = await this.client.getStore()
    const result = getNodeOp(store, { node_id: id })
    return result?.node
  }

  /** Update a node by id. Returns the updated node. */
  async update(id: string, patch: Partial<UPGBaseNode>): Promise<UPGBaseNode> {
    const store = await this.client.getStore()
    const updated = store.updateNode(id, patch)
    await store.flush()
    return updated
  }

  /** Delete a node and all incident edges. */
  async delete(id: string) {
    const store = await this.client.getStore()
    const result = deleteNodeOp(store, { node_id: id })
    await store.flush()
    return result
  }
}

class EdgesAPI {
  constructor(private readonly client: UPGClient) {}

  /**
   * Connect two nodes with an edge. Edge type is inferred from source +
   * target entity types if not provided.
   */
  async connect(sourceId: string, targetId: string, opts: Partial<CreateEdgeArgs> = {}) {
    const store = await this.client.getStore()
    const args: CreateEdgeArgs = {
      source_id: sourceId,
      target_id: targetId,
      ...opts,
    }
    const result = createEdgeOp(store, args)
    await store.flush()
    return result
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
    await store.flush()
    return result
  }
}
