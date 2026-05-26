import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const workspaceCommand = new Command('workspace')
  .arguments('[action]')
  .description('Workspace actions: list (default), switch <name>, add <title>.')
  .arguments('[arg]')
  .action(async (action, arg) => {
    try {
      const cwd = process.cwd()
      const workspacePath = path.join(cwd, '.upg', 'workspace.json')

      if (!action || action === 'list') {
        // List products in workspace
        try {
          const raw = await fs.readFile(workspacePath, 'utf-8')
          const workspace = JSON.parse(raw)
          console.log(`\nWorkspace: ${workspace.products?.length ?? 0} product(s)\n`)
          for (const p of workspace.products ?? []) {
            const active = p.file === workspace.default_product ? ' (active)' : ''
            console.log(`  ${p.title}  ${p.file}${active}`)
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

      if (action === 'switch') {
        if (!arg) { console.error('Usage: upg workspace switch <name>'); process.exit(1) }
        const raw = await fs.readFile(workspacePath, 'utf-8')
        const workspace = JSON.parse(raw)
        const match = workspace.products?.find(
          (p: { file: string; title: string }) =>
            p.file === arg || p.file === `${arg}.upg` || p.title.toLowerCase() === arg.toLowerCase()
        )
        if (!match) {
          console.error(`Product not found: "${arg}". Available: ${workspace.products?.map((p: { title: string }) => p.title).join(', ')}`)
          process.exit(1)
        }
        workspace.default_product = match.file
        await fs.writeFile(workspacePath, JSON.stringify(workspace, null, 2) + '\n', 'utf-8')
        console.log(`Switched to: ${match.title} (${match.file})`)
        return
      }

      console.error(`Unknown action: "${action}". Use: list, switch`)
      process.exit(1)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
