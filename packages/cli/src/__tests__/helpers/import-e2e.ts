/**
 * Reusable end-to-end import harness for adapter audits.
 *
 * Exercises the REAL production pipeline a user hits with `upg import --from X`:
 *
 *   raw source payload
 *     → adapter.list(config)         (parse seam, incl. the network fetch)
 *     → adapter.convert(items)       (mapping seam)
 *     → writeToUPGFile(tmp.upg)      (the actual CLI writer: id remap + serialize)
 *     → re-read tmp.upg from disk     (raw JSON + UPGFileStore.loadReadOnly)
 *
 * The re-read is the proof that data didn't just transform in memory but
 * persisted as a valid, reloadable .upg graph. UPGFileStore quarantines
 * nodes with unknown types / missing titles on load, so a successful reload
 * also proves every emitted node type is in the spec catalogue.
 *
 * Two entry modes:
 *   - { config }: live/fetch adapters — calls adapter.list(config). Pair with
 *     stubFetch() to serve a fixture instead of hitting the network.
 *   - { items }:  convert-only adapters — feeds SourceItems straight to convert().
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { getLifecycleForType, UPG_EDGE_CATALOG } from '@unified-product-graph/core'

/** Edge type → declared {source_type, target_type}. `node` is the polymorphic
 *  wildcard (e.g. node_informs_node) and is exempt from endpoint checks. */
const EDGE_ENDPOINTS = UPG_EDGE_CATALOG as Record<string, { source_type: string; target_type: string }>

/** Canonical top-level UPGBaseNode fields. Anything else an adapter spreads onto
 *  a node is off-schema and is dropped by the .upg writer (silent data loss). */
const CANONICAL_NODE_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'title', 'slug', 'aliases', 'description', 'tags', 'status',
  'source_id', 'source_type', 'mapping_confidence',
  'external_tool', 'external_ref', 'external_id', 'properties',
])

/** Valid status values for an entity type, or null when the type is lifecycle-free. */
function validStatusesForType(type: string): ReadonlySet<string> | null {
  const lc = getLifecycleForType(type)
  if (!lc) return null
  const set = new Set<string>()
  for (const phase of lc.phases) {
    set.add(phase.id)
    for (const s of phase.core_states ?? []) set.add(s.id)
  }
  return set
}

// Structural type so we don't couple the harness to the adapters package's
// exported type surface. Any UPGAdapter satisfies this.
export interface AdapterLike {
  name: string
  list(config: Record<string, unknown>): Promise<unknown[]>
  convert(
    items: unknown[],
    config?: Record<string, unknown>,
  ): Promise<{
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
    source_map: Record<string, string>
    warnings?: string[]
  }>
}

export interface FetchRoute {
  /** Substring or predicate matched against the request URL. */
  match: string | ((url: string) => boolean)
  status?: number
  /** JSON body returned for a matching request (ignored if `body` is set). */
  json?: unknown
  /** Raw string body (overrides `json`). */
  body?: string
}

/**
 * Install a global.fetch stub that answers from `routes` (first match wins).
 * An unmatched URL resolves to 404 so a wrong endpoint behaves like the real
 * server would. Returns a restore function — always call it in a finally/after.
 */
export function stubFetch(routes: FetchRoute[]): () => void {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    for (const r of routes) {
      const hit = typeof r.match === 'function' ? r.match(url) : url.includes(r.match)
      if (hit) {
        const status = r.status ?? 200
        const body = r.body ?? JSON.stringify(r.json ?? {})
        return new Response(body, { status, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: 'not found', url }), { status: 404 })
  }) as typeof fetch
  ;(globalThis.fetch as unknown as { calls: string[] }).calls = calls
  return () => {
    globalThis.fetch = original
  }
}

export interface E2EOutcome {
  /** SourceItems produced by list() (or the items passed in). */
  items: unknown[]
  /** The in-memory convert() result. */
  result: {
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
    source_map: Record<string, string>
    warnings?: string[]
  }
  /** Absolute path of the temp .upg that was written. */
  tmpFile: string
  /** The .upg parsed straight back off disk (what was actually persisted). */
  rawDoc: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; [k: string]: unknown }
  /** Nodes the store accepted on reload (excludes quarantined). null if reload threw. */
  reloadedNodes: Array<Record<string, unknown>> | null
  reloadedEdges: Array<Record<string, unknown>> | null
  /** Set if UPGFileStore.loadReadOnly rejected the written file. */
  reloadError: Error | null
  /** Remove the temp file/dir. */
  cleanup: () => Promise<void>
}

/**
 * Run the full import round-trip and hand back everything needed to assert on.
 * Throws only if list()/convert()/the writer throw — callers that expect a
 * failing stage (e.g. a 404 from list()) should wrap the call themselves.
 */
