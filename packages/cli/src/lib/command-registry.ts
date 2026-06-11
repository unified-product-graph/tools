/**
 * The command registry — the single source of truth for every command the CLI
 * registers.
 *
 * cli.ts builds the program from `ALL_COMMANDS`; the help-safety and help-drift
 * regression tests iterate the same array. Because all three derive from one
 * list, a new command (or a new option on an existing command) cannot silently
 * escape help coverage: the help-drift guard fails until it is documented.
 *
 * Importing this module is side-effect-free — each command module merely
 * constructs a Commander `Command` (the `.action()` is registered, never run),
 * so tests can import the registry without driving the CLI.
 */

import type { Command } from 'commander'
import { healthCommand } from '../commands/health.js'
import { verifyCommand } from '../commands/verify.js'
import { diffCommand } from '../commands/diff.js'
import { listCommand } from '../commands/list.js'
import { treeCommand } from '../commands/tree.js'
import { searchCommand } from '../commands/search.js'
import { createCommand } from '../commands/create.js'
import { updateCommand } from '../commands/update.js'
import { deleteCommand } from '../commands/delete.js'
import { connectCommand } from '../commands/connect.js'
import { gapsCommand } from '../commands/gaps.js'
import { initCommand } from '../commands/init.js'
import { workspaceCommand } from '../commands/workspace.js'
import { exportCommand } from '../commands/export.js'
import { fmtCommand } from '../commands/fmt.js'
import { installSkillsCommand } from '../commands/install-skills.js'
import { mcpCommand } from '../commands/mcp.js'
import { importCommand } from '../commands/import.js'
// Tier-1 "ceiling" verbs: stand-inside-the-graph UX, additive sugar
// over the Tier-3 flat substrate. They share session-local cursor + lens state
// (lib/session.ts); the Tier-3 commands never read it.
import { useCommand } from '../commands/use.js'
import { hereCommand, atCommand } from '../commands/here.js'
import { lsCommand } from '../commands/ls.js'
import { newCommand } from '../commands/new.js'
import { linkCommand } from '../commands/link.js'
import { findCommand } from '../commands/find.js'
import { checkCommand } from '../commands/check.js'
import { fixCommand } from '../commands/fix.js'
import { applyCommand } from '../commands/apply.js'
import { scoreCommand } from '../commands/score.js'
import { showCommand } from '../commands/show.js'
import { specCommand } from '../commands/spec.js'
import { queryCommand } from '../commands/query.js'
import { registryCommand } from '../commands/registry.js'
import { portfolioCommand } from '../commands/portfolio.js'
import { areaCommand } from '../commands/area.js'
import { migrateCommand } from '../commands/migrate.js'
import { moveCommand } from '../commands/move.js'
import { disconnectCommand } from '../commands/disconnect.js'
import { dedupeCommand } from '../commands/dedupe.js'
import { cloneCommand } from '../commands/clone.js'
import { contextCommand } from '../commands/context.js'
import { logCommand } from '../commands/log.js'
import { prioritiseCommand } from '../commands/prioritise.js'
import { syncCommand } from '../commands/sync.js'
import { productCommand } from '../commands/product.js'
import { batchCommand } from '../commands/batch.js'

/**
 * Every command registered on the program. The order is the display order in
 * `printHelp`. Kept as a single array so the help interceptor and the
 * regression tests can both iterate the full registry.
 */
export const ALL_COMMANDS: Command[] = [
  // Tier-1 "ceiling" verbs — the stand-inside-the-graph surface.
  useCommand, hereCommand, atCommand, lsCommand, findCommand,
  newCommand, linkCommand, checkCommand, fixCommand,
  // Governance
  healthCommand, verifyCommand, diffCommand, listCommand, treeCommand, searchCommand,
  // CRUD & manipulation
  createCommand, updateCommand, deleteCommand, connectCommand, gapsCommand,
  initCommand, workspaceCommand, importCommand, exportCommand, fmtCommand,
  // Frameworks (exercises)
  applyCommand, scoreCommand, showCommand,
  // Tool parity (CLI-next): spec browser, traversal, registry, portfolio, areas, migrations
  specCommand, queryCommand, registryCommand, portfolioCommand, areaCommand, migrateCommand,
  // Tool parity singletons
  moveCommand, disconnectCommand, dedupeCommand, cloneCommand, contextCommand,
  logCommand, prioritiseCommand, syncCommand, productCommand, batchCommand,
  // Setup
  installSkillsCommand, mcpCommand,
]

/** Command names the user can pass to `upg help <name>` / probe with --help. */
export function commandNames(): string[] {
  return ALL_COMMANDS.map((c) => c.name())
}
