import type { Pool, PoolClient } from 'pg'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { nodeId, edgeId } from '../id-helpers.js'
import { appendAudit } from '../lib/audit.js'
import type { WebhookEvent } from '../lib/webhook-dispatcher.js'

// ─── Local types ─────────────────────────────────────────────────────────────

export interface Product {
  id: string
  title: string
  description?: string
  stage?: string
}

export interface GraphSummary {
  product: { id: string; title: string; stage?: string }
  node_count: number
  edge_count: number
  nodes_by_type: Record<string, number>
  edges_by_type: Record<string, number>
  orphan_count: number
}

export interface AuditEntry {
  id: string
  user_id: string
  action: string
  entity_type: string
  entity_id: string
  changes: unknown
  created_at: string
}

export interface Comment {
  id: string
  node_id: string
  user_id: string
  body: string
  created_at: string
}

export interface AccessRecord {
  id: string
  user_id: string
  role: string
  created_at: string
}

export interface GraphAnalytics {
  hypothesis_velocity: { untested: number; testing: number; validated: number; invalidated: number }
  coverage_ratio: number  // 0-100
  evidence_density: number  // ratio
  stale_entity_rate: number  // 0-100
  orphan_rate: number  // 0-100
}

export interface CrossProductEdge {
  id: string
  source: string
  target: string
  type: string
  created_by_product_id: string
  created_at: string
}

export interface Webhook {
  id: string
  event: string
  url: string
  active: boolean
  created_at: string
}

// ─── Postgres-backed UPG Store ───────────────────────────────────────────────

export { UPGPgStore as PgStore }

export class UPGPgStore {
  constructor(private pool: Pool) {}

  // ── Event sink (webhook delivery) ──────────────────────────────────
  // Set by the server entry point. Mutations call `emit` AFTER they commit, so
  // events only fire for durable writes. Default is a no-op, so the store works
  // standalone (and in tests) with no dispatcher wired.
  private eventSink: ((event: WebhookEvent) => void) | null = null

  setEventSink(sink: (event: WebhookEvent) => void): void {
    this.eventSink = sink
  }

  /** Emit a post-commit event to the sink, if one is set. Public so the batch
   *  tools (which run their own transactions) can emit too. */
  emit(productId: string, event: string, payload: Record<string, unknown>): void {
    this.eventSink?.({ productId, event, payload })
  }

  // ── Products ───────────────────────────────────────────────────────────────

  async listProducts(): Promise<Product[]> {
    const { rows } = await this.pool.query<Product>(
      `SELECT id, title, description, stage FROM upg.products ORDER BY title`,
    )
    return rows
  }

  async getProduct(productId: string): Promise<Product> {
    const { rows } = await this.pool.query<Product>(
      `SELECT id, title, description, stage FROM upg.products WHERE id = $1`,
      [productId],
    )
    if (rows.length === 0) throw new Error(`Product not found: ${productId}`)
    return rows[0]
  }

