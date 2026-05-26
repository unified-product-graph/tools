/**
 * MCP wire-shape primitives. One response shape across stdio, HTTP, and
 * embedded servers.
 */

export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: ToolTextContent[]
  isError?: true
}

export function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] }
}

export function textError(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true }
}
