/**
 * Pre-flight payload-size guardrail for read tools.
 *
 * MCP responses cross a stdio transport that is intolerant of multi-100KB
 * payloads. At the harness boundary they get chopped into a `.txt` overflow
 * file, forcing the agent to round-trip through filesystem reads for what
 * should have been a single tool result. The right defence isn't agent
 * discipline, it's the server refusing to ship payloads that will detonate
 * downstream.
 *
 * Heuristic, not exact: we estimate from node + edge counts rather than
 * stringifying. Stringifying defeats the purpose for the huge-payload case
 * (the whole point of pre-flight is to avoid paying that cost), and the rough
 * estimate is well within an order of magnitude for steering decisions.
 */

import type { ToolResult } from './server-context.js'
import { textError } from './server-context.js'

/** Average serialised bytes per node, including title/status/properties/tags. */
const NODE_BYTES = 800

/** Average serialised bytes per edge with `source_title` + `target_title` populated. */
const EDGE_BYTES_FULL = 250

/** Average serialised bytes per edge when only `id`/`type`/`source`/`target` are emitted. */
const EDGE_BYTES_COMPACT = 120

/**
 * Soft limit; responses at or above this size get a `_warning` field but
 * still ship. Tunable via `UPG_MCP_PAYLOAD_SOFT_LIMIT`. Defaults to 50 KB.
 */
export function getSoftLimit(): number {
  const raw = process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000
}

/**
 * Hard limit; responses at or above this size are refused outright with a
 * structured steering hint. Tunable via `UPG_MCP_PAYLOAD_HARD_LIMIT`.
 * Defaults to 150 KB.
 */
export function getHardLimit(): number {
  const raw = process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 150_000
}

export interface EstimateInput {
  nodeCount: number
  edgeCount: number
  /** When true, edges omit `source_title`/`target_title` and other display fields. */
  compactEdges?: boolean
}

/**
 * Rough byte estimate for a JSON-stringified `{ nodes, edges, ... }` response.
 *
 * Pure function; safe to call from anywhere. Returns 0 for empty payloads.
 */
export function estimatePayloadBytes(input: EstimateInput): number {
  const edgeUnit = input.compactEdges ? EDGE_BYTES_COMPACT : EDGE_BYTES_FULL
  return input.nodeCount * NODE_BYTES + input.edgeCount * edgeUnit
}

export type PreflightOutcome =
  | { kind: 'ok' }
  | { kind: 'warn'; bytes: number; fields: { _warning: string; _payload_bytes: number } }
  | { kind: 'refuse'; result: ToolResult }

export interface PreflightInput extends EstimateInput {
  toolName: string
  /** Optional context appended to the soft-limit warning (e.g. the offending args). */
  argsHint?: string
}

/**
 * Decide what to do with a read-tool response based on its estimated size.
 *
 * - bytes < soft → `{ kind: 'ok' }`
 * - soft ≤ bytes < hard → `{ kind: 'warn', fields }`; caller merges `fields`
 *   into the response object before stringifying
 * - bytes ≥ hard → `{ kind: 'refuse', result }`; caller returns `result` directly
 */
export function preflightPayload(input: PreflightInput): PreflightOutcome {
  const bytes = estimatePayloadBytes(input)
  const soft = getSoftLimit()
  const hard = getHardLimit()

  // Hard refusal is checked first so an inverted threshold pair
  // (UPG_MCP_PAYLOAD_HARD_LIMIT < UPG_MCP_PAYLOAD_SOFT_LIMIT, e.g. CI tightening)
  // still refuses rather than slipping into the soft-warn branch.
  if (bytes >= hard) {
    return {
      kind: 'refuse',
      result: textError(buildRefusalMessage({ ...input, bytes, hard })),
    }
  }

  if (bytes < soft) return { kind: 'ok' }

  return {
    kind: 'warn',
    bytes,
    fields: {
      _warning: buildSoftWarning({ ...input, bytes, soft }),
      _payload_bytes: bytes,
    },
  }
}

interface RefusalContext extends PreflightInput {
  bytes: number
  hard: number
}

function buildRefusalMessage(ctx: RefusalContext): string {
  const kb = Math.round(ctx.bytes / 1000)
  const tokens = Math.round(ctx.bytes / 3.3)
  const tokensK = (tokens / 1000).toFixed(0)
  const lines = [
    `Estimated ${kb} KB response (~${tokensK}K tokens). ${ctx.toolName} on ${ctx.nodeCount} nodes / ${ctx.edgeCount} edges routinely overflows MCP transport caps.`,
    '',
    'Try one of:',
    '  - query({ from: "<type>", include: ["title"], edge_include: [] }); projection-aware traversal, far cheaper',
    `  - ${ctx.toolName} with a smaller limit (~50 nodes)`,
    `  - ${ctx.toolName} with include_edges:false`,
    `  - ${ctx.toolName} with compact_edges:true (where supported)`,
    '',
    `Limit configurable via UPG_MCP_PAYLOAD_HARD_LIMIT (current: ${ctx.hard}).`,
  ]
  if (ctx.argsHint) {
    lines.splice(1, 0, `Called with: ${ctx.argsHint}`)
  }
  return lines.join('\n')
}

interface SoftContext extends PreflightInput {
  bytes: number
  soft: number
}

function buildSoftWarning(ctx: SoftContext): string {
  const kb = Math.round(ctx.bytes / 1000)
  return `estimated ${kb} KB response (${ctx.nodeCount} nodes, ${ctx.edgeCount} edges): approaching transport limits; consider a tighter projection via query() or a smaller limit.`
}
