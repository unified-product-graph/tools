/**
 * @unified-product-graph/notion-sync: Notion to UPG pull
 *
 * Reads Notion databases and pages, returns SourceItems compatible with
 * NotionAdapter.convert() from @unified-product-graph/adapters.
 *
 * The pull direction follows the discovery flow from the mapping doc (§6):
 *
 *   1. List databases (filtered by parentPageId or explicit databaseIds)
 *   2. Classify each database against UPG entity types (via name + property heuristics)
 *   3. Query all pages in high/medium confidence databases
 *   4. Map pages → SourceItems (compatible with NotionAdapter.convert())
 *   5. Attach metadata.relation_ids for post-import edge resolution
 *
 * Database classification is implemented inline here as heuristics.
 *
 * TODO: Replace with classifyDatabases() from
 * @unified-product-graph/adapters once that work lands:
 *
 *   import { classifyDatabases } from '@unified-product-graph/adapters'
 */

import type { SourceItem } from '@unified-product-graph/adapters'
import type { NotionSyncClient, NotionDatabaseInfo, NotionPage } from './client.js'

// ─── Classification types ─────────────────────────────────────────────────────

/** Confidence level for a database classification */
export type ClassificationConfidence = 'high' | 'medium' | 'low'

/** Result of classifying a Notion database as a UPG entity type */
export interface DatabaseClassification {
  database_id: string
  database_title: string
  /** Best-match UPG entity type ('unknown' if we can't classify) */
  entity_type: string
  confidence: ClassificationConfidence
  /** Matched signals (for debugging / user review) */
  matched_signals: string[]
}

// ─── Database name → UPG type heuristics ─────────────────────────────────────
//
// Maps common Notion database name patterns to UPG entity types.
// Keyed by lowercase substring patterns that appear in real workspace names.
// Ordered longest-first to prefer specific matches over generic ones.

const DB_NAME_PATTERNS: Array<{ pattern: RegExp; entity_type: string }> = [
  { pattern: /\bfeature request/i, entity_type: 'feature_request' },
  { pattern: /\bkey result/i, entity_type: 'key_result' },
  { pattern: /\bmeeting note/i, entity_type: 'document' },
  { pattern: /\bchangelog/i, entity_type: 'changelog' },
  { pattern: /\bcontent calendar/i, entity_type: 'content_calendar' },
  { pattern: /\bcontent piece/i, entity_type: 'content_piece' },
  { pattern: /\bresearch study/i, entity_type: 'research_study' },
  { pattern: /\bsprint|cycle/i, entity_type: 'sprint' },
  { pattern: /\bstory|user stor/i, entity_type: 'user_story' },
  { pattern: /\bopportunity|opportunit/i, entity_type: 'opportunity' },
  { pattern: /\bhypothes/i, entity_type: 'hypothesis' },
  { pattern: /\bexperiment/i, entity_type: 'experiment' },
  { pattern: /\bresearch|interview/i, entity_type: 'research_study' },
  { pattern: /\binsight/i, entity_type: 'insight' },
  { pattern: /\bobjective|okr/i, entity_type: 'objective' },
  { pattern: /\bmetric|kpi/i, entity_type: 'metric' },
  { pattern: /\bpersona|audience/i, entity_type: 'persona' },
  { pattern: /\bcompetitor|competitive/i, entity_type: 'competitor' },
  { pattern: /\bfeature/i, entity_type: 'feature' },
  { pattern: /\bsolution/i, entity_type: 'solution' },
  { pattern: /\bepic/i, entity_type: 'epic' },
  { pattern: /\broadmap/i, entity_type: 'roadmap_item' },
  { pattern: /\bdecision/i, entity_type: 'decision' },
  { pattern: /\bassumption/i, entity_type: 'assumption' },
  { pattern: /\bbug|defect/i, entity_type: 'bug' },
  { pattern: /\btask|to.?do/i, entity_type: 'task' },
  { pattern: /\bproject/i, entity_type: 'project' },
  { pattern: /\brelease/i, entity_type: 'release' },
  { pattern: /\binitiative/i, entity_type: 'initiative' },
  { pattern: /\bparticipant/i, entity_type: 'participant' },
  { pattern: /\bteam|member/i, entity_type: 'team' },
]

/** Classify a single database by its title and property schema */
export function classifyDatabase(db: NotionDatabaseInfo): DatabaseClassification {
  const signals: string[] = []
  let entityType = 'unknown'
  let confidence: ClassificationConfidence = 'low'

  // Name-based classification (highest signal)
  for (const { pattern, entity_type } of DB_NAME_PATTERNS) {
    if (pattern.test(db.title)) {
      entityType = entity_type
      confidence = 'high'
      signals.push(`title matches /${pattern.source}/`)
      break
    }
  }

  // Property-based signals (secondary classification)
  const propNames = Object.keys(db.properties).map((n) => n.toLowerCase())

  if (propNames.some((n) => /hypothesis|assumption/.test(n))) {
    signals.push('has hypothesis/assumption property')
    if (confidence === 'low') {
      entityType = 'hypothesis'
      confidence = 'medium'
    }
  }

  if (propNames.some((n) => /persona|segment/.test(n))) {
    signals.push('has persona/segment property')
    if (confidence === 'low') {
      entityType = 'persona'
      confidence = 'medium'
    }
  }

  if (propNames.some((n) => /severity|priority/.test(n)) && confidence === 'low') {
    entityType = 'bug'
    confidence = 'medium'
    signals.push('has severity/priority property')
  }

  // Relation properties = edge signals (boost confidence if already matched)
  const hasRelations = Object.values(db.properties).some(
    (p) => p.type === 'relation',
  )
  if (hasRelations && confidence !== 'low') {
    signals.push('has relation properties (edge-aware schema)')
    confidence = 'high'
  }

  return {
    database_id: db.id,
    database_title: db.title,
    entity_type: entityType,
    confidence,
    matched_signals: signals,
  }
}

