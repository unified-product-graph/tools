/**
 * Emits the `document_transcludes_node` edge for every inline anchor in a
 * document body. The anchor and the edge are one fact recorded twice, so the
 * emitter is written beside the parser rather than left to each consumer.
 *
 * Resolution against a graph stays the caller's responsibility, exactly as in
 * validate(): the caller injects a lookup, and an anchor that does not resolve
 * yields no edge.
 */

import type {
  ParseResult,
  SkippedAnchor,
  TransclusionEdge,
  TransclusionOptions,
  TransclusionResult,
} from './types.js'
import { buildIndex } from './index-builder.js'

/**
 * The catalog key this emitter writes. Spelled out rather than imported: this
 * package parses text and treats types and ids as plain strings, so it carries
 * no runtime dependency on the spec package.
 */
const TRANSCLUDES_EDGE_TYPE = 'document_transcludes_node' as const

/**
 * Build the transclusion edges a parsed .upg.md asserts.
 *
 * One edge per (document, node) pair, sourced on the document the frontmatter
 * declares and targeted on whatever the resolver returns for the anchor. The
 * edge carries no position: the anchor is the position, and it lives in the
 * prose where ordinary editing moves it for free.
 *
 * @param result - The parse result for a single .upg.md document
 * @param options - Target resolution, injected by the caller
 * @returns The edges to write, and every anchor that produced none, with its reason
 */
export async function buildTransclusionEdges(
  result: ParseResult,
  options: TransclusionOptions,
): Promise<TransclusionResult> {
  const index = buildIndex(result)
  const edges: TransclusionEdge[] = []
  const skipped: SkippedAnchor[] = []

  // Read defensively. The frontmatter TYPE declares entity_type: 'document' and a
  // required entity_id, but the value is whatever the YAML held: parse() records
  // an error for a non-document entity_type and still returns the frontmatter, so
  // a document-shaped type here would let the wrong source through.
  const entityType = result.frontmatter.entity_type as string | undefined
  const documentId = result.frontmatter.entity_id as string | undefined

  // The containing document IS the frontmatter. `entity_type` must be 'document'
  // (spec section 3.1, which parse() already records an error against) and
  // `entity_id` is that document's identity. An anchor sitting in the body of
  // anything else is not a transclusion: the edge declares `document` as its
  // source type and there is no second source to fall back to, so the honest
  // answer is no edge at all rather than an edge from a guessed owner.
  if (entityType !== 'document' || !documentId) {
    const reason = entityType !== 'document'
      ? 'source_not_a_document'
      : 'source_missing_entity_id'
    for (const entry of index.entities.values()) {
      skipped.push({ key: entry.key, reason, isCreation: entry.isCreation })
    }
    return { edges, skipped }
  }

  for (const entry of index.entities.values()) {
    // `count === 0` means the entity reached the index only as an endpoint of a
    // {{a -> b|verb}} edge ref, never as an inline [[type:id]] anchor. That form
    // asserts a relationship between the two entities it names and says nothing
    // about the document, so it must not pull the document into an edge. This
    // check is also what keeps the emitter keyed on the ANCHOR: the loop can
    // only ever see entities the prose actually anchored, so no generic
    // pair-resolution path reaches the write below. The edge is deliberate_only
    // precisely so that no such path may.
    if (entry.count === 0) {
      skipped.push({ key: entry.key, reason: 'not_an_anchor', isCreation: entry.isCreation })
      continue
    }

    // Cross-product anchors ([[type:id@product]]) are refused BEFORE resolution,
    // and deliberately never handed to the resolver: 'type:id@product' names an
    // entity in another graph, and a resolver asked to look that key up locally
    // would at best miss and at worst match a same-id local entity, minting an
    // edge to the wrong node. The relationship is not expressible by this edge
    // in any case. Neither of its endpoint types is portfolio-shared (`document`
    // is not, and the `node` wildcard never qualifies on its own), so it
    // classifies resident and cannot cross graphs; a genuine cross-product
    // transclusion belongs in the portfolio document as a cross-edge. Reported
    // here rather than dropped, so a caller can route it.
    if (entry.product) {
      skipped.push({ key: entry.key, reason: 'cross_product_anchor', isCreation: entry.isCreation })
      continue
    }

    // Creation anchors ([[+type:id]]) are eligible, and gated by resolution like
    // every other anchor rather than refused up front. The + marks node
    // LIFECYCLE (mint this node), not prose semantics: an anchor in a document
    // body is a transclusion anchor whether or not the node existed when the
    // sentence was typed. Minting is the caller's decision, so until the caller
    // has made it the resolver returns null and the anchor is skipped as
    // unresolved, carrying isCreation so the caller can tell "not created yet"
    // from "genuinely stale". Once the node exists the same anchor emits its
    // edge instead of being silently lost, and no dangling edge is ever written.
    const target = await options.resolveTarget(entry.key)
    if (!target) {
      skipped.push({ key: entry.key, reason: 'unresolved_anchor', isCreation: entry.isCreation })
      continue
    }

    // One edge per (document, node) pair. index.entities is already deduplicated
    // by key and already carries `count` and `lines`; the repeat count and the
    // line numbers stay there, where a reader looking for occurrences will look,
    // and neither travels onto the edge.
    edges.push({
      type: TRANSCLUDES_EDGE_TYPE,
      source: documentId,
      target,
      anchor: entry.key,
    })
  }

  return { edges, skipped }
}
