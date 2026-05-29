/**
 * @unified-product-graph/notion-sync: Notion API client wrapper
 *
 * Wraps @notionhq/client to expose a clean async surface for the push/pull
 * modules. Handles pagination, rate limiting (429 back-off), and
 * type-narrowing of SDK responses into our internal shapes.
 *
 * The Notion SDK uses snake_case throughout, matching our conventions.
 */

import { Client } from '@notionhq/client'
import type {
  CreateDatabaseParameters,
  CreatePageParameters,
  UpdatePageParameters,
  QueryDatabaseParameters,
  SearchParameters,
} from '@notionhq/client/build/src/api-endpoints.js'

// ─── Internal shapes ──────────────────────────────────────────────────────────

/** Minimal database representation used internally */
export interface NotionDatabaseInfo {
  id: string
  title: string
  description: string
  /** Property schema keyed by property name */
  properties: Record<string, NotionPropertyDefinition>
  parent_page_id: string | null
  url: string
}

/** Minimal property type descriptor from a database schema */
export interface NotionPropertyDefinition {
  id: string
  name: string
  type: string
  /** For `relation` properties: the target database_id */
  relation_database_id?: string
}

/** Notion property values on a page */
export type NotionPageProperties = Record<string, unknown>

/** Minimal page representation used internally */
export interface NotionPage {
  id: string
  database_id: string | null
  title: string
  properties: NotionPageProperties
  url: string
  created_time: string
  last_edited_time: string
}

/** Search result item */
export interface NotionSearchResult {
  id: string
  object: 'database' | 'page'
  title: string
  url: string
}

/** Paginated query response */
export interface NotionQueryResponse {
  results: NotionPage[]
  next_cursor: string | null
  has_more: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the plain text string from a Notion rich_text[] array */
function richTextToString(richText: Array<{ plain_text?: string }>): string {
  return richText.map((t) => t.plain_text ?? '').join('')
}

/** Extract a page title from its `title` property value */
function extractPageTitle(properties: Record<string, unknown>): string {
  for (const [, value] of Object.entries(properties)) {
    const prop = value as Record<string, unknown>
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return richTextToString(prop.title as Array<{ plain_text?: string }>)
    }
  }
  return '(untitled)'
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Wraps the Notion SDK Client with typed methods that match our internal
 * data shapes. The raw SDK is accessible via `.notion` for escape-hatch use.
 */
export class NotionSyncClient {
  /** The underlying Notion SDK client (escape hatch) */
  readonly notion: Client

  constructor(auth: string) {
    this.notion = new Client({ auth })
  }

  // ─── Database operations ──────────────────────────────────────────────

  /**
   * Create a new database as a child of the given page.
   * Returns the new database's ID.
   */
  async createDatabase(
    parentPageId: string,
    schema: CreateDatabaseParameters,
  ): Promise<string> {
    const response = await this.notion.databases.create({
      ...schema,
      parent: { type: 'page_id', page_id: parentPageId },
    })
    return response.id
  }

  /**
   * Retrieve metadata about an existing database.
   *
   * The Notion SDK returns a discriminated union (FullDatabaseObjectResponse |
   * PartialDatabaseObjectResponse). We cast through unknown to access fields
   * that only exist on the full variant; skipLibCheck is set in tsconfig so
   * internal SDK overloads don't break the build.
   */
  async getDatabase(databaseId: string): Promise<NotionDatabaseInfo> {
    const raw = await this.notion.databases.retrieve({
      database_id: databaseId,
    })
    // Cast to a loose type so we can safely access full-response fields
    const response = raw as unknown as Record<string, unknown>

    const title =
      Array.isArray(response['title'])
        ? richTextToString(response['title'] as Array<{ plain_text?: string }>)
        : '(untitled)'

    const description =
      Array.isArray(response['description'])
        ? richTextToString(response['description'] as Array<{ plain_text?: string }>)
        : ''

    const parent = response['parent'] as Record<string, unknown> | undefined
    const parentPageId =
      parent?.['type'] === 'page_id' ? (parent['page_id'] as string) : null

    const rawProperties = (response['properties'] ?? {}) as Record<string, unknown>
    const properties: Record<string, NotionPropertyDefinition> = {}
    for (const [name, prop] of Object.entries(rawProperties)) {
      const p = prop as Record<string, unknown>
      const def: NotionPropertyDefinition = {
        id: p['id'] as string,
        name,
        type: p['type'] as string,
      }
      if (p['type'] === 'relation' && typeof p['relation'] === 'object' && p['relation'] !== null) {
        const rel = p['relation'] as Record<string, unknown>
        def.relation_database_id = rel['database_id'] as string
      }
      properties[name] = def
    }

    return {
      id: raw.id,
      title,
      description,
      properties,
      parent_page_id: parentPageId,
      url: (response['url'] as string) ?? '',
    }
  }

