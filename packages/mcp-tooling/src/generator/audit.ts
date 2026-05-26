/**
 * Audit gate. Three required fields per tool:
 *
 *   - description (prose body, at least one character).
 *   - `@returns`.
 *   - `@atomicity` (write tools; anything tagged other than
 *     `read-only`).
 *
 * Failures emit precise `file:line` diagnostics and fail the build.
 */

import type { JSDocBlock } from './jsdoc-walker.js'
import type { ToolDefinition } from '../tool-definition.js'

export interface AuditedTool {
  definition: ToolDefinition
  block: JSDocBlock
  domain: string
}

export interface AuditFailure {
  tool: string
  source: string
  reason: string
}

/**
 * Determine if a handler is a write tool (one that mutates the graph or
 * filesystem). Anything whose `@atomicity` value contains the substring
 * `read-only` (e.g. `atomic (read-only)`) counts as a read tool. Tools
 * that omit `@atomicity` entirely count as writes, so the audit
 * REQUIRES the tag for them and surfaces a precise failure.
 */
export function isWriteTool(block: JSDocBlock): boolean {
  if (!block.atomicity) return true
  return !/read-only/i.test(block.atomicity)
}

export function runAudit(tools: AuditedTool[]): AuditFailure[] {
  const failures: AuditFailure[] = []

  for (const { definition, block } of tools) {
    if (!definition.description || definition.description.trim().length === 0) {
      failures.push({
        tool: definition.name,
        source: block.source,
        reason: 'Missing tool description (registry entry has no description body)',
      })
    }

    if (!block.description || block.description.trim().length === 0) {
      failures.push({
        tool: definition.name,
        source: block.source,
        reason: 'Missing JSDoc description on handler',
      })
    }

    if (!block.returns || block.returns.trim().length === 0) {
      failures.push({
        tool: definition.name,
        source: block.source,
        reason: 'Missing @returns tag. Every tool handler documents its return shape so the generated reference and tool-registry description stay accurate.',
      })
    }

    if (isWriteTool(block) && (!block.atomicity || block.atomicity.trim().length === 0)) {
      failures.push({
        tool: definition.name,
        source: block.source,
        reason: 'Missing @atomicity tag. Every write tool declares its transactional behaviour so callers know whether a partial failure can leave the graph in a mixed state. Use one of: `atomic`, `atomic-with-rollback`, `non-atomic`, or `atomic (read-only)`.',
      })
    }
  }

  return failures
}

export function formatFailures(failures: AuditFailure[]): string {
  if (failures.length === 0) return ''
  const lines = [
    `\nUPG MCP tool audit failed. ${failures.length} issue${failures.length === 1 ? '' : 's'}:`,
    '',
  ]
  for (const f of failures) {
    lines.push(`  ✗ ${f.tool}  (${f.source})`)
    lines.push(`      ${f.reason}`)
    lines.push('')
  }
  lines.push('Fix the JSDoc blocks above and re-run `npm run generate-tools`.')
  return lines.join('\n')
}
