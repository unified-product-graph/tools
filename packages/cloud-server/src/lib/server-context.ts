/**
 * Cloud-side `ToolHandler` context: the runtime closure passed to every
 * cloud tool handler. Wraps a `PgStore` over Postgres. Shares the
 * `ToolHandler<TContext>` contract with the local server's file-store wrapper.
 */

import type { PgStore } from '../store/pg-store.js'
import { type ToolHandler as ToolHandlerBase } from '@unified-product-graph/mcp-tooling'

export interface CloudContext {
  store: PgStore
}

export type ToolHandler = ToolHandlerBase<CloudContext>

export { text, textError, type ToolResult } from '@unified-product-graph/mcp-tooling'
