/**
 * Graph loader. Uses UPGFileStore from @unified-product-graph/sdk.
 *
 * Same discovery logic, same store, same behavior. The CLI is a thin
 * frontend over the SDK; the MCP server is the other.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { InvalidArgumentError } from 'commander'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { UPG_FRAMEWORKS_BY_ID, UPG_SCALES, type UPGFramework } from '@unified-product-graph/core'
import { usageError, runtimeError, violation, type CliError } from './errors.js'
import { CLI_VERSION } from './version.js'

/**
 * (a) — a Commander option coercion for a bounded numeric flag.
 *
 * The bug: an option declared with a bare `parseFloat` coercion silently accepts
 * garbage. `parseFloat('abc')` / `parseFloat('')` is `NaN`, and EVERY comparison
 * against `NaN` is false, so `--max-orphan-rate abc` made a 100%-orphan graph
 * PASS at exit 0 (the gate became a no-op). `--max-orphan-rate 99` (a rate, not a
 * percentage) and `Infinity` were likewise swallowed.
 *
 * The fix: reject anything that is not a finite number inside the inclusive
 * [min, max] window, throwing Commander's `InvalidArgumentError`. The CLI entry
 * point already maps that to a usage error (exit 3) via `USAGE_ERROR_CODES`, so
 * bad input fails loudly at parse time, before any command logic runs. Returns a
 * curried coercion suitable for `.option(..., boundedFloat(0, 1, 'flag'))`.
 */
export function boundedFloat(
  min: number,
  max: number,
  flagLabel: string,
): (raw: string) => number {
  return (raw: string): number => {
    // Number() (not parseFloat) so trailing garbage like "0.5x" is rejected
    // rather than silently parsed to 0.5. Empty string → NaN → rejected.
    const n = raw.trim() === '' ? Number.NaN : Number(raw)
    if (!Number.isFinite(n)) {
      throw new InvalidArgumentError(
        `${flagLabel} must be a number between ${min} and ${max}; got "${raw}".`,
      )
    }
    if (n < min || n > max) {
      throw new InvalidArgumentError(
        `${flagLabel} must be between ${min} and ${max}; got ${n}.`,
      )
    }
    return n
  }
}

export { UPGFileStore }

// Re-export shared tools so commands import from one place
export {
  computeGraphDigest,
  computeHealthScore,
  searchNodes,
  listNodes,
  getOrphans,
  BUSINESS_AREAS,
  CHAINS,
  sortByType,
  inferEdgeType,
  validateStatusAgainstLifecycle,
  nodeId,
  edgeId,
  type GraphDigest,
  type SearchResult,
} from '@unified-product-graph/sdk'

/**
 * A node title must be a non-empty string with at least one non-whitespace
 * character. Reject blanks at the write boundary (create/new/update): the spec's
 * required-title check only catches falsy titles, so "" slips through as a
 * persisted-but-invalid node and whitespace-only ("   ") passes entirely
 * ( / F1+F10). An invalid node on disk then bricks every subsequent read
 * AND the delete/update that could repair it, so the writer must never be more
 * permissive than the reader (CLI-FEEDBACK #4). Returns an error message, or
 * null when the title is valid.
 */
export function validateTitle(title: unknown): string | null {
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'Title is required and cannot be empty or whitespace-only.'
  }
  return null
}

/**
 * Upper bound on a `--data` payload ( E5). A `.upg` node's properties are
 * small structured fields; a multi-hundred-KB blob is a paste mistake or an
 * abuse vector that bloats the file and slows every later read. 256 KiB is
 * generous for legitimate property maps.
 */
export const MAX_DATA_BYTES = 256 * 1024

/**
 * One consistent error message for a malformed `--data` payload across
 * `create` / `update` / `score`. Before D2 these diverged: create/update
 * said "Invalid --data JSON" and exited 1 (runtime); score said "--data must be
 * valid JSON. Got: ..." and exited 3 (usage). The contract says a bad CLI
 * argument is a USAGE error (exit 3), so they now share this text and code.
 */
