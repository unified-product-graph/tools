/**
 * sync.test.ts — Bidirectional sync coordinator tests
 *
 * Verifies that sync() correctly orchestrates push/pull and maintains
 * cursor state across invocations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sync } from '../sync.js'
import type { SyncOptions } from '../types.js'
import { MemoryCursorStorage, emptyCursor } from '../cursor.js'
import type { UPGBaseNode } from '@unified-product-graph/core'
import type { UPGEdge } from '@unified-product-graph/core'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_NODES: UPGBaseNode[] = [
  {
    id: 'n_persona_1',
    type: 'persona',
    title: 'Head of Product',
    description: 'B2B SaaS product lead',
  },
  {
    id: 'n_opp_1',
    type: 'opportunity',
    title: 'Slow onboarding',
    status: 'active',
  },
]

const TEST_EDGES: UPGEdge[] = []

// ─── Mock the Notion client constructor ───────────────────────────────────────
//
// We mock at the module level so sync() gets a fake client.

vi.mock('../client.js', () => {
  class MockNotionSyncClient {
    notion = {
      databases: {
        create: vi.fn().mockImplementation(async () => ({ id: 'db-mock-1' })),
      },
      pages: {
        update: vi.fn().mockResolvedValue({}),
      },
    }
    createDatabase = vi.fn().mockResolvedValue('db-mock-1')
    createPage = vi.fn().mockResolvedValue('page-mock-1')
    updatePage = vi.fn().mockResolvedValue(undefined)
    getDatabase = vi.fn()
    listDatabases = vi.fn().mockResolvedValue([])
    getPage = vi.fn()
    queryDatabase = vi.fn().mockResolvedValue({
      results: [],
      next_cursor: null,
      has_more: false,
    })
    search = vi.fn().mockResolvedValue([])
    getWorkspaceInfo = vi.fn().mockResolvedValue({ id: 'ws-1', name: 'Test' })
  }

  return {
    NotionSyncClient: MockNotionSyncClient,
  }
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sync — cursor persistence', () => {
  it('returns a cursor even on the first run', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'push',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    const result = await sync(TEST_NODES, TEST_EDGES, options)

    expect(result.cursor).toBeDefined()
    expect(result.cursor.last_sync_at).toBeDefined()
  })

  it('does not persist cursor in dry-run mode', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'push',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    await sync(TEST_NODES, TEST_EDGES, options)

    // Cursor should not be saved in dry-run
    const saved = await storage.get('upg-notion-sync:cursor')
    expect(saved).toBeNull()
  })

  it('returns a SyncResult with push when direction is push', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'push',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    const result = await sync(TEST_NODES, TEST_EDGES, options)

    expect(result.push).toBeDefined()
    expect(result.pull).toBeUndefined()
  })

  it('returns a SyncResult with pull when direction is pull', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'pull',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    const result = await sync(TEST_NODES, TEST_EDGES, options)

    expect(result.push).toBeUndefined()
    expect(result.pull).toBeDefined()
  })

  it('returns both push and pull when direction is both', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'both',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    const result = await sync(TEST_NODES, TEST_EDGES, options)

    expect(result.push).toBeDefined()
    expect(result.pull).toBeDefined()
  })

  it('records duration_ms', async () => {
    const storage = new MemoryCursorStorage()
    const options: SyncOptions = {
      direction: 'push',
      parentPageId: 'parent-page-1',
      authToken: 'test-token',
      cursorStorage: storage,
      dryRun: true,
    }

    const result = await sync(TEST_NODES, TEST_EDGES, options)

    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    expect(typeof result.duration_ms).toBe('number')
  })
})

describe('MemoryCursorStorage', () => {
  it('returns null for a key that has not been set', async () => {
    const storage = new MemoryCursorStorage()
    expect(await storage.get('missing')).toBeNull()
  })

  it('stores and retrieves a value', async () => {
    const storage = new MemoryCursorStorage()
    await storage.set('key', 'value')
    expect(await storage.get('key')).toBe('value')
  })

  it('overwrites an existing value', async () => {
    const storage = new MemoryCursorStorage()
    await storage.set('key', 'first')
    await storage.set('key', 'second')
    expect(await storage.get('key')).toBe('second')
  })
})

describe('emptyCursor', () => {
  it('returns a cursor with empty maps', () => {
    const cursor = emptyCursor()
    expect(cursor.node_to_page_id).toEqual({})
    expect(cursor.page_to_node_id).toEqual({})
    expect(cursor.entity_to_database_id).toEqual({})
    expect(cursor.database_cursors).toEqual({})
  })

  it('returns a cursor with a valid last_sync_at', () => {
    const cursor = emptyCursor()
    const date = new Date(cursor.last_sync_at)
    expect(date.getFullYear()).toBe(1970) // epoch — never synced
  })
})
