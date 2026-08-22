/**
 * Unified write-validation pass (Seam 1).
 *
 * ONE validation function, called by every write tool — single AND batch —
 * so the same off-spec input gets the same answer everywhere. Before this
 * module each write tool validated differently:
 *
 *   - single `create_node` WARNED on unknown properties but was SILENT on an
 *     invalid status;
 *   - batch `batch_create_nodes` was the opposite (silent on properties, warned
 *     on status);
 *   - single `create_edge` accepted ANY string as an explicit edge type while
 *     batch `edges[]` rejected non-catalog types and rolled back.
 *
 * The seam spec's posture (see `upg-seam-design-spec.md`, SEAM 1):
 *
 *   | dimension        | posture                                   |
 *   |------------------|-------------------------------------------|
 *   | entity `type`    | STRICT — reject unknown (alias → warn)     |
 *   | `status`         | STRICT — must ∈ entity's lifecycle phases  |
 *   | `properties`     | PERMISSIVE — warn on unknown keys, store   |
 *   | explicit edge `type` | STRICT — must ∈ catalog + pair matches |
 *   | inferred edge    | STRICT — resolver must be non-null         |
 *
 * `strict: true` promotes the permissive PROPERTY warnings to rejections for
 * authoring-time use; it never relaxes the strict dimensions.
 */

import {
  getPropertySchema,
  resolveEntityType,
  UnknownEntityTypeError,
  UPG_EDGE_CATALOG,
  validateProductStageStrict,
  type UPGEdgeType,
} from '@unified-product-graph/core'
import { validateStatusAgainstLifecycle } from './tools.js'
import { checkUndeclaredProperties } from './property-type-validator.js'
import { validateEdgeTypePair } from './edge-pair-validator.js'

export interface WriteValidationOptions {
  /**
   * Authoring-time strictness. When true, unknown-property WARNINGS are
   * promoted to errors (rejections). Strict dimensions (type / status / edge)
   * reject regardless of this flag.
   */
  strict?: boolean
}

export interface NodeWriteValidation {
  /** Canonical entity type (alias-resolved). */
  canonicalType: string
  /** Rejections. Non-empty means the caller MUST refuse the write. */
  errors: string[]
  /** Non-fatal warnings (alias use, unknown properties in non-strict mode). */
  warnings: string[]
}

/**
 * Validate a node write (create OR update) against the canonical posture.
 *
 * - `type` (when provided): alias → warning; unknown → error. Omit `type` for
 *   update-only validation where the type is fixed (pass `knownType`).
 * - `status` (when provided): must ∈ the entity type's lifecycle phases → error.
 * - `properties` (when provided): unknown keys → warning (or error in strict).
 *
 * Returns `errors` (rejections) + `warnings`. Callers reject iff
 * `errors.length > 0`, applying the SAME rule for single + batch. Never throws
 * for an unknown type; the error is collected so single and batch report it
 * identically (batch historically returned a structured error, single threw —
 * callers that want to preserve a thrown `UnknownEntityTypeError` can opt in
 * via `throwOnUnknownType`).
 */
