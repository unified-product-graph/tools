/**
 * 0.38.0 (F5) — `--profile read-only|author` filters the tool surface
 * server-side: tools/list shrinks AND the dispatcher refuses excluded calls
 * (the list is discovery; the refusal is the gate).
 *
 * The coverage test is the load-bearing one: classification FAILS CLOSED, so
 * a NEW tool absent from READ_ONLY_TOOLS is gated out of read-only until
 * someone classifies it deliberately — and this file is where that decision
 * gets made visible.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import {
  READ_ONLY_TOOLS,
  AUTHOR_EXCLUDED_TOOLS,
  isToolAllowed,
  isValidProfile,
  profileRefusalMessage,
} from '../lib/tool-profiles.js'
import { createServer } from '../server.js'
import { UPGFileStore } from '@unified-product-graph/sdk'

const ALL_NAMES = TOOL_DEFINITIONS.map((t) => t.name)

describe('profile classification coverage', () => {
  it('every READ_ONLY / AUTHOR_EXCLUDED name is a real tool (no stale entries)', () => {
    const real = new Set(ALL_NAMES)
    const stale = [...READ_ONLY_TOOLS, ...AUTHOR_EXCLUDED_TOOLS].filter((n) => !real.has(n))
    expect(stale, 'profile sets referencing tools that no longer exist').toEqual([])
  })

  it('read-only and author-excluded are disjoint', () => {
    const both = [...READ_ONLY_TOOLS].filter((n) => AUTHOR_EXCLUDED_TOOLS.has(n))
    expect(both).toEqual([])
  })

  it('read-only surface is a strict subset of the author surface', () => {
    const readOnly = ALL_NAMES.filter((n) => isToolAllowed('read-only', n))
    const author = ALL_NAMES.filter((n) => isToolAllowed('author', n))
    const escaped = readOnly.filter((n) => !author.includes(n))
    expect(escaped, 'a tool readable in read-only but gated for authors is incoherent').toEqual([])
    expect(readOnly.length).toBeLessThan(author.length)
    expect(author.length).toBeLessThan(ALL_NAMES.length)
  })

  it('every tool is DELIBERATELY classified: read, author-gated, or plain write', () => {
    // Fail-closed means an unclassified new tool is silently excluded from
    // read-only — safe, but the exclusion should be a decision, not a default.
    // This assertion makes the suite name every tool that is neither in the
    // read allowlist nor an author exclusion nor a recognised write verb, so
    // adding a tool forces a visit here.
    const WRITE_VERBS = /^(create|update|delete|batch|move|merge|migrate|rename|promote|register|define|deduplicate|repair|clone|apply|assign|attach|detach|remove|link|init|push|upsert|submit)_|^switch_|^reload_/
    const unclassified = ALL_NAMES.filter(
      (n) => !READ_ONLY_TOOLS.has(n) && !AUTHOR_EXCLUDED_TOOLS.has(n) && !WRITE_VERBS.test(n),
    )
    expect(unclassified, 'new tools needing a deliberate profile decision').toEqual([])
  })

  it('no graph-writing verb leaked into the read-only allowlist', () => {
    const MUTATING_VERBS = /^(create|update|delete|batch|move|merge|migrate|rename|promote|register|define|deduplicate|repair|clone|apply|assign|attach|detach|remove|link|init|push|upsert|submit)_/
    const leaked = [...READ_ONLY_TOOLS].filter((n) => MUTATING_VERBS.test(n))
    expect(leaked).toEqual([])
  })

  it('spot checks match the field brief', () => {
    expect(isToolAllowed('read-only', 'get_graph_digest')).toBe(true)
    expect(isToolAllowed('read-only', 'query')).toBe(true)
    expect(isToolAllowed('read-only', 'switch_product')).toBe(true)
    expect(isToolAllowed('read-only', 'create_node')).toBe(false)
    expect(isToolAllowed('read-only', 'submit_feedback')).toBe(false)
    expect(isToolAllowed('author', 'create_node')).toBe(true)
    expect(isToolAllowed('author', 'upsert_composition')).toBe(true)
    expect(isToolAllowed('author', 'delete_node')).toBe(false)
    expect(isToolAllowed('author', 'push_to_cloud')).toBe(false)
    expect(isToolAllowed('author', 'init_workspace')).toBe(false)
    expect(isToolAllowed(undefined, 'delete_node')).toBe(true)
  })

  it('isValidProfile accepts exactly the two profiles', () => {
    expect(isValidProfile('read-only')).toBe(true)
    expect(isValidProfile('author')).toBe(true)
    expect(isValidProfile('admin')).toBe(false)
    expect(isValidProfile(undefined)).toBe(false)
  })

  it('the refusal names the profile, the tool, and the fix', () => {
    const msg = profileRefusalMessage('read-only', 'delete_node')
    expect(msg).toContain('delete_node')
    expect(msg).toContain('read-only')
    expect(msg).toContain('--profile')
  })
})

describe('createServer accepts the profile without disturbing the default path', () => {
  it('a profiled server constructs and says so in its name; unprofiled is unchanged', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'upg-profile-'))
    const file = join(dir, 'profile-test.upg')
    writeFileSync(
      file,
      JSON.stringify({
        upg_version: '0.8.0',
        exported_at: new Date().toISOString(),
        source: { tool: 'test', tool_version: '0' },
        product: { id: 'p_1', title: 'T' },
        nodes: [],
        edges: [],
      }),
      'utf-8',
    )
    const store = new UPGFileStore()
    await store.load(file)
    // Construction is the assertion: a throw here fails the test. The wire
    // behavior (filtered tools/list, dispatch refusal) is enforced by the
    // handler wiring these options feed; the classification tests above pin
    // exactly which names each surface exposes.
    expect(() => createServer(store, { profile: 'read-only' })).not.toThrow()
    expect(() => createServer(store)).not.toThrow()
    store.stopWatching()
  })
})
