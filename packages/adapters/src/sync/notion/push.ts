/**
 * @unified-product-graph/notion-sync: UPG to Notion push
 *
 * Executes a NotionWorkspacePlan against the Notion API.
 *
 * The algorithm follows the three-phase sequence from the mapping doc (§6):
 *
 *   Phase 1: Create databases (schema only, no rows)
 *   Phase 2: Create pages in each database (property values, no relations yet)
 *   Phase 3: Populate relation properties (now that all page_ids are known)
 *
 * This ordering avoids circular reference problems: a relation property needs
 * the target page's ID, which won't exist until that page is created. Creating
 * all pages first, then wiring relations, solves this cleanly.
 *
 * The schema generator (NotionWorkspacePlan) is provided by
 * `@unified-product-graph/adapters`. We import the types here and stub the
 * interface until that work lands.
 */

import type { NotionSyncClient } from './client.js'

// ─── NotionWorkspacePlan (stub interface) ─────────────────────────────────────
//
// TODO: Replace this stub with the real import once the schema generator
// lands in @unified-product-graph/adapters:
//
//   import type {
//     NotionWorkspacePlan,
//     NotionDatabaseSchema,
//     NotionNodePlan,
//   } from '@unified-product-graph/adapters'
//
// The shapes below match the contract described in the mapping doc (§6).
// They will be type-compatible with the adapter's output.

/** A property value to write to a Notion page */
export type NotionPropertyValue =
  | { type: 'title'; title: Array<{ text: { content: string } }> }
  | { type: 'rich_text'; rich_text: Array<{ text: { content: string } }> }
  | { type: 'number'; number: number | null }
  | { type: 'select'; select: { name: string } | null }
  | { type: 'multi_select'; multi_select: Array<{ name: string }> }
  | { type: 'status'; status: { name: string } | null }
  | { type: 'date'; date: { start: string; end?: string } | null }
  | { type: 'checkbox'; checkbox: boolean }
  | { type: 'url'; url: string | null }
  | { type: 'email'; email: string | null }
  | { type: 'unique_id'; unique_id: Record<string, unknown> }
  | { type: 'relation'; relation: Array<{ id: string }> }

/** Notion database property schema definition */
export interface NotionPropertySchema {
  type: string
  /** For relation properties: the target entity type (resolved to database_id at push time) */
  relation_entity_type?: string
}

/** Schema for a Notion database to be created */
export interface NotionDatabaseSchema {
  /** Human-readable name (e.g. "Features", "Opportunities") */
  title: string
  /** The UPG entity type this database represents */
  entity_type: string
  /** Property schema */
  properties: Record<string, NotionPropertySchema>
  /** Optional description */
  description?: string
  /** Optional emoji icon */
  icon?: string
}

/** Plan for a single UPG node to be pushed as a Notion page */
export interface NotionNodePlan {
  /** UPG node ID */
  node_id: string
  /** Entity type: determines which database this page goes into */
  entity_type: string
  /** Property values to write (title, rich_text, etc.) */
  properties: Record<string, NotionPropertyValue>
  /**
   * Relation stubs: maps property name → array of UPG node IDs.
   * These are wired in Phase 3 once all page IDs are known.
   */
  relations: Record<string, string[]>
}

/**
 * The complete workspace plan produced by the schema generator.
 *
 * @see @unified-product-graph/adapters notion-schema-generator
 */
export interface NotionWorkspacePlan {
  /** Databases to create, one per entity type present in the graph */
  databases: NotionDatabaseSchema[]
  /** Nodes to push, one per UPG node */
  nodes: NotionNodePlan[]
}

// ─── Push options & result ────────────────────────────────────────────────────

export interface PushOptions {
  /** Notion page ID where databases will be created */
  parentPageId: string
  /** Dry run: log operations without writing to Notion */
  dryRun?: boolean
  /**
   * Existing database IDs from a previous push; enables update mode.
   * Maps entity_type → existing Notion database_id.
   */
  existingDatabaseIds?: Record<string, string>
}

