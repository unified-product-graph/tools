/**
 * Runtime entry. Four groups of exports:
 *
 *   - Wire shapes: `ToolResult`, `text()`, `textError()`.
 *   - Catalog contracts: `ToolDefinition`, `ToolHandler<TContext>`,
 *     `ToolBinding<TContext>`.
 *   - Transport interface: `MCPTransport`, `ToolRequest`, `ToolResponse`.
 *   - Catalog helpers: `resolveEntityType`, `UnknownEntityTypeError`,
 *     `buildEntitySchema`, `buildEntityFields`.
 *   - Atomicity contracts: `MigrateTypeResult`, `RenameEdgeTypeResult`,
 *     `ExportEdgesResult`, `ValidateGraphResult`, `MigratePropertiesResult`.
 *
 * Generator exports live at `@unified-product-graph/mcp-tooling/generator`.
 */

export {
  type ToolTextContent,
  type ToolResult,
  text,
  textError,
} from './result.js'

export {
  type ToolInputSchema,
  type ToolDefinition,
  type ToolHandler,
  type ToolBinding,
} from './tool-definition.js'

export {
  type ToolRequest,
  type ToolResponse,
  type MCPTransport,
} from './transport.js'

export {
  type EntityTypeResolution,
  UnknownEntityTypeError,
  resolveEntityType,
  type EntitySchema,
  type EntitySchemaEdgeOut,
  type EntitySchemaEdgeIn,
  type EntitySchemaDomainGuide,
  type EntitySchemaDomainGuideAntiPattern,
  type BuildEntitySchemaOptions,
  buildEntitySchema,
  buildEntityFields,
  buildAllEntityFields,
} from './catalog.js'

export {
  type MigrateTypeResult,
  type MigrateTypeEdgeRename,
  type MigrateTypeEdgeDrop,
  type MigrateTypeUnmappedLegacyEdge,
  type MigratePropertiesResult,
  type MigratePropertiesNodeChange,
  type MigrateStatusResult,
  type MigrateStatusNodeChange,
  type ValidateGraphResult,
  type ValidateGraphScope,
  type ValidateGraphSummary,
  type ValidateGraphEntityDrift,
  type ValidateGraphEntitySuggestion,
  type ValidateGraphEdgeDrift,
  type ValidateGraphEdgeSuggestion,
  type ValidateGraphTopLevelDrift,
  type ValidateGraphLifecycleDrift,
  type ValidateGraphLifecycleSuggestion,
  type ValidateGraphSelfReferential,
  type ValidateGraphPropertyDrift,
  type ValidateGraphAntiPatternViolation,
  type RenameEdgeTypeResult,
  type RenameEdgeTypeSampleEdge,
  type ExportEdgesResult,
  type ExportEdgesEdge,
} from './atomicity-contracts.js'
