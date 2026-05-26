/**
 * Transport contract. Two canonical adapters:
 *
 *   - `StdioTransport` (`mcp-server`): local `.upg` over MCP stdio.
 *   - `HttpTransport` (`cloud-server`): Postgres over HTTP.
 *
 * A dispatcher receives a `ToolRequest`, looks up the binding by name,
 * and calls the handler with the server's runtime context.
 */

import type { ToolResult } from './result.js'

export interface ToolRequest {
  /** Tool name (e.g. `create_node`, `validate_graph`). */
  name: string
  /** Tool arguments. Shape validated by `ToolDefinition.inputSchema`. */
  args: Record<string, unknown>
  /** Optional request id for transport-level correlation. */
  id?: string | number
}

export interface ToolResponse {
  /** Echoed from the request when the transport carries one. */
  id?: string | number
  /** The handler's result (or the dispatcher's error envelope). */
  result: ToolResult
}

/**
 * Generic transport interface. Implementations bridge a wire protocol
 * (stdio framed messages, HTTP/JSON-RPC, etc.) to the dispatcher.
 *
 * `start`/`stop` are lifecycle hooks for long-lived transports. Stateless
 * adapters (a per-request Next.js route, say) omit them.
 */
export interface MCPTransport {
  /**
   * Dispatch a single request through the tool registry. Implementations
   * handle argument decoding, registry lookup, and error envelopes.
   * Handler return shapes pass through untouched.
   */
  dispatch(request: ToolRequest): Promise<ToolResponse>

  /** Begin accepting requests. Long-lived transports open sockets here. */
  start?(): Promise<void>

  /** Drain in-flight requests and shut down. */
  stop?(): Promise<void>
}
