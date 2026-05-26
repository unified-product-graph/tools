/**
 * Helm's one-and-only UPGClient.
 *
 * Constructing a UPGClient is cheap — it doesn't read the file until you
 * call something on it. So we can export a singleton and share it across
 * every command without worrying about init order or load races.
 *
 * The `--file` flag flows in via the global option (see cli.ts). Default is
 * the bundled `demo.upg` so `helm report` works out of the box without setup.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPGClient } from '@unified-product-graph/sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEMO_UPG = path.resolve(HERE, '../demo.upg')

let _client: UPGClient | null = null

export function getClient(file?: string): UPGClient {
  if (_client) return _client
  _client = new UPGClient({ file: file ?? DEMO_UPG })
  return _client
}
