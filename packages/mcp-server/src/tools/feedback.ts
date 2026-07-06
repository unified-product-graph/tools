/**
 * `submit_feedback` — the one write-OUT tool in the UPG MCP surface.
 *
 * Every other tool reads or writes the local `.upg` graph. This one is a thin
 * HTTP client that POSTs a feedback report — a bug, a feature request, an
 * observation — to the project's public triage queue at
 * `unifiedproductgraph.org/api/feedback`, so feedback from ANY MCP client lands
 * in one funnel instead of being hand-carried across surfaces.
 *
 * Three invariants make it safe to ship into every client:
 *
 *  1. CONSENT. The tool refuses to send anything unless the caller passes
 *     `confirmed: true`. Absent that, it returns the exact payload it WOULD
 *     send (a preview) and sends nothing — the human-in-the-loop checkpoint.
 *     The agent must show the user that payload, get an explicit yes, then
 *     call again with `confirmed: true`.
 *
 *  2. PRIVACY. The outbound `context` is auto-assembled here from an ALLOWLIST
 *     of non-content sources only — the MCP client name/version (from the
 *     `initialize` handshake), the server name/version, the Node runtime, and
 *     graph SIZE counts. It NEVER contains node titles, descriptions, or any
 *     graph content. `assembleContext` is the single chokepoint and is unit-
 *     tested against `ALLOWED_CONTEXT_KEYS` so no content can leak in.
 *
 *  3. FRICTION, NOT AUTH. A non-secret shared submission key is baked in
 *     (`x-upg-key`), overridable via env. It is a revocable speed-bump against
 *     drive-by abuse, not authentication — the reporter stays anonymous.
 *
 * Local-only by design: it needs the CLIENT's environment (its handshake, its
 * runtime) to assemble context, so it lives on the local server, not the
 * stateless cloud server.
 */

import {
  text,
  textError,
  type ToolContext,
  type ToolHandler,
  type ToolResult,
} from '../lib/server-context.js'

