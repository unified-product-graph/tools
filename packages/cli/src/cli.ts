/**
 * UPG CLI entry point. Local-first: nodes, edges, graph analysis, MCP wiring,
 * skills. (The former Cloud command group was removed — there is no cloud
 * backend; see CLI-FEEDBACK #10.)
 *
 * Usage: upg <command> [options]
 *
 * Groups: setup, workspace, governance, explore, create/edit.
 *
 * Help safety (CLI-FEEDBACK #1): `--help`/`-h` and `upg help <cmd>` are
 * intercepted in `interceptHelp()` BEFORE Commander dispatches any action, so
 * asking for help can never trigger a command's side effects.
 */

import { Command } from 'commander'
import { existsSync, readdirSync } from 'node:fs'
import { healthCommand } from './commands/health.js'
import { verifyCommand } from './commands/verify.js'
import { diffCommand } from './commands/diff.js'
import { listCommand } from './commands/list.js'
import { treeCommand } from './commands/tree.js'
import { searchCommand } from './commands/search.js'
import { createCommand } from './commands/create.js'
import { updateCommand } from './commands/update.js'
import { deleteCommand } from './commands/delete.js'
import { connectCommand } from './commands/connect.js'
import { gapsCommand } from './commands/gaps.js'
import { initCommand } from './commands/init.js'
import { workspaceCommand } from './commands/workspace.js'
import { exportCommand } from './commands/export.js'
import { fmtCommand } from './commands/fmt.js'
import { installSkillsCommand } from './commands/install-skills.js'
import { mcpCommand } from './commands/mcp.js'
import { importCommand } from './commands/import.js'
// Tier-1 "ceiling" verbs: stand-inside-the-graph UX, additive sugar
// over the Tier-3 flat substrate above. They share session-local cursor + lens
// state (lib/session.ts); the Tier-3 commands never read it.
import { useCommand } from './commands/use.js'
import { hereCommand, atCommand } from './commands/here.js'
import { lsCommand } from './commands/ls.js'
import { newCommand } from './commands/new.js'
import { linkCommand } from './commands/link.js'
import { findCommand } from './commands/find.js'
import { checkCommand } from './commands/check.js'
import { fixCommand } from './commands/fix.js'
import chalk from 'chalk'
import { upgLogo } from './lib/formatter.js'
import { applyColorPreference } from './lib/output.js'
import { commandHelp, helpTopics, type HelpEntry } from './lib/help.js'
import { CLI_VERSION } from './lib/version.js'

// Single source of truth for the version — read from package.json at runtime so
// `upg --version`, the logo, and the `init` banner never drift (CLI-FEEDBACK #5).
export const VERSION = CLI_VERSION

// Every command registered on the program. The order is the display order in
// `printHelp`. Kept as a single array so the help interceptor and the
// regression test can both iterate the full registry.
const ALL_COMMANDS: Command[] = [
  // Tier-1 "ceiling" verbs — the stand-inside-the-graph surface.
  useCommand, hereCommand, atCommand, lsCommand, findCommand,
  newCommand, linkCommand, checkCommand, fixCommand,
  // Governance
  healthCommand, verifyCommand, diffCommand, listCommand, treeCommand, searchCommand,
  // CRUD & manipulation
  createCommand, updateCommand, deleteCommand, connectCommand, gapsCommand,
  initCommand, workspaceCommand, importCommand, exportCommand, fmtCommand,
  // Setup
  installSkillsCommand, mcpCommand,
]

/** Command names the user can pass to `upg help <name>` / probe with --help. */
export function commandNames(): string[] {
  return ALL_COMMANDS.map((c) => c.name())
}

