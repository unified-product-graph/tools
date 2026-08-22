/**
 * @unified-product-graph/markdown: public entry point.
 *
 * See https://unifiedproductgraph.org. MIT.
 */

export { parse } from './parse.js'
export { buildIndex } from './index-builder.js'
export { validate } from './validate.js'
export { buildTransclusionEdges } from './transclude.js'
export { toPlainMarkdown, updateRefs } from './export.js'
export type { TitleResolver, RefResolution, RefResolver, ExportOptions } from './export.js'
export { toTipTapJSON } from './to-tiptap.js'
export { fromTipTapJSON } from './from-tiptap.js'
export type { TipTapNode, TipTapDocument } from './to-tiptap.js'
export type { FromTipTapOptions } from './from-tiptap.js'

export type {
  // Core types
  UPGMarkdownFrontmatter,
  EntityReference,
  EdgeReference,
  InlineProperty,
  ParseResult,
  ParseWarning,
  ParseError,
  WarningCode,
  ErrorCode,

  // Index
  ReferenceIndex,
  IndexEntry,

  // Transclusion
  TransclusionEdge,
  TransclusionSkipReason,
  SkippedAnchor,
  TransclusionOptions,
  TransclusionResult,

  // Validation
  ValidationOptions,
  ValidationResult,
} from './types.js'
