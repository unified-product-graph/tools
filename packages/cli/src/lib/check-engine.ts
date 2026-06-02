/**
 * The `check` engine — one ranked verdict folding the four governance signals
 * the floor exposes separately (CLI-DESIGN-SPEC §3):
 *
 *   1. structure validity  (verify: dangling edges)
 *   2. health score        (health: 0–100)
 *   3. coverage gaps       (gaps: broken chains)
 *   4. anti-pattern lint   (the curated catalog, ranked high → low)
 *
 * Both `upg check` and `upg fix` consume this, so the verdict a human reads and
 * the remediation `fix` executes come from ONE evaluation — they can't drift.
 *
 * A "finding" is one ranked problem with the command to run. Each finding is
 * either AUTO-REMEDIABLE (a deterministic, safe structural mutation `fix` can
 * perform) or GUIDED (the remediation needs human judgment, so `fix` prints the
 * step rather than fabricating entities).
 *
 * WAVE-1 NOTE — every finding here is currently GUIDED. The curated anti-pattern
 * remediations all need judgment (draft a hypothesis, link a persona to a job),
 * and the obvious structural auto-fix — pruning dangling edges — is unreachable
 * because `UPGFileStore.load` REJECTS a document with an edge to a missing node
 * (it never loads into a fixable in-memory state). The `autoRemediable` flag and
 * `applyAutoFix` registry are kept as the seam a later wave fills once a
 * genuinely deterministic + reachable remediation exists; for now the registry
 * is empty and `fix` always guides.
 */

import {
  collectAntiPatternInputs,
  computeGraphDigest,
  computeHealthScore,
} from '@unified-product-graph/sdk'
import { evaluateAntiPatterns } from '@unified-product-graph/core'
import type { UPGFileStore } from './graph.js'
import type { UPGProductStage } from '@unified-product-graph/core'

export type FindingKind = 'structure' | 'anti-pattern' | 'chain'

export interface Finding {
  /** Stable id (anti-pattern slug, or a structure/chain rule id). */
  id: string
  kind: FindingKind
  /** high | medium | low — drives ranking. */
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  /** Prose remediation (from the catalog or a structural hint). */
  remediation: string
  /** The command a human would run to address it. */
  command: string
  /** True when `fix` can deterministically + safely remediate this. */
  autoRemediable: boolean
}

export interface CheckVerdict {
  product: { title: string; stage?: string }
  health: number
  /** True when there are no structural (validity) violations. */
  structureValid: boolean
  findings: Finding[]
}

const SEVERITY_RANK: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 }

/**
 * Re-derive dangling edges against the in-memory node set. Used only for the
 * `structureValid` flag in the verdict. `UPGFileStore.load` rejects documents
 * with edges to missing nodes, so a loaded store is virtually always clean here;
 * this is a belt-and-braces check, not a `fix` target (see the module note).
 */
function danglingEdges(store: UPGFileStore): string[] {
  const ids = new Set(store.getAllNodes().map((n) => n.id))
  return store
    .getAllEdges()
    .filter((e) => !ids.has(e.source) || !ids.has(e.target))
    .map((e) => e.id)
}

/** Build the full ranked verdict from a loaded store. */
export function buildVerdict(store: UPGFileStore): CheckVerdict {
  const digest = computeGraphDigest(store)
  const health = computeHealthScore(digest)
  const product = store.getProduct() as { title?: string; stage?: string }
  const stage = product?.stage as UPGProductStage | undefined

  const findings: Finding[] = []

  // 4 — anti-pattern lint (curated catalog, stage-gated, already ranked).
  const inputs = collectAntiPatternInputs(store, stage)
  for (const v of evaluateAntiPatterns(inputs)) {
    findings.push({
      id: v.anti_pattern_id,
      kind: 'anti-pattern',
      severity: v.severity,
      title: v.name,
      detail: v.description,
      remediation: v.remediation,
      // Anti-pattern remediations need judgment (drafting hypotheses, linking
      // personas to jobs, etc.) — guided, not auto, in WAVE 1.
      command: guidedCommandFor(v.anti_pattern_id),
      autoRemediable: false,
    })
  }

  // 3 — broken chains (coverage gaps). Surfaced informationally, ranked low.
  const chainPairs: Array<[string, number, number]> = [
    ['persona → job', digest.chains.persona_with_job, digest.chains.persona_total],
    ['job → need', digest.chains.job_with_need, digest.chains.job_total],
    ['opportunity → solution', digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
  ]
  for (const [name, connected, total] of chainPairs) {
    if (total > 0 && connected < total) {
      findings.push({
        id: `chain:${name}`,
        kind: 'chain',
        severity: 'low',
        title: `Broken chain: ${name}`,
        detail: `${connected}/${total} connected`,
        remediation: `Link the unconnected ${name.split(' → ')[0]} entities into the chain.`,
        command: 'upg gaps',
        autoRemediable: false,
      })
    }
  }

  // Rank: severity, then auto-remediable first (a later wave's auto handlers
  // surface ahead of guided ones), then id for stability.
  findings.sort((a, b) => {
    const sd = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (sd !== 0) return sd
    if (a.autoRemediable !== b.autoRemediable) return a.autoRemediable ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  return {
    product: { title: product?.title ?? 'Untitled', ...(stage ? { stage } : {}) },
    health,
    structureValid: danglingEdges(store).length === 0,
    findings,
  }
}

/** A reasonable "run this" command hint for a guided anti-pattern. */
function guidedCommandFor(id: string): string {
  if (id.startsWith('personas-without')) return 'upg at <persona> && upg new job "<job>"'
  if (id.startsWith('features-without')) return 'upg at <feature> && upg new hypothesis "<belief>"'
  if (id.startsWith('objective-without')) return 'upg at <objective> && upg new key_result "<measurable>"'
  if (id.startsWith('orphan')) return 'upg ls --at <orphan>  # then link or archive'
  return 'upg ls  # connect the unlinked entities'
}

/**
 * The auto-fix registry seam (the future wave fills this). WAVE 1 ships no
 * handlers — `applyAutoFix` is unreachable in practice because every finding is
 * GUIDED (`autoRemediable === false`), and the `fix` command guards on that flag
 * before ever calling here. Kept exported so the registry has a single, typed
 * home a later wave extends.
 *
 * @throws always, in WAVE 1 — a caller reaching this has a logic bug (it should
 * have routed a guided finding to the print-the-step path instead).
 */
export function applyAutoFix(_store: UPGFileStore, finding: Finding): { changed: string[] } {
  throw new Error(
    `No auto-fix handler for "${finding.id}". WAVE 1 findings are all guided; ` +
      `route guided findings to the manual-step path, not applyAutoFix.`,
  )
}