function printHelp() {
  console.log(upgLogo(VERSION))

  const cmd = (name: string, args: string, desc: string) =>
    `  ${chalk.blueBright(name.padEnd(12))} ${chalk.dim(args.padEnd(24))} ${desc}`

  console.log(chalk.bold('  Stand in the graph'))
  console.log(cmd('use', '<lens>', 'Set the operating lens (scopes vocabulary)'))
  console.log(cmd('here', '', 'Show where the cursor stands'))
  console.log(cmd('at', '<node>', 'Move the cursor (by id or title)'))
  console.log(cmd('ls', '', "The cursor's neighbours, grouped by relationship"))
  console.log(cmd('find', '<query>', 'Search; pick a result to move the cursor (TTY)'))
  console.log(cmd('new', '<type> <title>', 'Create + auto-link to the cursor (edge inferred)'))
  console.log(cmd('link', '<a> <b>', 'Connect two nodes (edge + direction inferred)'))
  console.log(cmd('check', '', 'One verdict: structure + health + gaps + lint'))
  console.log(cmd('fix', '', 'Execute the top auto-remediable fix from check'))
  console.log()

  console.log(chalk.bold('  Setup'))
  console.log(cmd('mcp setup', '[options]', 'Write MCP server entry into .claude/settings.json'))
  console.log(cmd('mcp status', '', 'Report MCP server config across scopes'))
  console.log(cmd('install-skills', '[options]', 'Install bundled UPG skills into Claude Code'))
  console.log()

  console.log(chalk.bold('  Workspace'))
  console.log(cmd('init', '[options]', 'Create a .upg file'))
  console.log(cmd('workspace', '[action]', 'List, switch, or add products'))
  console.log(cmd('import', '--from <tool>', 'Import from Markdown, Notion, Linear, Vistaly, Dovetail, GitHub'))
  console.log(cmd('export', '[options]', 'Export as JSON, Markdown, or CSV'))
  console.log(cmd('fmt', '[files...]', 'Rewrite .upg to canonical form. --check for CI'))
  console.log()

  console.log(chalk.bold('  Governance'))
  console.log(cmd('health', '[options]', 'Score the graph 0-100. Pair --min-score with CI'))
  console.log(cmd('verify', '[options]', 'Structural validation. Exits 2 on violations'))
  console.log(cmd('diff', '[options]', 'Compare against a git ref. For PR reviews'))
  console.log(cmd('gaps', '[options]', 'Empty domains, broken chains, sparse areas'))
  console.log()

  console.log(chalk.bold('  Explore'))
  console.log(cmd('list', '[options]', 'Query entities by type, status, domain'))
  console.log(cmd('tree', '[filter]', 'Tree view of the graph'))
  console.log(cmd('search', '<query>', 'Fuzzy search across titles and descriptions'))
  console.log()

  console.log(chalk.bold('  Create & Edit'))
  console.log(cmd('create', '<type> <title>', 'Create an entity (type-validated)'))
  console.log(cmd('update', '<id>', 'Update an entity. Unspecified fields preserved'))
  console.log(cmd('delete', '<id>', 'Delete an entity and its edges'))
  console.log(cmd('connect', '<src> <tgt>', 'Create an edge. Type auto-inferred'))
  console.log()

  console.log(chalk.bold('  Global flags'))
  console.log(cmd('--file <path>', '', 'Target a specific .upg file (or set UPG_FILE)'))
  console.log(cmd('--json', '', 'Machine-readable JSON (reads + mutations)'))
  console.log(cmd('--no-color', '', 'Disable colour/boxes (also honours NO_COLOR)'))
  console.log(cmd('--yes, -y', '', 'Skip confirmation on destructive ops'))
  console.log()

  console.log(chalk.bold('  Exit codes'))
  console.log('  ' + chalk.dim('0 success · 1 runtime error · 2 validation/policy · 3 usage error'))
  console.log()

  console.log(chalk.dim('  Run `upg <command> --help` for command-specific help and examples.'))
  console.log()
}

