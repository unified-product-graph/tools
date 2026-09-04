/**
 * validate_graph header-seal drift: `counts_drift` + `integrity_drift`
 * (feedback 1bb903bf).
 *
 * `$upg.counts` and `$upg.integrity.body` are derived from the body at write
 * time, and until this change nothing read either back. A `.upg` whose header
 * had fallen out of step with its body therefore passed every drift class
 * clean, with `structurally_valid: true`.
 *
 * The reachable cause is an ordinary git merge with no conflict: two branches
 * each append one node, git merges the bodies (different array positions) but
 * sees the identical `"nodes": 1273 → 1274` header hunk on both sides and takes
 * it once. The merged file declares 1274 and holds 1275.
 *
 * These tests reproduce that shape directly — tamper with the header, or with
 * the body, and assert the right class fires — plus the negative cases that
 * matter most: a clean canonical file and a legacy headerless file must both
 * stay silent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { serializeCanonical } from '@unified-product-graph/core'
import type { UPGDocument } from '@unified-product-graph/core'
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

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>
}

/** A small, schema-clean graph: no other drift class may fire and mask ours. */
function baseDoc(): UPGDocument {
  return {
    upg_version: '0.26.0',
    exported_at: '2026-08-12T00:00:00Z',
    source: { tool: 'test' },
    product: { id: 'p_root', title: 'Root', stage: 'concept' },
    nodes: [
      { id: 'n_a', type: 'feature', title: 'Feature A' },
      { id: 'n_b', type: 'feature', title: 'Feature B' },
      { id: 'n_c', type: 'persona', title: 'Persona C' },
    ],
    edges: [],
  } as unknown as UPGDocument
}

/** Write a canonically-sealed `.upg`, then optionally corrupt the parsed JSON. */
function writeGraph(cwd: string, mutate?: (json: Record<string, any>) => void): string {
  const path = join(cwd, '.upg', 'root.upg')
  const canonical = serializeCanonical(baseDoc())
  if (!mutate) {
    writeFileSync(path, canonical)
    return path
  }
  const json = JSON.parse(canonical)
  mutate(json)
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  return path
}

async function loadStore(path: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(path)
  store.stopWatching()
  return store
}

async function validate(store: UPGFileStore, args: Record<string, unknown> = {}) {
  return parse(validateGraph({ skip_anti_patterns: true, ...args }, makeCtx(store)))
}