export interface PushResult {
  databases_created: number
  databases_updated: number
  pages_created: number
  pages_updated: number
  relations_linked: number
  errors: string[]
  /** Maps UPG entity_type → Notion database_id */
  entity_to_database_id: Record<string, string>
  /** Maps UPG node_id → Notion page_id */
  node_to_page_id: Record<string, string>
}

// ─── Property value builders ──────────────────────────────────────────────────

/** Build a Notion title property value from a string */
function titleProp(text: string): NotionPropertyValue {
  return { type: 'title', title: [{ text: { content: text } }] }
}

/** Build a rich_text property value from a string */
function richTextProp(text: string): NotionPropertyValue {
  return { type: 'rich_text', rich_text: [{ text: { content: text } }] }
}

/** Convert a NotionPropertyValue to the raw Notion API shape */
function toApiProperty(value: NotionPropertyValue): unknown {
  // The Notion SDK accepts property values directly in their typed shape.
  // We pass through as-is since our types match the API wire format.
  return value
}

// ─── Database schema builder ──────────────────────────────────────────────────

/**
 * Convert our internal NotionDatabaseSchema into Notion SDK create parameters.
 *
 * Note: relation properties require the target database_id to already exist,
 * so we omit them here and add them in a schema update pass after all databases
 * are created (Phase 1b, not yet implemented, tracked as TODO below).
 */
function buildDatabaseCreateParams(
  schema: NotionDatabaseSchema,
  parentPageId: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (propSchema.type === 'relation') {
      // Relations need target db IDs; deferred to Phase 1b
      // TODO: add a Phase 1b pass that updates relation properties once all
      // databases exist (requires a notion.databases.update() call per db).
      continue
    }

    switch (propSchema.type) {
      case 'title':
        properties[name] = { title: {} }
        break
      case 'rich_text':
        properties[name] = { rich_text: {} }
        break
      case 'number':
        properties[name] = { number: {} }
        break
      case 'select':
        properties[name] = { select: {} }
        break
      case 'multi_select':
        properties[name] = { multi_select: {} }
        break
      case 'status':
        properties[name] = { status: {} }
        break
      case 'date':
        properties[name] = { date: {} }
        break
      case 'checkbox':
        properties[name] = { checkbox: {} }
        break
      case 'url':
        properties[name] = { url: {} }
        break
      case 'email':
        properties[name] = { email: {} }
        break
      case 'unique_id':
        properties[name] = { unique_id: {} }
        break
      default:
        // Unknown type: skip with a comment
        break
    }
  }

  // Every UPG-generated database gets a UPG_ID field for sync anchoring.
  // This stores the UPG node_id so we can round-trip without scanning titles.
  properties['UPG ID'] = { rich_text: {} }

  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: schema.title } }],
    ...(schema.description
      ? {
          description: [{ type: 'text', text: { content: schema.description } }],
        }
      : {}),
    ...(schema.icon ? { icon: { type: 'emoji', emoji: schema.icon } } : {}),
    properties,
  }
}

// ─── Core push function ───────────────────────────────────────────────────────

/**
 * Execute a NotionWorkspacePlan against the Notion API.
 *
 * Three-phase algorithm:
 *   1. Create databases (schema, no content)
 *   2. Create pages (properties, no relations)
 *   3. Wire relation properties (now all page IDs are known)
 */
