/**
 * push.test.ts — UPG → Notion push tests
 *
 * Verifies that pushToNotion() makes the correct Notion API calls given a
 * minimal NotionWorkspacePlan, using a mocked NotionSyncClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pushToNotion } from '../push.js'
import type { NotionWorkspacePlan, PushOptions } from '../push.js'
import type { NotionSyncClient } from '../client.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARENT_PAGE_ID = 'parent-page-abc123'

const MINIMAL_PLAN: NotionWorkspacePlan = {
  databases: [
    {
      title: 'Opportunities',
      entity_type: 'opportunity',
      description: 'UPG opportunity entities',
      properties: {
        Name: { type: 'title' },
        Description: { type: 'rich_text' },
        Status: { type: 'status' },
        'UPG ID': { type: 'rich_text' },
      },
    },
    {
      title: 'Features',
      entity_type: 'feature',
      description: 'UPG feature entities',
      properties: {
        Name: { type: 'title' },
        Description: { type: 'rich_text' },
        'UPG ID': { type: 'rich_text' },
      },
    },
  ],
  nodes: [
    {
      node_id: 'n_opp_1',
      entity_type: 'opportunity',
      properties: {
        Name: {
          type: 'title',
          title: [{ text: { content: 'Slow onboarding' } }],
        },
        Description: {
          type: 'rich_text',
          rich_text: [{ text: { content: 'Users drop off during first 5 minutes' } }],
        },
      },
      relations: {
        'Drives features': ['n_feat_1'],
      },
    },
    {
      node_id: 'n_feat_1',
      entity_type: 'feature',
      properties: {
        Name: {
          type: 'title',
          title: [{ text: { content: 'Quick start wizard' } }],
        },
      },
      relations: {},
    },
  ],
}

// ─── Mock client factory ──────────────────────────────────────────────────────

function makeMockClient(): NotionSyncClient {
  let dbCounter = 0
  let pageCounter = 0

  const mockNotionInner = {
    databases: {
      create: vi.fn().mockImplementation(async () => {
        dbCounter++
        return { id: `db-${dbCounter}` }
      }),
    },
    pages: {
      update: vi.fn().mockResolvedValue({}),
    },
  }

  const client = {
    notion: mockNotionInner,
    createDatabase: vi.fn().mockImplementation(async () => {
      dbCounter++
      return `db-${dbCounter}`
    }),
    createPage: vi.fn().mockImplementation(async () => {
      pageCounter++
      return `page-${pageCounter}`
    }),
    updatePage: vi.fn().mockResolvedValue(undefined),
    getDatabase: vi.fn(),
    listDatabases: vi.fn().mockResolvedValue([]),
    getPage: vi.fn(),
    queryDatabase: vi.fn().mockResolvedValue({ results: [], next_cursor: null, has_more: false }),
    search: vi.fn().mockResolvedValue([]),
    getWorkspaceInfo: vi.fn().mockResolvedValue({ id: 'ws-1', name: 'Test Workspace' }),
  } as unknown as NotionSyncClient

  return client
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pushToNotion — database creation', () => {
  it('creates one database per entity type in the plan', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.databases_created).toBe(2)
    expect(result.databases_updated).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('populates entity_to_database_id for each entity type', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.entity_to_database_id).toHaveProperty('opportunity')
    expect(result.entity_to_database_id).toHaveProperty('feature')
    expect(result.entity_to_database_id['opportunity']).toMatch(/^db-/)
    expect(result.entity_to_database_id['feature']).toMatch(/^db-/)
  })

  it('reuses existing databases when existingDatabaseIds is provided', async () => {
    const client = makeMockClient()
    const options: PushOptions = {
      parentPageId: PARENT_PAGE_ID,
      existingDatabaseIds: {
        opportunity: 'existing-db-opp',
        feature: 'existing-db-feat',
      },
    }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.databases_created).toBe(0)
    expect(result.databases_updated).toBe(2)
    expect(result.entity_to_database_id['opportunity']).toBe('existing-db-opp')
    expect(result.entity_to_database_id['feature']).toBe('existing-db-feat')
  })
})

describe('pushToNotion — page creation', () => {
  it('creates one page per node in the plan', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.pages_created).toBe(2)
    expect(result.pages_updated).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('populates node_to_page_id for each node', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.node_to_page_id).toHaveProperty('n_opp_1')
    expect(result.node_to_page_id).toHaveProperty('n_feat_1')
    expect(result.node_to_page_id['n_opp_1']).toMatch(/^page-/)
    expect(result.node_to_page_id['n_feat_1']).toMatch(/^page-/)
  })

  it('calls createPage with the correct database ID', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    await pushToNotion(MINIMAL_PLAN, client, options)

    expect(client.createPage).toHaveBeenCalledTimes(2)
    // Both calls should be made with a database ID (not null or undefined)
    for (const call of (client.createPage as ReturnType<typeof vi.fn>).mock.calls) {
      expect(typeof call[0]).toBe('string')
      expect(call[0].length).toBeGreaterThan(0)
    }
  })
})

describe('pushToNotion — relation wiring (Phase 3)', () => {
  it('calls updatePage to wire relation properties', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    // n_opp_1 has one relation: 'Drives features' → [n_feat_1]
    expect(client.updatePage).toHaveBeenCalledTimes(1)
    expect(result.relations_linked).toBe(1)
  })

  it('includes the correct target page ID in the relation value', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    const updateCall = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0]
    const sourcePageId = updateCall[0] as string
    const relationProps = updateCall[1] as Record<string, unknown>

    // Source page should be n_opp_1's page
    expect(sourcePageId).toBe(result.node_to_page_id['n_opp_1'])

    // Relation should point to n_feat_1's page
    const relation = (relationProps['Drives features'] as Record<string, unknown>)
    expect(relation.type).toBe('relation')
    const targets = relation.relation as Array<{ id: string }>
    expect(targets).toHaveLength(1)
    expect(targets[0].id).toBe(result.node_to_page_id['n_feat_1'])
  })
})

describe('pushToNotion — dry run mode', () => {
  it('does not call any write APIs in dry-run mode', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID, dryRun: true }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(client.notion.databases.create).not.toHaveBeenCalled()
    expect(client.createPage).not.toHaveBeenCalled()
    expect(client.updatePage).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(0)
  })

  it('still returns the correct counts in dry-run mode', async () => {
    const client = makeMockClient()
    const options: PushOptions = { parentPageId: PARENT_PAGE_ID, dryRun: true }

    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    expect(result.databases_created).toBe(2)
    expect(result.pages_created).toBe(2)
  })
})

describe('pushToNotion — error handling', () => {
  it('records errors and continues when a database creation fails', async () => {
    const client = makeMockClient()
    let callCount = 0

    // Make the first databases.create call fail
    ;(client.notion.databases.create as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Notion API error: insufficient permissions')
        }
        return { id: `db-${callCount}` }
      },
    )

    const options: PushOptions = { parentPageId: PARENT_PAGE_ID }
    const result = await pushToNotion(MINIMAL_PLAN, client, options)

    // Expect at least one error from the DB creation failure.
    // Additional errors may be recorded for nodes whose database creation failed.
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    expect(result.errors[0]).toContain('Failed to create database')
    // The second database should still succeed
    expect(result.databases_created).toBe(1)
  })
})
