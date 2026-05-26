/**
 * `upg init`: create a .upg file. Interactive by default; flag-driven when scripted.
 */

import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import chalk from 'chalk'
import { input, select } from '@inquirer/prompts'
import { UPG_VERSION } from '@unified-product-graph/core'
import { nodeId } from '../lib/graph.js'
import { upgLogo } from '../lib/formatter.js'

// ── Template definitions ───────────────────────────────────────────────────

type TemplateKey = 'blank' | 'saas' | 'marketplace' | 'mobile' | 'oss'

interface SeedNode {
  id: string
  type: string
  title: string
  description?: string
}

function buildSeedNodes(template: TemplateKey): SeedNode[] {
  switch (template) {
    case 'blank':
      return []

    case 'saas':
      return [
        { id: nodeId(), type: 'persona', title: 'Primary User', description: 'The main user of your product' },
        { id: nodeId(), type: 'job', title: 'Core Job to Be Done' },
        { id: nodeId(), type: 'opportunity', title: 'Key Opportunity' },
      ]

    case 'marketplace':
      return [
        { id: nodeId(), type: 'persona', title: 'Supply Side (Provider)' },
        { id: nodeId(), type: 'persona', title: 'Demand Side (Consumer)' },
        { id: nodeId(), type: 'opportunity', title: 'Platform Value Creation' },
      ]

    case 'mobile':
      return [
        { id: nodeId(), type: 'persona', title: 'Mobile User' },
        { id: nodeId(), type: 'job', title: 'Primary Mobile Job' },
        { id: nodeId(), type: 'feature', title: 'Core Feature' },
      ]

    case 'oss':
      return [
        { id: nodeId(), type: 'persona', title: 'Contributor' },
        { id: nodeId(), type: 'persona', title: 'End User' },
        { id: nodeId(), type: 'feature', title: 'Core Feature' },
      ]
  }
}

// ── CLI command ────────────────────────────────────────────────────────────

