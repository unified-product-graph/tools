/**
 * Tests for the `migrate_status` MCP tool + the `validate_graph`
 * lifecycle_drift suggestion enrichment.
 *
 * Two surfaces under test:
 *
 *  1. The standalone `migrate_status` tool: rewrites legacy status values
 *     to canonical lifecycle phases via `UPG_STATUS_MIGRATIONS`. Mirrors
 *     the dry-run / commit envelope from `migrate_type` and
 *     `migrate_properties`.
 *
 *  2. The `validate_graph` lifecycle_drift entries: now include
 *     `suggested_migration` pointing at `migrate_status` when the
 *     registry resolves the (type, status) pair, omitted otherwise.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type {
  UPGDocument,
  UPGBaseNode,
  UPGEdge,
  UPGEntityType,
} from '@unified-product-graph/core'
import { migrateStatus } from '../tools/migrations.js'
import { validateGraph } from '../tools/validation.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

// ─── Fixture helpers ────────────────────────────────────────────────

function makeDoc(nodes: UPGBaseNode[], edges: UPGEdge[] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: {
      id: 'p1',
      title: 'Status migration fixture',
      stage: 'concept',
    },
    nodes,
    edges,
  }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-migrate-status-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(doc, null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

const node = (
  id: string,
  type: string,
  status: string,
  title = `Node ${id}`,
): UPGBaseNode => ({
  id,
  type: type as UPGEntityType,
  title,
  status,
})

// ─── migrate_status: dry-run ───────────────────────────────────────

describe('migrate_status: dry-run', () => {
  it('reports planned mutations without writing', async () => {
    const store = await loadStore(
      makeDoc([
        node('s1', 'service', 'active'),
        node('s2', 'service', 'inactive'),
        node('f1', 'feature', 'active'),
        node('p1', 'persona', 'active'), // no migration registered, no lifecycle
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus({}, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.dry_run).toBe(true)
    expect(body.migrated_nodes).toBe(3)
    expect(body.changes).toEqual(
      expect.arrayContaining([
        { id: 's1', type: 'service', from: 'active', to: 'production' },
        { id: 's2', type: 'service', from: 'inactive', to: 'deprecated' },
        { id: 'f1', type: 'feature', from: 'active', to: 'shipped' },
      ]),
    )

    // Dry-run must not mutate the store.
    expect(store.getNode('s1')?.status).toBe('active')
    expect(store.getNode('f1')?.status).toBe('active')
  })

  it('counts invalid statuses with no registered migration under skipped_no_migration', async () => {
    const store = await loadStore(
      makeDoc([
        // service:active has a migration (→ production).
        node('s1', 'service', 'active'),
        // service:totally_invalid has no migration registered; skipped.
        node('s2', 'service', 'totally_invalid'),
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus({}, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.migrated_nodes).toBe(1)
    expect(body.skipped_no_migration).toBe(1)
  })

  it('leaves canonical statuses alone', async () => {
    const store = await loadStore(
      makeDoc([
        node('s1', 'service', 'production'), // canonical, not drift
        node('s2', 'service', 'development'), // canonical, not drift
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus({}, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.migrated_nodes).toBe(0)
    expect(body.skipped_no_migration).toBe(0)
  })
})

// ─── migrate_status: apply ─────────────────────────────────────────

describe('migrate_status: apply', () => {
  it('actually rewrites status values when dry_run: false', async () => {
    const store = await loadStore(
      makeDoc([
        node('s1', 'service', 'active'),
        node('f1', 'feature', 'active'),
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus({ dry_run: false }, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.dry_run).toBe(false)
    expect(body.migrated_nodes).toBe(2)
    expect(store.getNode('s1')?.status).toBe('production')
    expect(store.getNode('f1')?.status).toBe('shipped')
  })

  it('idempotent on retry: second commit reports zero changes', async () => {
    const store = await loadStore(makeDoc([node('s1', 'service', 'active')]))
    const ctx = makeCtx(store)

    const first = JSON.parse(
      (await migrateStatus({ dry_run: false }, ctx)).content[0].text,
    )
    expect(first.migrated_nodes).toBe(1)

    const second = JSON.parse(
      (await migrateStatus({ dry_run: false }, ctx)).content[0].text,
    )
    expect(second.migrated_nodes).toBe(0)
  })
})

// ─── migrate_status: filters ───────────────────────────────────────

describe('migrate_status: filters', () => {
  it('entity_type narrows the rewrite scope', async () => {
    const store = await loadStore(
      makeDoc([
        node('s1', 'service', 'active'),
        node('f1', 'feature', 'active'),
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus({ entity_type: 'service' }, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.migrated_nodes).toBe(1)
    expect(body.changes[0]).toMatchObject({ id: 's1', type: 'service' })
  })

  it('from_status + to_status overrides the registry', async () => {
    const store = await loadStore(
      makeDoc([
        // Surgical override: rewrite every service:experimental → staging,
        // regardless of whether the registry knows about "experimental".
        node('s1', 'service', 'experimental'),
        node('s2', 'service', 'experimental'),
        node('s3', 'service', 'active'), // unaffected by the from_status filter
      ]),
    )
    const ctx = makeCtx(store)

    const result = await migrateStatus(
      {
        entity_type: 'service',
        from_status: 'experimental',
        to_status: 'staging',
        dry_run: false,
      },
      ctx,
    )
    const body = JSON.parse(result.content[0].text)

    expect(body.migrated_nodes).toBe(2)
    expect(store.getNode('s1')?.status).toBe('staging')
    expect(store.getNode('s2')?.status).toBe('staging')
    // s3 was not in the from_status filter, so it's untouched.
    expect(store.getNode('s3')?.status).toBe('active')
  })

  it('rejects from_status without to_status', async () => {
    const store = await loadStore(makeDoc([node('s1', 'service', 'active')]))
    const ctx = makeCtx(store)

    const result = await migrateStatus({ from_status: 'active' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('to_status is required')
  })
})

// ─── validate_graph lifecycle_drift suggested_migration enrichment ──

describe('validate_graph: lifecycle_drift suggested_migration', () => {
  it('attaches suggested_migration when UPG_STATUS_MIGRATIONS resolves', async () => {
    const store = await loadStore(
      makeDoc([node('s1', 'service', 'active', 'My Service')]),
    )
    const ctx = makeCtx(store)

    const result = await validateGraph({ scope: 'lifecycle_drift' }, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.lifecycle_drift).toHaveLength(1)
    const drift = body.lifecycle_drift[0]
    expect(drift.id).toBe('s1')
    expect(drift.type).toBe('service')
    expect(drift.status).toBe('active')
    expect(drift.valid_phases).toEqual(
      expect.arrayContaining(['development', 'staging', 'production', 'deprecated']),
    )
    expect(drift.suggested_migration).toEqual({
      kind: 'migrate_status',
      to: 'production',
      via: 'UPG_STATUS_MIGRATIONS',
    })
  })

  it('omits suggested_migration when no migration is registered', async () => {
    const store = await loadStore(
      makeDoc([node('s1', 'service', 'totally_invalid_value')]),
    )
    const ctx = makeCtx(store)

    const result = await validateGraph({ scope: 'lifecycle_drift' }, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.lifecycle_drift).toHaveLength(1)
    const drift = body.lifecycle_drift[0]
    expect(drift.status).toBe('totally_invalid_value')
    expect(drift.suggested_migration).toBeUndefined()
  })

  it('does not emit lifecycle_drift for canonical statuses', async () => {
    const store = await loadStore(
      makeDoc([node('s1', 'service', 'production')]),
    )
    const ctx = makeCtx(store)

    const result = await validateGraph({ scope: 'lifecycle_drift' }, ctx)
    const body = JSON.parse(result.content[0].text)

    expect(body.lifecycle_drift).toEqual([])
  })
})
