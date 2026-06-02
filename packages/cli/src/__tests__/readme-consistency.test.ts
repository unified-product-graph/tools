import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Guards the bundled README against drifting back out of sync with the binary
// (field report N2): it had re-introduced the removed Cloud group, a stale
// command count, and an exit-code table that contradicted the CLI. This is the
// "regression check" that keeps the docs honest.

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(resolve(here, '..', '..', 'README.md'), 'utf-8')

describe('bundled CLI README stays consistent with the binary', () => {
  it('names the cli package, not the old mcp package', () => {
    expect(readme).toContain('# @unified-product-graph/cli')
    expect(readme).not.toContain('# @unified-product-graph/mcp\n')
  })

  it('does not advertise the removed Cloud command group', () => {
    for (const dead of ['upg push', 'upg pull', 'upg products', 'upg login', 'upg logout']) {
      expect(readme, `README still mentions removed command: ${dead}`).not.toContain(dead)
    }
    expect(readme).not.toMatch(/###\s+Cloud/)
  })

  it('does not carry a stale hard-coded command count', () => {
    expect(readme).not.toContain('23 commands')
  })

  it('publishes the 0/1/2/3 exit-code table, not the old violations=1 one', () => {
    expect(readme).toContain('3 | Usage error')
    expect(readme).toContain('2 | Validation / policy')
    // The old, contradicting row said violations exit 1.
    expect(readme).not.toContain('Failure / below threshold / violations found')
  })

  it('points MCP setup at the files Claude Code actually reads', () => {
    expect(readme).toContain('.mcp.json')
    expect(readme).not.toContain('.claude/settings.json')
  })

  it('documents the 0.8.4 framework-exercise commands', () => {
    expect(readme).toContain('upg apply')
    expect(readme).toContain('upg score')
  })
})
