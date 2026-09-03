import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { die, runtimeError, usageError, violation } from '../lib/errors.js'
import { loadStore } from '../lib/graph.js'
import { updateProduct, UPG_MEMBER_KINDS } from '@unified-product-graph/sdk'

export const workspaceCommand = new Command('workspace')
  .arguments('[action] [items...]')
  .description('Workspace actions: list (default), switch <name> (session-only), set-default <name>, rekind --kind <kind> <file...>.')
  .option('--kind <kind>', `For rekind: ${UPG_MEMBER_KINDS.join(' | ')}`)
  .option('--json', 'Machine-readable JSON output (rekind)')
  // Commander passes (…args, options, command). With two declared arguments
  // ([action] [items...]) the third callback parameter is the parsed options
  // object, not the Command — reading options directly avoids the historical
  // `cmd.opts is not a function` crash.
  .action(async (action: string | undefined, items: string[] | undefined, options: { kind?: string; json?: boolean }) => {
    try {
      const cwd = process.cwd()
      const workspacePath = path.join(cwd, '.upg', 'workspace.json')

      if (!action || action === 'list') {
        // List products in workspace
        try {
          const raw = await fs.readFile(workspacePath, 'utf-8')
          const workspace = JSON.parse(raw)
          // The session cursor (gitignored) wins over the tracked default for
          // what "active" means, matching discoverUPGFile's precedence.
          let sessionActive: string | undefined
          try {
            const sraw = await fs.readFile(path.join(cwd, '.upg', 'workspace.session.json'), 'utf-8')
            sessionActive = JSON.parse(sraw).active_product
          } catch { /* no session cursor */ }
          const activeFile = sessionActive ?? workspace.default_product
          console.log(`\nWorkspace: ${workspace.products?.length ?? 0} product(s)\n`)
          for (const p of workspace.products ?? []) {
            const active = p.file === activeFile
              ? (sessionActive && p.file === sessionActive && p.file !== workspace.default_product ? ' (active, session)' : ' (active)')
              : ''
            const kind = p.member_kind && p.member_kind !== 'product' ? `  [${p.member_kind}]` : ''
            console.log(`  ${p.title}  ${p.file}${kind}${active}`)
          }
          console.log()
        } catch {
          // Check for standalone .upg files
          const entries = await fs.readdir(cwd)
          const upgFiles = entries.filter((f) => f.endsWith('.upg'))
          if (upgFiles.length > 0) {
            console.log(`\nNo workspace. ${upgFiles.length} standalone .upg file(s):\n`)
            for (const f of upgFiles) console.log(`  ${f}`)
            console.log('\nRun `upg init --workspace` to create a workspace.')
          } else {
            console.log('No .upg files found. Run `upg init` to get started.')
          }
        }
        return
      }

      if (action === 'switch' || action === 'set-default') {
        const name = items?.[0]
        if (!name) die(usageError(`Usage: upg workspace ${action} <name>`))
        const raw = await fs.readFile(workspacePath, 'utf-8')
        const workspace = JSON.parse(raw)
        const match = workspace.products?.find(
          (p: { file: string; title: string }) =>
            p.file === name || p.file === `${name}.upg` || p.title.toLowerCase() === name.toLowerCase()
        )
        if (!match) {
          die(runtimeError(`Product not found: "${name}". Available: ${workspace.products?.map((p: { title: string }) => p.title).join(', ')}`))
        }

        if (action === 'set-default') {
          // The EXPLICIT tracked write: moves workspace.json's default_product,
          // which is committed and shared. This is the only action that touches
          // the tracked file.
          workspace.default_product = match.file
          await fs.writeFile(workspacePath, JSON.stringify(workspace, null, 2) + '\n', 'utf-8')
          console.log(`Default product set: ${match.title} (${match.file})`)
          return
        }

        // `switch` records a SESSION cursor in a gitignored sibling (0.38.0,
        // F4) instead of rewriting the tracked workspace.json: a read-only
        // exploration must not leave the repo dirty, and an agent running
        // `git add -A` must never commit a cursor move. The MCP server's
        // switch_product already behaved this way (in-memory); the CLI catches
        // up to the server's own standard. Use `workspace set-default` to move
        // the shared default deliberately.
        const sessionPath = path.join(cwd, '.upg', 'workspace.session.json')
        await fs.writeFile(
          sessionPath,
          JSON.stringify({ active_product: match.file, switched_at: new Date().toISOString() }, null, 2) + '\n',
          'utf-8',
        )
        console.log(`Switched to: ${match.title} (${match.file})  [session only — \`workspace set-default\` moves the shared default]`)
        return
      }

      // ── rekind: bulk set member_kind across many graphs (spec #44, 0.10.1) ──
      // Pass files as positional args; shell globs expand naturally, e.g.
      //   upg workspace rekind --kind watched .upg/competitor-*.upg
      // Each file's $upg.member_kind is set (integrity resealed) and the
      // workspace.json cache + portfolio.upg registry are reconciled.
      if (action === 'rekind') {
        const kind = options.kind
        const json = options.json === true
        if (!kind) {
          die(usageError(`Usage: upg workspace rekind --kind <${UPG_MEMBER_KINDS.join('|')}> <file...>`))
        }
        if (!(UPG_MEMBER_KINDS as readonly string[]).includes(kind)) {
          die(violation(`Invalid --kind "${kind}". Valid: ${UPG_MEMBER_KINDS.join(', ')}.`))
        }
        const files = items ?? []
        if (files.length === 0) {
          die(usageError(
            'No files given. Pass one or more .upg files (shell globs expand), e.g. `upg workspace rekind --kind watched .upg/competitor-*.upg`.',
          ))
        }
        const results: Array<{ file: string; ok: boolean; changed: boolean; error?: string }> = []
        for (const f of files) {
          try {
            const store = await loadStore(f)
            try {
              const r = await updateProduct({ store, member_kind: kind as never, cwd })
              await store.flush()
              results.push({ file: f, ok: true, changed: r.updated.includes('member_kind') })
            } finally {
              store.stopWatching()
            }
          } catch (e) {
            results.push({ file: f, ok: false, changed: false, error: (e as Error).message })
          }
        }
        const okCount = results.filter((r) => r.ok).length
        const changedCount = results.filter((r) => r.changed).length
        const failedCount = results.length - okCount
        if (json) {
          process.stdout.write(JSON.stringify({ ok: failedCount === 0, kind, results }, null, 2) + '\n')
        } else {
          console.log(`\nRe-kind to "${kind}": ${okCount}/${results.length} ok (${changedCount} changed)\n`)
          for (const r of results) {
            const mark = r.ok ? (r.changed ? '✓' : '=') : '✗'
            console.log(`  ${mark} ${r.file}${r.error ? `  ${r.error}` : ''}`)
          }
          console.log()
        }
        if (failedCount > 0) process.exitCode = 1
        return
      }

      die(usageError(`Unknown action: "${action}". Use: list, switch, set-default, rekind`))
    } catch (err) {
      die(err)
    }
  })
