/**
 * Snapshot test for the MCP server `instructions` string.
 *
 * The instructions are public API: every connecting client reads them in the
 * initialise handshake and uses them to learn how to call the server. A casual
 * edit shouldn't drift the wording; if you're intentionally updating it, also
 * update `__fixtures__/server-instructions.txt`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SERVER_INSTRUCTIONS } from '../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '__fixtures__', 'server-instructions.txt')

describe('SERVER_INSTRUCTIONS', () => {
  it('matches the checked-in fixture', () => {
    const fixture = readFileSync(fixturePath, 'utf8').replace(/\n$/, '')
    expect(SERVER_INSTRUCTIONS).toBe(fixture)
  })

  it('promotes query as the default for graph-wide reads', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Traverse the graph: query/)
    expect(SERVER_INSTRUCTIONS).toMatch(/Default for "show me the graph"/)
  })

  it('warns against the list_nodes overflow footgun', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /DO NOT pass include_edges:true with limit > 50/,
    )
  })
})
