/**
 * `upg import`: pull external tool data into a .upg file.
 *
 * Sources: markdown, github, linear, jira, dovetail, vistaly, notion (via MCP).
 *
 * Example: `upg import --from markdown --input ./docs/ --dry-run`
 */

import { Command, Option } from 'commander'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { input, password } from '@inquirer/prompts'
import ora from 'ora'
import { MarkdownAdapter } from '@unified-product-graph/adapters'
import { serializeCanonical, type UPGDocument } from '@unified-product-graph/core'
import { discoverUPGFile, loadStore, nodeId as genNodeId, edgeId as genEdgeId } from '../lib/graph.js'

// Version constant: keep in sync with packages/upg-spec/src/index.ts
const UPG_VERSION = '0.4.0' as const

// ── Types ──────────────────────────────────────────────────────────────────

type LiveTool = 'github' | 'linear' | 'jira' | 'dovetail' | 'vistaly'

type SupportedTool =
  | 'markdown'
  | 'notion'
  | 'linear'
  | 'github'
  | 'vistaly'
  | 'dovetail'
  | 'jira'

interface ImportOptions {
  from: SupportedTool
  file?: string
  output?: string
  dryRun?: boolean
  yes?: boolean
}

// ── File collection ────────────────────────────────────────────────────────

function collectMarkdownFiles(inputPath: string): string[] {
  const resolved = path.resolve(inputPath)

  // Single file
  if (fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile()) {
    if (resolved.endsWith('.md')) return [resolved]
    return []
  }

  // Directory: collect recursively
  const results: string[] = []

  function walk(dir: string): void {
    let entries: fsSync.Dirent[]
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full)
      }
    }
  }

  walk(resolved)
  return results.sort()
}

// ── Preview & summary ──────────────────────────────────────────────────────

function printPreview(
  nodes: Array<{ type: string; title: string }>,
  edges: Array<unknown>,
  warnings: string[],
): void {
  // Count by type
  const counts: Record<string, number> = {}
  for (const n of nodes) {
    counts[n.type] = (counts[n.type] ?? 0) + 1
  }

  console.log()
  console.log(`  ${chalk.bold('Preview')}  ${chalk.dim('·')}  ${nodes.length} entities · ${edges.length} edges`)
  console.log()

  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a)
  for (const [type, count] of sorted) {
    const bar = chalk.dim('·'.repeat(Math.min(count, 30)))
    console.log(`    ${chalk.blueBright(type.padEnd(22))}  ${chalk.white(String(count).padStart(3))}  ${bar}`)
  }

  if (warnings.length > 0) {
    console.log()
    console.log(`  ${chalk.yellow('Warnings')}`)
    for (const w of warnings.slice(0, 5)) {
      console.log(`    ${chalk.dim('·')} ${chalk.yellow(w)}`)
    }
    if (warnings.length > 5) {
      console.log(`    ${chalk.dim(`... and ${warnings.length - 5} more`)}`)
    }
  }

  console.log()
}

// ── .upg writer ────────────────────────────────────────────────────────────

