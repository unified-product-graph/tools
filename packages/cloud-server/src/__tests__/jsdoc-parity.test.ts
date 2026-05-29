/**
 * JSDoc parity guard for Cloud MCP.
 *
 * Mirror of 's parity test on Local. Locks in 100% `@returns` +
 * `@atomicity` coverage on every advertised tool handler. The richness
 * sweep added `@see` / `@throws` / `@warning` lines on top; the floor
 * enforced here is the minimum two tags every public handler MUST carry
 * so generated TOOLS.md never regresses.
 *
 * Why the floor and not the ceiling: `@see` cross-links are judgment
 * calls (some tools have no kin), `@throws` is conditional on validation
 * paths, `@warning` is reserved for surprise behaviour. `@returns` +
 * `@atomicity` are universal: every handler returns a shape and has an
 * atomicity story.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'tools',
)

interface Export {
  file: string
  name: string
  jsdoc: string
}

/**
 * Parse a tools/*.ts source and extract every public `ToolHandler` export
 * with its preceding JSDoc block.
 */
function extractExports(filePath: string): Export[] {
  const src = readFileSync(filePath, 'utf-8')
  const lines = src.split('\n')
  const exports: Export[] = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^export const (\w+): ToolHandler/,
    )
    if (!m) continue

    let j = i - 1
    while (j >= 0 && lines[j].trim() === '') j--
    if (j < 0 || !lines[j].trim().endsWith('*/')) continue

    const jsdocEnd = j
    while (j >= 0 && !lines[j].trim().startsWith('/**')) j--
    if (j < 0) continue
    const jsdoc = lines.slice(j, jsdocEnd + 1).join('\n')

    exports.push({
      file: filePath,
      name: m[1],
      jsdoc,
    })
  }

  return exports
}

describe('JSDoc parity floor on Cloud tool handlers', () => {
  const files = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(TOOLS_DIR, f))

  const allExports = files.flatMap(extractExports)

  it('discovers a non-trivial number of exported handlers', () => {
    // Cloud has 79 tools; floor at 60 guards against losing half the surface.
    expect(allExports.length).toBeGreaterThanOrEqual(60)
  })

  it('every exported ToolHandler has an @returns tag', () => {
    const missing = allExports
      .filter((e) => !/^[\s*]*\* @returns\b/m.test(e.jsdoc))
      .map((e) => `${e.file.split('/').slice(-2).join('/')}::${e.name}`)

    expect(missing, `Tools missing @returns:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('every exported ToolHandler has an @atomicity tag', () => {
    const missing = allExports
      .filter((e) => !/^[\s*]*\* @atomicity\b/m.test(e.jsdoc))
      .map((e) => `${e.file.split('/').slice(-2).join('/')}::${e.name}`)

    expect(missing, `Tools missing @atomicity:\n  ${missing.join('\n  ')}`).toEqual([])
  })
})