// RICE fields are 1-5 ASSESSMENT scales in core (reach -> reach_5, etc.), so the
// old `{"reach":800,...}` example was invalid under the model and contradicted
// the verify-side scale check. Use an in-scale example so help <-> create <->
// verify all agree ( seam with Spock's verify validator).
export const DATA_INVALID_JSON_MSG =
  '--data must be valid JSON, e.g. \'{"reach":4,"impact":3,"confidence":4,"effort":2}\'.'

/**
 * One consistent error for a `--data` payload that parsed as JSON but is not a
 * plain object ( b). `properties` is a map of property name → value, so
 * an array, a primitive, or `null` is never a valid payload. Before this guard
 * `[1,2,3]` / `42` / `true` were stored verbatim as `properties` (later tripping
 * the fmt layer or silently corrupting the node), `null` was dropped, and a bare
 * `"hello"` leaked a `[upg fmt]` string at exit 1. We now reject all of these up
 * front at the write boundary as a usage error (exit 3) with the same message
 * everywhere.
 */
export const DATA_NOT_OBJECT_MSG =
  "--data must be a JSON object of property to value, e.g. '{\"moscow\":\"must\"}'."

/** True for a non-null, non-array plain object — the only valid `--data` shape. */
export function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a `--data` option value: enforce the size guard (E5), JSON-parse, then
 * require a plain object ( b). Throws a usage error (exit 3) on any
 * failure so every command treats a bad `--data` argument identically
 * ( D2 / E5 / b). Returns the parsed object.
 *
 * The object requirement lives HERE, at the single shared parse point, rather
 * than in each caller, so `create` / `update` / `score` cannot drift: arrays,
 * primitives, and `null` are rejected before they can ever reach `properties`.
 */
