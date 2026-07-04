/**
 * Snapshot guard for the cloud server's `instructions` string. If
 * SERVER_INSTRUCTIONS changes, update `__fixtures__/server-instructions.txt`.
 * Also asserts the ratified SEE/THINK/ACT/LEARN preamble is present VERBATIM
 * (parity with the local server).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_INSTRUCTIONS } from '../server.js'

const fixturePath = join(fileURLToPath(import.meta.url), '..', '__fixtures__', 'server-instructions.txt')

describe('cloud SERVER_INSTRUCTIONS', () => {
  it('matches the checked-in fixture', () => {
    const fixture = readFileSync(fixturePath, 'utf8').replace(/\n$/, '')
    expect(SERVER_INSTRUCTIONS).toBe(fixture)
  })

  it('opens with the ratified methodology preamble (verbatim, parity with local)', () => {
    expect(SERVER_INSTRUCTIONS.startsWith('How to work: the graph is a loop you advance, not a form you fill.')).toBe(true)
    expect(SERVER_INSTRUCTIONS).toMatch(/- SEE\. Orient before you write: get_graph_digest or get_product_context first\./)
    expect(SERVER_INSTRUCTIONS).toMatch(/- THINK\. Before creating an entity or edge, call get_entity_schema for the type\./)
    expect(SERVER_INSTRUCTIONS).toMatch(/- ACT\. Write atomically \(batch_\* with parent_ref chaining\)\./)
    expect(SERVER_INSTRUCTIONS).toMatch(/- LEARN\. Close on evidence: validate_graph for drift/)
  })

  it('points spec introspection at the faceted surface (no retired tool names)', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/list_catalog\(\{ kind \}\)/)
    expect(SERVER_INSTRUCTIONS).toMatch(/get_catalog_entry\(\{ kind, id \}\)/)
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\blist_playbooks\b/)
  })
})