describe('validate_graph header seal (feedback 1bb903bf)', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'upg-seal-'))
    mkdirSync(join(cwd, '.upg'), { recursive: true })
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it('a freshly-serialised canonical file has no seal drift', async () => {
    const store = await loadStore(writeGraph(cwd))
    const res = await validate(store)

    expect(res.counts_drift).toEqual([])
    expect(res.integrity_drift).toEqual([])
    expect((res.summary as Record<string, unknown>).counts_drift).toBe(0)
    expect((res.summary as Record<string, unknown>).integrity_drift).toBe(0)
    expect(res.structurally_valid).toBe(true)
    expect(res.header_seal_note).toBeUndefined()
  })

  it('reproduces the bad-merge case: header declares one fewer node than the body holds', async () => {
    // Exactly the reporter's shape — git took the counts hunk once, so the
    // declared total lags the body by one. The body itself is untouched and
    // perfectly valid, which is why every other drift class stays silent.
    const path = writeGraph(cwd, (json) => {
      json.$upg.counts.nodes = json.$upg.counts.nodes - 1
    })
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([{ field: 'nodes', declared: 2, actual: 3 }])
    expect((res.summary as Record<string, unknown>).counts_drift).toBe(1)
    // The integrity seal covers the BODY, which the merge left intact — so it
    // must NOT fire here. counts is the only signal that catches this.
    expect(res.integrity_drift).toEqual([])
    // The verdict the reporter watched come back true.
    expect(res.structurally_valid).toBe(false)
    expect(res.valid).toBe(false)
  })

  it('an appended node with no reseal fires BOTH counts and integrity drift', async () => {
    const path = writeGraph(cwd, (json) => {
      json.nodes.push({ id: 'n_d', type: 'feature', title: 'Feature D' })
    })
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([{ field: 'nodes', declared: 3, actual: 4 }])
    const integrity = res.integrity_drift as Array<Record<string, string>>
    expect(integrity).toHaveLength(1)
    expect(integrity[0].algorithm).toBe('sha256-128')
    expect(integrity[0].declared).not.toBe(integrity[0].computed)
    expect(res.structurally_valid).toBe(false)
  })

  it('an edited node body fires integrity drift alone — counts cannot see it', async () => {
    // The case for keeping both classes: a hand-edit that changes content
    // without changing cardinality is invisible to counts and caught only by
    // the checksum.
    const path = writeGraph(cwd, (json) => {
      json.nodes[0].title = 'Feature A (tampered)'
    })
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([])
    expect(res.integrity_drift).toHaveLength(1)
    expect(res.structurally_valid).toBe(false)
  })

  it('a stale counts key left behind at zero is caught in the other direction', async () => {
    const path = writeGraph(cwd, (json) => {
      json.$upg.counts.watched_products = 2 // never derived for a single-product doc
    })
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([{ field: 'watched_products', declared: 2, actual: 0 }])
  })

  it('a legacy flat file declares no header and so cannot drift', async () => {
    // Guards every pre-existing test in this suite, which writes bare
    // { product, nodes, edges } documents with no `$upg` block at all.
    const path = join(cwd, '.upg', 'root.upg')
    writeFileSync(path, JSON.stringify(baseDoc(), null, 2))
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([])
    expect(res.integrity_drift).toEqual([])
    expect(res.structurally_valid).toBe(true)
  })

  it('an unrecognised format_version reports a note instead of false drift', async () => {
    const path = writeGraph(cwd, (json) => {
      json.$upg.format_version = '9.9.9'
    })
    const store = await loadStore(path)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([])
    expect(res.integrity_drift).toEqual([])
    expect(res.header_seal_note).toContain('9.9.9')
    expect(res.structurally_valid).toBe(true)
  })

  it('unsaved in-memory writes are not reported as seal drift', async () => {
    // The file on disk stays self-consistent until it is flushed, so a pending
    // write must not masquerade as a stale header.
    const store = await loadStore(writeGraph(cwd))
    store.addNode({ id: 'n_mem', type: 'feature', title: 'Added in memory' } as never)
    const res = await validate(store)

    expect(res.counts_drift).toEqual([])
    expect(res.integrity_drift).toEqual([])
  })

  describe('scope selection', () => {
    it('scope: counts_drift returns counts only', async () => {
      const path = writeGraph(cwd, (json) => {
        json.nodes.push({ id: 'n_d', type: 'feature', title: 'Feature D' })
      })
      const res = await validate(await loadStore(path), { scope: 'counts_drift' })

      expect(res.counts_drift).toHaveLength(1)
      expect(res.integrity_drift).toBeUndefined()
    })

    it('scope: integrity_drift returns integrity only', async () => {
      const path = writeGraph(cwd, (json) => {
        json.nodes.push({ id: 'n_d', type: 'feature', title: 'Feature D' })
      })
      const res = await validate(await loadStore(path), { scope: 'integrity_drift' })

      expect(res.integrity_drift).toHaveLength(1)
      expect(res.counts_drift).toBeUndefined()
    })

    it('an unrelated scope withholds the arrays but still counts and still gates', async () => {
      const path = writeGraph(cwd, (json) => {
        json.$upg.counts.nodes = 0
      })
      const res = await validate(await loadStore(path), { scope: 'entity_drift' })

      // Scope still governs which ENTRY ARRAYS come back. That half is unchanged.
      expect(res.counts_drift).toBeUndefined()
      expect(res.integrity_drift).toBeUndefined()

      // What changed in 0.41.0 (F2): the count and the verdict no longer
      // depend on which class the caller asked to see. This graph's header
      // says 0 nodes over a body that has some, and it said so before the
      // scope was chosen. Reporting structurally_valid: true here was a false
      // all-clear in the exact signal the seal check exists to protect: the
      // comment on that check calls a gate which stays green through a
      // corrupted merge "worth little", and this was that gate going green.
      // The cost of the correction is one file re-read on a call that already
      // walks every node and edge.
      expect((res.summary as { counts_drift: number }).counts_drift).toBe(1)
      expect(res.structurally_valid).toBe(false)
    })

    it('both classes are listed as valid scopes in the error message', async () => {
      const store = await loadStore(writeGraph(cwd))
      // textError returns a plain-text body, not JSON — read it directly.
      const raw = validateGraph({ scope: 'nope' }, makeCtx(store)) as {
        content: Array<{ text: string }>
      }
      expect(raw.content[0].text).toContain('counts_drift')
      expect(raw.content[0].text).toContain('integrity_drift')
    })
  })

  it('upg fmt is the repair: reserialising the file clears both classes', async () => {
    const path = writeGraph(cwd, (json) => {
      json.nodes.push({ id: 'n_d', type: 'feature', title: 'Feature D' })
    })
    const dirty = await validate(await loadStore(path))
    expect(dirty.structurally_valid).toBe(false)

    // What `upg fmt` does: parse → re-serialise, which restamps counts and the
    // body checksum from the body actually present.
    const { formatUpgText } = await import('@unified-product-graph/core')
    writeFileSync(path, formatUpgText(readFileSync(path, 'utf-8')))

    const healed = await validate(await loadStore(path))
    expect(healed.counts_drift).toEqual([])
    expect(healed.integrity_drift).toEqual([])
    expect(healed.structurally_valid).toBe(true)
  })
})
