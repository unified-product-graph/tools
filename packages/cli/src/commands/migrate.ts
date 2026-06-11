/**
 * `upg migrate` - catalogue-aware graph migrations.
 *
 * Subcommands (each supports --dry-run and --json):
 *
 *   type <from> <to>      Retype every node of <from> to <to>. Applies spec
 *                         property defaults from UPG_MIGRATIONS automatically.
 *                         Pass --force to override the catalogue guard.
 *   status                Rewrite invalid status values to canonical lifecycle
 *                         phases via UPG_STATUS_MIGRATIONS. Scoped by
 *                         --entity-type / --from-status / --to-status.
 *   properties            Apply UPG_PROPERTY_MIGRATIONS across all nodes
 *                         (top-level renames, lifts, drops).
 *   edges --from <t> --to <t>
 *                         Exact-match rename every edge of type <from> to <to>.
 *                         --flip swaps source/target per matched edge.
 *
 * Default dry-run behaviour mirrors the MCP handlers:
 *   - type:       dry_run defaults to FALSE (mirrors migrate_type MCP)
 *   - status:     dry_run defaults to TRUE  (mirrors migrate_status MCP)
 *   - properties: dry_run defaults to TRUE  (mirrors migrate_properties MCP)
 *   - edges:      dry_run defaults to TRUE  (mirrors rename_edge_type MCP)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { die, runtimeError, usageError } from '../lib/errors.js'
import { upgHeader, success, label } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import {
  UPG_MIGRATIONS,
  UPG_EDGE_CATALOG,
  UPG_VERSION,
  migrateEdge,
  migrateNodeProperties,
  migrateStatusValue,
  getLifecycleForType,
  type UPGPropertyMigrationChange,
} from '@unified-product-graph/core'
import type { UPGEdgeType } from '@unified-product-graph/core'

// ── helpers ──────────────────────────────────────────────────────────────────

function w(s: string): string {
  return chalk.white(sanitizeForTerminal(s))
}

function dim(s: string): string {
  return chalk.dim(sanitizeForTerminal(s))
}

// ── migrate type ─────────────────────────────────────────────────────────────

const typeCmd = new Command('type')
  .description('Retype every node of <from-type> to <to-type>.')
  .argument('<from-type>', 'Current entity type')
  .argument('<to-type>', 'Target entity type')
  .option('--file <path>', 'Path to .upg file')
  .option('--dry-run', 'Preview only, no write (default: false for this subcommand)')
  .option('--force', 'Override the UPG_MIGRATIONS catalogue guard')
  .option('--json', 'Machine-readable JSON output')
  .action(async (fromType: string, toType: string, opts: {
    file?: string
    dryRun?: boolean
    force?: boolean
    json?: boolean
  }) => {
    try {
      // Validate against registered migration rules unless --force.
      let registeredRule: { from: string; to: string; defaults?: Record<string, unknown>; reason: string } | undefined
      const availableFromThisFrom: string[] = []
      for (const migrations of Object.values(UPG_MIGRATIONS)) {
        for (const m of migrations) {
          if (m.from === fromType) {
            availableFromThisFrom.push(m.to)
            if (m.to === toType) registeredRule = m
          }
        }
      }

      if (!registeredRule && !opts.force) {
        const hint =
          availableFromThisFrom.length > 0
            ? ` Available migrations from "${fromType}": [${[...new Set(availableFromThisFrom)].join(', ')}].`
            : ` No migration rules registered from "${fromType}".`
        die(
          runtimeError(
            `No UPG_MIGRATIONS rule for (${fromType} -> ${toType}).` +
            hint +
            ` Pass --force to override.`,
          ),
        )
      }

      const defaults =
        registeredRule?.defaults && Object.keys(registeredRule.defaults).length > 0
          ? registeredRule.defaults
          : undefined

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const allNodes = store.getAllNodes()
      const allEdges = store.getAllEdges()
      const matchingNodes = allNodes.filter((n) => n.type === fromType)
      const canonicalEdgeKeys = new Set(Object.keys(UPG_EDGE_CATALOG))
      const unmappedCounts: Record<string, number> = {}

      if (opts.dryRun) {
        const plannedRenames: Array<{ id: string; from: string; to: string; flipped: boolean }> = []
        const plannedDrops: Array<{ id: string; from: string }> = []

        for (const edge of allEdges) {
          const sourceNode = store.getNode(edge.source)
          const targetNode = store.getNode(edge.target)
          const sourceType =
            sourceNode?.type === fromType ? toType : (sourceNode?.type as string | undefined)
          const targetType =
            targetNode?.type === fromType ? toType : (targetNode?.type as string | undefined)
          const result = migrateEdge(edge, '0.0.0', UPG_VERSION, { sourceType, targetType })
          if (result === null) {
            plannedDrops.push({ id: edge.id, from: edge.type })
          } else if (result !== edge) {
            const flipped = result.source !== edge.source
            plannedRenames.push({ id: edge.id, from: edge.type, to: result.type, flipped })
          } else if (!canonicalEdgeKeys.has(edge.type)) {
            unmappedCounts[edge.type] = (unmappedCounts[edge.type] ?? 0) + 1
          }
        }

        store.stopWatching()
        const unmappedLegacyEdges = Object.entries(unmappedCounts).map(([type, count]) => ({ type, count }))
        const out = {
          migrated_nodes: matchingNodes.length,
          migrated_edges: plannedRenames.length + plannedDrops.length,
          edge_renames: plannedRenames,
          dropped_edges: plannedDrops,
          unmapped_legacy_edges: unmappedLegacyEdges,
          defaults_applied: defaults ?? null,
          dry_run: true,
        }

        if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

        process.stderr.write(upgHeader('Migrate - type (dry run)') + '\n')
        console.log(label('  from:   ') + w(fromType) + '  ->  ' + w(toType))
        console.log(label('  nodes:  ') + w(String(out.migrated_nodes)) + dim(' (would retype)'))
        console.log(label('  edges:  ') + w(String(out.migrated_edges)) + dim(' (renames + drops)'))
        if (defaults) console.log(label('  defaults: ') + dim(JSON.stringify(defaults)))
        if (out.unmapped_legacy_edges.length > 0) {
          console.log(chalk.yellow('  warning: unmapped legacy edge types remain after migration:'))
          for (const { type, count } of out.unmapped_legacy_edges) {
            console.log('    ' + dim(type) + '  x' + count)
          }
        }
        console.log(chalk.dim('\n  (dry run - nothing written; omit --dry-run to apply)'))
        return
      }

      // Apply
      const result = store.migrateType(fromType, toType, defaults)

      for (const edge of store.getAllEdges()) {
        if (!canonicalEdgeKeys.has(edge.type)) {
          unmappedCounts[edge.type] = (unmappedCounts[edge.type] ?? 0) + 1
        }
      }

      await store.flush()
      store.stopWatching()

      const unmappedLegacyEdges = Object.entries(unmappedCounts).map(([type, count]) => ({ type, count }))
      const out = {
        migrated_nodes: result.migratedNodes,
        migrated_edges: result.edgeRenames.length + result.edgeDrops.length,
        edge_renames: result.edgeRenames,
        dropped_edges: result.edgeDrops,
        unmapped_legacy_edges: unmappedLegacyEdges,
        defaults_applied: defaults ?? null,
        dry_run: false,
      }

      if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

      process.stderr.write(upgHeader('Migrate - type') + '\n')
      console.log(success(`  Retyped ${out.migrated_nodes} node(s): ${fromType} -> ${toType}`))
      if (out.migrated_edges > 0) {
        console.log(label('  edges:  ') + w(String(out.migrated_edges)) + dim(' (renames + drops)'))
      }
      if (defaults) console.log(label('  defaults: ') + dim(JSON.stringify(defaults)))
      if (out.unmapped_legacy_edges.length > 0) {
        console.log(chalk.yellow('  warning: unmapped legacy edge types remain:'))
        for (const { type, count } of out.unmapped_legacy_edges) {
          console.log('    ' + dim(type) + '  x' + count)
        }
      }
    } catch (err) {
      die(err)
    }
  })

// ── migrate status ────────────────────────────────────────────────────────────

const statusCmd = new Command('status')
  .description('Rewrite invalid status values to canonical lifecycle phases.')
  .option('--file <path>', 'Path to .upg file')
  .option('--entity-type <type>', 'Restrict to nodes of this type')
  .option('--from-status <value>', 'Restrict to nodes with this current status')
  .option('--to-status <value>', 'Explicit target status (required when --from-status is set)')
  .option('--dry-run', 'Preview only, no write (default: true for this subcommand)')
  .option('--no-dry-run', 'Commit the changes')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    file?: string
    entityType?: string
    fromStatus?: string
    toStatus?: string
    dryRun?: boolean
    json?: boolean
  }) => {
    try {
      const dryRun = opts.dryRun !== false

      if (opts.fromStatus !== undefined && opts.toStatus === undefined) {
        die(usageError('--to-status is required when --from-status is provided'))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const changes: Array<{ id: string; type: string; from: string; to: string }> = []
      let skipped = 0

      for (const node of store.getAllNodes()) {
        const nodeType = node.type as string
        const nodeStatus = node.status as string | undefined

        if (opts.entityType && nodeType !== opts.entityType) continue
        if (typeof nodeStatus !== 'string' || nodeStatus.length === 0) continue

        let target: string | null

        if (opts.fromStatus !== undefined) {
          if (nodeStatus !== opts.fromStatus) continue
          target = opts.toStatus ?? null
        } else {
          const lifecycle = getLifecycleForType(nodeType)
          if (!lifecycle) continue
          const validPhases = lifecycle.phases.map((p) => p.id)
          if (validPhases.includes(nodeStatus)) continue
          target = migrateStatusValue(nodeType, nodeStatus)
          if (target === null) { skipped += 1; continue }
        }

        if (target === null || target === nodeStatus) continue
        changes.push({ id: node.id, type: nodeType, from: nodeStatus, to: target })
      }

      if (!dryRun) {
        for (const change of changes) {
          store.updateNode(change.id, { status: change.to })
        }
        await store.flush()
      }

      store.stopWatching()

      const out = {
        migrated_nodes: changes.length,
        skipped_no_migration: skipped,
        changes,
        dry_run: dryRun,
      }

      if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

      const header = dryRun ? 'Migrate - status (dry run)' : 'Migrate - status'
      process.stderr.write(upgHeader(header) + '\n')

      if (changes.length === 0) {
        console.log(chalk.dim('  No status changes needed.'))
        if (skipped > 0) console.log(chalk.yellow(`  ${skipped} node(s) have invalid status with no registered migration.`))
      } else {
        const verb = dryRun ? 'Would migrate' : 'Migrated'
        console.log(success(`  ${verb} ${changes.length} node(s)`))
        for (const c of changes) {
          console.log('    ' + dim(c.id) + '  ' + w(c.from) + '  ->  ' + w(c.to))
        }
        if (skipped > 0) console.log(chalk.yellow(`  ${skipped} node(s) skipped: invalid status, no registered migration.`))
        if (dryRun) console.log(chalk.dim('\n  (dry run - nothing written; pass --no-dry-run to apply)'))
      }
    } catch (err) {
      die(err)
    }
  })

// ── migrate properties ────────────────────────────────────────────────────────

const propertiesCmd = new Command('properties')
  .description('Apply UPG_PROPERTY_MIGRATIONS across all nodes (renames, lifts, drops).')
  .option('--file <path>', 'Path to .upg file')
  .option('--dry-run', 'Preview only, no write (default: true for this subcommand)')
  .option('--no-dry-run', 'Commit the changes')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    file?: string
    dryRun?: boolean
    json?: boolean
  }) => {
    try {
      const dryRun = opts.dryRun !== false

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      if (dryRun) {
        const top_level_renames: Array<{ id: string; from: string; to: string; value_changed: boolean }> = []
        const lifted_properties: Array<{ id: string; from_property: string; to: string; value_changed: boolean }> = []
        const dropped_props: Array<{ id: string; key: string }> = []
        const dropped_self_referential: Array<{ id: string; field: string }> = []

        for (const node of store.getAllNodes()) {
          const { changes } = migrateNodeProperties(
            node as unknown as Record<string, unknown> & { id?: string; type: string; properties?: Record<string, unknown> },
            '0.0.0',
            UPG_VERSION,
          )
          for (const change of changes as UPGPropertyMigrationChange[]) {
            switch (change.kind) {
              case 'dropped': dropped_props.push({ id: node.id, key: change.key }); break
              case 'renamed_top_level': top_level_renames.push({ id: node.id, from: change.from, to: change.to, value_changed: change.value_changed }); break
              case 'lifted_to_top_level': lifted_properties.push({ id: node.id, from_property: change.from_property, to: change.to, value_changed: change.value_changed }); break
              case 'self_ref_dropped': dropped_self_referential.push({ id: node.id, field: change.field }); break
            }
          }
        }

        store.stopWatching()
        const out = { top_level_renames, lifted_properties, dropped_props, dropped_self_referential, dry_run: true }

        if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

        process.stderr.write(upgHeader('Migrate - properties (dry run)') + '\n')
        const total = top_level_renames.length + lifted_properties.length + dropped_props.length + dropped_self_referential.length
        if (total === 0) {
          console.log(chalk.dim('  No property migrations needed.'))
        } else {
          console.log(label('  top-level renames: ') + w(String(top_level_renames.length)))
          console.log(label('  lifts to top-level: ') + w(String(lifted_properties.length)))
          console.log(label('  dropped props: ') + w(String(dropped_props.length)))
          console.log(label('  dropped self-refs: ') + w(String(dropped_self_referential.length)))
          console.log(chalk.dim('\n  (dry run - nothing written; pass --no-dry-run to apply)'))
        }
        return
      }

      const result = store.applyPropertyMigrations('0.0.0', UPG_VERSION)
      await store.flush()
      store.stopWatching()

      const out = { ...result, dry_run: false }

      if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

      process.stderr.write(upgHeader('Migrate - properties') + '\n')
      const total = result.top_level_renames.length + result.lifted_properties.length + result.dropped_props.length + result.dropped_self_referential.length
      if (total === 0) {
        console.log(chalk.dim('  No property migrations applied.'))
      } else {
        console.log(success(`  Applied ${total} property migration(s)`))
        if (result.top_level_renames.length > 0) console.log(label('  top-level renames: ') + w(String(result.top_level_renames.length)))
        if (result.lifted_properties.length > 0) console.log(label('  lifts to top-level: ') + w(String(result.lifted_properties.length)))
        if (result.dropped_props.length > 0) console.log(label('  dropped props: ') + w(String(result.dropped_props.length)))
        if (result.dropped_self_referential.length > 0) console.log(label('  dropped self-refs: ') + w(String(result.dropped_self_referential.length)))
      }
    } catch (err) {
      die(err)
    }
  })

// ── migrate edges ─────────────────────────────────────────────────────────────

const edgesCmd = new Command('edges')
  .description('Exact-match rename every edge of type <from> to <to>. Optionally flips direction.')
  .requiredOption('--from <type>', 'Current edge type')
  .requiredOption('--to <type>', 'Target edge type')
  .option('--flip', 'Swap source/target per matched edge')
  .option('--allow-non-canonical', 'Allow rename to a type not in UPG_EDGE_CATALOG')
  .option('--file <path>', 'Path to .upg file')
  .option('--dry-run', 'Preview only, no write (default: true for this subcommand)')
  .option('--no-dry-run', 'Commit the rename')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    from: string
    to: string
    flip?: boolean
    allowNonCanonical?: boolean
    file?: string
    dryRun?: boolean
    json?: boolean
  }) => {
    try {
      const dryRun = opts.dryRun !== false
      const flip = opts.flip ?? false
      const from = opts.from
      const to = opts.to

      if (from === to && !flip) {
        die(usageError('--from equals --to and --flip is false; nothing to do.'))
      }

      if (!opts.allowNonCanonical && !UPG_EDGE_CATALOG[to as UPGEdgeType]) {
        die(
          runtimeError(
            `--to edge type "${to}" is not in UPG_EDGE_CATALOG. ` +
            `Pass --allow-non-canonical to override.`,
          ),
        )
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)
      const matching = store.getAllEdges().filter((e) => e.type === from)

      if (dryRun) {
        store.stopWatching()
        const out = {
          dry_run: true,
          from,
          to,
          flip,
          would_rename: matching.length,
          sample: matching.slice(0, 5).map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type })),
        }

        if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

        process.stderr.write(upgHeader('Migrate - edges (dry run)') + '\n')
        console.log(label('  from:        ') + w(from) + '  ->  ' + w(to))
        if (flip) console.log(label('  flip:        ') + dim('yes'))
        console.log(label('  would rename: ') + w(String(matching.length)))
        if (out.sample.length > 0) {
          console.log(label('  sample:'))
          for (const s of out.sample) {
            console.log('    ' + dim(s.id) + '  ' + w(s.source) + ' -> ' + w(s.target))
          }
        }
        console.log(chalk.dim('\n  (dry run - nothing written; pass --no-dry-run to apply)'))
        return
      }

      const result = store.renameEdgeType(from, to, flip)
      await store.flush()
      store.stopWatching()

      const out = { dry_run: false, from, to, flip, renamed: result.renamed, ids: result.ids }

      if (opts.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return }

      process.stderr.write(upgHeader('Migrate - edges') + '\n')
      if (result.renamed === 0) {
        console.log(chalk.dim('  No edges matched; nothing renamed.'))
      } else {
        console.log(success(`  Renamed ${result.renamed} edge(s): ${from} -> ${to}${flip ? ' (flipped)' : ''}`))
      }
    } catch (err) {
      die(err)
    }
  })

// ── root group ────────────────────────────────────────────────────────────────

export const migrateCommand = new Command('migrate')
  .description('Catalogue-aware graph migrations. Subcommands: type, status, properties, edges.')
  .addCommand(typeCmd)
  .addCommand(statusCmd)
  .addCommand(propertiesCmd)
  .addCommand(edgesCmd)