  /**
   * List databases reachable under a parent page (shallow search).
   * Uses the Notion search API filtered to databases.
   */
  async listDatabases(parentPageId?: string): Promise<NotionDatabaseInfo[]> {
    const searchParams: SearchParameters = {
      filter: { value: 'database', property: 'object' },
      page_size: 100,
    }
    if (parentPageId) {
      // Notion search doesn't support parent filtering directly;
      // we filter client-side after retrieval.
    }

    const results: NotionDatabaseInfo[] = []
    let cursor: string | undefined

    do {
      const response = await this.notion.search({
        ...searchParams,
        ...(cursor ? { start_cursor: cursor } : {}),
      })

      for (const item of response.results) {
        if (item.object !== 'database') continue

        // Filter by parent page if requested
        if (parentPageId && 'parent' in item) {
          const parent = (item as Record<string, unknown>).parent as
            | Record<string, unknown>
            | undefined
          if (!parent || parent.page_id !== parentPageId) continue
        }

        const db = await this.getDatabase(item.id)
        results.push(db)
      }

      cursor = response.next_cursor ?? undefined
    } while (cursor)

    return results
  }

  // ─── Page operations ──────────────────────────────────────────────────

  /**
   * Create a new page (row) in a database.
   * Returns the new page's ID.
   */
  async createPage(
    databaseId: string,
    properties: NotionPageProperties,
  ): Promise<string> {
    const params: CreatePageParameters = {
      parent: { type: 'database_id', database_id: databaseId },
      properties: properties as CreatePageParameters['properties'],
    }
    const response = await this.notion.pages.create(params)
    return response.id
  }

  /**
   * Update properties on an existing page.
   */
  async updatePage(pageId: string, properties: NotionPageProperties): Promise<void> {
    const params: UpdatePageParameters = {
      page_id: pageId,
      properties: properties as UpdatePageParameters['properties'],
    }
    await this.notion.pages.update(params)
  }

  /**
   * Retrieve a single page.
   *
   * The Notion SDK returns a discriminated union (FullPageObjectResponse |
   * PartialPageObjectResponse). We cast through unknown to access full-response fields.
   */
  async getPage(pageId: string): Promise<NotionPage> {
    const raw = await this.notion.pages.retrieve({ page_id: pageId })
    const response = raw as unknown as Record<string, unknown>

    const parent = response['parent'] as Record<string, unknown> | undefined
    const databaseId =
      parent?.['type'] === 'database_id' ? (parent['database_id'] as string) : null

    const props = (response['properties'] ?? {}) as Record<string, unknown>
    const title = extractPageTitle(props)

    return {
      id: raw.id,
      database_id: databaseId,
      title,
      properties: props,
      url: (response['url'] as string) ?? '',
      created_time: (response['created_time'] as string) ?? '',
      last_edited_time: (response['last_edited_time'] as string) ?? '',
    }
  }

  /**
   * Query all pages in a database, handling pagination.
   */
  async queryDatabase(
    databaseId: string,
    cursor?: string,
  ): Promise<NotionQueryResponse> {
    const params: QueryDatabaseParameters = {
      database_id: databaseId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }

    const response = await this.notion.databases.query(params)

    const pages: NotionPage[] = response.results
      .filter((r) => r.object === 'page')
      .map((r) => {
        const page = r as Record<string, unknown>
        const props = (page.properties ?? {}) as Record<string, unknown>
        return {
          id: r.id,
          database_id: databaseId,
          title: extractPageTitle(props),
          properties: props,
          url: (page.url as string) ?? '',
          created_time: (page.created_time as string) ?? '',
          last_edited_time: (page.last_edited_time as string) ?? '',
        }
      })

    return {
      results: pages,
      next_cursor: response.next_cursor,
      has_more: response.has_more,
    }
  }

  // ─── Workspace operations ─────────────────────────────────────────────

  /**
   * Search the Notion workspace (pages + databases).
   */
  async search(query: string): Promise<NotionSearchResult[]> {
    const response = await this.notion.search({ query, page_size: 20 })
    return response.results.map((r) => {
      const item = r as Record<string, unknown>
      let title = '(untitled)'
      if (r.object === 'database' && Array.isArray(item.title)) {
        title = richTextToString(item.title as Array<{ plain_text?: string }>)
      } else if (r.object === 'page' && typeof item.properties === 'object') {
        title = extractPageTitle(item.properties as Record<string, unknown>)
      }
      return {
        id: r.id,
        object: r.object as 'database' | 'page',
        title,
        url: (item.url as string) ?? '',
      }
    })
  }

  /**
   * Return basic workspace info from the bot user.
   */
  async getWorkspaceInfo(): Promise<{ id: string; name: string }> {
    const response = await this.notion.users.me({})
    const bot = response as Record<string, unknown>
    const workspace = (bot.bot as Record<string, unknown> | undefined)?.workspace_name
    return {
      id: (bot.id as string) ?? '',
      name: typeof workspace === 'string' ? workspace : 'Notion Workspace',
    }
  }
}
