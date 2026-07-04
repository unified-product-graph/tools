/**
 * Guard (UPG 0.19.0 consolidation, §6c): no retired catalog/fold tool NAME may
 * appear in any shipped SKILL.md / SKILL-DETAIL.md. The 48-tool removal is a
 * breaking change; a skill still telling an agent to call `list_regions` would
 * silently break at runtime. This enforces the ~32-skill rewrite — it is not
 * trusted, it is checked.
 *
 * Scope: the 25 list + 15 get + 3 fold names (43). The 5 routers
 * (plan/inspect/prioritise/reflect/trace) are EXCLUDED — they are ordinary
 * English words and the names of surviving `/upg-*` skills, not tool calls.
 *
 * `skill-spec-refs.test.ts` remains the guard for spec SYMBOLS; this is the
 * distinct guard for tool NAMES it never covered.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRetiredTools } from '@unified-product-graph/mcp-tooling'

const SKILLS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'skills')

const contract = loadRetiredTools()
// catalog + fold tool names only (NOT the router/prompt bucket)
const RETIRED_TOOL_NAMES = [
  ...Object.keys(contract.list),
  ...Object.keys(contract.get),
  ...Object.keys(contract.fold),
]

/**
 * Boundary that matches a tool name whether bare (`list_playbooks(`) OR carried
 * on the MCP namespace (`mcp__unified-product-graph__list_playbooks`). A plain
 * `\b<name>\b` MISSES the namespaced form: `_` is a word char, so there is no
 * word boundary between `__` and `list` — which is exactly why four stale refs
 * slipped past the first version of this guard. The left bound excludes only
 * [A-Za-z0-9] (NOT `_`), so it fires after the namespace's `__` and after a
 * space/backtick, but not inside a longer identifier (`forget_playbook`). The
 * right bound excludes `[A-Za-z0-9_]` so `list_playbooks` is not matched inside
 * a longer name.
 */
function retiredNameRegex(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9_])`)
}

function skillFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(SKILLS_DIR)) {
    const dir = join(SKILLS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    for (const fn of ['SKILL.md', 'SKILL-DETAIL.md']) {
      const f = join(dir, fn)
      try {
        statSync(f)
        out.push(f)
      } catch {
        /* absent */
      }
    }
  }
  return out
}

describe('skill guard: no retired tool name in any SKILL.md', () => {
  const files = skillFiles()

  it('finds skill files to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const name of RETIRED_TOOL_NAMES) {
    const re = retiredNameRegex(name)
    it(`no skill references retired tool \`${name}\``, () => {
      const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8')))
      expect(offenders, `retired \`${name}\` still referenced in:\n${offenders.join('\n')}`).toEqual([])
    })
  }
})

// Non-vacuity: the boundary must BITE on the namespaced form (the exact shape
// that slipped past `\b...\b`) and on the bare call form, while ignoring benign
// look-alikes. Guards this guard against silently going vacuous.
describe('skill guard: boundary catches both bare and mcp-namespaced forms', () => {
  it('matches the mcp-namespaced form', () => {
    expect(retiredNameRegex('list_playbooks').test('mcp__unified-product-graph__list_playbooks()')).toBe(true)
  })
  it('matches the bare call form', () => {
    expect(retiredNameRegex('get_playbook').test('call `get_playbook({ id })` here')).toBe(true)
  })
  it('does NOT match a longer identifier that merely contains the name', () => {
    expect(retiredNameRegex('get_playbook').test('forget_playbookish')).toBe(false)
  })
  it('does NOT match the facet replacement', () => {
    expect(retiredNameRegex('list_playbooks').test("list_catalog({ kind: 'playbooks' })")).toBe(false)
  })
})