export const initCommand = new Command('init')
  .description('Create a .upg file. Interactive by default.')
  .option('--title <title>', 'Product title. Skips prompt')
  .option('--template <template>', 'blank | saas | marketplace | mobile | oss. Skips prompt')
  .option('--workspace', 'Create in .upg/<name>.upg with workspace.json. Skips prompt')
  .option('--single', 'Create product.upg in the current directory. Skips prompt')
  .option('--force', 'Overwrite the existing file')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      const isInteractive = !opts.title && !opts.template && !opts.workspace && !opts.single

      // ── Banner ────────────────────────────────────────────────────────────
      if (isInteractive) {
        console.log(upgLogo(UPG_VERSION))
      }

      // ── Prompt: product title ─────────────────────────────────────────────
      let title: string
      if (opts.title) {
        title = opts.title as string
      } else {
        const defaultName = path.basename(cwd)
        title = await input({
          message: "What's your product called?",
          default: defaultName,
        })
      }

      // ── Prompt: template ──────────────────────────────────────────────────
      let template: TemplateKey
      if (opts.template) {
        const t = opts.template as string
        const valid: TemplateKey[] = ['blank', 'saas', 'marketplace', 'mobile', 'oss']
        if (!valid.includes(t as TemplateKey)) {
          console.error(chalk.red(`Unknown template: ${t}. Valid options: ${valid.join(', ')}`))
          process.exit(1)
        }
        template = t as TemplateKey
      } else {
        template = await select<TemplateKey>({
          message: 'Start from a template?',
          choices: [
            { name: 'blank          · Empty graph, start fresh', value: 'blank' },
            { name: 'saas           · SaaS: personas, jobs, opportunities, hypotheses', value: 'saas' },
            { name: 'marketplace    · Marketplace: two-sided personas, platform opportunity', value: 'marketplace' },
            { name: 'mobile         · Mobile app: personas, jobs, platform features', value: 'mobile' },
            { name: 'oss            · Open source: contributor persona, issue-to-feature chain', value: 'oss' },
          ],
        })
      }

      // ── Prompt: single vs workspace ───────────────────────────────────────
      let useWorkspace: boolean
      if (opts.workspace) {
        useWorkspace = true
      } else if (opts.single) {
        useWorkspace = false
      } else {
        const mode = await select<'single' | 'workspace'>({
          message: 'Single product or multi-product workspace?',
          choices: [
            { name: 'single         · Creates product.upg in current directory', value: 'single' },
            { name: 'workspace      · Creates .upg/<name>.upg + workspace.json', value: 'workspace' },
          ],
        })
        useWorkspace = mode === 'workspace'
      }

      // ── Build file path ───────────────────────────────────────────────────
      let filePath: string

      if (useWorkspace) {
        const upgDir = path.join(cwd, '.upg')
        await fs.mkdir(upgDir, { recursive: true })
        const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.upg'
        filePath = path.join(upgDir, filename)

        // Create or update workspace.json
        const workspacePath = path.join(upgDir, 'workspace.json')
        let workspace: { version: string; default_product: string; products: Array<{ file: string; title: string }> }
        try {
          const raw = await fs.readFile(workspacePath, 'utf-8')
          workspace = JSON.parse(raw)
          workspace.products.push({ file: filename, title })
        } catch {
          workspace = {
            version: '1.0',
            default_product: filename,
            products: [{ file: filename, title }],
          }
        }
        await fs.writeFile(workspacePath, JSON.stringify(workspace, null, 2) + '\n', 'utf-8')
      } else {
        filePath = path.join(cwd, 'product.upg')
      }

      // ── Guard: file already exists ────────────────────────────────────────
      if (!opts.force) {
        try {
          await fs.access(filePath)
          console.error(chalk.red(`File already exists: ${filePath}`))
          console.error(chalk.dim('Use --force to overwrite.'))
          process.exit(1)
        } catch { /* good: file does not exist */ }
      }

      // ── Build document ────────────────────────────────────────────────────
      const nodes = buildSeedNodes(template)

      const doc = {
        upg_version: UPG_VERSION,
        exported_at: new Date().toISOString(),
        source: { tool: 'upg-cli', tool_version: '0.1.0' },
        product: { id: nodeId(), title },
        nodes,
        edges: [],
      }

      await fs.writeFile(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf-8')

      // ── Success output ────────────────────────────────────────────────────
      const relPath = path.relative(cwd, filePath)
      const displayPath = relPath.startsWith('..') ? filePath : relPath

      const nodeCountLabel = nodes.length > 0
        ? `${nodes.length} seed node${nodes.length === 1 ? '' : 's'}  ${chalk.dim('·')}  template: ${template}`
        : `template: ${template}`

      console.log('')
      console.log(`  ${chalk.green('✓')}  Created ${chalk.white(displayPath)}`)
      console.log(`     ${chalk.dim(nodeCountLabel)}`)
      console.log('')
      console.log(`  ${chalk.bold('Next steps:')}`)
      console.log('')
      console.log(`    ${chalk.blueBright('upg install-skills')}        ${chalk.dim('Install UPG skills into Claude Code')}`)
      console.log(`    ${chalk.blueBright('upg mcp setup')}             ${chalk.dim('Wire the MCP server (one-time)')}`)
      console.log(`    ${chalk.blueBright('upg health')}                ${chalk.dim('Check your graph')}`)
      console.log('')
      console.log(`  Then open Claude Code and type ${chalk.bold.white('/upg')} to get started.`)
      console.log('')

    } catch (err) {
      // Handle inquirer ExitPromptError (Ctrl+C)
      const error = err as Error
      if (error.name === 'ExitPromptError') {
        console.log(chalk.dim('\nCancelled.'))
        process.exit(0)
      }
      console.error(chalk.red((err as Error).message))
      process.exit(2)
    }
  })
