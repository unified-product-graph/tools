/**
 * Wire-shape contract for an MCP tool. Handlers generic over `TContext`:
 * each server passes its own runtime store, session, or cache.
 */

import type { ToolResult } from './result.js'

export interface ToolInputSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

/**
 * Tool handler. Takes args and a server-supplied context, returns a
 * `ToolResult` (sync or async). Context shape is the server's concern;
 * the catalog treats it as opaque.
 *
 *   - `mcp-server`: `UPGFileStore` + session, cache, sync state.
 *   - `cloud-server`: Postgres store + tenant, auth state.
 *   - Embedders: whatever you pass.
 */
export type ToolHandler<TContext> = (
  args: Record<string, unknown>,
  ctx: TContext,
) => Promise<ToolResult> | ToolResult

/**
 * Registry binding. Pairs a `ToolDefinition` with its `ToolHandler`.
 * Each server passes an array of these to its dispatcher.
 */
export interface ToolBinding<TContext> {
  definition: ToolDefinition
  handler: ToolHandler<TContext>
}