export async function runImportE2E(opts: {
  adapter: AdapterLike
  /** When set, calls adapter.list(config) first (live/fetch adapters). */
  config?: Record<string, unknown>
  /** When set, skips list() and feeds these straight to convert(). */
  items?: unknown[]
}): Promise<E2EOutcome> {
  const { writeToUPGFile } = await import('../../commands/import.js')

  const items = opts.items ?? (await opts.adapter.list(opts.config ?? {}))
  const result = await opts.adapter.convert(items)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `upg-e2e-${opts.adapter.name}-`))
  const tmpFile = path.join(dir, `${opts.adapter.name}.upg`)

  await writeToUPGFile(
    result.nodes as Parameters<typeof writeToUPGFile>[0],
    result.edges as Parameters<typeof writeToUPGFile>[1],
    tmpFile,
  )

  const rawDoc = JSON.parse(await fs.readFile(tmpFile, 'utf-8'))

  let reloadedNodes: Array<Record<string, unknown>> | null = null
  let reloadedEdges: Array<Record<string, unknown>> | null = null
  let reloadError: Error | null = null
  try {
    const store = new UPGFileStore()
    await store.loadReadOnly(tmpFile)
    reloadedNodes = store.getAllNodes() as unknown as Array<Record<string, unknown>>
    reloadedEdges = store.getAllEdges() as unknown as Array<Record<string, unknown>>
  } catch (err) {
    reloadError = err as Error
  }

  return {
    items,
    result,
    tmpFile,
    rawDoc,
    reloadedNodes,
    reloadedEdges,
    reloadError,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
  }
}

/**
 * Spec-conformance check for an import round-trip. Returns a list of human
 * readable issues; empty means the import is conformant. The shared audit bar:
 *
 *   expect(conformanceIssues(out, EDGE_TYPES)).toEqual([])
 *
 * Checks:
 * - the writer's output reloads without error (a malformed .upg is a hard fail);
 * - no node was quarantined on reload (quarantine = an invalid entity type or a
 *   missing title — the store drops these, so reloaded < persisted flags it);
 * - every persisted edge type is in the canonical catalogue;
 * - every persisted node keeps a `source_id` (round-trip traceability).
 */
export function conformanceIssues(
  out: E2EOutcome,
  edgeTypes: ReadonlySet<string>,
): string[] {
  const issues: string[] = []
  if (out.reloadError) {
    issues.push(`written .upg failed to reload: ${out.reloadError.message}`)
    return issues
  }
  const persisted = out.rawDoc.nodes.length
  const reloaded = out.reloadedNodes?.length ?? -1
  if (reloaded !== persisted) {
    issues.push(
      `${persisted - reloaded} of ${persisted} nodes quarantined on reload ` +
        `(invalid entity type or missing title)`,
    )
  }
  const persistedEdges = out.rawDoc.edges.length
  const reloadedEdges = out.reloadedEdges?.length ?? -1
  if (reloadedEdges !== persistedEdges) {
    issues.push(`${persistedEdges - reloadedEdges} of ${persistedEdges} edges dropped on reload`)
  }
  const nodeTypeById = new Map<string, string>()
  for (const n of out.rawDoc.nodes) nodeTypeById.set(n.id as string, n.type as string)
  for (const e of out.rawDoc.edges) {
    if (!edgeTypes.has(e.type as string)) {
      issues.push(`uncatalogued edge type: "${e.type}"`)
      continue
    }
    // Endpoint-type correctness: the edge's source/target node types must match
    // what the catalogue declares (polymorphic `node` endpoints are exempt).
    const def = EDGE_ENDPOINTS[e.type as string]
    if (!def) continue
    const srcType = nodeTypeById.get(e.source as string)
    const tgtType = nodeTypeById.get(e.target as string)
    if (def.source_type !== 'node' && srcType && srcType !== def.source_type) {
      issues.push(`edge "${e.type}" source is ${srcType}, catalogue expects ${def.source_type}`)
    }
    if (def.target_type !== 'node' && tgtType && tgtType !== def.target_type) {
      issues.push(`edge "${e.type}" target is ${tgtType}, catalogue expects ${def.target_type}`)
    }
  }
  for (const n of out.rawDoc.nodes) {
    if (!n.source_id) issues.push(`node "${n.title ?? n.id}" lost its source_id on persist`)
  }
  // Status validity: a persisted status must belong to its type's lifecycle.
  for (const n of out.rawDoc.nodes) {
    const status = n.status as string | undefined
    if (!status) continue
    const valid = validStatusesForType(n.type as string)
    if (valid && !valid.has(status)) {
      issues.push(`node "${n.title}" (${n.type}) has status "${status}" not in its lifecycle`)
    }
  }
  // Off-schema fields: detected on the in-memory result (the writer silently
  // drops them, so they never reach rawDoc). These are real data loss — the
  // values belong under `properties`.
  for (const n of out.result.nodes) {
    for (const key of Object.keys(n)) {
      if (!CANONICAL_NODE_KEYS.has(key)) {
        issues.push(`node "${n.title ?? n.id}" emits off-schema field "${key}" (lost on persist; nest under properties)`)
      }
    }
  }
  return issues
}
