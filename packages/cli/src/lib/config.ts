/**
 * Config and credentials. Stored in ~/.upg/.
 *
 * ~/.upg/config.json:      default endpoint and preferences.
 * ~/.upg/credentials.json: API keys per endpoint (gitignored).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const CONFIG_DIR = path.join(os.homedir(), '.upg')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json')

interface Config {
  default_endpoint?: string
}

interface Credentials {
  endpoints: Record<string, {
    api_key: string
    email?: string
    logged_in_at?: string
  }>
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await ensureDir()
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export async function readCredentials(): Promise<Credentials> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { endpoints: {} }
  }
}

export async function writeCredentials(creds: Credentials): Promise<void> {
  await ensureDir()
  await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600, // owner read/write only
  })
}

export async function storeApiKey(endpoint: string, apiKey: string, email?: string): Promise<void> {
  const creds = await readCredentials()
  creds.endpoints[endpoint] = {
    api_key: apiKey,
    email,
    logged_in_at: new Date().toISOString(),
  }
  await writeCredentials(creds)

  // Also set as default endpoint if none set
  const config = await readConfig()
  if (!config.default_endpoint) {
    config.default_endpoint = endpoint
    await writeConfig(config)
  }
}

/**
 * Resolve API key. Priority: UPG_API_KEY env var > stored credentials > error.
 */
export async function resolveApiKey(endpoint?: string): Promise<{ endpoint: string; apiKey: string }> {
  // Env var takes precedence (for CI)
  const envKey = process.env.UPG_API_KEY
  if (envKey) {
    const config = await readConfig()
    const ep = endpoint ?? config.default_endpoint ?? 'https://cloud.unifiedproductgraph.org'
    return { endpoint: ep, apiKey: envKey }
  }

  const config = await readConfig()
  const ep = endpoint ?? config.default_endpoint
  if (!ep) {
    throw new Error('Not logged in. Run `upg login` first, or set UPG_API_KEY.')
  }

  const creds = await readCredentials()
  const stored = creds.endpoints[ep]
  if (!stored?.api_key) {
    throw new Error(`No API key for ${ep}. Run \`upg login\` or set UPG_API_KEY.`)
  }

  return { endpoint: ep, apiKey: stored.api_key }
}