export function parseDataOption(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf-8') > MAX_DATA_BYTES) {
    throw usageError(
      `--data is too large (${Buffer.byteLength(raw, 'utf-8')} bytes; max ${MAX_DATA_BYTES}). ` +
        `Pass a smaller property map.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw usageError(DATA_INVALID_JSON_MSG)
  }
  if (!isPlainDataObject(parsed)) {
    throw usageError(DATA_NOT_OBJECT_MSG)
  }
  return parsed
}

/* ----------------------------------------------------------------------------
 * — `score --data` framework validation (CLI half)
 *
 * The SDK's `scoreEntity` is deliberately PERMISSIVE: it only ever *warns* on a
 * bad value and still persists it, because storage must not brick on drift. That
 * means an invalid bucket ("definitely-maybe"), a value off the wrong schema
 * ({reach:999} on a MoSCoW exercise), a string where a number is declared, an
 * out-of-range score, or `effort:0` (which makes RICE's reach*impact*confidence
 * /effort blow up to -Infinity) all slip through at exit 0 today.
 *
 * `score` is a deliberate WRITE of a framework result, so the CLI validates the
 * `--data` payload against the framework definition BEFORE calling the SDK and
 * REJECTS (exit 2, nothing persisted) when it does not fit. This is the CLI's
 * own gate — self-contained, no new spec export needed. The framework + scale
 * definitions are read from `@unified-product-graph/core`, the same source the
 * SDK and `apply` use, so the two surfaces never disagree about what a framework
 * declares.
 * ------------------------------------------------------------------------- */

/**
 * The declared input spec for one framework property, as it appears in a
 * framework's `data.required_properties[<entityType>]` array in core. Mirrors
 * the (unexported) SDK shape so the CLI can read it without an SDK dependency.
 */
interface FrameworkInputSpec {
  property: string
  type?: 'number' | 'string' | 'enum' | 'boolean' | 'assessment'
  required?: boolean
  scale_id?: string
  enum_values?: string[]
}

/** Read the per-entity-type input specs a framework declares. */
function frameworkInputSpecs(framework: UPGFramework, entityType: string): FrameworkInputSpec[] {
  const req = (
    framework.data as { required_properties?: Record<string, FrameworkInputSpec[]> } | undefined
  )?.required_properties
  return req?.[entityType] ?? []
}

/**
 * Union of input specs across EVERY entity-type slot a framework declares, keyed
 * by property name. Used as a fallback when the scored entity's exact type slot
 * is empty (e.g. an entity type the framework broadened to but has no bespoke
 * slot for) so we still validate against the framework's known fields rather
 * than waving the payload through.
 */
function frameworkInputSpecsAnyType(framework: UPGFramework): Map<string, FrameworkInputSpec> {
  const out = new Map<string, FrameworkInputSpec>()
  const req = (
    framework.data as { required_properties?: Record<string, FrameworkInputSpec[]> } | undefined
  )?.required_properties
  for (const specs of Object.values(req ?? {})) {
    for (const s of specs) if (s?.property && !out.has(s.property)) out.set(s.property, s)
  }
  return out
}

/**
 * Resolve a numeric range for an input spec. Assessment / number inputs that name
 * a `scale_id` inherit that scale's [min, max]. Bare `number` inputs (e.g. ICE's
 * 1-10 fields, described only in prose) get a sane lower bound of 0 with no upper
 * bound, which still catches negatives and the `effort:0` divide hazard. Returns
 * `[min, max]` where either bound may be `undefined`.
 */
function numericRange(spec: FrameworkInputSpec): [number | undefined, number | undefined] {
  if (spec.scale_id) {
    const scale = UPG_SCALES[spec.scale_id]
    if (scale) return [scale.min, scale.max]
  }
  return [0, undefined]
}

/**
 * Validate a `score --data` payload against the exercise's framework. Returns a
 * list of human-readable problems; empty means the payload is acceptable. The
 * caller turns a non-empty list into a single exit-2 violation.
 *
 * Checks, in order:
 *   1. unknown keys        — the payload names a property the framework does not
 *                            declare (e.g. {reach:999} on a MoSCoW exercise:
 *                            wrong schema entirely).
 *   2. required presence   — a `required:true` input for this entity type slot is
 *                            missing.
 *   3. type                — enum value must be one of the declared buckets; a
 *                            number/assessment input must be a finite number, not
 *                            a string or NaN/Infinity; boolean must be boolean.
 *   4. range               — numeric inputs must sit within their scale (or be
 *                            >= 0 for bare-number inputs), which also rejects the
 *                            `effort:0` -Infinity hazard (effort's scale min is 1).
 *
 * `frameworkId` may be undefined (exercise missing its framework_id property) or
 * unknown to the catalog; in either case we cannot validate and return [] so the
 * SDK's own handling stands. The exercise-type check and persistence still live
 * in the SDK.
 *
 * NOTE (extension): all current scoring frameworks describe their inputs in
 * `data.required_properties` with `type` + `scale_id`/`enum_values`, so this is
 * fully data-driven across MoSCoW, RICE, ICE, Kano, etc. If a future framework
 * ships richer input semantics (cross-field constraints, conditional requireds),
 * extend the per-spec checks here rather than special-casing a framework id.
 */
export function validateScoreData(
  frameworkId: string | undefined,
  entityType: string | undefined,
  values: Record<string, unknown>,
): string[] {
  if (!frameworkId) return []
  const framework = UPG_FRAMEWORKS_BY_ID[frameworkId]
  if (!framework) return []

  // Prefer the scored entity's exact type slot; fall back to the union of all
  // declared slots so a missing-slot type still validates against known fields.
  const slot = entityType ? frameworkInputSpecs(framework, entityType) : []
  const specByProp =
    slot.length > 0
      ? new Map(slot.map((s) => [s.property, s]))
      : frameworkInputSpecsAnyType(framework)

  // No declared inputs anywhere → nothing to validate against; defer to SDK.
  if (specByProp.size === 0) return []

  const problems: string[] = []
  const allowed = [...specByProp.keys()]

  // 1. Unknown keys — payload off the framework's schema.
  for (const key of Object.keys(values)) {
    if (!specByProp.has(key)) {
      problems.push(
        `"${key}" is not a ${frameworkId} input. Allowed: ${allowed.join(', ')}.`,
      )
    }
  }

  // 2. Required presence.
  for (const spec of specByProp.values()) {
    if (spec.required && !(spec.property in values)) {
      problems.push(`Missing required "${spec.property}" for ${frameworkId}.`)
    }
  }

  // 3 + 4. Per-value type and range.
  for (const [key, value] of Object.entries(values)) {
    const spec = specByProp.get(key)
    if (!spec) continue // already flagged as unknown above
    if (value === null || value === undefined) {
      problems.push(`"${key}" must not be null for ${frameworkId}.`)
      continue
    }
    switch (spec.type) {
      case 'enum': {
        const buckets = spec.enum_values ?? []
        if (typeof value !== 'string' || (buckets.length > 0 && !buckets.includes(value))) {
          problems.push(
            `"${key}" = ${JSON.stringify(value)} is not a valid ${frameworkId} value. ` +
              `Allowed: ${buckets.join(', ')}.`,
          )
        }
        break
      }
      case 'number':
      case 'assessment': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push(`"${key}" must be a number for ${frameworkId}, got ${JSON.stringify(value)}.`)
          break
        }
        const [min, max] = numericRange(spec)
        if (min !== undefined && value < min) {
          problems.push(
            `"${key}" = ${value} is below the minimum ${min}` +
              (spec.scale_id ? ` for the ${spec.scale_id} scale` : '') + `.`,
          )
        } else if (max !== undefined && value > max) {
          problems.push(
            `"${key}" = ${value} is above the maximum ${max}` +
              (spec.scale_id ? ` for the ${spec.scale_id} scale` : '') + `.`,
          )
        }
        break
      }
      case 'boolean':
        if (typeof value !== 'boolean') {
          problems.push(`"${key}" must be true or false for ${frameworkId}, got ${JSON.stringify(value)}.`)
        }
        break
      case 'string':
        if (typeof value !== 'string') {
          problems.push(`"${key}" must be a string for ${frameworkId}, got ${JSON.stringify(value)}.`)
        }
        break
      default:
        // Spec declares the property but no type — nothing strict to assert.
        break
    }
  }

  return problems
}

/**
 * Translate the SDK's internal "no canonical edge" failure into a user-facing
 * message ( E4). `inferEdgeType` throws an `InferEdgeTypeError` whose
 * message leaks the catalog internals
 * (`No edge type in UPG_EDGE_CATALOG for source=X, target=Y.`). Rewrite it to a
 * plain sentence and classify it as a policy violation (exit 2) — an
 * incompatible pair is the same class of problem as an incompatible `connect`.
 * Any other error keeps its message and stays a runtime error (exit 1).
 */
export function wrapEdgeInferenceError(err: unknown): CliError {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /No edge type in UPG_EDGE_CATALOG for source=([\w-]+), target=([\w-]+)/.exec(msg)
  if (m) {
    const [, source, target] = m
    // Hyphen, not em-dash (the em-dash hook rejects em-dashes in user strings).
    return violation(
      `${source} cannot connect directly to ${target} - no canonical relationship exists. ` +
        `Reorient the pair, or use \`upg connect\` with an explicit --type.`,
    )
  }
  return runtimeError(msg)
}

