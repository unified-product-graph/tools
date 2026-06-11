/**
 * Server auto-start bundling guard (`shouldAutoStart`).
 *
 * mcp-server's index.js is BOTH the library entry (the CLI imports `runMcpServer`)
 * and the bin (`node dist/index.js` / `npx @unified-product-graph/mcp-server`
 * auto-start). The CLI bundles this module into its single-file `cli.cjs`, and a
 * bundler rewrites `import.meta.url` to the bundle path — which made the old
 * realpath-only guard match `argv[1]` and auto-start a SECOND server alongside
 * the CLI's own `runMcpServer()` for `mcp run`. Two servers on one stdin meant
 * every request was handled twice and every write duplicated. These pin the fix:
 * auto-start only when our own `index.js` is genuinely the executed entry.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shouldAutoStart } from '../index.js'

describe('shouldAutoStart (server auto-start bundling guard)', () => {
  it('does NOT auto-start when inlined into another tool bundle (cli.cjs)', () => {
    // The exact failure: bundled, argv[1] and the rewritten selfUrl both point at
    // cli.cjs. The basename guard rejects it -> the CLI starts only one server.
    expect(shouldAutoStart('/x/dist/cli.cjs', pathToFileURL('/x/dist/cli.cjs').href)).toBe(false)
  })

  it('does NOT auto-start without an argv[1]', () => {
    expect(shouldAutoStart(undefined, pathToFileURL('/x/dist/index.js').href)).toBe(false)
  })

  it('auto-starts when run directly as index.js (node dist/index.js / the bin)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upg-autostart-'))
    const idx = join(dir, 'index.js')
    writeFileSync(idx, '// entry')
    expect(shouldAutoStart(idx, pathToFileURL(idx).href)).toBe(true)
  })

  it('does NOT auto-start when imported as a library (argv[1] is a different file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upg-autostart-'))
    const idx = join(dir, 'index.js')
    writeFileSync(idx, '// entry')
    const other = join(dir, 'importer.js')
    writeFileSync(other, '// importer')
    expect(shouldAutoStart(other, pathToFileURL(idx).href)).toBe(false)
  })
})
