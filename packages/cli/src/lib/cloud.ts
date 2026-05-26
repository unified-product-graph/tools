/**
 * Cloud API client: wraps the UPG cloud MCP endpoint for CLI use.
 */

export interface CloudClient {
  endpoint: string
  apiKey: string
}

/** Call an MCP tool on the cloud server */
export async function callTool(
  client: CloudClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${client.endpoint}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Cloud server returned ${response.status}: ${body}`)
  }

  const rpc = await response.json() as {
    result?: { content?: Array<{ text?: string }> }
    error?: { code?: number; message?: string }
  }

  if (rpc.error) {
    throw new Error(`Cloud error: ${rpc.error.message ?? JSON.stringify(rpc.error)}`)
  }

  const text = rpc.result?.content?.[0]?.text
  if (!text) throw new Error('Empty response from cloud')

  return JSON.parse(text)
}

/** Upload a .upg file via the REST import endpoint */
export async function uploadFile(
  client: CloudClient,
  filePath: string,
  strategy: string = 'create_new',
  productId?: string
): Promise<{
  product_id: string
  nodes_created: number
  edges_created: number
  node_id_map: Record<string, string>
  edge_id_map: Record<string, string>
  errors: Array<{ index: number; error: string }>
}> {
  const fs = await import('node:fs')
  const { Blob } = await import('node:buffer')

  const content = fs.readFileSync(filePath, 'utf-8')
  const blob = new Blob([content], { type: 'application/json' })

  const formData = new FormData()
  formData.append('file', blob, filePath.split('/').pop() ?? 'product.upg')
  formData.append('strategy', strategy)
  if (productId) formData.append('product_id', productId)

  const response = await fetch(`${client.endpoint}/api/import-upg`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${client.apiKey}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Upload failed (${response.status}): ${body}`)
  }

  return response.json() as Promise<{
    product_id: string
    nodes_created: number
    edges_created: number
    node_id_map: Record<string, string>
    edge_id_map: Record<string, string>
    errors: Array<{ index: number; error: string }>
  }>
}