// ─── Page → SourceItem mapping ────────────────────────────────────────────────

/**
 * Convert a Notion page into a SourceItem for NotionAdapter.convert().
 *
 * Extracts:
 * - title from the title property
 * - description from the first rich_text property
 * - tags from the first multi_select property
 * - status from the first status or select property named "Status"
 * - relation_ids from all relation properties (Notion page IDs → to be
 *   resolved to UPG node IDs after import via the cursor's page_to_node_id map)
 */
function pageToSourceItem(
  page: NotionPage,
  classification: DatabaseClassification,
): SourceItem {
  const meta: Record<string, unknown> = {
    database_id: page.database_id,
    database_name: classification.database_title,
    entity_type: classification.entity_type,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }

  let description: string | undefined
  const tags: string[] = []
  const relationIds: Record<string, string[]> = {}

  for (const [propName, propValue] of Object.entries(page.properties)) {
    const pv = propValue as Record<string, unknown>

    switch (pv.type) {
      case 'rich_text': {
        if (!description && Array.isArray(pv.rich_text)) {
          const texts = pv.rich_text as Array<{ plain_text?: string }>
          const text = texts.map((t) => t.plain_text ?? '').join('')
          if (text) description = text
        }
        break
      }
      case 'multi_select': {
        if (Array.isArray(pv.multi_select)) {
          const values = (pv.multi_select as Array<{ name?: string }>)
            .map((s) => s.name ?? '')
            .filter(Boolean)
          tags.push(...values)
        }
        break
      }
      case 'status': {
        if (typeof (pv.status as Record<string, unknown> | null)?.name === 'string') {
          meta.status = (pv.status as Record<string, unknown>).name
        }
        break
      }
      case 'select': {
        if (
          propName.toLowerCase() === 'status' &&
          typeof (pv.select as Record<string, unknown> | null)?.name === 'string'
        ) {
          meta.status = (pv.select as Record<string, unknown>).name
        }
        break
      }
      case 'relation': {
        if (Array.isArray(pv.relation)) {
          const ids = (pv.relation as Array<{ id?: string }>)
            .map((r) => r.id ?? '')
            .filter(Boolean)
          if (ids.length > 0) {
            relationIds[propName] = ids
          }
        }
        break
      }
    }
  }

  if (tags.length > 0) meta.tags = tags
  if (Object.keys(relationIds).length > 0) {
    // relation_ids: { "Addresses": ["notion-page-id-1", ...] }
    // The sync coordinator resolves these to UPG node_ids post-import.
    meta.relation_ids = relationIds
  }

  return {
    source_id: page.id,
    source_type: 'database_item',
    title: page.title,
    ...(description ? { content: description } : {}),
    metadata: meta,
  }
}

// ─── Pull options & result ────────────────────────────────────────────────────

export interface PullOptions {
  /** Specific database IDs to pull (pulls all discoverable databases if omitted) */
  databaseIds?: string[]
  /** Search for databases under this parent page */
  parentPageId?: string
  /** Fetch block content (expensive, off by default) */
  includeBlocks?: boolean
  /** Pagination cursor for incremental pulls */
  cursor?: string
}

export interface PullResult {
  items: SourceItem[]
  next_cursor: string | null
  database_classifications: DatabaseClassification[]
}

// ─── Core pull function ───────────────────────────────────────────────────────

/**
 * Pull pages from Notion databases and return SourceItems for the adapter.
 */
export async function pullFromNotion(
  client: NotionSyncClient,
  options: PullOptions,
): Promise<PullResult> {
  const { databaseIds, parentPageId, cursor } = options
  const items: SourceItem[] = []
  const classifications: DatabaseClassification[] = []
  let nextCursor: string | null = null

  // ── Discover databases ───────────────────────────────────────────────────────

  let databases: NotionDatabaseInfo[]

  if (databaseIds && databaseIds.length > 0) {
    // Explicit database list: fetch each
    databases = await Promise.all(databaseIds.map((id) => client.getDatabase(id)))
  } else {
    // Discover databases under the parent page (or workspace-wide)
    databases = await client.listDatabases(parentPageId)
  }

  // ── Classify databases ───────────────────────────────────────────────────────

  for (const db of databases) {
    const classification = classifyDatabase(db)
    classifications.push(classification)

    // Only pull from high/medium confidence databases
    if (classification.confidence === 'low') continue

    // ── Query pages ──────────────────────────────────────────────────────────

    try {
      const response = await client.queryDatabase(db.id, cursor)

      for (const page of response.results) {
        items.push(pageToSourceItem(page, classification))
      }

      // Track the last cursor for incremental syncs
      if (response.next_cursor) {
        nextCursor = response.next_cursor
      }
    } catch (err) {
      // Log but don't fail the entire pull for one database
      console.warn(`Failed to query database ${db.title} (${db.id}):`, err)
    }
  }

  return {
    items,
    next_cursor: nextCursor,
    database_classifications: classifications,
  }
}