  async createProduct(
    title: string,
    description?: string,
    stage?: string,
  ): Promise<Product> {
    const id = nodeId()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<Product>(
        `INSERT INTO upg.products (id, title, description, stage)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, description, stage`,
        [id, title, description ?? null, stage ?? null],
      )
      await appendAudit(client, {
        productId: id,
        action: 'create',
        entityType: 'product',
        entityId: id,
        changes: { title, description: description ?? null, stage: stage ?? null },
      })
      await client.query('COMMIT')
      this.emit(id, 'product.created', { id, title })
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  private static NODE_COLS = 'id, product_id, type, title, description, status, tags, data'

  async getNode(id: string): Promise<(UPGBaseNode & { product_id: string }) | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${UPGPgStore.NODE_COLS} FROM upg.nodes WHERE id = $1`,
      [id],
    )
    if (rows.length === 0) return undefined
    return rowToNode(rows[0])
  }

  async getAllNodes(productId: string): Promise<UPGBaseNode[]> {
    const { rows } = await this.pool.query(
      `SELECT ${UPGPgStore.NODE_COLS} FROM upg.nodes
       WHERE product_id = $1 ORDER BY title`,
      [productId],
    )
    return rows.map(rowToNode)
  }

  async addNode(productId: string, node: UPGBaseNode): Promise<UPGBaseNode> {
    const id = node.id || nodeId()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO upg.nodes (id, product_id, type, title, description, status, tags, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${UPGPgStore.NODE_COLS}`,
        [
          id,
          productId,
          node.type,
          node.title,
          node.description ?? null,
          node.status ?? null,
          node.tags ?? null,
          node.properties ? JSON.stringify(node.properties) : null,
        ],
      )
      await appendAudit(client, {
        productId,
        action: 'create',
        entityType: 'node',
        entityId: id,
        changes: { type: node.type, title: node.title },
      })
      await client.query('COMMIT')
      this.emit(productId, 'node.created', { id, type: node.type, title: node.title })
      return rowToNode(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async updateNode(id: string, patch: Partial<UPGBaseNode>): Promise<UPGBaseNode> {
    const setClauses: string[] = []
    const values: unknown[] = []
    let p = 1

    if (patch.title !== undefined) { setClauses.push(`title = $${p++}`); values.push(patch.title) }
    if (patch.description !== undefined) { setClauses.push(`description = $${p++}`); values.push(patch.description) }
    if (patch.status !== undefined) { setClauses.push(`status = $${p++}`); values.push(patch.status) }
    if (patch.tags !== undefined) { setClauses.push(`tags = $${p++}`); values.push(patch.tags) }
    if (patch.properties !== undefined) {
      setClauses.push(`data = COALESCE(data, '{}'::jsonb) || $${p++}::jsonb`)
      values.push(JSON.stringify(patch.properties))
    }

    if (setClauses.length === 0) {
      const existing = await this.getNode(id)
      if (!existing) throw new Error(`Node not found: ${id}`)
      return existing
    }

    values.push(id)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `UPDATE upg.nodes SET ${setClauses.join(', ')}
         WHERE id = $${p}
         RETURNING ${UPGPgStore.NODE_COLS}`,
        values,
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        throw new Error(`Node not found: ${id}`)
      }
      await appendAudit(client, {
        productId: rows[0].product_id,
        action: 'update',
        entityType: 'node',
        entityId: id,
        changes: patch,
      })
      await client.query('COMMIT')
      this.emit(rows[0].product_id, 'node.updated', { id, ...patch } as Record<string, unknown>)
      return rowToNode(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async removeNode(id: string): Promise<{ node: UPGBaseNode; removedEdgeIds: string[] }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: nodeRows } = await client.query(
        `SELECT ${UPGPgStore.NODE_COLS} FROM upg.nodes WHERE id = $1`,
        [id],
      )
      if (nodeRows.length === 0) {
        await client.query('ROLLBACK')
        throw new Error(`Node not found: ${id}`)
      }

      const { rows: edgeRows } = await client.query<{ id: string }>(
        `DELETE FROM upg.edges WHERE source = $1 OR target = $1 RETURNING id`,
        [id],
      )

      await client.query(`DELETE FROM upg.nodes WHERE id = $1`, [id])
      await appendAudit(client, {
        productId: nodeRows[0].product_id,
        action: 'delete',
        entityType: 'node',
        entityId: id,
        changes: { removed_edge_ids: edgeRows.map((r) => r.id) },
      })
      await client.query('COMMIT')

      this.emit(nodeRows[0].product_id, 'node.deleted', { id })
      return {
        node: rowToNode(nodeRows[0]),
        removedEdgeIds: edgeRows.map((r) => r.id),
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Atomically reparent a node. Deletes any existing containment edge targeting
   * `nodeId`, then inserts a new edge from `newParentId` to `nodeId`.
   *
   * @returns `{ node_id, old_parent_id, new_parent_id, edge_created }`.
   *   `old_parent_id` is `null` when no prior containment edge existed.
   */
  async moveNode(
    productId: string,
    nodeId: string,
    newParentId: string,
    newEdgeType: string,
    newEdgeIdParam: string,
  ): Promise<{
    node_id: string
    old_parent_id: string | null
    new_parent_id: string
    edge_created: { id: string; source: string; target: string; type: string }
  }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Delete any containment edge where this node is the target
      const { rows: deletedEdges } = await client.query<{ id: string; source: string }>(
        `DELETE FROM upg.edges
         WHERE product_id = $1 AND target = $2
         RETURNING id, source`,
        [productId, nodeId],
      )
      const oldParentId = deletedEdges.length > 0 ? deletedEdges[0].source : null

      // Insert new containment edge
      await client.query(
        `INSERT INTO upg.edges (id, product_id, source, target, type)
         VALUES ($1, $2, $3, $4, $5)`,
        [newEdgeIdParam, productId, newParentId, nodeId, newEdgeType],
      )

      await appendAudit(client, {
        productId,
        action: 'update',
        entityType: 'node',
        entityId: nodeId,
        changes: { old_parent_id: oldParentId, new_parent_id: newParentId, edge_type: newEdgeType },
      })

      await client.query('COMMIT')

      this.emit(productId, 'node.updated', { id: nodeId, new_parent_id: newParentId })
      return {
        node_id: nodeId,
        old_parent_id: oldParentId,
        new_parent_id: newParentId,
        edge_created: { id: newEdgeIdParam, source: newParentId, target: nodeId, type: newEdgeType },
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Merge duplicate nodes into a canonical node inside an all-or-nothing
   * Postgres transaction.
   *
   * Steps (in order, inside a single transaction):
   * 1. Rebind all edges from each duplicate to the canonical.
   * 2. Delete self-loops (source = canonical AND target = canonical).
   * 3. Remove duplicate edges (same source, target, type), keeping one.
   * 4. Shallow-merge duplicate properties into canonical (canonical wins).
   * 5. Delete the duplicate nodes.
   *
   * @returns Counts of rebound edges, removed self-loops, removed duplicate
   *   edges, plus the canonical_id and list of merged ids.
   */
  async deduplicateNodes(
    productId: string,
    canonicalId: string,
    duplicateIds: string[],
  ): Promise<{
    canonical_id: string
    merged_ids: string[]
    rebound_edges: number
    removed_self_loops: number
    removed_duplicate_edges: number
  }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      let reboundEdges = 0

      // Step 1: Rebind edges from each duplicate to canonical
      for (const dupId of duplicateIds) {
        const { rowCount: srcCount } = await client.query(
          `UPDATE upg.edges SET source = $1 WHERE source = $2 AND product_id = $3`,
          [canonicalId, dupId, productId],
        )
        const { rowCount: tgtCount } = await client.query(
          `UPDATE upg.edges SET target = $1 WHERE target = $2 AND product_id = $3`,
          [canonicalId, dupId, productId],
        )
        reboundEdges += (srcCount ?? 0) + (tgtCount ?? 0)
      }

      // Step 2: Delete self-loops created by rebinding
      const { rowCount: selfLoopCount } = await client.query(
        `DELETE FROM upg.edges
         WHERE product_id = $1 AND source = $2 AND target = $2`,
        [productId, canonicalId],
      )

      // Step 3: Remove duplicate edges (same source, target, type), keeping one
      const { rowCount: dupEdgeCount } = await client.query(
        `DELETE FROM upg.edges
         WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY source, target, type ORDER BY id
             ) AS rn
             FROM upg.edges WHERE product_id = $1
           ) t WHERE rn > 1
         )`,
        [productId],
      )

      // Step 4: Merge duplicate properties into canonical (canonical wins)
      await client.query(
        `UPDATE upg.nodes
         SET data = (
           SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
           FROM (
             SELECT key, value
             FROM upg.nodes, jsonb_each(COALESCE(data, '{}'::jsonb))
             WHERE id = ANY($2::text[])
             UNION ALL
             SELECT key, value
             FROM upg.nodes, jsonb_each(COALESCE(data, '{}'::jsonb))
             WHERE id = $3
           ) merged
         )
         WHERE id = $3`,
        [productId, duplicateIds, canonicalId],
      )

      // Step 5: Delete duplicates
      await client.query(
        `DELETE FROM upg.nodes WHERE id = ANY($1::text[]) AND product_id = $2`,
        [duplicateIds, productId],
      )

      // Audit each merged-away duplicate as a deletion.
      for (const dupId of duplicateIds) {
        await appendAudit(client, {
          productId,
          action: 'delete',
          entityType: 'node',
          entityId: dupId,
          changes: { merged_into: canonicalId },
        })
      }

      await client.query('COMMIT')

      for (const dupId of duplicateIds) {
        this.emit(productId, 'node.deleted', { id: dupId, merged_into: canonicalId })
      }
      return {
        canonical_id: canonicalId,
        merged_ids: duplicateIds,
        rebound_edges: reboundEdges,
        removed_self_loops: selfLoopCount ?? 0,
        removed_duplicate_edges: dupEdgeCount ?? 0,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  async getAllEdges(productId: string): Promise<UPGEdge[]> {
    const { rows } = await this.pool.query(
      `SELECT id, source, target, type, properties FROM upg.edges WHERE product_id = $1`,
      [productId],
    )
    return rows.map(rowToEdge)
  }

  async getEdgesForNode(nodeId: string): Promise<UPGEdge[]> {
    const { rows } = await this.pool.query(
      `SELECT id, source, target, type, properties FROM upg.edges
       WHERE source = $1 OR target = $1`,
      [nodeId],
    )
    return rows.map(rowToEdge)
  }

  async addEdge(productId: string, edge: UPGEdge): Promise<void> {
    const id = edge.id || edgeId()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO upg.edges (id, product_id, source, target, type, properties)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          productId,
          edge.source,
          edge.target,
          edge.type,
          edge.properties ? JSON.stringify(edge.properties) : null,
        ],
      )
      await appendAudit(client, {
        productId,
        action: 'create',
        entityType: 'edge',
        entityId: id,
        changes: { source: edge.source, target: edge.target, type: edge.type },
      })
      await client.query('COMMIT')
      this.emit(productId, 'edge.created', { id, source: edge.source, target: edge.target, type: edge.type })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async removeEdge(id: string): Promise<UPGEdge> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `DELETE FROM upg.edges WHERE id = $1
         RETURNING id, product_id, source, target, type, properties`,
        [id],
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        throw new Error(`Edge not found: ${id}`)
      }
      await appendAudit(client, {
        productId: rows[0].product_id,
        action: 'delete',
        entityType: 'edge',
        entityId: id,
        changes: { source: rows[0].source, target: rows[0].target, type: rows[0].type },
      })
      await client.query('COMMIT')
      this.emit(rows[0].product_id, 'edge.deleted', { id, source: rows[0].source, target: rows[0].target, type: rows[0].type })
      return rowToEdge(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Set (or merge) the gated `properties` payload on a single edge (0.8.6
   * framework-exercise parity). Merge is the default: the supplied keys are
   * deep-merged at the top level via JSONB `||`; pass `{ merge: false }` to
   * replace the payload wholesale. Mirrors the local SDK's `setEdgeProperties`.
   */
  async setEdgeProperties(
    id: string,
    values: Record<string, unknown>,
    opts: { merge?: boolean } = {},
  ): Promise<UPGEdge> {
    const merge = opts.merge !== false
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const sql = merge
        ? `UPDATE upg.edges
             SET properties = COALESCE(properties, '{}'::jsonb) || $1::jsonb
           WHERE id = $2
           RETURNING id, product_id, source, target, type, properties`
        : `UPDATE upg.edges
             SET properties = $1::jsonb
           WHERE id = $2
           RETURNING id, product_id, source, target, type, properties`
      const { rows } = await client.query(sql, [JSON.stringify(values), id])
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        throw new Error(`Edge not found: ${id}`)
      }
      await appendAudit(client, {
        productId: rows[0].product_id,
        action: 'update',
        entityType: 'edge',
        entityId: id,
        changes: values,
      })
      await client.query('COMMIT')
      this.emit(rows[0].product_id, 'edge.updated', { id, properties: values })
      return rowToEdge(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Edge utilities ─────────────────────────────────────

  /**
   * Flat enumeration of all edges for a product, optionally filtered by type.
   * Used for migration passes. Returns lightweight { id, source, target, type }
   * rows ordered by id without full node payloads.
   */
  async exportEdges(productId: string, types?: string[]) {
    const { rows } = await this.pool.query(
      `SELECT id, source, target, type
       FROM upg.edges
       WHERE product_id = $1
         AND ($2::text[] IS NULL OR type = ANY($2))
       ORDER BY id`,
      [productId, types ?? null],
    )
    return rows
  }

  /**
   * Rename all edges of one type to another within a product.
   * dryRun=true (default): count only. dryRun=false: transactional UPDATE.
   */
  async renameEdgeType(productId: string, from: string, to: string, dryRun = true) {
    if (dryRun) {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::text AS count FROM upg.edges WHERE product_id = $1 AND type = $2`,
        [productId, from],
      )
      return parseInt(rows[0].count, 10)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `UPDATE upg.edges SET type = $3 WHERE product_id = $1 AND type = $2`,
        [productId, from, to],
      )
      await client.query('COMMIT')
      return rowCount ?? 0
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

    // ── Search ─────────────────────────────────────────────────────────────────

  async searchNodes(
    productId: string,
    query: string,
    type?: string,
    limit: number = 20,
  ): Promise<UPGBaseNode[]> {
    const conditions = [
      `product_id = $1`,
      `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')) @@ plainto_tsquery('english', $2)`,
    ]
    const values: unknown[] = [productId, query]
    let p = 3

    if (type) {
      conditions.push(`type = $${p++}`)
      values.push(type)
    }

    values.push(limit)

    const { rows } = await this.pool.query(
      `SELECT ${UPGPgStore.NODE_COLS} FROM upg.nodes
       WHERE ${conditions.join(' AND ')}
       ORDER BY ts_rank(
         to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')),
         plainto_tsquery('english', $2)
       ) DESC
       LIMIT $${p}`,
      values,
    )
    return rows.map(rowToNode)
  }

  // ── Aggregation ────────────────────────────────────────────────────────────

  async getGraphSummary(productId: string): Promise<GraphSummary> {
    const product = await this.getProduct(productId)

    const { rows: ntRows } = await this.pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count FROM upg.nodes WHERE product_id = $1 GROUP BY type`,
      [productId],
    )
    const nodes_by_type: Record<string, number> = {}
    let node_count = 0
    for (const r of ntRows) { const c = parseInt(r.count, 10); nodes_by_type[r.type] = c; node_count += c }

    const { rows: etRows } = await this.pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count FROM upg.edges WHERE product_id = $1 GROUP BY type`,
      [productId],
    )
    const edges_by_type: Record<string, number> = {}
    let edge_count = 0
    for (const r of etRows) { const c = parseInt(r.count, 10); edges_by_type[r.type] = c; edge_count += c }

    const { rows: oRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM upg.nodes n
       WHERE n.product_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM upg.edges e
           WHERE e.product_id = $1 AND (e.source = n.id OR e.target = n.id)
         )`,
      [productId],
    )
    const orphan_count = parseInt(oRows[0].count, 10)

    return { product: { id: product.id, title: product.title, stage: product.stage }, node_count, edge_count, nodes_by_type, edges_by_type, orphan_count }
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async getProductGraph(productId: string): Promise<{ product: Product; nodes: UPGBaseNode[]; edges: UPGEdge[] }> {
    const [product, nodes, edges] = await Promise.all([
      this.getProduct(productId),
      this.getAllNodes(productId),
      this.getAllEdges(productId),
    ])
    return { product, nodes, edges }
  }

  // ── Collaboration: Audit Log ────────────────────────────────────────────────

  async getAuditLog(productId: string, limit = 50): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query<AuditEntry>(
      `SELECT id, user_id, action, entity_type, entity_id, changes, created_at
       FROM upg.audit_log
       WHERE product_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [productId, limit],
    )
    return rows
  }

  // ── Collaboration: Comments ─────────────────────────────────────────────────

  async addComment(productId: string, nodeId: string, userId: string, body: string): Promise<Comment> {
    const { rows } = await this.pool.query<Comment>(
      `INSERT INTO upg.comments (product_id, node_id, user_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, node_id, user_id, body, created_at`,
      [productId, nodeId, userId, body],
    )
    return rows[0]
  }

  async listComments(nodeId: string): Promise<Comment[]> {
    const { rows } = await this.pool.query<Comment>(
      `SELECT id, node_id, user_id, body, created_at
       FROM upg.comments
       WHERE node_id = $1
       ORDER BY created_at DESC`,
      [nodeId],
    )
    return rows
  }

  // ── Collaboration: Access Control ───────────────────────────────────────────

  async grantAccess(productId: string, userId: string, role: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO upg.access (product_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [productId, userId, role],
    )
  }

  async listCollaborators(productId: string): Promise<AccessRecord[]> {
    const { rows } = await this.pool.query<AccessRecord>(
      `SELECT id, user_id, role, created_at
       FROM upg.access
       WHERE product_id = $1
       ORDER BY created_at`,
      [productId],
    )
    return rows
  }

  // ── Analytics ─────────────────────────────────────────────────────────────────

  async getGraphAnalytics(productId: string): Promise<GraphAnalytics> {
    // 1. Hypothesis velocity: count by status
    const { rows: hvRows } = await this.pool.query<{ status: string; count: string }>(
      `SELECT COALESCE(status, 'untested') AS status, COUNT(*)::text AS count
       FROM upg.nodes
       WHERE product_id = $1 AND type = 'hypothesis'
       GROUP BY COALESCE(status, 'untested')`,
      [productId],
    )
    const hv = { untested: 0, testing: 0, validated: 0, invalidated: 0 }
    for (const r of hvRows) {
      const s = r.status as keyof typeof hv
      if (s in hv) hv[s] = parseInt(r.count, 10)
    }

    // 2. Coverage ratio: % of personas with complete chains
    //    (persona → jtbd → pain_point → opportunity → solution)
    const { rows: coverageRows } = await this.pool.query<{ total: string; covered: string }>(
      `WITH personas AS (
         SELECT id FROM upg.nodes WHERE product_id = $1 AND type = 'persona'
       ),
       covered AS (
         SELECT DISTINCT p.id
         FROM personas p
         JOIN upg.edges e1 ON e1.source = p.id
         JOIN upg.nodes jtbd ON jtbd.id = e1.target AND jtbd.type = 'jtbd'
         JOIN upg.edges e2 ON e2.source = jtbd.id
         JOIN upg.nodes pp ON pp.id = e2.target AND pp.type = 'pain_point'
         JOIN upg.edges e3 ON e3.source = pp.id
         JOIN upg.nodes opp ON opp.id = e3.target AND opp.type = 'opportunity'
         JOIN upg.edges e4 ON e4.source = opp.id
         JOIN upg.nodes sol ON sol.id = e4.target AND sol.type = 'solution'
       )
       SELECT
         (SELECT COUNT(*)::text FROM personas) AS total,
         (SELECT COUNT(*)::text FROM covered) AS covered`,
      [productId],
    )
    const totalPersonas = parseInt(coverageRows[0].total, 10)
    const coveredPersonas = parseInt(coverageRows[0].covered, 10)
    const coverage_ratio = totalPersonas > 0
      ? Math.round((coveredPersonas / totalPersonas) * 100)
      : 0

    // 3. Evidence density: (learnings + research_insights) / hypotheses
    const { rows: edRows } = await this.pool.query<{ evidence: string; hypotheses: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM upg.nodes WHERE product_id = $1 AND type IN ('learning', 'research_insight')) AS evidence,
         (SELECT COUNT(*)::text FROM upg.nodes WHERE product_id = $1 AND type = 'hypothesis') AS hypotheses`,
      [productId],
    )
    const evidenceCount = parseInt(edRows[0].evidence, 10)
    const hypothesisCount = parseInt(edRows[0].hypotheses, 10)
    const evidence_density = hypothesisCount > 0
      ? Math.round((evidenceCount / hypothesisCount) * 100) / 100
      : 0

    // 4. Stale entity rate: % of nodes whose last update is 14+ days old
    const { rows: staleRows } = await this.pool.query<{ total: string; stale: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE updated_at < now() - INTERVAL '14 days')::text AS stale
       FROM upg.nodes
       WHERE product_id = $1`,
      [productId],
    )
    const totalNodes = parseInt(staleRows[0].total, 10)
    const staleNodes = parseInt(staleRows[0].stale, 10)
    const stale_entity_rate = totalNodes > 0
      ? Math.round((staleNodes / totalNodes) * 100)
      : 0

    // 5. Orphan rate: % of nodes with no edges
    const { rows: orphanRows } = await this.pool.query<{ total: string; orphans: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM upg.edges e
             WHERE e.product_id = $1 AND (e.source = n.id OR e.target = n.id)
           )
         )::text AS orphans
       FROM upg.nodes n
       WHERE n.product_id = $1`,
      [productId],
    )
    const totalForOrphan = parseInt(orphanRows[0].total, 10)
    const orphanCount = parseInt(orphanRows[0].orphans, 10)
    const orphan_rate = totalForOrphan > 0
      ? Math.round((orphanCount / totalForOrphan) * 100)
      : 0

    return { hypothesis_velocity: hv, coverage_ratio, evidence_density, stale_entity_rate, orphan_rate }
  }

  // ── Product Area Scoping ─────────────────────────────────────────────────────

  async listProductAreas(productId: string): Promise<Array<{ id: string; title: string; child_count: number }>> {
    const { rows } = await this.pool.query<{ id: string; title: string; child_count: string }>(
      `SELECT n.id, n.title,
              (SELECT COUNT(*)::text FROM upg.edges e WHERE e.source = n.id AND e.product_id = $1) AS child_count
       FROM upg.nodes n
       WHERE n.product_id = $1 AND n.type = 'product_area'
       ORDER BY n.title`,
      [productId],
    )
    return rows.map((r) => ({ id: r.id, title: r.title, child_count: parseInt(r.child_count, 10) }))
  }

  async getAreaGraph(
    productId: string,
    areaId: string,
    depth: number,
  ): Promise<{
    area: { id: string; title: string; type: string }
    nodes: UPGBaseNode[]
    edges: UPGEdge[]
    node_count: number
    edge_count: number
  }> {
    // Verify the area node exists and is a product_area
    const areaNode = await this.getNode(areaId)
    if (!areaNode) throw new Error(`Area node not found: ${areaId}`)
    if (areaNode.type !== 'product_area')
      throw new Error(`Node ${areaId} is type "${areaNode.type}", not "product_area"`)
    if (areaNode.product_id !== productId)
      throw new Error(`Area node ${areaId} does not belong to product ${productId}`)

    // Recursive CTE to walk the graph from the area node
    const { rows: nodeIds } = await this.pool.query<{ id: string }>(
      `WITH RECURSIVE area_walk AS (
         SELECT id, 0 AS depth FROM upg.nodes WHERE id = $1 AND product_id = $2
         UNION
         SELECT CASE WHEN e.source = aw.id THEN e.target ELSE e.source END, aw.depth + 1
         FROM area_walk aw
         JOIN upg.edges e ON (e.source = aw.id OR e.target = aw.id) AND e.product_id = $2
         WHERE aw.depth < $3
       )
       SELECT DISTINCT id FROM area_walk`,
      [areaId, productId, depth],
    )

    if (nodeIds.length === 0) {
      return {
        area: { id: areaNode.id, title: areaNode.title, type: areaNode.type },
        nodes: [],
        edges: [],
        node_count: 0,
        edge_count: 0,
      }
    }

    const ids = nodeIds.map((r) => r.id)

    // Fetch all nodes by IDs
    const { rows: nodeRows } = await this.pool.query(
      `SELECT ${UPGPgStore.NODE_COLS} FROM upg.nodes
       WHERE id = ANY($1) AND product_id = $2`,
      [ids, productId],
    )
    const nodes = nodeRows.map(rowToNode)

    // Fetch all edges between these nodes
    const { rows: edgeRows } = await this.pool.query(
      `SELECT id, source, target, type FROM upg.edges
       WHERE product_id = $1 AND source = ANY($2) AND target = ANY($2)`,
      [productId, ids],
    )
    const edges = edgeRows.map(rowToEdge)

    return {
      area: { id: areaNode.id, title: areaNode.title, type: areaNode.type },
      nodes,
      edges,
      node_count: nodes.length,
      edge_count: edges.length,
    }
  }

  /**
   * Count descendant nodes by type, starting from any node (not restricted to
   * `product_area`). Used by `get_area_context` to summarise area contents.
   *
   * @returns Array of `{ type, count }` rows, excluding the root node itself.
   */
  async getDescendantTypeCounts(
    productId: string,
    rootNodeId: string,
    depth: number,
  ): Promise<Array<{ type: string; count: number }>> {
    const { rows } = await this.pool.query<{ type: string; count: string }>(
      `WITH RECURSIVE sub AS (
         SELECT id, 0 AS depth FROM upg.nodes WHERE id = $1 AND product_id = $2
         UNION
         SELECT CASE WHEN e.source = s.id THEN e.target ELSE e.source END, s.depth + 1
         FROM sub s
         JOIN upg.edges e ON (e.source = s.id OR e.target = s.id) AND e.product_id = $2
         WHERE s.depth < $3
       )
       SELECT n.type, COUNT(*)::text AS count
       FROM sub
       JOIN upg.nodes n ON n.id = sub.id AND n.id != $1
       GROUP BY n.type`,
      [rootNodeId, productId, depth],
    )
    return rows.map((r) => ({ type: r.type, count: parseInt(r.count, 10) }))
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────────

  async registerWebhook(productId: string, event: string, url: string, secret?: string): Promise<Webhook> {
    const { rows } = await this.pool.query<Webhook>(
      `INSERT INTO upg.webhooks (product_id, event, url, secret)
       VALUES ($1, $2, $3, $4)
       RETURNING id, event, url, active, created_at`,
      [productId, event, url, secret ?? null],
    )
    return rows[0]
  }

  async listWebhooks(productId: string): Promise<Webhook[]> {
    const { rows } = await this.pool.query<Webhook>(
      `SELECT id, event, url, active, created_at
       FROM upg.webhooks
       WHERE product_id = $1
       ORDER BY created_at`,
      [productId],
    )
    return rows
  }

  async removeWebhook(id: string): Promise<void> {
    const { rows } = await this.pool.query(
      `DELETE FROM upg.webhooks WHERE id = $1 RETURNING id`,
      [id],
    )
    if (rows.length === 0) throw new Error(`Webhook not found: ${id}`)
  }

  // ── Cross-product edges ────────────────────────────────────────────────────

  async listCrossProductEdges(productId: string): Promise<CrossProductEdge[]> {
    const { rows } = await this.pool.query<CrossProductEdge>(
      `SELECT id, source, target, type, created_by_product_id, created_at
       FROM upg.cross_product_edges
       WHERE created_by_product_id = $1
       ORDER BY created_at DESC`,
      [productId],
    )
    return rows
  }

  async addCrossProductEdge(
    id: string,
    productId: string,
    source: string,
    target: string,
    type: string,
  ): Promise<CrossProductEdge> {
    const { rows } = await this.pool.query<CrossProductEdge>(
      `INSERT INTO upg.cross_product_edges (id, source, target, type, created_by_product_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, source, target, type, created_by_product_id, created_at`,
      [id, source, target, type, productId],
    )
    return rows[0]
  }

  async deleteCrossProductEdge(id: string): Promise<CrossProductEdge> {
    const { rows } = await this.pool.query<CrossProductEdge>(
      `DELETE FROM upg.cross_product_edges WHERE id = $1
       RETURNING id, source, target, type, created_by_product_id, created_at`,
      [id],
    )
    if (rows.length === 0) throw new Error(`Cross-product edge not found: ${id}`)
    return rows[0]
  }

  async productExists(productId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM upg.products WHERE id = $1) AS exists`,
      [productId],
    )
    return rows[0].exists
  }
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToNode(row: any): UPGBaseNode & { product_id: string } {
  const node: UPGBaseNode & { product_id: string } = {
    id: row.id,
    type: row.type,
    title: row.title,
    product_id: row.product_id,
  }
  if (row.description != null) node.description = row.description
  if (row.status != null) node.status = row.status
  if (row.tags != null) node.tags = row.tags
  if (row.data != null) node.properties = row.data
  return node
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEdge(row: any): UPGEdge {
  const edge: UPGEdge = { id: row.id, source: row.source, target: row.target, type: row.type }
  // Gated edge payload (0.8.6). JSONB comes back parsed; null/absent → no key.
  if (row.properties != null) edge.properties = row.properties
  return edge
}