/**
 * Resolve the .upg file a command operates on (CLI-FEEDBACK #8).
 *
 * Precedence:
 *   1. explicit `--file <path>`
 *   2. `UPG_FILE` env var (honoured on every command, for CI/scripts)
 *   3. `.upg/workspace.session.json` active_product (the gitignored session
 *      cursor `upg workspace switch` writes — 0.38.0, F4)
 *   4. `.upg/workspace.json` default_product
 *   5. exactly one `.upg` in `.upg/` (else, with >1 and no workspace, error —
 *      never silently pick)
 *   6. exactly one `*.upg` in cwd (else, with >1, error)
 *
 * The ambiguity guard raises a UsageError-style message rather than guessing,
 * because silently selecting one of several files surfaced the *wrong* (broken)
 * graph in the field report.
 */
export async function discoverUPGFile(explicitFile?: string): Promise<string> {
  if (explicitFile) return path.resolve(explicitFile)

  // UPG_FILE applies uniformly to every command.
  const envFile = process.env.UPG_FILE
  if (envFile) return path.resolve(envFile)

  const cwd = process.cwd()

  // Tier 1.5: the workspace SESSION cursor (0.38.0, F4). `upg workspace
  // switch` records the active product here — a gitignored sibling — instead
  // of rewriting the tracked workspace.json, so a read-only exploration never
  // leaves the repo dirty (and an agent's `git add -A` never commits a cursor
  // move). `workspace set-default` is the explicit way to move the tracked
  // default. A cursor pointing at a deleted file is skipped, not fatal.
  const sessionPath = path.join(cwd, '.upg', 'workspace.session.json')
  try {
    const raw = await fs.readFile(sessionPath, 'utf-8')
    const session = JSON.parse(raw)
    if (session.active_product) {
      const filePath = path.join(cwd, '.upg', session.active_product)
      await fs.access(filePath)
      return filePath
    }
  } catch { /* continue */ }

  // Tier 2: .upg/workspace.json default_product (an explicit selection).
  const workspacePath = path.join(cwd, '.upg', 'workspace.json')
  try {
    const raw = await fs.readFile(workspacePath, 'utf-8')
    const workspace = JSON.parse(raw)
    if (workspace.default_product) {
      const filePath = path.join(cwd, '.upg', workspace.default_product)
      await fs.access(filePath)
      return filePath
    }
  } catch { /* continue */ }

  // Tier 2.5: .upg/ dir with .upg files but no workspace.json.
  try {
    const upgDir = path.join(cwd, '.upg')
    const entries = await fs.readdir(upgDir)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length === 1) return path.join(upgDir, upgFiles[0])
    if (upgFiles.length > 1) {
      throw new AmbiguousFileError(upgFiles.map((f) => path.join('.upg', f)))
    }
  } catch (err) {
    if (err instanceof AmbiguousFileError) throw err
    /* continue */
  }

  // Tier 3: *.upg in cwd.
  try {
    const entries = await fs.readdir(cwd)
    const upgFiles = entries.filter((f) => f.endsWith('.upg')).sort()
    if (upgFiles.length === 1) return path.resolve(upgFiles[0])
    if (upgFiles.length > 1) throw new AmbiguousFileError(upgFiles)
  } catch (err) {
    if (err instanceof AmbiguousFileError) throw err
    /* continue */
  }

  throw new Error('No .upg file found. Run `upg init` to create one, or use --file <path> (or set UPG_FILE).')
}