export async function writeToUPGFile(
  importedNodes: Array<{ id: string; type: string; title: string; description?: string; tags?: string[]; status?: string; properties?: Record<string, unknown>; source_id?: string; source_type?: string; mapping_confidence?: string; external_tool?: string; external_ref?: string; external_id?: string }>,
  importedEdges: Array<{ id: string; source: string; target: string; type: string; mapping_confidence?: string }>,
  outputPath: string,
): Promise<{ created: boolean }> {
  // Check if file exists
  let fileExists = false
  try {
    await fs.access(outputPath)
    fileExists = true
  } catch {
    fileExists = false
  }

  if (fileExists) {
    // Append to existing file via the store, which preserves all existing data
    const store = await loadStore(outputPath)

    for (const n of importedNodes) {
      // Give each node a fresh local ID (import IDs are deterministic but not UPG-format)
      const localId = genNodeId()
      // We need the mapping for edges, so build it up as we go
      // The store accepts any UPGBaseNode shape
      store.addNode({
        id: localId,
        type: n.type,
        title: n.title,
        ...(n.description ? { description: n.description } : {}),
        ...(n.tags && n.tags.length > 0 ? { tags: n.tags } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...(n.properties ? { properties: n.properties } : {}),
        ...(n.source_id ? { source_id: n.source_id } : {}),
        ...(n.source_type ? { source_type: n.source_type } : {}),
        ...(n.mapping_confidence ? { mapping_confidence: n.mapping_confidence } : {}),
        // Canonical provenance fields (UPGBaseNode) — preserve, don't drop.
        ...(n.external_tool ? { external_tool: n.external_tool } : {}),
        ...(n.external_ref ? { external_ref: n.external_ref } : {}),
        ...(n.external_id ? { external_id: n.external_id } : {}),
      } as Parameters<typeof store.addNode>[0])

      // Update the import ID → local ID mapping for edge resolution
      importedEdges = importedEdges.map((e) => ({
        ...e,
        source: e.source === n.id ? localId : e.source,
        target: e.target === n.id ? localId : e.target,
      }))

      // Overwrite n.id so edge resolution works for subsequent nodes
      n.id = localId
    }

    for (const e of importedEdges) {
      try {
        store.addEdge({
          id: genEdgeId(),
          source: e.source,
          target: e.target,
          type: e.type,
          ...(e.mapping_confidence ? { mapping_confidence: e.mapping_confidence } : {}),
        } as Parameters<typeof store.addEdge>[0])
      } catch {
        // Skip edges whose endpoints didn't resolve (e.g. already-merged nodes)
      }
    }

    await store.flush()
    store.stopWatching()
    return { created: false }
  } else {
    // Create a new .upg file
    // Assign fresh local IDs
    const idMap: Record<string, string> = {}
    const finalNodes = importedNodes.map((n) => {
      const localId = genNodeId()
      idMap[n.id] = localId
      return {
        id: localId,
        type: n.type,
        title: n.title,
        ...(n.description ? { description: n.description } : {}),
        ...(n.tags && n.tags.length > 0 ? { tags: n.tags } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...(n.properties ? { properties: n.properties } : {}),
        ...(n.source_id ? { source_id: n.source_id } : {}),
        ...(n.source_type ? { source_type: n.source_type } : {}),
        ...(n.mapping_confidence ? { mapping_confidence: n.mapping_confidence } : {}),
        // Canonical provenance fields (UPGBaseNode) — preserve, don't drop.
        ...(n.external_tool ? { external_tool: n.external_tool } : {}),
        ...(n.external_ref ? { external_ref: n.external_ref } : {}),
        ...(n.external_id ? { external_id: n.external_id } : {}),
      }
    })

    const finalEdges = importedEdges
      .map((e) => ({
        id: genEdgeId(),
        source: idMap[e.source] ?? e.source,
        target: idMap[e.target] ?? e.target,
        type: e.type,
        ...(e.mapping_confidence ? { mapping_confidence: e.mapping_confidence } : {}),
      }))
      .filter((e) => e.source !== e.target) // drop any self-loops from unresolved IDs

    const productTitle = path.basename(outputPath, '.upg')

    const doc = {
      upg_version: UPG_VERSION,
      exported_at: new Date().toISOString(),
      source: { tool: 'upg-cli/import', tool_version: '0.1.0' },
      product: { id: genNodeId(), title: productTitle },
      nodes: finalNodes,
      edges: finalEdges,
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, serializeCanonical(doc as UPGDocument), 'utf-8')
    return { created: true }
  }
}

// ── Markdown import ────────────────────────────────────────────────────────

async function runMarkdownImport(opts: ImportOptions): Promise<void> {
  const inputPath = opts.file ?? '.'
  const files = collectMarkdownFiles(inputPath)

  if (files.length === 0) {
    console.log()
    console.log(`  ${chalk.yellow('No .md files found')} in ${chalk.white(path.resolve(inputPath))}`)
    console.log()
    process.exit(1)
  }

  const adapter = new MarkdownAdapter()

  // Use list() so each file is parsed into a section tree before conversion.
  // list() accepts { files: [{ path, content }] } and returns fully-sectioned SourceItems.
  const fileEntries = files.map((filePath) => ({
    path: filePath,
    content: fsSync.readFileSync(filePath, 'utf-8'),
  }))

  const items = await adapter.list({ files: fileEntries })
  const result = await adapter.convert(items)

  // Show preview
  if (!opts.dryRun) {
    console.log()
    console.log(`  ${chalk.dim('Found')} ${chalk.white(String(files.length))} ${chalk.dim(`file${files.length === 1 ? '' : 's'}  ·  ${result.nodes.length} entities`)}`)
  }

  printPreview(result.nodes, result.edges, result.warnings ?? [])

  if (opts.dryRun) {
    console.log(`  ${chalk.dim('Dry run. No changes written.')}`)
    console.log()
    return
  }

  // Resolve output path
  let outputPath: string
  if (opts.output) {
    outputPath = path.resolve(opts.output)
  } else {
    // Try to discover existing .upg file first
    try {
      outputPath = await discoverUPGFile()
    } catch {
      // None found, default to ./product.upg
      outputPath = path.resolve('product.upg')
    }
  }

  // Confirm
  if (!opts.yes) {
    const relOutput = path.relative(process.cwd(), outputPath)
    const displayOutput = relOutput.startsWith('..') ? outputPath : relOutput

    let fileAction: string
    try {
      await fs.access(outputPath)
      fileAction = `append to ${chalk.white(displayOutput)}`
    } catch {
      fileAction = `create ${chalk.white(displayOutput)}`
    }

    const confirmed = await confirm({
      message: `Add ${result.nodes.length} entities and ${result.edges.length} edges to your graph (${fileAction})?`,
      default: true,
    })

    if (!confirmed) {
      console.log(chalk.dim('\n  Cancelled.\n'))
      return
    }
  }

  const { created } = await writeToUPGFile(result.nodes, result.edges, outputPath)

  const relOutput = path.relative(process.cwd(), outputPath)
  const displayOutput = relOutput.startsWith('..') ? outputPath : relOutput

  console.log()
  console.log(
    `  ${chalk.green('✓')}  ${created ? 'Created' : 'Updated'} ${chalk.white(displayOutput)}` +
    `  ${chalk.dim(`+${result.nodes.length} nodes · +${result.edges.length} edges`)}`,
  )
  console.log()
  console.log(`  ${chalk.dim('Run')} ${chalk.blueBright('upg health')} ${chalk.dim('to check your graph.')}`)
  console.log()
}

// ── API credential resolution ──────────────────────────────────────────────

async function resolveCredentials(tool: LiveTool): Promise<Record<string, string>> {
  switch (tool) {
    case 'github': {
      const token = process.env.GITHUB_TOKEN
        ?? await password({ message: 'GitHub token (or set GITHUB_TOKEN env var):' })
      const ownerRepo = process.env.GITHUB_REPO
        ?? await input({ message: 'GitHub repository (owner/repo, e.g. acme/my-product):' })
      const [owner, repo] = ownerRepo.includes('/')
        ? ownerRepo.split('/')
        : [ownerRepo, ownerRepo]
      return { token, owner: owner ?? '', repo: repo ?? ownerRepo }
    }

    case 'linear': {
      const api_key = process.env.LINEAR_API_KEY
        ?? await password({ message: 'Linear API key (or set LINEAR_API_KEY env var):' })
      return { api_key }
    }

    case 'jira': {
      const base_url = process.env.JIRA_BASE_URL
        ?? await input({ message: 'Jira base URL (e.g. https://yourteam.atlassian.net):' })
      const email = process.env.JIRA_EMAIL
        ?? await input({ message: 'Jira email address:' })
      const api_token = process.env.JIRA_API_TOKEN
        ?? await password({ message: 'Jira API token (or set JIRA_API_TOKEN env var):' })
      return { base_url, email, api_token }
    }

    case 'dovetail': {
      const api_key = process.env.DOVETAIL_API_KEY
        ?? await password({ message: 'Dovetail API key (or set DOVETAIL_API_KEY env var):' })
      return { api_key }
    }

    case 'vistaly': {
      const api_key = process.env.VISTALY_API_KEY
        ?? await password({ message: 'Vistaly API key (or set VISTALY_API_KEY env var):' })
      const workspace_id = process.env.VISTALY_WORKSPACE_ID ?? ''
      return { api_key, workspace_id }
    }
  }
}

// ── Adapter factory ────────────────────────────────────────────────────────

const LIVE_TOOLS: LiveTool[] = ['github', 'linear', 'jira', 'dovetail', 'vistaly']

async function getAdapterForTool(tool: LiveTool) {
  switch (tool) {
    case 'github': {
      const { GitHubAdapter } = await import('@unified-product-graph/adapters')
      return new GitHubAdapter()
    }
    case 'linear': {
      const { LinearAdapter } = await import('@unified-product-graph/adapters')
      return new LinearAdapter()
    }
    case 'jira': {
      const { JiraAdapter } = await import('@unified-product-graph/adapters')
      return new JiraAdapter()
    }
    case 'dovetail': {
      const { DovetailAdapter } = await import('@unified-product-graph/adapters')
      return new DovetailAdapter()
    }
    case 'vistaly': {
      const { VistalyAdapter } = await import('@unified-product-graph/adapters')
      return new VistalyAdapter()
    }
  }
}

// ── Live import ────────────────────────────────────────────────────────────

async function runLiveImport(tool: LiveTool, opts: ImportOptions): Promise<void> {
  // 1. Resolve credentials
  const creds = await resolveCredentials(tool)

  // 2. Fetch with spinner
  const spinner = ora(`  Connecting to ${tool}...`).start()
  let items
  try {
    const adapter = await getAdapterForTool(tool)
    items = await adapter.list(creds)
    spinner.succeed(`  Fetched ${items.length} items from ${tool}`)
  } catch (err) {
    spinner.fail(`  Failed to connect to ${tool}`)
    throw err
  }

  // 3. Convert
  const adapter = await getAdapterForTool(tool)
  const result = await adapter.convert(items)

  // 4. Preview
  printPreview(result.nodes, result.edges, result.warnings ?? [])

  if (opts.dryRun) {
    console.log(`  ${chalk.dim('Dry run. No changes written.')}`)
    console.log()
    return
  }

  // 5. Resolve output path (same logic as markdown)
  let outputPath: string
  if (opts.output) {
    outputPath = path.resolve(opts.output)
  } else {
    try {
      outputPath = await discoverUPGFile()
    } catch {
      outputPath = path.resolve('product.upg')
    }
  }

  // 6. Confirm
  if (!opts.yes) {
    const relOutput = path.relative(process.cwd(), outputPath)
    const displayOutput = relOutput.startsWith('..') ? outputPath : relOutput
    let fileAction: string
    try {
      await fs.access(outputPath)
      fileAction = `append to ${chalk.white(displayOutput)}`
    } catch {
      fileAction = `create ${chalk.white(displayOutput)}`
    }

    const confirmed = await confirm({
      message: `Add ${result.nodes.length} entities and ${result.edges.length} edges to your graph (${fileAction})?`,
      default: true,
    })
    if (!confirmed) {
      console.log(chalk.dim('\n  Cancelled.\n'))
      return
    }
  }

  // 7. Write
  const { created } = await writeToUPGFile(result.nodes, result.edges, outputPath)

  const relOutput = path.relative(process.cwd(), outputPath)
  const displayOutput = relOutput.startsWith('..') ? outputPath : relOutput

  console.log()
  console.log(
    `  ${chalk.green('✓')}  ${created ? 'Created' : 'Updated'} ${chalk.white(displayOutput)}` +
    `  ${chalk.dim(`+${result.nodes.length} nodes · +${result.edges.length} edges`)}`,
  )
  console.log()
  console.log(`  ${chalk.dim('Run')} ${chalk.blueBright('upg health')} ${chalk.dim('to check your graph.')}`)
  console.log()
}

// ── Coming-soon handler (Notion only) ─────────────────────────────────────

function printComingSoon(tool: 'notion'): void {
  console.log()

  switch (tool) {
    case 'notion': {
      console.log(`  The Notion adapter is ready.`)
      console.log()
      console.log(`  ${chalk.bold('To import from Notion via Claude Code (recommended):')}`)
      console.log()
      console.log(`    Open Claude Code and run: ${chalk.blueBright('/upg-sync-import')}`)
      console.log(`    The skill guides you through Notion MCP setup, database`)
      console.log(`    classification, and controlled import with review.`)
      console.log()
      console.log(`  ${chalk.bold('To import from a Notion export (alternative):')}`)
      console.log()
      console.log(`    1. In Notion: Settings → Export → Markdown & CSV`)
      console.log(`    2. Unzip the export and run:`)
      console.log()
      console.log(`       ${chalk.white('upg import --from markdown --input ./notion-export/')}`)
      console.log()
      console.log(`  ${chalk.dim('Full CLI support with live Notion API sync is in development.')}`)
      break
    }
  }

  console.log()
}

// ── Command ────────────────────────────────────────────────────────────────

const SUPPORTED_TOOLS: SupportedTool[] = [
  'markdown',
  'notion',
  'linear',
  'github',
  'vistaly',
  'dovetail',
  'jira',
]

// Re-export for use in tests
export { LIVE_TOOLS }

export const importCommand = new Command('import')
  .description('Pull entities from an external tool into your .upg file.')
  // Optional positional source path, e.g. `upg import --from markdown ./docs`.
  .argument('[path]', 'For markdown: path to .md file or directory. Same as --input.')
  // .choices() makes a bogus value a usage error (commander.invalidOptionArgument
  // -> exit 3) instead of falling through to the action handler.
  .addOption(
    new Option('--from <tool>', `Source tool: ${SUPPORTED_TOOLS.join(', ')}`)
      .choices(SUPPORTED_TOOLS)
      .makeOptionMandatory(),
  )
  .option('--input <path>', 'For markdown: path to .md file or directory. Defaults to .')
  .option('--file <path>', 'Alias for --input (kept for back-compat).')
  .option('--output <path>', 'Output .upg path. Defaults to auto-discover or ./product.upg')
  .option('--dry-run', 'Preview entities. Skips the write')
  .option('--yes', 'Skip confirmation prompts')
  .addHelpText('after', `
Examples:
  upg import --from markdown
  upg import --from markdown --input ./research/
  upg import --from markdown ./research/
  upg import --from markdown --input ./notes.md --dry-run
  upg import --from notion
  upg import --from github
  upg import --from linear
  upg import --from jira
  upg import --from vistaly
  upg import --from dovetail

Environment variables (avoids prompts):
  GITHUB_TOKEN, GITHUB_REPO (owner/repo)
  LINEAR_API_KEY
  JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
  DOVETAIL_API_KEY
  VISTALY_API_KEY, VISTALY_WORKSPACE_ID`)
  .action(async (positionalPath: string | undefined, opts) => {
    const tool = opts.from as string

    // .choices() already rejects bad --from values as a usage error (exit 3);
    // this guard stays as a defensive net for any unexpected value.
    if (!SUPPORTED_TOOLS.includes(tool as SupportedTool)) {
      console.error(
        chalk.red(`Unknown tool: ${tool}\n`) +
        chalk.dim(`Supported: ${SUPPORTED_TOOLS.join(', ')}`),
      )
      process.exit(3)
    }

    // Source path precedence: --input, then the --file back-compat alias, then
    // the optional positional argument. Any one of them feeds the adapter flow.
    const sourcePath =
      (opts.input as string | undefined) ??
      (opts.file as string | undefined) ??
      positionalPath

    const importOpts: ImportOptions = {
      from: tool as SupportedTool,
      file: sourcePath,
      output: opts.output as string | undefined,
      dryRun: opts.dryRun as boolean | undefined,
      yes: opts.yes as boolean | undefined,
    }

    try {
      switch (tool) {
        case 'markdown':
          await runMarkdownImport(importOpts)
          break

        case 'github':
        case 'linear':
        case 'jira':
        case 'dovetail':
        case 'vistaly':
          await runLiveImport(tool as LiveTool, importOpts)
          break

        case 'notion':
          printComingSoon('notion')
          break
      }
    } catch (err) {
      const error = err as Error
      if (error.name === 'ExitPromptError') {
        console.log(chalk.dim('\n  Cancelled.'))
        process.exit(0)
      }
      console.error(chalk.red((err as Error).message))
      process.exit(2)
    }
  })