/** Intake vocabulary (matches the endpoint's `FEEDBACK_TYPES`). */
export const FEEDBACK_TYPES = ['bug', 'feature_request', 'observation', 'general'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

const TITLE_MAX = 200
const DESCRIPTION_MAX = 5000

const DEFAULT_FEEDBACK_API_URL = 'https://unifiedproductgraph.org/api/feedback'
/** Non-secret shared key: friction + revocable, NOT authentication. */
const DEFAULT_SUBMISSION_KEY = 'upg-fb-public-v1'

/**
 * The ONLY keys `submit_feedback` ever writes into the outbound `context`.
 * Every key is a version, a client identifier, a runtime fact, or a graph SIZE
 * count — never graph content. The privacy-invariant test asserts the assembled
 * context is a subset of this set, so a future edit cannot silently add a
 * content-bearing field.
 */
export const ALLOWED_CONTEXT_KEYS = [
  'mcp_client',
  'client_version',
  'server',
  'server_version',
  'runtime',
  'platform',
  'node_count',
  'edge_count',
] as const

export interface FeedbackContext {
  /** MCP client name from the `initialize` handshake (e.g. "claude-code"). */
  mcp_client?: string
  /** MCP client version from the handshake. */
  client_version?: string
  /** UPG server name. */
  server?: string
  /** UPG server (package) version. */
  server_version?: string
  /** Node runtime, e.g. "node v20.11.0". */
  runtime?: string
  /** OS platform token, e.g. "darwin". */
  platform?: string
  /** Number of nodes in the active graph — SIZE only, no content. */
  node_count?: number
  /** Number of edges in the active graph — SIZE only, no content. */
  edge_count?: number
}

/**
 * Assemble the outbound `context` from allowlisted, non-content sources only.
 * Exported so the privacy-invariant test drives this exact chokepoint. Never
 * reads a node title/description/property — graph SIZE counts are the only
 * graph-derived values, and they are integers.
 */
export function assembleContext(ctx: ToolContext): FeedbackContext {
  const out: FeedbackContext = {}

  const client = ctx.getClientInfo?.()
  if (client?.name) out.mcp_client = client.name
  if (client?.version) out.client_version = client.version

  if (ctx.serverInfo?.name) out.server = ctx.serverInfo.name
  if (ctx.serverInfo?.version) out.server_version = ctx.serverInfo.version

  out.runtime = `node ${process.version}`
  out.platform = process.platform

  // Graph SIZE only — never node/edge content. Defensive: an unbound store or
  // an empty graph simply omits the counts.
  try {
    const doc = ctx.store.getDocument() as { nodes?: unknown[]; edges?: unknown[] }
    if (Array.isArray(doc.nodes)) out.node_count = doc.nodes.length
    if (Array.isArray(doc.edges)) out.edge_count = doc.edges.length
  } catch {
    /* no active graph — counts omitted */
  }

  return out
}

/** Build the outbound POST body (feedback fields + assembled context). */
function buildPayload(
  fields: {
    type: FeedbackType
    title: string
    description: string
    details?: Record<string, unknown>
    product_stage?: string
  },
  ctx: ToolContext,
): Record<string, unknown> {
  return {
    type: fields.type,
    title: fields.title,
    description: fields.description,
    context: assembleContext(ctx),
    ...(fields.details && Object.keys(fields.details).length > 0 ? { details: fields.details } : {}),
    ...(fields.product_stage ? { product_stage: fields.product_stage } : {}),
  }
}

/**
 * Submit feedback about the Unified Product Graph to the project's triage queue.
 *
 * A thin HTTP client: validates and shapes the report, refuses to send without
 * explicit consent (`confirmed: true`), then POSTs to
 * `unifiedproductgraph.org/api/feedback`. The outbound `context` is auto-
 * assembled from the client handshake + server runtime + graph SIZE counts —
 * never graph content (see `assembleContext`). Anonymous; a baked-in shared key
 * gates the endpoint (friction, not auth).
 *
 * @param type One of `bug` | `feature_request` | `observation` | `general`. Required.
 * @param title A concise one-line summary (≤200 chars). Required.
 * @param description The full report (≤5000 chars). Required — shape it to be
 *   actionable: a bug wants steps/expected/actual, a feature its problem/outcome.
 * @param details Optional type-aware structured fields. bug →
 *   `steps_to_reproduce` / `expected` / `actual` / `severity`
 *   (low|medium|high|critical); feature_request → `problem` / `desired_outcome`
 *   / `workaround`. Ignored for observation/general.
 * @param product_stage Optional product stage the reporter is at (folded into
 *   context server-side).
 * @param confirmed CONSENT GATE. Must be `true` to send. When absent/false the
 *   tool sends NOTHING and returns the exact payload it would send, for the
 *   agent to show the user before re-calling with `confirmed: true`.
 * @returns On send: `{ status: "submitted", id, message }`. Without consent:
 *   `{ status: "confirmation_required", preview }`. On a rejected/failed POST:
 *   an error result with a clear message (401 bad key, 429 rate-limited, …).
 * @atomicity atomic (single outbound POST). Never reads or writes the local graph.
 */
export const submitFeedback: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  // ── Validate ───────────────────────────────────────────────────────────────
  const type = args.type
  if (typeof type !== 'string' || !FEEDBACK_TYPES.includes(type as FeedbackType)) {
    return textError(`type must be one of: ${FEEDBACK_TYPES.join(', ')}`)
  }

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) return textError('title is required and must be a non-empty string.')
  if (title.length > TITLE_MAX) return textError(`title must be ${TITLE_MAX} characters or fewer.`)

  const description = typeof args.description === 'string' ? args.description.trim() : ''
  if (!description) {
    return textError('description is required: describe the feedback in enough detail for someone to act on it.')
  }
  if (description.length > DESCRIPTION_MAX) {
    return textError(`description must be ${DESCRIPTION_MAX} characters or fewer.`)
  }

  let details: Record<string, unknown> | undefined
  if (args.details !== undefined && args.details !== null) {
    if (typeof args.details !== 'object' || Array.isArray(args.details)) {
      return textError('details must be an object.')
    }
    details = args.details as Record<string, unknown>
  }

  const product_stage = typeof args.product_stage === 'string' ? args.product_stage : undefined

  const fields = { type: type as FeedbackType, title, description, details, product_stage }

  // ── Consent gate ─────────────────────────────────────────────────────────
  // No `confirmed: true` → send NOTHING; return the exact payload for review.
  if (args.confirmed !== true) {
    return text(
      JSON.stringify(
        {
          status: 'confirmation_required',
          message:
            'Nothing was sent. Show the user this exact payload, including the auto-collected `context` (client/server versions, runtime, and graph SIZE counts only; never graph content), get an explicit yes, then call submit_feedback again with confirmed: true.',
          preview: buildPayload(fields, ctx),
        },
        null,
        2,
      ),
    )
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  const url = process.env.UPG_FEEDBACK_API_URL || DEFAULT_FEEDBACK_API_URL
  const key = process.env.UPG_FEEDBACK_SUBMISSION_KEY || DEFAULT_SUBMISSION_KEY

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-upg-key': key },
      body: JSON.stringify(buildPayload(fields, ctx)),
    })
  } catch (err) {
    return textError(
      `Could not reach the feedback endpoint (${url}): ${err instanceof Error ? err.message : String(err)}. ` +
        'Nothing was sent. Check the connection and try again.',
    )
  }

  if (resp.status === 401) {
    return textError(
      'The feedback endpoint rejected the submission key (401). The baked-in key may have been rotated. ' +
        'Update @unified-product-graph/mcp-server, or set UPG_FEEDBACK_SUBMISSION_KEY to a current key.',
    )
  }
  if (resp.status === 429) {
    const retry = resp.headers.get('retry-after')
    return textError(
      `Rate limited (429) by the feedback endpoint${retry ? `, retry after ${retry}s` : ''}. ` +
        'Too many submissions from this network recently; wait a bit and try again. Nothing was saved.',
    )
  }
  if (!resp.ok) {
    let detail = ''
    try {
      const j = (await resp.json()) as { error?: string }
      if (j?.error) detail = `: ${j.error}`
    } catch {
      /* non-JSON error body */
    }
    return textError(`The feedback endpoint returned ${resp.status}${detail}. Nothing was saved.`)
  }

  let data: { id?: string; message?: string }
  try {
    data = (await resp.json()) as { id?: string; message?: string }
  } catch {
    return textError('The feedback endpoint returned a non-JSON success response; the submission status is unknown.')
  }

  return text(
    JSON.stringify(
      {
        status: 'submitted',
        id: data.id ?? null,
        message: data.message ?? 'Feedback received. Thank you!',
      },
      null,
      2,
    ),
  )
}
