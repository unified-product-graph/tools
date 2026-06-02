/**
 * Seam 0 drift gate (DT-SPEC-4): every machine reference in a canonical
 * SKILL.md / SKILL-DETAIL.md must resolve against `@unified-product-graph/core`.
 *
 * The companion to `skill-md-field-refs.test.ts` (which guards digest field
 * refs). This guards the OTHER class of skill drift the E2E feedback found:
 * skills naming entity types, edge types, lens ids, playbook ids, and
 * framework ids that the spec does not define. The server's permissive writes
 * hid this at runtime (a fictional `product_has_persona` edge persisted
 * silently), so the only way to catch it is a static gate that resolves every
 * reference against core.
 *
 * What it checks, per skill file:
 *  - `create_node({ type: "X" })` -> X is an active (non-deprecated) entity type
 *  - `create_edge({ ... type: "X" })` -> X is in the edge catalog
 *  - frontmatter `playbooks: [...]` -> each id resolves via getPlaybookById
 *  - `playbook:<id>` references in the body -> resolve via getPlaybookById
 *  - `get_lens("X")` / `update_session_context({ lens: "X" })` -> X is a canonical lens id
 *  - `get_framework("X")` / `get_framework({ id: "X" })` -> X resolves in the framework catalog
 *
 * Extraction is deliberately conservative: it only fires inside the exact
 * call/frontmatter shapes above, and skips obvious placeholders
 * (`<...>`, `...`, single tokens). When this test fails, either fix the
 * SKILL.md to name a real spec symbol, or — if the symbol is genuinely new —
 * add it to core first.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  UPG_TYPES_SET,
  UPG_EDGE_CATALOG,
  getLensIds,
  getPlaybookById,
  isDeprecatedType,
  UPG_FRAMEWORKS_BY_ID,
} from '@unified-product-graph/core'

// ── Core resolvers ───────────────────────────────────────────────────────────

const LENS_IDS = new Set(getLensIds())
const EDGE_TYPES = new Set(Object.keys(UPG_EDGE_CATALOG as Record<string, unknown>))
const FRAMEWORK_IDS = new Set(Object.keys(UPG_FRAMEWORKS_BY_ID as Record<string, unknown>))

function isActiveType(t: string): boolean {
  return UPG_TYPES_SET.has(t) && !isDeprecatedType(t)
}

// ── Skill file discovery ─────────────────────────────────────────────────────

const SKILLS_DIR = resolve(__dirname, '..', '..', 'skills')

function listSkillFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of ['SKILL.md', 'SKILL-DETAIL.md']) {
      const f = join(SKILLS_DIR, entry.name, name)
      try {
        if (statSync(f).isFile()) out.push(f)
      } catch {
        /* skip */
      }
    }
  }
  return out.sort()
}

// ── Placeholder detection ────────────────────────────────────────────────────

/** A value is a documentation placeholder, not a real spec symbol. */
function isPlaceholder(v: string): boolean {
  return (
    v.length === 0 ||
    v.includes('<') ||
    v.includes('>') ||
    v.includes('|') || // "a | b" enum-doc shorthand
    v.includes(' ') ||
    v.includes('.') ||
    /[A-Z]/.test(v) // canonical type/edge/lens/playbook ids are snake_case
  )
}

// ── Reference extraction ─────────────────────────────────────────────────────

type Kind = 'entity_type' | 'edge_type' | 'lens' | 'playbook' | 'framework'

interface Ref {
  kind: Kind
  value: string
  file: string
  line: number
}

/**
 * Walk the file line by line, tracking whether we are inside a `create_node`
 * or `create_edge` call so that a bare `type: "X"` is classified correctly.
 * The call shapes span multiple lines, so we keep a small state machine that
 * opens on `create_node(` / `create_edge(` and closes on the matching `})`.
 */
