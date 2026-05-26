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
    `\n╭─ UPG MCP Server — missing dependencies ─────────────────╮\n` +
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

// All deps present — boot the real server
await import('./index.js')

export {}
