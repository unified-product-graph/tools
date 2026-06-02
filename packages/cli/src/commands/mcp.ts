/**
 * `upg mcp`: configure, inspect, and run the UPG MCP server.
 *
 * 3 subcommands: `setup`, `status`, `run`.
 */

import { Command } from 'commander'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createInterface } from 'node:readline'
import chalk from 'chalk'

// ── Types ─────────────────────────────────────────────────────────────────────

export type McpScope = 'project' | 'user'

export interface McpServerEntry {
  command: string
  args: string[]
}

export interface ClaudeSettings {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the config file Claude Code actually reads for MCP server definitions.
 *
 * - project scope → `<cwd>/.mcp.json` (the file Claude Code reads for
 *   project-scoped servers; commit it to share with the team).
 * - user scope → `~/.claude.json` (top-level `mcpServers`, user-global).
 *
 * NOT `.claude/settings.json` — that file gates servers
 * (`enabledMcpjsonServers`) and carries permissions/hooks, but Claude Code does
 * NOT read server *definitions* from it. Writing there is why a fresh setup
 * never connected until a `.mcp.json` was added by hand.
 */
function resolveSettingsPath(scope: McpScope): string {
  if (scope === 'user') {
    return path.join(os.homedir(), '.claude.json')
  }
  return path.join(process.cwd(), '.mcp.json')
}

/**
 * Detect the best command+args to use for the MCP server.
 *
 * Detection order:
 *   1. --command override: split on spaces, first token is command, rest are args
 *   2. Monorepo layout: ./packages/upg-cli/dist/cli.cjs exists, use node
 *   3. Default fallback: npx -y @unified-product-graph/mcp-server
 *
 * The server ships as its own package, @unified-product-graph/mcp-server, with a
 * `upg-mcp-server` bin. The canonical launch is the package directly via npx —
 * no `upg mcp run` indirection and no `mcp`/`run` positionals (which used to
 * crash the server's arg parser). `-y` skips the npx install prompt so a fresh
 * machine connects unattended.
 */
export function detectMcpCommand(commandOverride?: string): McpServerEntry {
  // 1. Explicit override.
  if (commandOverride) {
    const parts = commandOverride.trim().split(/\s+/)
    return { command: parts[0], args: parts.slice(1) }
  }

  // 2. Monorepo layout: run the server's own built entry, not via the CLI.
  const monorepoServer = path.join(process.cwd(), 'packages', 'upg-mcp-server', 'dist', 'index.js')
  if (fs.existsSync(monorepoServer)) {
    return { command: 'node', args: ['./packages/upg-mcp-server/dist/index.js'] }
  }

  // 3. Default: npx the published server package directly.
  return { command: 'npx', args: ['-y', '@unified-product-graph/mcp-server'] }
}

// ── Settings file helpers ─────────────────────────────────────────────────────

async function readSettings(filePath: string): Promise<ClaudeSettings> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as ClaudeSettings
  } catch {
    return {}
  }
}

async function writeSettings(filePath: string, settings: ClaudeSettings): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

// ── Prompt helper ─────────────────────────────────────────────────────────────

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (a) => {
      rl.close()
      resolve(a.trim().toLowerCase())
    })
  })
  return answer === 'y' || answer === 'yes'
}

// ── Core runners (exported for tests) ────────────────────────────────────────

export interface SetupOptions {
  scope: McpScope
  force: boolean
  commandOverride?: string
  /** Override settings file path (test hook). */
  settingsPathOverride?: string
}

export interface SetupResult {
  settingsPath: string
  entry: McpServerEntry
  /** true if there was a pre-existing entry that was overwritten */
  overwrote: boolean
  /** true if skipped because user declined to overwrite */
  skipped: boolean
}

export async function runMcpSetup(opts: SetupOptions): Promise<SetupResult> {
  const settingsPath = opts.settingsPathOverride ?? resolveSettingsPath(opts.scope)
  const entry = detectMcpCommand(opts.commandOverride)

  const settings = await readSettings(settingsPath)
  const existing = settings.mcpServers?.['unified-product-graph']

  if (existing && !opts.force) {
    const confirmed = await promptConfirm(
      `  ${chalk.yellow('?')} unified-product-graph entry already exists. Overwrite? [y/N] `,
    )
    if (!confirmed) {
      return { settingsPath, entry, overwrote: false, skipped: true }
    }
  }

  const overwrote = Boolean(existing)

  // Merge: preserve all other top-level keys and other mcpServers entries.
  const merged: ClaudeSettings = {
    ...settings,
    mcpServers: {
      ...(settings.mcpServers ?? {}),
      'unified-product-graph': entry,
    },
  }

  await writeSettings(settingsPath, merged)
  return { settingsPath, entry, overwrote, skipped: false }
}

export interface StatusResult {
  project: { configured: boolean; entry?: McpServerEntry; settingsPath: string; binaryResolvable?: boolean }
  user: { configured: boolean; entry?: McpServerEntry; settingsPath: string; binaryResolvable?: boolean }
}

export interface StatusOptions {
  /** Override project-scope settings path (test hook). */
  projectPathOverride?: string
  /** Override user-scope settings path (test hook). */
  userPathOverride?: string
}

