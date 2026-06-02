/**
 * Tier-1 session state: the graph CURSOR and the operating LENS.
 *
 * The ceiling design (CLI-DESIGN-SPEC §2, §9) turns the graph into "a place you
 * stand in". That requires two pieces of session-local state:
 *
 *   - cursor: the current node id, like a shell's `cwd`. `new` links to it,
 *     `ls` shows its neighbours, `find` moves it.
 *   - lens:   the operating worldview (one of the 8 canonical lenses, or
 *     `full`). Scopes the vocabulary `new`/`ls` speak.
 *
 * Invariants (design §9):
 *   - State is SESSION-LOCAL and lives next to the resolved `.upg` file
 *     (`<file>.session.json`), or wherever `$UPG_SESSION` points. It is never
 *     part of the `.upg` document, so two graphs keep independent cursors.
 *   - The Tier-3 flat commands (create/connect/list/verify/…) NEVER read this
 *     state, so CI stays deterministic. Only the Tier-1 verbs in this wave do.
 *   - Stateless overrides exist on every Tier-1 verb (`--at <id>`, `--lens <l>`)
 *     so a script never has to depend on the sticky state.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getLensIds } from '@unified-product-graph/core'

/** The persisted shape. Both fields optional; absence = "no cursor / full lens". */
export interface SessionState {
  /** Current node id (the cursor). */
  cursor?: string
  /** Operating lens id (one of the canonical 8). Absence ⇒ treated as `full`. */
  lens?: string
}

/** The implicit, always-available lens — the unfiltered graph. */
export const FULL_LENS = 'full'

/**
 * The canonical set of selectable lens ids: the 8 from core
 * (`product`, `ux_design`, `engineering`, `growth`, `business`, `research`,
 * `marketing`) PLUS the implicit `full`. `getLensIds()` already includes `full`
 * in the catalog, but we union defensively so `full` is always valid even if a
 * future catalog drops it.
 */
export function validLensIds(): string[] {
  const ids = new Set(getLensIds())
  ids.add(FULL_LENS)
  return [...ids]
}

/** True when `id` is a selectable lens. */
export function isValidLens(id: string): boolean {
  return validLensIds().includes(id)
}

/**
 * Resolve the session-state file path for a given `.upg` file.
 *
 * Precedence:
 *   1. `$UPG_SESSION` (explicit, for CI / multi-shell scenarios)
 *   2. `<resolvedUpgFile>.session.json` — co-located with the graph, so each
 *      graph keeps its own cursor/lens. (`.upg` → `.upg.session.json`.)
 */
export function sessionPath(upgFile: string): string {
  const env = process.env.UPG_SESSION
  if (env) return path.resolve(env)
  return path.resolve(upgFile) + '.session.json'
}

/** Read the current session state for a graph. Missing/corrupt ⇒ `{}`. */
export function readSession(upgFile: string): SessionState {
  const p = sessionPath(upgFile)
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as SessionState
    // Defensive: ignore non-object payloads.
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

/** Persist session state for a graph (merging over what's already there). */
export function writeSession(upgFile: string, patch: SessionState): SessionState {
  const next = { ...readSession(upgFile), ...patch }
  // Drop undefined keys so the file stays clean.
  for (const k of Object.keys(next) as (keyof SessionState)[]) {
    if (next[k] === undefined) delete next[k]
  }
  fs.writeFileSync(sessionPath(upgFile), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** Clear the cursor (e.g. when its node was deleted). */
export function clearCursor(upgFile: string): void {
  const s = readSession(upgFile)
  delete s.cursor
  fs.writeFileSync(sessionPath(upgFile), JSON.stringify(s, null, 2) + '\n')
}

/**
 * The effective lens for this invocation: a `--lens` override wins over the
 * sticky session lens, which falls back to `full`. The override is validated
 * by the caller (it raises a usage error on an unknown id); here we just pick.
 */
export function effectiveLens(state: SessionState, override?: string): string {
  return override ?? state.lens ?? FULL_LENS
}
