/**
 * `upg sync` - cloud sync surface.
 *
 * Read-only entry point: `sync status` reports the local .upg-sync sidecar
 * state vs cloud without touching the network. Push/pull are deliberately
 * agent-only (MCP tools); the CLI exposes only the read path.
 *
 * Subcommands:
 *   status   - show sync state for the active .upg file (get_sync_state mirror)
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader, label } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { die } from '../lib/errors.js'

// ── Sync state shape (mirrors server-context.ts SyncState) ────────────────

interface SyncState {
  cloud_endpoint: string
  product_id: string
  last_synced_at: string
  node_id_map: Record<string, string>
  edge_id_map: Record<string, string>
  last_snapshot_hash: string
}

/**
 * Resolve the .upg-sync sidecar path for a given .upg file path.
 * Convention: same directory, base name with .upg-sync extension.
 * Mirrors the MCP server's syncFilePath() in lib/server-context.ts.
 */
function syncFilePath(upgPath: string): string {
  const dir = path.dirname(upgPath)
  const base = path.basename(upgPath, '.upg')
  return path.join(dir, `${base}.upg-sync`)
}

/**
 * Read the .upg-sync sidecar for a .upg file.
 * Returns null when the file does not exist (never been pushed).
 */
async function readSyncState(upgPath: string): Promise<SyncState | null> {
  const p = syncFilePath(upgPath)
  try {
    const raw = await fsp.readFile(p, 'utf-8')
    return JSON.parse(raw) as SyncState
  } catch {
    return null
  }
}

// ── sub-command: status ────────────────────────────────────────────────────

const statusCmd = new Command('status')
  .description('Show cloud sync state for the active .upg file (read-only).')
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: { file?: string; json?: boolean }) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      store.stopWatching()

      const syncState = await readSyncState(filePath)

      if (!syncState) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              synced: false,
              message: 'No .upg-sync file found. This product has never been pushed to the cloud.',
              file: filePath,
            }, null, 2) + '\n',
          )
          return
        }
        process.stdout.write(upgHeader('Sync - Status') + '\n')
        console.log(label('  synced:        ') + chalk.dim('no'))
        console.log(chalk.dim('  No .upg-sync file found. Push to the cloud first via the MCP push_to_cloud tool.'))
        console.log()
        return
      }

      const result = {
        synced: true,
        cloud_endpoint: syncState.cloud_endpoint,
        product_id: syncState.product_id,
        last_synced_at: syncState.last_synced_at,
        mapped_nodes: Object.keys(syncState.node_id_map).length,
        mapped_edges: Object.keys(syncState.edge_id_map).length,
        last_snapshot_hash: syncState.last_snapshot_hash,
        file: filePath,
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return
      }

      process.stdout.write(upgHeader('Sync - Status') + '\n')
      console.log(label('  synced:        ') + chalk.green('yes'))
      console.log(label('  cloud:         ') + chalk.white(sanitizeForTerminal(syncState.cloud_endpoint)))
      console.log(label('  product_id:    ') + chalk.white(sanitizeForTerminal(syncState.product_id)))
      console.log(label('  last_synced:   ') + chalk.white(sanitizeForTerminal(syncState.last_synced_at)))
      console.log(label('  mapped_nodes:  ') + chalk.white(String(result.mapped_nodes)))
      console.log(label('  mapped_edges:  ') + chalk.white(String(result.mapped_edges)))
      console.log(label('  snapshot_hash: ') + chalk.dim(sanitizeForTerminal(syncState.last_snapshot_hash.slice(0, 12) + '...')))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── parent command ─────────────────────────────────────────────────────────

export const syncCommand = new Command('sync')
  .description('Cloud sync: inspect local .upg-sync state. Push/pull are available via the MCP server.')
  .addCommand(statusCmd)
  .action(() => {
    console.log(upgHeader('Sync'))
    console.log('  Subcommands:')
    console.log()
    console.log('    status   Show cloud sync state for the active .upg file (read-only)')
    console.log()
    console.log('  Push/pull: use the MCP server tools push_to_cloud and apply_pull_changeset.')
    console.log()
    console.log('  Global option: --file <path>  (targets a specific .upg file)')
    console.log()
  })
