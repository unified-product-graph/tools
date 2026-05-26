import { Command } from 'commander'
import * as http from 'node:http'
import * as readline from 'node:readline'
import { storeApiKey, readCredentials, readConfig } from '../lib/config.js'

export const loginCommand = new Command('login')
  .description('Authenticate with UPG cloud via browser OAuth or --key.')
  .option('--endpoint <url>', 'Cloud endpoint URL', 'https://cloud.unifiedproductgraph.org')
  .option('--key <key>', 'API key. Skips the browser flow')
  .action(async (opts) => {
    const endpoint = opts.endpoint.replace(/\/$/, '')

    // Fast path: direct API key
    if (opts.key) {
      await storeApiKey(endpoint, opts.key)
      console.log(`✓ API key stored for ${endpoint}`)
      return
    }

    // Check env var
    if (process.env.UPG_API_KEY) {
      await storeApiKey(endpoint, process.env.UPG_API_KEY)
      console.log(`✓ API key from UPG_API_KEY stored for ${endpoint}`)
      return
    }

    // Try browser-based OAuth flow
    console.log('\nOpening browser for authentication...\n')

    try {
      const result = await browserAuthFlow(endpoint)
      await storeApiKey(endpoint, result.apiKey, result.email)
      console.log(`\n✓ Logged in as ${result.email ?? 'authenticated user'}`)
      console.log(`  Endpoint: ${endpoint}`)
      console.log(`  Key stored in ~/.upg/credentials.json\n`)
    } catch (err) {
      // Browser flow failed; fall back to manual key entry.
      console.log('Browser auth not available. Enter your API key manually.')
      console.log(`Get one from: ${endpoint}/settings → API Keys\n`)

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const key = await new Promise<string>((resolve) => {
        rl.question('API key: ', (answer) => { rl.close(); resolve(answer.trim()) })
      })

      if (!key) {
        console.error('No key provided.')
        process.exit(1)
      }

      await storeApiKey(endpoint, key)
      console.log(`\n✓ API key stored for ${endpoint}\n`)
    }
  })

/** Remove credentials for one or all endpoints. */
export const logoutCommand = new Command('logout')
  .description('Remove stored credentials.')
  .option('--endpoint <url>', 'Cloud endpoint to log out from')
  .action(async (opts) => {
    const { readCredentials, writeCredentials } = await import('../lib/config.js')
    const creds = await readCredentials()

    if (opts.endpoint) {
      delete creds.endpoints[opts.endpoint]
      await writeCredentials(creds)
      console.log(`✓ Logged out of ${opts.endpoint}`)
    } else {
      await writeCredentials({ endpoints: {} })
      console.log('✓ All credentials removed')
    }
  })

/**
 * Browser-based OAuth flow:
 * 1. Start local HTTP server on random port
 * 2. Open browser to auth page
 * 3. Wait for callback with API key
 */
async function browserAuthFlow(endpoint: string): Promise<{ apiKey: string; email?: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`)

      if (url.pathname === '/callback') {
        const apiKey = url.searchParams.get('key')
        const email = url.searchParams.get('email')

        if (apiKey) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
                <div style="text-align: center;">
                  <h1>✓ Authenticated</h1>
                  <p>You can close this window and return to the terminal.</p>
                </div>
              </body>
            </html>
          `)
          server.close()
          resolve({ apiKey, email: email ?? undefined })
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Missing API key in callback')
          server.close()
          reject(new Error('No API key in callback'))
        }
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start local server'))
        return
      }
      const port = address.port
      const authUrl = `${endpoint}/cli-auth?port=${port}&callback=http://127.0.0.1:${port}/callback`

      // Open browser
      const { exec } = require('node:child_process')
      const openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open'
      exec(`${openCmd} "${authUrl}"`, (err: Error | null) => {
        if (err) {
          server.close()
          reject(new Error('Could not open browser'))
        }
      })

      console.log(`Waiting for authentication at: ${authUrl}`)
      console.log('(Press Ctrl+C to cancel)\n')

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close()
        reject(new Error('Authentication timed out (2 minutes)'))
      }, 120000)
    })
  })
}
