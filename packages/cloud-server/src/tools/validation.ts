/**
 * `validate_graph`: schema-drift detection over a product's Postgres graph.
 *
 * Three drift surfaces:
 *   1. Entity-type drift (nodes outside UPG_TYPES_SET).
 *   2. Edge-type drift (edges outside UPG_EDGE_CATALOG).
 *   3. Property drift (sampled over 500 nodes).
 *
 * Read-only. FK constraints handle dangling-edge enforcement at the database.
 * Pair with `migrate_type` and `rename_edge_type` for remediation.
 */

import {
  UPG_TYPES_SET,
  UPG_EDGE_CATALOG,
  UPG_PROPERTY_SCHEMA,
  UPG_ENTITY_META_BY_NAME,
} from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'

/** All valid edge type strings, derived from the edge catalog keys. */
const VALID_EDGE_TYPES: ReadonlySet<string> = new Set(Object.keys(UPG_EDGE_CATALOG))

/** For each entity type, the list of property keys defined in the schema. */
const SCHEMA_PROPERTIES_BY_TYPE: ReadonlyMap<string, string[]> = buildSchemaPropertiesMap()

function buildSchemaPropertiesMap(): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const [entityType, schema] of Object.entries(UPG_PROPERTY_SCHEMA)) {
    const keys = Object.keys(schema)
    if (keys.length > 0) m.set(entityType, keys)
  }
  return m
}

/** Suggest a canonical replacement for an unknown entity type, if one exists. */
function suggestMigration(unknownType: string): string | null {
  const meta = UPG_ENTITY_META_BY_NAME.get(unknownType)
  if (meta?.replacement) return meta.replacement
  return null
}

// ─── Internal row types for SQL results ───────────────────────────────────────

interface EntityTypeDriftRow { type: string; count: string }
interface EdgeTypeDriftRow { type: string; count: string }
interface CountRow { count: string }
interface NodeSampleRow { type: string; id: string; data: Record<string, unknown> | null }

// ─── Pool accessor ───────────────────────────────────────────────────────────

interface PoolLike {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}

function getPool(store: object): PoolLike {
  return (store as unknown as { pool: PoolLike }).pool
}

/**
 * Validate a product graph for schema drift. Detects entity type drift,
 * edge type drift, and property drift (sampled over 500 nodes). Postgres
 * FK constraints enforce endpoint existence, so intra-product edges stay
 * tied to live endpoints.
 *
 * @returns JSON: `{ valid, product_id, summary, entity_type_drift,
 *   edge_type_drift, property_drift, notes }`.
 * @throws textError when `product_id` is missing or the product
 *   is not visible to the caller.
 * @atomicity atomic (read-only)
 * @warning **Property drift is sampled** (first 500 nodes by id order);
 *   for products beyond 500 nodes the drift list is incomplete. Each
 *   reported type carries one example node id; run again or query
 *   `list_nodes` for full coverage.
 * @see migrate_type
 * @see migrate_cross_edges
 * @see rename_edge_type
 * @see list_anti_patterns
 * @see list_type_migrations
 * @see list_edge_migrations
 * @see inspect
 */
export const validateGraph: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const productId = args.product_id as string

  // Verify the product exists first.
  try {
    await store.getProduct(productId)
  } catch {
    return textError(`Product not found: ${productId}`)
  }

  const pool = getPool(store)

  // ── 1. Total counts ──────────────────────────────────────────────────────────

  const [{ rows: nodeCountRows }, { rows: edgeCountRows }] = await Promise.all([
    pool.query<CountRow>(`SELECT COUNT(*)::text AS count FROM upg.nodes WHERE product_id = $1`, [productId]),
    pool.query<CountRow>(`SELECT COUNT(*)::text AS count FROM upg.edges WHERE product_id = $1`, [productId]),
  ])
  const totalNodes = parseInt(nodeCountRows[0].count, 10)
  const totalEdges = parseInt(edgeCountRows[0].count, 10)

  // ── 2. Entity type drift ─────────────────────────────────────────────────────
  // SQL: select types not in the canonical set, grouped and counted.
  const validTypeLiterals = [...UPG_TYPES_SET].map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')

  const { rows: entityDriftRows } = await pool.query<EntityTypeDriftRow>(
    `SELECT type, COUNT(*)::text AS count
     FROM upg.nodes
     WHERE product_id = $1
       AND type NOT IN (${validTypeLiterals})
     GROUP BY type
     ORDER BY count DESC`,
    [productId],
  )

  const entityTypeDrift = entityDriftRows.map((row) => ({
    type: row.type,
    count: parseInt(row.count, 10),
    suggested_migration: suggestMigration(row.type),
  }))

  // ── 3. Edge type drift ───────────────────────────────────────────────────────
  const validEdgeLiterals = [...VALID_EDGE_TYPES].map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')

  const { rows: edgeDriftRows } = await pool.query<EdgeTypeDriftRow>(
    `SELECT type, COUNT(*)::text AS count
     FROM upg.edges
     WHERE product_id = $1
       AND type NOT IN (${validEdgeLiterals})
     GROUP BY type
     ORDER BY count DESC`,
    [productId],
  )

  const edgeTypeDrift = edgeDriftRows.map((row) => ({
    type: row.type,
    count: parseInt(row.count, 10),
  }))

  // ── 4. Property drift (sampled) ──────────────────────────────────────────────
  // Sample up to 500 nodes. For each typed node that has a property schema,
  // check which schema fields are absent from the node's stored properties.
  // Report one example per entity type (first mismatch found).

  const { rows: sampleRows } = await pool.query<NodeSampleRow>(
    `SELECT type, id, data
     FROM upg.nodes
     WHERE product_id = $1
     LIMIT 500`,
    [productId],
  )

  const propertyDriftByType = new Map<string, { missingFields: string[]; exampleNodeId: string }>()

  for (const row of sampleRows) {
    if (propertyDriftByType.has(row.type)) continue // already have an example for this type
    const schemaFields = SCHEMA_PROPERTIES_BY_TYPE.get(row.type)
    if (!schemaFields) continue // no property schema for this entity type

    const nodeProperties = row.data ?? {}
    const missingFields = schemaFields.filter((field) => !(field in nodeProperties))
    if (missingFields.length > 0) {
      propertyDriftByType.set(row.type, {
        missingFields,
        exampleNodeId: row.id,
      })
    }
  }

  const propertyDrift = [...propertyDriftByType.entries()].map(([entityType, info]) => ({
    entity_type: entityType,
    missing_fields: info.missingFields,
    example_node_id: info.exampleNodeId,
  }))

  // ── Build result ─────────────────────────────────────────────────────────────

  const unknownTypeNodes = entityTypeDrift.reduce((sum, e) => sum + e.count, 0)
  const unknownTypeEdges = edgeTypeDrift.reduce((sum, e) => sum + e.count, 0)
  const valid = unknownTypeNodes === 0 && unknownTypeEdges === 0 && propertyDrift.length === 0

  return text(JSON.stringify({
    valid,
    product_id: productId,
    summary: {
      total_nodes: totalNodes,
      total_edges: totalEdges,
      unknown_type_nodes: unknownTypeNodes,
      unknown_type_edges: unknownTypeEdges,
      property_drift_types: propertyDrift.length,
    },
    entity_type_drift: entityTypeDrift,
    edge_type_drift: edgeTypeDrift,
    property_drift: propertyDrift,
    notes: [
      'Endpoint-existence checks are enforced by Postgres FK constraints, so intra-product edges always have live endpoints.',
      'Property drift is sampled (first 500 nodes). Run again for full coverage on large graphs.',
    ],
  }, null, 2))
}
