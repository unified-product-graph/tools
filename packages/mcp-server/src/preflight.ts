/**
 * Preflight dependency check for the UPG MCP Server.
 *
 * ES module imports are hoisted, so if a dependency is missing the process
 * crashes before any error-handling code runs, producing silent failure
 * in Claude Code. This script checks critical deps first, prints a
 * human-readable message on failure, then dynamically imports the real
 * entry point.
 */

const REQUIRED_DEPS: Array<[label: string, specifier: string]> = [
  ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/server'],
  ['@unified-product-graph/core', '@unified-product-graph/core'],
  ['chokidar', 'chokidar'],
  ['nanoid', 'nanoid'],
]

const missing: string[] = []

for (const [label, specifier] of REQUIRED_DEPS) {
  try {
    await import(specifier)
  } catch {
    missing.push(label)
  }
}

if (missing.length > 0) {
  process.stderr.write(
    `\n╭─ UPG MCP Server: missing dependencies ─────────────────╮\n` +
    `│                                                          │\n` +
    missing.map((d) =>
      `│  ✗ ${d}${' '.repeat(Math.max(0, 52 - d.length))}│\n`
    ).join('') +
    `│                                                          │\n` +
    `│  Run \`npm install\` in the project root to fix this.      │\n` +
    `╰──────────────────────────────────────────────────────────╯\n\n`,
  )
  process.exit(1)
}

// All deps present; boot the real server.
//
// CALLED, not merely imported (fixed 0.34.1). This used to be a bare
// `await import('./index.js')` and relied on that module's auto-start guard to
// notice it had been loaded. The guard compares `process.argv[1]` against its
// own module URL, and through this file argv[1] is `preflight.js`, so the
// comparison was false and NOTHING started: the process imported the whole
// server, started no transport, and exited 0 with an empty stdout and an empty
// stderr. A client launched through this entry point got a server that
// connected and said nothing at all, with no diagnosis anywhere — the true
// version of the silent failure this file exists to prevent.
//
// Calling `runMcpServer` directly removes the guess. The same catch as the
// direct entry point, so a startup failure is reported and exits non-zero
// rather than vanishing.
const { runMcpServer } = await import('./index.js')
try {
  await runMcpServer()
} catch (err) {
  process.stderr.write(
    `\nUPG MCP server failed to start:\n${(err as Error).message ?? String(err)}\n`,
  )
  process.exit(1)
}

export {}
