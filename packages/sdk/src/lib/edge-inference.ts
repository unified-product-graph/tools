import {
  getReplacementType,
  pickCanonicalEdge,
  UPG_EDGE_TYPES,
  UPG_TYPES,
} from '@unified-product-graph/core'
import type { UPGEdgeType } from '@unified-product-graph/core'

/**
 * Tiered edge type inference.
 *
 * Tier 1 (Core): source/target match a verb-anchored core edge.
 * Tier 2 (Extended): catalog-listed edge for the source/target pair.
 * Reject: neither tier hits, even after resolving deprecated source/target
 *   through `getReplacementType`. The previous Tier-3 fallback used to
 *   fabricate `${source}_contains_${target}` as a placeholder, which silently
 *   wrote non-canonical edge types into the graph.
 */

// ── Tier 1: Core lookup ──────────────────────────────────────────────────────

const CORE_EDGE_LOOKUP = new Map<string, UPGEdgeType>()

for (const edgeType of UPG_EDGE_TYPES) {
  // Parse "source_verb_target" patterns (has, produces, informs, addresses, pursues, relates_to)
  const match = edgeType.match(/^(\w+?)_(has|produces|informs|addresses|pursues|relates_to)_(\w+)$/)
  if (match) {
    const [, sourceType, , targetType] = match
    CORE_EDGE_LOOKUP.set(`${sourceType}:${targetType}`, edgeType)
  }
}

// ── Inference result shapes ──────────────────────────────────────────────────

export interface EdgeAlias {
  /** Original (often deprecated) type the caller passed */
  from: string
  /** Canonical replacement resolved via @unified-product-graph/core's deprecation map */
  to: string
}

export interface EdgeInferenceSuggestion {
  source_type: string
  target_type: string
  edge_type: UPGEdgeType
}

export type EdgeInferenceOk = {
  ok: true
  edgeType: UPGEdgeType
  tier: 'core' | 'extended'
  /** Set when source and/or target were resolved via getReplacementType. */
  aliased?: EdgeAlias[]
  warning?: string
}

export type EdgeInferenceFail = {
  ok: false
  reason: string
  /** Pairs that DO resolve in the catalog; best-effort near-misses. */
  suggestions: EdgeInferenceSuggestion[]
  /** Source/target after deprecation resolution, for diagnostics. */
  resolved: { source_type: string; target_type: string }
}

export type EdgeInferenceResult = EdgeInferenceOk | EdgeInferenceFail

// ── Levenshtein-1 candidates ─────────────────────────────────────────────────

/** True iff a and b are within edit distance ≤ 1. Linear-time, no allocations. */
function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true
  const al = a.length
  const bl = b.length
  if (Math.abs(al - bl) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < al && j < bl) {
    if (a[i] !== b[j]) {
      if (++edits > 1) return false
      if (al > bl) i++
      else if (bl > al) j++
      else {
        i++
        j++
      }
    } else {
      i++
      j++
    }
  }
  if (i < al || j < bl) edits++
  return edits <= 1
}

function nearMissTypes(name: string): string[] {
  const matches: string[] = []
  for (const t of UPG_TYPES) {
    if (t === name) continue
    if (withinEditDistance1(t, name)) matches.push(t)
  }
  return matches
}

/**
 * Suggest catalog-resolvable (source, target) pairs for a failed inference.
 *
 * 1. Build candidate sets via Levenshtein-1 against UPG_TYPES.
 * 2. Always include the resolved input type in its own candidate set so a
 *    typo on one side still surfaces good pairs on the other.
 * 3. Cross-product the candidate sets, keep pairs that hit the catalog.
 */
function suggestEdgePairs(sourceType: string, targetType: string): EdgeInferenceSuggestion[] {
  const sourceCandidates = new Set<string>([sourceType, ...nearMissTypes(sourceType)])
  const targetCandidates = new Set<string>([targetType, ...nearMissTypes(targetType)])
  const out: EdgeInferenceSuggestion[] = []
  for (const s of sourceCandidates) {
    for (const t of targetCandidates) {
      if (s === sourceType && t === targetType) continue
      // UPG_EDGE_PAIR_MAP is `Record<string, UPGEdgeType[]>`.
      // Use pickCanonicalEdge for the single deterministic answer per pair.
      const edgeType = pickCanonicalEdge(s, t)
      if (edgeType) out.push({ source_type: s, target_type: t, edge_type: edgeType })
    }
  }
  // Cap suggestions; agents don't need the full cross-product.
  return out.slice(0, 5)
}

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Infers the canonical edge type for a (sourceType, targetType) pair, or
 * reports a structured failure when neither the raw nor alias-resolved pair
 * appears in the catalog. Never fabricates a Tier-3 string.
 */
export function inferEdgeTypeWithTier(
  sourceType: string,
  targetType: string,
): EdgeInferenceResult {
  // Resolve deprecated source/target via the spec's migration map BEFORE
  // catalog lookup. A `jtbd → need` request becomes `job → need`.
  const canonicalSource = getReplacementType(sourceType) ?? sourceType
  const canonicalTarget = getReplacementType(targetType) ?? targetType
  const aliased: EdgeAlias[] = []
  if (canonicalSource !== sourceType) aliased.push({ from: sourceType, to: canonicalSource })
  if (canonicalTarget !== targetType) aliased.push({ from: targetType, to: canonicalTarget })

  const key = `${canonicalSource}:${canonicalTarget}`

  const core = CORE_EDGE_LOOKUP.get(key)
  if (core) {
    return {
      ok: true,
      edgeType: core,
      tier: 'core',
      ...(aliased.length > 0 ? { aliased } : {}),
    }
  }

  // Pair map is list-valued; pickCanonicalEdge applies
  // the classification-ranked policy (hierarchy ≻ causal ≻ semantic ≻ cross-domain).
  const extended = pickCanonicalEdge(canonicalSource, canonicalTarget)
  if (extended) {
    return {
      ok: true,
      edgeType: extended,
      tier: 'extended',
      ...(aliased.length > 0 ? { aliased } : {}),
    }
  }

  // Reject: no fabrication. Surface near-miss pairs that DO resolve.
  return {
    ok: false,
    reason: `No edge type in UPG_EDGE_CATALOG for source=${canonicalSource}, target=${canonicalTarget}.`,
    suggestions: suggestEdgePairs(canonicalSource, canonicalTarget),
    resolved: { source_type: canonicalSource, target_type: canonicalTarget },
  }
}

/**
 * Throwing variant. Suitable for code paths where a missing canonical edge is
 * unrecoverable (the caller intends to write an edge and has no fallback).
 * Throws an `InferEdgeTypeError` carrying the structured failure for callers
 * to format into MCP error responses.
 */
export class InferEdgeTypeError extends Error {
  readonly result: EdgeInferenceFail

  constructor(result: EdgeInferenceFail) {
    const suggestionLine =
      result.suggestions.length > 0
        ? ` Did you mean: ${result.suggestions
            .map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`)
            .join('; ')}?`
        : ''
    super(`${result.reason}${suggestionLine}`)
    this.name = 'InferEdgeTypeError'
    this.result = result
  }
}

export function inferEdgeType(sourceType: string, targetType: string): UPGEdgeType {
  const result = inferEdgeTypeWithTier(sourceType, targetType)
  if (!result.ok) throw new InferEdgeTypeError(result)
  return result.edgeType
}