/** Check if a command is resolvable (exists on PATH or as a file). */
function isResolvable(command: string): boolean {
  // Absolute or relative path: check existence.
  if (command.startsWith('/') || command.startsWith('.')) {
    return fs.existsSync(command)
  }
  // Otherwise check common PATH locations (best-effort heuristic).
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter)
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

export async function runMcpStatus(opts: StatusOptions = {}): Promise<StatusResult> {
  const projectPath = opts.projectPathOverride ?? resolveSettingsPath('project')
  const userPath = opts.userPathOverride ?? resolveSettingsPath('user')

  async function check(filePath: string) {
    const settings = await readSettings(filePath)
    const entry = settings.mcpServers?.['unified-product-graph']
    if (!entry) return { configured: false, settingsPath: filePath }
    return {
      configured: true,
      entry,
      settingsPath: filePath,
      binaryResolvable: isResolvable(entry.command),
    }
  }

  const [project, user] = await Promise.all([check(projectPath), check(userPath)])
  return { project, user }
}

// ── Command output helpers ────────────────────────────────────────────────────

function formatEntry(entry: McpServerEntry): string {
  // Show the entry exactly as it lands in the config file, nested under its key.
  const block = { 'unified-product-graph': { command: entry.command, args: entry.args } }
  return JSON.stringify(block, null, 2)
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')
}

// ── Commander commands ────────────────────────────────────────────────────────

const mcpSetupCommand = new Command('setup')
  .description('Write the UPG MCP server entry into the config Claude Code reads')
  .option(
    '--scope <user|project>',
    'project = <cwd>/.mcp.json. user = ~/.claude.json',
    'project',
  )
  .option('--force', 'Overwrite an existing entry without prompting', false)
  .option('--command <cmd>', 'Override the server command. Example: "node /path/to/index.js"')
  .action(async (opts) => {
    try {
      const scope = opts.scope as string
      if (scope !== 'project' && scope !== 'user') {
        console.error(`Invalid --scope "${scope}". Use "user" or "project".`)
        process.exit(2)
      }

      const result = await runMcpSetup({
        scope: scope as McpScope,
        force: Boolean(opts.force),
        commandOverride: opts.command as string | undefined,
      })

      if (result.skipped) {
        console.log()
        console.log(`  ${chalk.yellow('⚠')} Skipped. Existing entry preserved.`)
        console.log(chalk.dim('  Re-run with --force to overwrite.'))
        console.log()
        return
      }

      const verb = result.overwrote ? 'updated in' : 'configured in'
      console.log()
      console.log(`  ${chalk.green('✓')} MCP server ${verb} ${chalk.dim(result.settingsPath)}`)
      console.log()
      console.log(chalk.dim(formatEntry(result.entry)))
      console.log()
      console.log(`  Open Claude Code in this directory. The UPG tools will be available automatically.`)
      console.log()
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })

const mcpStatusCommand = new Command('status')
  .description('Report MCP server config across project and user scopes')
  .action(async () => {
    try {
      const result = await runMcpStatus()
      const scopeLines: string[] = []
      let anyConfigured = false

      for (const [scopeName, info] of [['project', result.project], ['user', result.user]] as const) {
        if (info.configured && info.entry) {
          anyConfigured = true
          const resolvable = info.binaryResolvable
          const statusMark = resolvable ? chalk.green('✓') : chalk.yellow('⚠')
          const resolvableNote = resolvable
            ? chalk.dim(' (command resolvable)')
            : chalk.yellow(' (command not found on PATH)')
          scopeLines.push(
            `  ${statusMark} ${chalk.bold(scopeName)} scope${resolvableNote}`,
          )
          scopeLines.push(chalk.dim(`    ${info.settingsPath}`))
          scopeLines.push(
            chalk.dim(`    command: ${info.entry.command} ${info.entry.args.join(' ')}`),
          )
        } else {
          scopeLines.push(`  ${chalk.dim('·')} ${chalk.dim(scopeName)} scope · not configured`)
          scopeLines.push(chalk.dim(`    ${info.settingsPath}`))
        }
      }

      console.log()
      scopeLines.forEach((l) => console.log(l))
      console.log()

      if (!anyConfigured) {
        console.log(
          chalk.dim('  Run ') +
          chalk.blueBright('upg mcp setup') +
          chalk.dim(' to configure the MCP server.'),
        )
        console.log()
        process.exit(1)
      }
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })

const mcpRunCommand = new Command('run')
  .description('Run the UPG MCP server over stdio. Invoked by Claude Desktop.')
  .option('-f, --file <path>', 'Path to a .upg file. Overrides auto-discovery')
  .option('-t, --title <title>', 'Title to mint when creating a blank .upg file')
  .action(async () => {
    // Pass our argv straight through so mcp-server's parseArgs sees --file/--title.
    // Stdio is reserved for the MCP protocol, so skip the banner, chalk, and stdout output.
    const { runMcpServer } = await import('@unified-product-graph/mcp-server')
    try {
      await runMcpServer()
    } catch (err) {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`)
      process.exit(1)
    }
  })

export const mcpCommand = new Command('mcp')
  .description('Configure, inspect, and run the UPG MCP server.')
  .addCommand(mcpSetupCommand)
  .addCommand(mcpStatusCommand)
  .addCommand(mcpRunCommand)
