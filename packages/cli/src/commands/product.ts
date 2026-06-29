/**
 * `upg product` - product-header management.
 *
 * Operates on the active .upg graph file (graph-scoped, mutating).
 * Reads the product header (`$upg.product`) and exposes an `update`
 * subcommand to patch any of its editable fields.
 *
 * Subcommands:
 *   update   - edit product-level fields: title, description, stage,
 *              health_status, url  (mirrors the MCP update_product tool)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { discoverUPGFile, loadStore, validateTitle } from '../lib/graph.js'
import { upgHeader, label, success } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { die, usageError, violation, runtimeError } from '../lib/errors.js'
import {
  updateProduct,
  InvalidProductStageError,
  InvalidMemberKindError,
} from '@unified-product-graph/sdk'

// ── sub-command: update ────────────────────────────────────────────────────

const updateCmd = new Command('update')
  .description('Edit product-level header fields (title, description, stage, health_status, url).')
  .option('--file <path>', 'Path to .upg file')
  .option('--title <title>', 'New product title')
  .option('--description <text>', 'New product description')
  .option('--stage <stage>', 'New product stage (e.g. concept, discovery, build, launch, growth, maturity, sunset)')
  .option('--health-status <status>', 'New health status (e.g. on_track, at_risk, off_track)')
  .option('--url <url>', 'Product URL')
  .option('--member-kind <kind>', 'Workspace member kind: product | org_rollup | watched')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    file?: string
    title?: string
    description?: string
    stage?: string
    healthStatus?: string
    url?: string
    memberKind?: string
    json?: boolean
  }) => {
    try {
      // Guard: at least one field must be supplied.
      const hasTitle = opts.title !== undefined
      const hasDescription = opts.description !== undefined
      const hasStage = opts.stage !== undefined
      const hasHealthStatus = opts.healthStatus !== undefined
      const hasUrl = opts.url !== undefined
      const hasMemberKind = opts.memberKind !== undefined

      if (!hasTitle && !hasDescription && !hasStage && !hasHealthStatus && !hasUrl && !hasMemberKind) {
        die(usageError(
          'Nothing to update: pass at least one of --title, --description, --stage, --health-status, --url, or --member-kind.',
        ))
      }

      // Validate title if provided.
      if (hasTitle) {
        const titleErr = validateTitle(opts.title)
        if (titleErr) die(usageError(titleErr))
      }

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      // updateProduct throws InvalidProductStageError for a bad stage value
      // (exit 2, policy violation) and a plain Error for any other problem.
      // Both are re-raised after stopping the watcher.
      let result: Awaited<ReturnType<typeof updateProduct>>
      try {
        result = await updateProduct({
          store,
          title: opts.title,
          description: opts.description,
          stage: opts.stage as never,
          health_status: opts.healthStatus,
          url: opts.url,
          member_kind: opts.memberKind as 'product' | 'org_rollup' | 'watched' | 'operating_function' | undefined,
          cwd: process.cwd(),
        })
      } catch (innerErr) {
        store.stopWatching()
        if (innerErr instanceof InvalidProductStageError || innerErr instanceof InvalidMemberKindError) {
          die(violation(innerErr.message))
        }
        throw innerErr
      }

      if (result.updated.length === 0) {
        store.stopWatching()
        die(runtimeError('Nothing was updated. Check field values and try again.'))
      }

      await store.flush()
      store.stopWatching()

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            message: `Updated product (${result.updated.join(', ')})`,
            updated: result.updated,
            product: result.product,
            file: filePath,
          }, null, 2) + '\n',
        )
        return
      }

      console.log(upgHeader('Product - Update'))
      console.log(success(`Updated product (${sanitizeForTerminal(result.updated.join(', '))})`))
      for (const field of result.updated) {
        const value = (result.product as Record<string, unknown>)[field]
        console.log(label(`  ${field.padEnd(14)} `) + chalk.white(sanitizeForTerminal(String(value ?? ''))))
      }
      console.log(label('  file:          ') + chalk.dim(sanitizeForTerminal(filePath)))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── parent command ─────────────────────────────────────────────────────────

export const productCommand = new Command('product')
  .description('Manage product-header fields (title, stage, description, health_status, url).')
  .addCommand(updateCmd)
  .action(() => {
    console.log(upgHeader('Product'))
    console.log('  Subcommands:')
    console.log()
    console.log('    update   Edit product-level header fields')
    console.log('             Options: --title, --description, --stage, --health-status, --url, --member-kind')
    console.log()
    console.log('  Global option: --file <path>  (targets a specific .upg file)')
    console.log()
  })