/** Render one command's structured help block to stdout, then exit 0. */
function printCommandHelp(entry: HelpEntry): never {
  const b = chalk.bold
  console.log()
  console.log(`  ${b(entry.usage)}`)
  console.log()
  console.log(`  ${entry.summary}`)
  if (entry.options.length > 0) {
    console.log()
    console.log(`  ${b('Options')}`)
    const width = Math.max(...entry.options.map((o) => o.flag.length))
    for (const o of entry.options) {
      console.log(`    ${chalk.blueBright(o.flag.padEnd(width))}  ${chalk.dim(o.desc)}`)
    }
  }
  if (entry.examples.length > 0) {
    console.log()
    console.log(`  ${b('Examples')}`)
    for (const ex of entry.examples) {
      if (ex.comment) console.log(`    ${chalk.dim('# ' + ex.comment)}`)
      console.log(`    ${chalk.white(ex.cmd)}`)
    }
  }
  if (entry.seeAlso) {
    console.log()
    console.log(`  ${chalk.dim('See also: ' + entry.seeAlso)}`)
  }
  console.log()
  process.exit(0)
}

const HELP_TOKENS = new Set(['--help', '-h'])

/**
 * CLI-FEEDBACK #1 — help safety.
 *
 * Intercept help BEFORE Commander parses or dispatches anything, so `upg <cmd>
 * --help`, `upg <cmd> -h`, and `upg help <cmd>` can never run a command's
 * action (no logout, no delete picker, no skill install). Returns true if it
 * handled and exited; otherwise lets normal parsing proceed.
 */
function interceptHelp(argv: string[]): void {
  // Tokens after `node cli.js`.
  const args = argv.slice(2)
  if (args.length === 0) return

  // `upg help [topic]`  → alias of `--help`.
  if (args[0] === 'help') {
    const topic = args[1]
    if (!topic) { printHelp(); process.exit(0) }
    const entry = commandHelp(topic)
    if (entry) printCommandHelp(entry)
    // Unknown help topic: show the top-level help (still safe, exit 0).
    printHelp()
    process.exit(0)
  }

  // Find the first non-flag token — the candidate command name.
  const cmdName = args.find((a) => !a.startsWith('-'))
  const hasHelpFlag = args.some((a) => HELP_TOKENS.has(a))

  // Top-level `upg --help` / `upg -h` → full help.
  if (!cmdName && hasHelpFlag) { printHelp(); process.exit(0) }

  if (cmdName && hasHelpFlag) {
    // `upg <cmd> ... --help` (in any position) → command help, never the action.
    const entry = commandHelp(cmdName)
    if (entry) printCommandHelp(entry)
    // Help requested for an unknown command: fall back to top-level help.
    printHelp()
    process.exit(0)
  }
}

const program = new Command()
  .name('upg')
  .description('Unified Product Graph CLI. Local-first governance, CRUD, analysis.')
  .version(VERSION, '-V, --version', 'output the version number')
  .option('--no-color', 'disable coloured output')
  // Commander's own help stays enabled as a backstop, but `interceptHelp` runs
  // first so help is guaranteed side-effect-free even for subcommands.
  .helpOption('-h, --help', 'display help')
  .action((_opts) => {
    const cwd = process.cwd()
    let hasDotUpg = false
    try {
      if (existsSync(cwd + '/.upg')) {
        hasDotUpg = true
      } else {
        const entries = readdirSync(cwd)
        hasDotUpg = entries.some((f) => f.endsWith('.upg'))
      }
    } catch { /* ignore read errors */ }

    if (!hasDotUpg) {
      console.log('\n  ' + chalk.dim('Empty directory. Run init to create a .upg file.'))
      console.log('  Run ' + chalk.blueBright('upg init') + ' to create one.\n')
    }

    printHelp()
  })

for (const c of ALL_COMMANDS) program.addCommand(c)

// Apply --no-color / NO_COLOR before anything renders.
applyColorPreference(process.argv.includes('--no-color'))

// Help is intercepted before parse so it can never execute a command.
interceptHelp(process.argv)

// Surface the registered topics so `help.ts` and the regression test agree on
// coverage. (Referenced to keep the import meaningful for tree-shakers.)
void helpTopics

program.parse()