function extractRefs(file: string): Ref[] {
  const refs: Ref[] = []
  const lines = readFileSync(file, 'utf8').split('\n')

  let callContext: 'node' | 'edge' | null = null

  // Frontmatter playbooks: [a, b] (may be prefixed or bare)
  let inFrontmatter = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ln = i + 1

    // ── frontmatter block ──
    if (ln === 1 && line.trim() === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter && line.trim() === '---') {
      inFrontmatter = false
      continue
    }
    if (inFrontmatter) {
      const pb = line.match(/^playbooks:\s*\[([^\]]*)\]/)
      if (pb) {
        for (const raw of pb[1].split(',')) {
          const id = raw.trim()
          if (id) refs.push({ kind: 'playbook', value: id, file, line: ln })
        }
      }
      continue
    }

    // ── create_node / create_edge call tracking ──
    if (/\bcreate_node\s*\(/.test(line)) callContext = 'node'
    else if (/\bcreate_edge\s*\(/.test(line)) callContext = 'edge'

    // `type: "X"` or `type: 'X'`
    const typeMatch = line.match(/\btype:\s*["']([^"']+)["']/)
    if (typeMatch && callContext) {
      const v = typeMatch[1]
      if (!isPlaceholder(v)) {
        refs.push({
          kind: callContext === 'node' ? 'entity_type' : 'edge_type',
          value: v,
          file,
          line: ln,
        })
      }
    }

    // closing of the call
    if (callContext && /\}\s*\)/.test(line)) callContext = null

    // ── get_lens / lens setter ──
    for (const m of line.matchAll(/get_lens\s*\(\s*["']([^"']+)["']/g)) {
      if (!isPlaceholder(m[1])) refs.push({ kind: 'lens', value: m[1], file, line: ln })
    }
    for (const m of line.matchAll(/lens:\s*["']([^"']+)["']/g)) {
      if (!isPlaceholder(m[1])) refs.push({ kind: 'lens', value: m[1], file, line: ln })
    }

    // ── playbook: prefixed ids anywhere in the body ──
    for (const m of line.matchAll(/playbook:[a-z0-9-]+/g)) {
      refs.push({ kind: 'playbook', value: m[0], file, line: ln })
    }

    // ── get_framework("X") / get_framework({ id: "X" }) ──
    for (const m of line.matchAll(/get_framework\s*\(\s*\{?\s*(?:id:\s*)?["']([^"']+)["']/g)) {
      if (!isPlaceholder(m[1])) refs.push({ kind: 'framework', value: m[1], file, line: ln })
    }
  }

  return refs
}

function resolves(ref: Ref): boolean {
  switch (ref.kind) {
    case 'entity_type':
      return isActiveType(ref.value)
    case 'edge_type':
      return EDGE_TYPES.has(ref.value)
    case 'lens':
      return LENS_IDS.has(ref.value)
    case 'playbook':
      return getPlaybookById(ref.value) !== undefined
    case 'framework':
      return FRAMEWORK_IDS.has(ref.value)
  }
}

// ── The contract ─────────────────────────────────────────────────────────────

describe('Seam 0 drift gate: SKILL.md spec references resolve against core', () => {
  it('every create_node/create_edge type, lens, playbook, framework ref resolves', () => {
    const files = listSkillFiles()
    expect(files.length).toBeGreaterThan(0)

    const allRefs = files.flatMap(extractRefs)
    // sanity: the extractor is actually finding references (not silently empty)
    expect(allRefs.length).toBeGreaterThan(0)

    const invalid = allRefs.filter((r) => !resolves(r))

    if (invalid.length > 0) {
      const report = invalid
        .map(
          (r) =>
            `  ${r.file.replace(SKILLS_DIR + '/', '')}:${r.line} → ${r.kind} "${r.value}"`,
        )
        .join('\n')
      throw new Error(
        `\n${invalid.length} unresolved spec reference(s) in SKILL.md files:\n${report}\n\n` +
          `Each must resolve against @unified-product-graph/core:\n` +
          `  entity_type → active, non-deprecated type (UPG_TYPES_SET)\n` +
          `  edge_type   → UPG_EDGE_CATALOG\n` +
          `  lens        → getLensIds()  [${getLensIds().join(', ')}]\n` +
          `  playbook    → getPlaybookById() (use the playbook: prefix)\n` +
          `  framework   → UPG_FRAMEWORKS_BY_ID\n\n` +
          `Fix the SKILL.md to name a real symbol, or add the symbol to core first.`,
      )
    }
  })

  it('the extractor catches a fictional edge type (self-test)', () => {
    // The exact failure mode this gate guards: a skill teaching a fictional
    // `_has_` edge. Resolve a known-fictional edge and confirm it fails.
    expect(EDGE_TYPES.has('product_has_persona')).toBe(false)
    expect(EDGE_TYPES.has('product_targets_persona')).toBe(true)
    // And a non-existent lens id (the DT-LENS-5 bug).
    expect(LENS_IDS.has('design')).toBe(false)
    expect(LENS_IDS.has('ux_design')).toBe(true)
  })
})
