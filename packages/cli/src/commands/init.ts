/**
 * `upg init`: create a .upg file. Interactive by default; flag-driven when scripted.
 */

import { Command } from 'commander'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import chalk from 'chalk'
import { input, select } from '@inquirer/prompts'
import { UPG_VERSION, serializeCanonical, type UPGDocument } from '@unified-product-graph/core'
import { getStarterSeeds, STARTER_KEYS, type StarterKey } from '@unified-product-graph/sdk'
import { nodeId } from '../lib/graph.js'
import { upgLogo } from '../lib/formatter.js'
import { CLI_VERSION } from '../lib/version.js'

// ── Template definitions ───────────────────────────────────────────────────

// Starter graphs come from @unified-product-graph/templates via the SDK access
// layer, so the CLI and the MCP servers share one source of truth instead of
// each importing the package. Seeds are placeholder-free and id-less; init
// stamps a fresh id on each at write time.
type TemplateKey = StarterKey

const TEMPLATE_KEYS = STARTER_KEYS

function buildSeedNodes(template: TemplateKey): Array<{ id: string; type: string; title: string; description?: string }> {
  return getStarterSeeds(template).map((seed) => ({ id: nodeId(), ...seed }))
}

// ── CLI command ────────────────────────────────────────────────────────────

export const initCommand = new Command('init')
  .description('Create a .upg file. Interactive by default.')
  .option('--title <title>', 'Product title. Skips prompt')
  .option('--template <template>', 'blank | saas | marketplace | mobile | oss | agency. Skips prompt')
  .option('--workspace', 'Create in .upg/<name>.upg with workspace.json. Skips prompt')
  .option('--single', 'Create product.upg in the current directory. Skips prompt')
  .option('--file <path>', 'Explicit output path (overrides the single/workspace default; also honours $UPG_FILE).')
  .option('--force', 'Overwrite the existing file')
  .option('--yes', 'Non-interactive: use defaults for anything not set by a flag (template = blank, mode = single).')
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      // --file (or $UPG_FILE) is an explicit output path; it also resolves the
      // single/workspace choice, so no mode prompt is needed (CLI-FEEDBACK L3).
      const explicitFile = (opts.file as string | undefined) ?? process.env.UPG_FILE
      // --yes makes init fully non-interactive: anything not set by a flag uses a
      // default (title = dir name, template = blank, mode = single) instead of
      // prompting (CLI-FEEDBACK L3 — previously --title alone still blocked on
      // the template + single/workspace prompts).
      const nonInteractive = opts.yes === true
      const willPrompt =
        !nonInteractive &&
        (!opts.title || !opts.template || (!explicitFile && !opts.workspace && !opts.single))

      // ── Banner ────────────────────────────────────────────────────────────
      if (willPrompt) {
        // Banner uses the CLI package version, not the spec's UPG_VERSION,
        // so it matches `upg --version` (CLI-FEEDBACK #5).
        console.log(upgLogo(CLI_VERSION))
      }

      // ── Prompt: product title ─────────────────────────────────────────────
      let title: string
      if (opts.title) {
        title = opts.title as string
      } else if (nonInteractive) {
        title = path.basename(cwd)
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
        if (!TEMPLATE_KEYS.includes(t as TemplateKey)) {
          console.error(chalk.red(`Unknown template: ${t}. Valid options: ${TEMPLATE_KEYS.join(', ')}`))
          process.exit(1)
        }
        template = t as TemplateKey
      } else if (nonInteractive) {
        template = 'blank'
      } else {
        template = await select<TemplateKey>({
          message: 'Start from a template?',
          choices: [
            { name: 'blank          · Empty graph, start fresh', value: 'blank' },
            { name: 'saas           · SaaS: primary user, core job, key opportunity', value: 'saas' },
            { name: 'marketplace    · Marketplace: two-sided personas, platform opportunity', value: 'marketplace' },
            { name: 'mobile         · Mobile app: user, job, core feature', value: 'mobile' },
            { name: 'oss            · Open source: contributor + end user, core feature', value: 'oss' },
            { name: 'agency         · Agency: client persona, engagement, project revenue', value: 'agency' },
          ],
        })
      }

      // ── Resolve output path ───────────────────────────────────────────────
      let filePath: string

      if (explicitFile) {
        // Explicit path (--file / $UPG_FILE): single-file semantics, no
        // workspace.json, no single/workspace prompt.
        filePath = path.resolve(cwd, explicitFile)
      } else {
        // Prompt (or default in --yes mode): single vs workspace.
        let useWorkspace: boolean
        if (opts.workspace) {
          useWorkspace = true
        } else if (opts.single) {
          useWorkspace = false
        } else if (nonInteractive) {
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
        source: { tool: 'upg-cli', tool_version: CLI_VERSION },
        product: { id: nodeId(), title },
        nodes,
        edges: [],
      }

      await fs.writeFile(filePath, serializeCanonical(doc as UPGDocument), 'utf-8')

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
