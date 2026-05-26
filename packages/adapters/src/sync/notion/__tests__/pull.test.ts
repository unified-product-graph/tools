/**
 * pull.test.ts — Notion → UPG pull tests
 *
 * Verifies that pullFromNotion() produces correct SourceItems given
 * mocked Notion database + page responses.
 */

import { describe, it, expect, vi } from 'vitest'
import { pullFromNotion, classifyDatabase } from '../pull.js'
import type { PullOptions } from '../pull.js'
import type { NotionSyncClient, NotionDatabaseInfo, NotionPage } from '../client.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FEATURES_DB: NotionDatabaseInfo = {
  id: 'db-features',
  title: 'Features',
  description: 'Product features backlog',
  parent_page_id: 'parent-page-abc',
  url: 'https://notion.so/db-features',
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title' },
    Description: { id: 'desc', name: 'Description', type: 'rich_text' },
    Status: { id: 'status', name: 'Status', type: 'status' },
    'Linked opportunities': {
      id: 'rel-opp',
      name: 'Linked opportunities',
      type: 'relation',
      relation_database_id: 'db-opportunities',
    },
  },
}

const OPPORTUNITIES_DB: NotionDatabaseInfo = {
  id: 'db-opportunities',
  title: 'Opportunities',
  description: 'Discovery opportunities',
  parent_page_id: 'parent-page-abc',
  url: 'https://notion.so/db-opportunities',
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title' },
    'Problem statement': { id: 'ps', name: 'Problem statement', type: 'rich_text' },
    Status: { id: 'status', name: 'Status', type: 'status' },
  },
}

const UNCLASSIFIABLE_DB: NotionDatabaseInfo = {
  id: 'db-misc',
  title: 'Employee Benefits Tracker',
  description: '',
  parent_page_id: 'parent-page-abc',
  url: 'https://notion.so/db-misc',
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title' },
    'Employee ID': { id: 'eid', name: 'Employee ID', type: 'number' },
  },
}

function makeFeaturePage(id: string, title: string, status = 'In progress'): NotionPage {
  return {
    id,
    database_id: 'db-features',
    title,
    url: `https://notion.so/${id}`,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-05-01T00:00:00.000Z',
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: title }],
      },
      Description: {
        type: 'rich_text',
        rich_text: [{ plain_text: `Description of ${title}` }],
      },
      Status: {
        type: 'status',
        status: { name: status },
      },
      'Linked opportunities': {
        type: 'relation',
        relation: [{ id: 'opp-page-1' }],
      },
    },
  }
}

// ─── Mock client factory ──────────────────────────────────────────────────────

function makeMockClient(databases: NotionDatabaseInfo[], pages: NotionPage[]): NotionSyncClient {
  const client = {
    notion: {},
    createDatabase: vi.fn(),
    createPage: vi.fn(),
    updatePage: vi.fn(),
    getDatabase: vi.fn().mockImplementation(async (id: string) => {
      const db = databases.find((d) => d.id === id)
      if (!db) throw new Error(`Database not found: ${id}`)
      return db
    }),
    listDatabases: vi.fn().mockResolvedValue(databases),
    getPage: vi.fn(),
    queryDatabase: vi.fn().mockImplementation(async (dbId: string) => {
      const dbPages = pages.filter((p) => p.database_id === dbId)
      return { results: dbPages, next_cursor: null, has_more: false }
    }),
    search: vi.fn().mockResolvedValue([]),
    getWorkspaceInfo: vi.fn().mockResolvedValue({ id: 'ws-1', name: 'Test' }),
  } as unknown as NotionSyncClient

  return client
}

// ─── classifyDatabase tests ───────────────────────────────────────────────────

describe('classifyDatabase', () => {
  it('classifies a Features database as feature with high confidence', () => {
    const result = classifyDatabase(FEATURES_DB)
    expect(result.entity_type).toBe('feature')
    expect(result.confidence).toBe('high')
    expect(result.database_id).toBe('db-features')
  })

  it('classifies an Opportunities database as opportunity with high confidence', () => {
    const result = classifyDatabase(OPPORTUNITIES_DB)
    expect(result.entity_type).toBe('opportunity')
    expect(result.confidence).toBe('high')
  })

  it('classifies an unrecognised database as unknown with low confidence', () => {
    const result = classifyDatabase(UNCLASSIFIABLE_DB)
    expect(result.entity_type).toBe('unknown')
    expect(result.confidence).toBe('low')
  })

  it('boosts confidence to high when the database has relation properties', () => {
    // Features DB has relation properties — should already be high
    const result = classifyDatabase(FEATURES_DB)
    expect(result.confidence).toBe('high')
    expect(result.matched_signals.some((s) => s.includes('relation'))).toBe(true)
  })

  it('includes matched signals in the result', () => {
    const result = classifyDatabase(FEATURES_DB)
    expect(result.matched_signals.length).toBeGreaterThan(0)
  })

  it('handles partial name matches (e.g. "My Team Features")', () => {
    const db: NotionDatabaseInfo = {
      ...FEATURES_DB,
      id: 'db-team-features',
      title: 'My Team Features',
    }
    const result = classifyDatabase(db)
    expect(result.entity_type).toBe('feature')
  })
})