export async function pushToNotion(
  plan: NotionWorkspacePlan,
  client: NotionSyncClient,
  options: PushOptions,
): Promise<PushResult> {
  const result: PushResult = {
    databases_created: 0,
    databases_updated: 0,
    pages_created: 0,
    pages_updated: 0,
    relations_linked: 0,
    errors: [],
    entity_to_database_id: {},
    node_to_page_id: {},
  }

  const { parentPageId, dryRun = false, existingDatabaseIds = {} } = options

  // ── Phase 1: Create or reuse databases ──────────────────────────────────────

  for (const dbSchema of plan.databases) {
    const existingId = existingDatabaseIds[dbSchema.entity_type]

    if (existingId) {
      // Reuse the existing database
      result.entity_to_database_id[dbSchema.entity_type] = existingId
      result.databases_updated++
      continue
    }

    if (dryRun) {
      console.log(
        `[dry-run] Would create database: ${dbSchema.title} (${dbSchema.entity_type})`,
      )
      // Use a placeholder ID so Phase 2 can proceed in dry-run mode
      result.entity_to_database_id[dbSchema.entity_type] = `dry-run-db-${dbSchema.entity_type}`
      result.databases_created++
      continue
    }

    try {
      const params = buildDatabaseCreateParams(dbSchema, parentPageId)
      const databaseId = await client.notion.databases.create(
        params as Parameters<typeof client.notion.databases.create>[0],
      )
      result.entity_to_database_id[dbSchema.entity_type] = databaseId.id
      result.databases_created++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to create database ${dbSchema.title}: ${msg}`)
    }
  }

  // ── Phase 2: Create pages (no relations yet) ─────────────────────────────────

  for (const nodePlan of plan.nodes) {
    const databaseId = result.entity_to_database_id[nodePlan.entity_type]

    if (!databaseId) {
      result.errors.push(
        `No database found for entity_type ${nodePlan.entity_type} (node ${nodePlan.node_id})`,
      )
      continue
    }

    // Build page properties; exclude relations (handled in Phase 3)
    const pageProperties: Record<string, unknown> = {}

    for (const [propName, propValue] of Object.entries(nodePlan.properties)) {
      if (propValue.type !== 'relation') {
        pageProperties[propName] = toApiProperty(propValue)
      }
    }

    // Write the UPG node_id into the sync anchor field
    pageProperties['UPG ID'] = toApiProperty(richTextProp(nodePlan.node_id))

    if (dryRun) {
      console.log(
        `[dry-run] Would create page in ${nodePlan.entity_type}: ${nodePlan.node_id}`,
      )
      result.node_to_page_id[nodePlan.node_id] = `dry-run-page-${nodePlan.node_id}`
      result.pages_created++
      continue
    }

    try {
      const pageId = await client.createPage(databaseId, pageProperties)
      result.node_to_page_id[nodePlan.node_id] = pageId
      result.pages_created++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to create page for node ${nodePlan.node_id}: ${msg}`)
    }
  }

  // ── Phase 3: Wire relation properties ───────────────────────────────────────
  //
  // Now that all page IDs are known, populate relation properties on each page.
  // A relation property value is an array of { id: page_id } objects.

  for (const nodePlan of plan.nodes) {
    if (Object.keys(nodePlan.relations).length === 0) continue

    const sourcePageId = result.node_to_page_id[nodePlan.node_id]
    if (!sourcePageId) continue

    const relationProperties: Record<string, unknown> = {}
    let hasRelations = false

    for (const [propName, targetNodeIds] of Object.entries(nodePlan.relations)) {
      const targetPageIds = targetNodeIds
        .map((nodeId) => result.node_to_page_id[nodeId])
        .filter((id): id is string => Boolean(id))

      if (targetPageIds.length === 0) continue

      relationProperties[propName] = {
        type: 'relation',
        relation: targetPageIds.map((id) => ({ id })),
      }
      hasRelations = true
      result.relations_linked += targetPageIds.length
    }

    if (!hasRelations) continue

    if (dryRun) {
      console.log(
        `[dry-run] Would wire ${Object.keys(relationProperties).length} relation(s) on ${nodePlan.node_id}`,
      )
      continue
    }

    try {
      await client.updatePage(sourcePageId, relationProperties)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(
        `Failed to wire relations on node ${nodePlan.node_id} (page ${sourcePageId}): ${msg}`,
      )
    }
  }

  return result
}

// ─── Title prop export (used in tests) ───────────────────────────────────────

export { titleProp, richTextProp }