export function validateNodeWrite(
  args: {
    type?: string
    knownType?: string
    status?: string
    properties?: Record<string, unknown>
  },
  options: WriteValidationOptions = {},
): NodeWriteValidation {
  const errors: string[] = []
  const warnings: string[] = []

  // ── type (STRICT) ─────────────────────────────────────────────────────────
  let canonicalType = args.knownType ?? ''
  if (args.type !== undefined) {
    try {
      const resolved = resolveEntityType(args.type)
      canonicalType = resolved.canonical
      if (resolved.alias) {
        warnings.push(
          `Type '${resolved.alias.from}' aliased to canonical '${resolved.alias.to}'. Update your caller to use '${resolved.alias.to}' directly.`,
        )
      }
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) {
        errors.push(err.message)
        return { canonicalType, errors, warnings }
      }
      throw err
    }
  }

  // ── status (STRICT) ─────────────────────────────────────────────────────
  if (args.status !== undefined && canonicalType) {
    const statusIssue = validateStatusAgainstLifecycle(canonicalType, args.status)
    if (statusIssue) errors.push(statusIssue)
  }

  // ── product.stage (STRICT / DT-SIM-1) ────────────────────────────
  // A `product` node carries its lifecycle stage in `properties.stage`. The
  // dedicated `create_product` write path validates that value against the
  // canonical UPGProductStage enum; the generic create_node / update_node path
  // historically did not, so `create_node(type:product,{stage:"idea"})` landed
  // a legacy value silently. Validate here with the SAME helper create_product
  // uses, so both paths reject identical legacy values with an identical
  // message. WRITE-PATH ONLY — load-time coercion (store.ts) is untouched, so
  // existing .upg files with legacy stages still load.
  if (args.properties && canonicalType === 'product' && 'stage' in args.properties) {
    const stageError = validateProductStageStrict(args.properties.stage)
    if (stageError !== null) errors.push(stageError)
  }

  // ── properties (PERMISSIVE → warn; strict → error) ────────────────────────
  if (args.properties && canonicalType) {
    const unknown = unknownPropertyKeys(canonicalType, args.properties)
    if (unknown.length > 0) {
      const msg =
        `Unknown propert${unknown.length === 1 ? 'y' : 'ies'} for type "${canonicalType}": ` +
        `[${unknown.join(', ')}]. Stored as-is (permissive write). ` +
        `See get_entity_schema("${canonicalType}") for declared properties.`
      if (options.strict) errors.push(msg)
      else warnings.push(msg)
    }
  }

  return { canonicalType, errors, warnings }
}

/**
 * Keys present on `properties` that are NOT declared in the entity type's
 * property schema. Types with no registered schema are treated as fully
 * permissive (no unknowns reported). The `unset_properties` sentinel and the
 * `_unset` marker are never reported as unknown.
 */
export function unknownPropertyKeys(
  entityType: string,
  properties: Record<string, unknown>,
): string[] {
  // Delegates, and the delegation is the point. This was the THIRD independent
  // implementation of "is this bag key declared?" — the read surface had one,
  // the graph-wide validator had another, and this one backed the write path.
  // 0.34.1 collapsed the first two into `checkUndeclaredProperties` and gave it
  // the `<tool>:<key>` namespace exemption the spec requires; this copy kept its
  // own answer, so `create_node` went on warning about a correctly-namespaced
  // extension that `get_node` and `validate_graph` had just stopped warning
  // about. One call could carry both verdicts about one key.
  //
  // Three implementations of one question will disagree eventually; the only
  // question is which release notices.
  return checkUndeclaredProperties(entityType, properties).unknown_properties
}

export interface EdgeWriteValidation {
  errors: string[]
  warnings: string[]
}

/**
 * Validate an EXPLICIT edge type against the catalog.
 *
 * STRICT: an explicit edge type must (a) exist in `UPG_EDGE_CATALOG` and
 * (b) match the catalog's declared source/target node types. This is what
 * batch `edges[]` already did; single `create_edge` previously skipped the
 * catalog-membership check (it accepted any string), so a "made up" edge type
 * landed silently. This closes that single↔batch gap.
 *
 * Inferred edges (no explicit `type`) are validated by the caller via
 * `inferEdgeTypeWithTier`; this helper covers only the explicit path.
 */
export function validateExplicitEdgeType(
  edgeType: string,
  sourceNodeType: string,
  targetNodeType: string,
): EdgeWriteValidation {
  const errors: string[] = []
  if (!UPG_EDGE_CATALOG[edgeType as UPGEdgeType]) {
    errors.push(
      `Edge type "${edgeType}" is not in UPG_EDGE_CATALOG. ` +
        `Pass a canonical edge type, or omit \`type\` to infer it from (${sourceNodeType} → ${targetNodeType}).`,
    )
    return { errors, warnings: [] }
  }
  const pairCheck = validateEdgeTypePair(edgeType, sourceNodeType, targetNodeType)
  if (!pairCheck.valid) errors.push(pairCheck.reason)
  return { errors, warnings: [] }
}
