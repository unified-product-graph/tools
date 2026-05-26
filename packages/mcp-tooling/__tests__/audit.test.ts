/**
 * Audit-gate unit tests.
 *
 * These tests pin the contract the reference generator enforces:
 *   - every tool needs a description (registry + JSDoc)
 *   - every tool needs `@returns`
 *   - every write tool needs `@atomicity`
 *
 * Read-only tools opt out of the atomicity gate by including the substring
 * `read-only` in the tag value (e.g. `atomic (read-only)`).
 */

import { describe, it, expect } from 'vitest'
import { runAudit, isWriteTool, type AuditedTool } from '../src/generator/audit.js'
import type { JSDocBlock } from '../src/generator/jsdoc-walker.js'
import type { ToolDefinition } from '../src/tool-definition.js'

function makeTool(
  block: Partial<JSDocBlock> = {},
  def: Partial<ToolDefinition> = {},
): AuditedTool {
  return {
    domain: 'nodes',
    definition: {
      name: 'test_tool',
      description: 'A test tool.',
      inputSchema: { type: 'object', properties: {} },
      ...def,
    },
    block: {
      symbol: 'testTool',
      source: 'src/tools/nodes.ts:1',
      description: 'A test handler.',
      throws: [],
      examples: [],
      warnings: [],
      see: [],
      ...block,
    },
  }
}

describe('isWriteTool', () => {
  it('treats `atomic (read-only)` as a read tool', () => {
    expect(isWriteTool(makeTool({ atomicity: 'atomic (read-only)' }).block)).toBe(false)
  })

  it('treats `atomic` (no read-only marker) as a write tool', () => {
    expect(isWriteTool(makeTool({ atomicity: 'atomic' }).block)).toBe(true)
  })

  it('treats `non-atomic` as a write tool', () => {
    expect(isWriteTool(makeTool({ atomicity: 'non-atomic' }).block)).toBe(true)
  })

  it('treats missing atomicity as a write tool (audit will then require the tag)', () => {
    expect(isWriteTool(makeTool({ atomicity: undefined }).block)).toBe(true)
  })
})

describe('runAudit', () => {
  it('passes a fully-tagged write tool', () => {
    const failures = runAudit([
      makeTool({
        returns: 'JSON: ...',
        atomicity: 'atomic-with-rollback',
      }),
    ])
    expect(failures).toEqual([])
  })

  it('passes a read-only tool with no atomicity required', () => {
    const failures = runAudit([
      makeTool({
        returns: 'JSON: ...',
        atomicity: 'atomic (read-only)',
      }),
    ])
    expect(failures).toEqual([])
  })

  it('fails when @returns is missing', () => {
    const failures = runAudit([
      makeTool({ returns: undefined, atomicity: 'atomic' }),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toMatch(/@returns/)
  })

  it('fails when a write tool has no @atomicity', () => {
    const failures = runAudit([
      makeTool({ returns: 'JSON: ...', atomicity: undefined }),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toMatch(/@atomicity/)
  })

  it('fails when the registry description is missing', () => {
    const failures = runAudit([
      makeTool(
        { returns: 'JSON: ...', atomicity: 'atomic' },
        { description: '' },
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toMatch(/description/)
  })

  it('fails when the JSDoc description is missing', () => {
    const failures = runAudit([
      makeTool({ description: '', returns: 'JSON: ...', atomicity: 'atomic' }),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toMatch(/JSDoc description/)
  })

  it('aggregates multiple failures across multiple tools', () => {
    const failures = runAudit([
      makeTool({ returns: undefined, atomicity: 'atomic' }, { name: 'one' }),
      makeTool({ returns: 'OK', atomicity: undefined }, { name: 'two' }),
    ])
    expect(failures).toHaveLength(2)
    expect(failures.map((f) => f.tool).sort()).toEqual(['one', 'two'])
  })
})
