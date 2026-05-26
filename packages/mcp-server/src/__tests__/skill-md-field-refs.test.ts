/**
 * — Every `chains.X` / `health.X` / `lens_digest.X` reference in a
 * canonical SKILL.md must resolve against the real `get_graph_digest` output.
 *
 * Why this exists: PR #1679's `/upg-impact` density gate referenced
 * `chains.feature_with_no_blockers`, a field that doesn't exist. The gate
 * compiled in markdown but never fired at runtime — caught only by Ro
 * Laren grepping the codebase mid-audit. This test pins the contract so
 * any future drift fails CI.
 *
 * Baseline before this test: N/A (new contract). `/upg-impact`'s fictional
 * field was patched by PR #1681 before this test landed, so the
 * suite passes against the current source.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── Valid field catalog ─────────────────────────────────────────────────────
//
// These sets are the source of truth for what fields exist in a runtime
// `get_graph_digest` response. When you add a new chains/health/lens_digest
// field in `tools/context.ts` or `lib/tools.ts`, add it here too — that's
// the explicit contract between the digest computation and the skills that
// reference it.

const VALID_CHAINS_KEYS = new Set([
  'persona_with_job',
  'persona_total',
  'job_with_need',
  'job_total',
  'opportunity_with_solution',
  'opportunity_total',
  'hypothesis_untested',
  'hypothesis_total',
  'experiment_with_learning',
  'experiment_total',
])

const VALID_HEALTH_KEYS = new Set([
  'orphan_count',
  'orphan_rate',
  'connectivity',
  'validation_rate',
  'user_coverage',
])

const VALID_LENS_DIGEST_KEYS = new Set([
  // engineering
  'open_bugs',
  'blockers',
  'in_flight_features',
  'active_debt',
  'blocked_features',
  'open_investigations',
  // design
  'screens_mapped',
  'components_audited',
  'flows_complete',
  'tokens_defined',
  'design_decisions',
  // growth
  'funnels_defined',
  'channels_active',
  'campaigns_running',
  // product (default lens)
  'personas',
  'outcomes',
  'hypotheses_validated',
])

// ── SKILL.md discovery ──────────────────────────────────────────────────────

const SKILLS_DIR = resolve(__dirname, '..', '..', 'skills')

function listSkillMdFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMd = join(SKILLS_DIR, entry.name, 'SKILL.md')
    try {
      if (statSync(skillMd).isFile()) out.push(skillMd)
    } catch {
      // Directory without SKILL.md — skip
    }
  }
  return out.sort()
}

// ── Reference extraction ────────────────────────────────────────────────────

/**
 * Match `chains.foo_bar`, `health.foo_bar`, `lens_digest.foo_bar` references.
 * The trailing `\b` boundary stops `chains.persona_with_job_total` from
 * accidentally matching `chains.persona_with_job` as a prefix.
 *
 * Excludes obvious template placeholders like `chains.X` (single letter)
 * and `chains.<something>` (angle brackets) — those are documentation
 * shorthand, not real refs.
 */
const REF_PATTERN = /\b(chains|health|lens_digest)\.([a-z_]{2,}[a-z0-9_]*)\b/g

interface Reference {
  namespace: 'chains' | 'health' | 'lens_digest'
  field: string
  filePath: string
  line: number
}

function extractReferences(filePath: string): Reference[] {
  const refs: Reference[] = []
  const lines = readFileSync(filePath, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    REF_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = REF_PATTERN.exec(lines[i])) !== null) {
      refs.push({
        namespace: match[1] as Reference['namespace'],
        field: match[2],
        filePath,
        line: i + 1,
      })
    }
  }
  return refs
}

function isValidReference(ref: Reference): boolean {
  switch (ref.namespace) {
    case 'chains':
      return VALID_CHAINS_KEYS.has(ref.field)
    case 'health':
      return VALID_HEALTH_KEYS.has(ref.field)
    case 'lens_digest':
      return VALID_LENS_DIGEST_KEYS.has(ref.field)
  }
}

// ── The contract ────────────────────────────────────────────────────────────

describe(' — SKILL.md digest field refs must resolve against real fields', () => {
  it('every chains.X / health.X / lens_digest.X reference in any SKILL.md is a real field', () => {
    const files = listSkillMdFiles()
    expect(files.length).toBeGreaterThan(0) // sanity — there's at least one SKILL.md

    const allRefs = files.flatMap(extractReferences)
    const invalid = allRefs.filter((r) => !isValidReference(r))

    if (invalid.length > 0) {
      const report = invalid
        .map(
          (r) =>
            `  ${r.filePath.replace(SKILLS_DIR + '/', '')}:${r.line} → ${r.namespace}.${r.field}`,
        )
        .join('\n')
      const namespacesUsed = Array.from(new Set(invalid.map((r) => r.namespace)))
      const validForEach = namespacesUsed
        .map((ns) => {
          const set =
            ns === 'chains'
              ? VALID_CHAINS_KEYS
              : ns === 'health'
                ? VALID_HEALTH_KEYS
                : VALID_LENS_DIGEST_KEYS
          return `  ${ns}: ${[...set].sort().join(', ')}`
        })
        .join('\n')
      throw new Error(
        `\n${invalid.length} invalid digest field reference(s) found in SKILL.md files:\n${report}\n\n` +
          `Valid fields for the namespaces used:\n${validForEach}\n\n` +
          `Either fix the SKILL.md to reference a real field, or — if this is a new field — add it to the digest computation (lib/tools.ts / tools/context.ts) AND to the VALID_*_KEYS sets in this test (src/__tests__/skill-md-field-refs.test.ts).`,
      )
    }
  })

  it('detects the historical bug (chains.feature_with_no_blockers) in a synthetic SKILL.md', () => {
    // Sanity-check the detector against the exact failure mode it's guarding
    // against. We don't write a real file — just run the extractor against a
    // synthetic string with the regex's behaviour.
    const synthetic = `
      ### Graph Readiness Check
      - \`chains.feature_with_no_blockers\` equals total features → surface gate.
      - \`chains.persona_with_job\` is real, so this should validate.
    `
    REF_PATTERN.lastIndex = 0
    const matches: { namespace: string; field: string }[] = []
    let m: RegExpExecArray | null
    while ((m = REF_PATTERN.exec(synthetic)) !== null) {
      matches.push({ namespace: m[1], field: m[2] })
    }
    expect(matches).toEqual([
      { namespace: 'chains', field: 'feature_with_no_blockers' },
      { namespace: 'chains', field: 'persona_with_job' },
    ])
    expect(VALID_CHAINS_KEYS.has('feature_with_no_blockers')).toBe(false)
    expect(VALID_CHAINS_KEYS.has('persona_with_job')).toBe(true)
  })
})
