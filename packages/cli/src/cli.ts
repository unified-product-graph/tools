/**
 * UPG CLI entry point. 22 commands across 6 groups.
 *
 * Usage: upg <command> [options]
 *
 * Groups: setup, workspace, governance, explore, create/edit, cloud.
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
import { loginCommand, logoutCommand } from './commands/login.js'
import { pushCommand } from './commands/push.js'
import { pullCommand } from './commands/pull.js'
import { productsCommand } from './commands/products.js'
import { logCommand } from './commands/log.js'
import { installSkillsCommand } from './commands/install-skills.js'
import { mcpCommand } from './commands/mcp.js'
import { importCommand } from './commands/import.js'
import chalk from 'chalk'
import { upgLogo } from './lib/formatter.js'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Read the version from package.json at runtime so `upg --version` always
// reflects the actually-installed package, not a hardcoded literal.
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(__dirname, '..', 'package.json')
const VERSION = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version

function printHelp() {
  console.log(upgLogo(VERSION))

  const cmd = (name: string, args: string, desc: string) =>
    `  ${chalk.blueBright(name.padEnd(12))} ${chalk.dim(args.padEnd(24))} ${desc}`

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
  console.log()

  console.log(chalk.bold('  Governance'))
  console.log(cmd('health', '[options]', 'Score the graph 0–100. Pair --min-score with CI'))
  console.log(cmd('verify', '[options]', 'Structural validation. Exits 1 on violations'))
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


  console.log(chalk.bold('  Cloud'))
  console.log(cmd('login', '[options]', 'Authenticate with UPG cloud'))
  console.log(cmd('logout', '[options]', 'Remove stored credentials'))
  console.log(cmd('push', '[options]', 'Push local graph to cloud'))
  console.log(cmd('pull', '[options]', 'Pull cloud changes to local'))
  console.log(cmd('products', '[options]', 'List your cloud products'))
  console.log(cmd('log', '[options]', 'Activity log: who changed what, when'))
  console.log()
}

const program = new Command()
  .name('upg')
  .description('Unified Product Graph CLI. Governance, CRUD, cloud sync.')
  .version(VERSION, '-V, --version', 'output the version number')
  .helpOption(false)
  .option('-h, --help', 'display help')
  .action((_opts) => {
    // Check whether a .upg file (or .upg/ dir) exists in the current directory.
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

// Phase 1: Governance
program.addCommand(healthCommand)
program.addCommand(verifyCommand)
program.addCommand(diffCommand)
program.addCommand(listCommand)
program.addCommand(treeCommand)
program.addCommand(searchCommand)

// Phase 2: CRUD & manipulation
program.addCommand(createCommand)
program.addCommand(updateCommand)
program.addCommand(deleteCommand)
program.addCommand(connectCommand)
program.addCommand(gapsCommand)
program.addCommand(initCommand)
program.addCommand(workspaceCommand)
program.addCommand(importCommand)
program.addCommand(exportCommand)

// Phase 3: Cloud bridge
program.addCommand(loginCommand)
program.addCommand(logoutCommand)
program.addCommand(pushCommand)
program.addCommand(pullCommand)
program.addCommand(productsCommand)
program.addCommand(logCommand)

// Skills
program.addCommand(installSkillsCommand)
program.addCommand(mcpCommand)

program.parse()
