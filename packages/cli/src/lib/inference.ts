/**
 * Edge inference — the heart of the "edges are never named by a human" promise
 * (CLI-DESIGN-SPEC §2, Move 3).
 *
 * Given two entity TYPES, resolve the canonical edge + direction so that `new`
 * and `link` never make the user pick one of 946 edges. Everything here is a
 * thin, pure layer over the SDK schema facade (`upg.schema.allEdgesFor`,
 * `upg.edges.resolve`) and the core edge catalog (for human verbs). No graph
 * state, no I/O.
 *
 * The design's empirical findings drive the rules:
 *   - Concrete edges only; polymorphic `node_*_node` wildcards are a fallback,
 *     never a candidate (the SDK's `allEdgesFor` already excludes them, since
 *     the pair map is keyed by concrete types).
 *   - ~94% of connectable pairs resolve to exactly one edge → auto.
 *   - The ambiguous remainder is offered as VERBS ("measures"/"drives"), never
 *     edge-type strings.
 *   - Direction auto-flips to the canonical orientation, and we SAY so.
 */

import { UPG_EDGE_CATALOG } from '@unified-product-graph/core'
import type { UPGEdgeType } from '@unified-product-graph/core'

/** A resolved (or candidate-laden) inference for an unordered pair of types. */
export interface Inference {
  /** The canonical SOURCE type (after any flip). */
  sourceType: string
  /** The canonical TARGET type (after any flip). */
  targetType: string
  /** Candidate edge types in canonical (source → target) orientation. */
  candidates: UPGEdgeType[]
  /**
   * True when the canonical direction is the REVERSE of how the caller named
   * the pair (i.e. they passed `b a` but the catalog edge is `a → b`).
   */
  flipped: boolean
}

/** Human verb for an edge type ("persona_pursues_job" → "pursues"). */
export function edgeVerb(type: string): string {
  const def = UPG_EDGE_CATALOG[type as UPGEdgeType]
  return def?.forward_verb?.replace(/_/g, ' ') ?? type
}

/**
 * Infer the canonical edge(s) between two types, trying the given orientation
 * first and auto-flipping if only the reverse direction is catalogued.
 *
 * `allEdgesFor` is the SDK facade over the catalog pair map; it returns every
 * concrete edge for the directed pair (most pairs have one; a handful several).
 *
 * @param aType type the caller named FIRST
 * @param bType type the caller named SECOND
 * @param allEdgesFor `upg.schema.allEdgesFor` (injected so this stays pure)
 * @returns an `Inference`, or `null` when neither direction has any edge.
 */
export function inferEdge(
  aType: string,
  bType: string,
  allEdgesFor: (a: string, b: string) => UPGEdgeType[],
): Inference | null {
  const forward = allEdgesFor(aType, bType)
  if (forward.length > 0) {
    return { sourceType: aType, targetType: bType, candidates: forward, flipped: false }
  }
  const reverse = allEdgesFor(bType, aType)
  if (reverse.length > 0) {
    return { sourceType: bType, targetType: aType, candidates: reverse, flipped: true }
  }
  return null
}

/**
 * Match a user selection against a candidate list. Accepts:
 *   - a 1-based index ("2")
 *   - an exact verb ("measures") or edge-type ("metric_measures_metric")
 *   - a verb substring (last resort, first match)
 * Returns the matched edge type, or `undefined`.
 */
export function matchCandidate(
  candidates: UPGEdgeType[],
  selection: string,
): UPGEdgeType | undefined {
  const sel = selection.trim()
  if (/^\d+$/.test(sel)) {
    const idx = Number(sel) - 1
    return candidates[idx]
  }
  return (
    candidates.find((t) => edgeVerb(t) === sel || t === sel) ??
    candidates.find((t) => edgeVerb(t).includes(sel))
  )
}

/** Render the candidate list as a numbered verb menu (for prompts / errors). */
export function candidateMenu(candidates: UPGEdgeType[]): string {
  return candidates
    .map((t, i) => `  ${i + 1}. ${edgeVerb(t).padEnd(18)} (${t})`)
    .join('\n')
}

/** The outcome of resolving which edge to use among candidates. */
export type ChooseResult =
  | { kind: 'chosen'; type: UPGEdgeType }
  | { kind: 'ambiguous-non-tty'; candidates: UPGEdgeType[] } // refuse to guess on a pipe
  | { kind: 'bad-selection'; selection: string; candidates: UPGEdgeType[] }
  | { kind: 'cancelled' }

/**
 * Decide which edge to use among `candidates`.
 *
 *   - exactly one candidate         → auto-chosen
 *   - an explicit `--as` selection  → matched (or `bad-selection`)
 *   - several, on a TTY             → caller must prompt (returns `ambiguous`-style
 *                                     via the `prompt` callback)
 *   - several, on a pipe            → refuse to guess (design §9)
 *
 * The interactive prompt is injected as `prompt` so this stays free of any I/O
 * and easy to unit-test. `prompt` resolves to the user's raw selection string,
 * or `undefined` if they cancelled.
 */
export async function chooseEdge(
  candidates: UPGEdgeType[],
  opts: {
    as?: string
    isTTY: boolean
    prompt?: (candidates: UPGEdgeType[]) => Promise<string | undefined>
  },
): Promise<ChooseResult> {
  const first = candidates[0]
  if (candidates.length === 1 && first) return { kind: 'chosen', type: first }

  if (opts.as !== undefined) {
    const matched = matchCandidate(candidates, opts.as)
    return matched
      ? { kind: 'chosen', type: matched }
      : { kind: 'bad-selection', selection: opts.as, candidates }
  }

  if (!opts.isTTY || !opts.prompt) {
    return { kind: 'ambiguous-non-tty', candidates }
  }

  const answer = await opts.prompt(candidates)
  if (answer === undefined || answer.trim() === '') return { kind: 'cancelled' }
  const matched = matchCandidate(candidates, answer)
  return matched
    ? { kind: 'chosen', type: matched }
    : { kind: 'bad-selection', selection: answer, candidates }
}