// ─── pullFromNotion tests ─────────────────────────────────────────────────────

describe('pullFromNotion — database discovery', () => {
  it('lists databases from the client when no databaseIds are specified', async () => {
    const client = makeMockClient([FEATURES_DB, OPPORTUNITIES_DB], [])
    const options: PullOptions = {}

    await pullFromNotion(client, options)

    expect(client.listDatabases).toHaveBeenCalledOnce()
  })

  it('fetches specific databases by ID when databaseIds are provided', async () => {
    const client = makeMockClient([FEATURES_DB], [])
    const options: PullOptions = { databaseIds: ['db-features'] }

    await pullFromNotion(client, options)

    expect(client.getDatabase).toHaveBeenCalledWith('db-features')
    expect(client.listDatabases).not.toHaveBeenCalled()
  })

  it('includes database classifications in the result', async () => {
    const client = makeMockClient(
      [FEATURES_DB, OPPORTUNITIES_DB, UNCLASSIFIABLE_DB],
      [],
    )
    const options: PullOptions = {}

    const result = await pullFromNotion(client, options)

    expect(result.database_classifications).toHaveLength(3)
    expect(result.database_classifications.map((c) => c.entity_type)).toContain('feature')
    expect(result.database_classifications.map((c) => c.entity_type)).toContain('opportunity')
    expect(result.database_classifications.map((c) => c.entity_type)).toContain('unknown')
  })

  it('skips low-confidence databases (does not query them)', async () => {
    const client = makeMockClient(
      [FEATURES_DB, UNCLASSIFIABLE_DB],
      [],
    )
    const options: PullOptions = {}

    await pullFromNotion(client, options)

    const queryCalls = (client.queryDatabase as ReturnType<typeof vi.fn>).mock.calls
    const queriedIds = queryCalls.map((c) => c[0] as string)
    expect(queriedIds).toContain('db-features')
    expect(queriedIds).not.toContain('db-misc')
  })
})

describe('pullFromNotion — SourceItem mapping', () => {
  const featurePage = makeFeaturePage('page-feat-1', 'Quick start wizard')
  const featurePage2 = makeFeaturePage('page-feat-2', 'Onboarding checklist', 'Done')

  it('maps Notion pages to SourceItems', async () => {
    const client = makeMockClient([FEATURES_DB], [featurePage, featurePage2])
    const options: PullOptions = {}

    const result = await pullFromNotion(client, options)

    expect(result.items).toHaveLength(2)
    expect(result.items[0].source_id).toBe('page-feat-1')
    expect(result.items[0].source_type).toBe('database_item')
    expect(result.items[0].title).toBe('Quick start wizard')
  })

  it('extracts content from rich_text properties', async () => {
    const client = makeMockClient([FEATURES_DB], [featurePage])
    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    expect(result.items[0].content).toBe('Description of Quick start wizard')
  })

  it('extracts status from status-type properties', async () => {
    const client = makeMockClient([FEATURES_DB], [featurePage])
    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    const meta = result.items[0].metadata ?? {}
    expect(meta.status).toBe('In progress')
  })

  it('includes relation_ids in metadata', async () => {
    const client = makeMockClient([FEATURES_DB], [featurePage])
    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    const meta = result.items[0].metadata ?? {}
    const relationIds = meta.relation_ids as Record<string, string[]>
    expect(relationIds).toBeDefined()
    expect(relationIds['Linked opportunities']).toEqual(['opp-page-1'])
  })

  it('includes database classification metadata on each SourceItem', async () => {
    const client = makeMockClient([FEATURES_DB], [featurePage])
    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    const meta = result.items[0].metadata ?? {}
    expect(meta.database_name).toBe('Features')
    expect(meta.entity_type).toBe('feature')
    expect(meta.database_id).toBe('db-features')
  })
})

describe('pullFromNotion — pagination', () => {
  it('returns next_cursor from database query when available', async () => {
    const client = makeMockClient([FEATURES_DB], [])

    ;(client.queryDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
      next_cursor: 'cursor-abc',
      has_more: true,
    })

    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    expect(result.next_cursor).toBe('cursor-abc')
  })

  it('returns null next_cursor when all pages have been fetched', async () => {
    const client = makeMockClient([FEATURES_DB], [makeFeaturePage('p1', 'Test')])
    const options: PullOptions = {}
    const result = await pullFromNotion(client, options)

    expect(result.next_cursor).toBeNull()
  })
})