/**
 * Raised when more than one `.upg` file is a candidate and there is no
 * workspace default. Carries the candidate list so commands can render a
 * helpful "which file?" message. Classified as a usage error (exit 3).
 */
export class AmbiguousFileError extends Error {
  readonly candidates: string[]
  constructor(candidates: string[]) {
    super(
      `Multiple .upg files found and no workspace default:\n` +
      candidates.map((c) => `  ${c}`).join('\n') +
      `\nPass --file <path> or set UPG_FILE to choose one.`,
    )
    this.name = 'AmbiguousFileError'
    this.candidates = candidates
  }
}

export async function loadStore(filePath: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  // Stamp this CLI (name + real version) as the writer so every file it saves
  // records accurate provenance ( / M7).
  store.setWriter('upg-cli', CLI_VERSION)
  try {
    await store.load(filePath)
  } catch (err) {
    // E4: turn raw filesystem / JSON failures into clear messages.
    // A missing file or an unparsable / non-.upg file (when `--file` or
    // `UPG_FILE` points somewhere wrong) otherwise surfaces a bare `ENOENT ...`
    // or `Unexpected token ...` that says nothing about what the user did.
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') {
      throw runtimeError(`No .upg file at ${filePath}`)
    }
    if (err instanceof SyntaxError) {
      throw runtimeError(`Not a valid .upg file: ${filePath}`)
    }
    throw err
  }
  return store
}
