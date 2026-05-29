/**
 * Spec Examples: Round-Trip Validity Test
 *
 * When the canonical UPG spec examples are available as a sibling package
 * (`@unified-product-graph/core`'s `spec/examples/` directory), this suite
 * asserts that every worked example:
 *
 *   1. Parses without errors.
 *   2. Has all required frontmatter fields recognised (spec §3.1).
 *   3. Round-trips through buildIndex without loss.
 *   4. Exports to plain markdown without throwing.
 *
 * When the sibling directory is absent (e.g. this package installed
 * standalone, or in a mirrored OSS repo), the suite skips cleanly.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../parse.js'
import { buildIndex } from '../index-builder.js'
import { toPlainMarkdown } from '../export.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLES_DIR = resolve(__dirname, '../../../upg-spec/spec/examples')

const exampleFiles = existsSync(EXAMPLES_DIR)
  ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.upg.md'))
  : []

describe.skipIf(exampleFiles.length === 0)('spec examples: round-trip validity', () => {
  it('discovers at least 3 worked examples (spec §10 minimum)', () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(3)
  })

  for (const filename of exampleFiles) {
    describe(filename, () => {
      const source = readFileSync(resolve(EXAMPLES_DIR, filename), 'utf-8')
      const result = parse(source)

      it('parses without errors', () => {
        expect(result.errors, `errors in ${filename}: ${JSON.stringify(result.errors)}`).toEqual([])
      })

      it('recognises all required frontmatter fields (spec §3.1)', () => {
        expect(result.frontmatter.title, 'title').toBeTruthy()
        expect(result.frontmatter.upg_product, 'upg_product').toBeTruthy()
        expect(result.frontmatter.upg_version, 'upg_version').toBeTruthy()
        expect(result.frontmatter.entity_type, 'entity_type').toBe('document')
        expect(result.frontmatter.entity_id, 'entity_id').toBeTruthy()
      })

      it('builds a reference index without loss', () => {
        const index = buildIndex(result)
        expect(index.totalEntityRefs).toBe(result.entityRefs.length)
        expect(index.totalEdgeRefs).toBe(result.edgeRefs.length)
      })

      it('exports to plain markdown without throwing', async () => {
        const plain = await toPlainMarkdown(source)
        expect(plain.length, 'plain markdown is non-empty').toBeGreaterThan(0)
      })
    })
  }
})
