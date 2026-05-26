/**
 * Generator orchestrator. Runs walker, audit gate, and emitters against
 * a server's tools directory and produces three reference outputs.
 *
 * Consumers call `runGenerator(config)` from a thin shim in
 * `<package>/scripts/`. Returns a `GeneratorResult` so the shim handles
 * exit codes.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { walkHandlerFile, type JSDocBlock } from './jsdoc-walker.js'
import { runAudit, formatFailures, type AuditedTool } from './audit.js'
import { renderMarkdown, renderManifest } from './emit.js'
import type { ToolDefinition } from '../tool-definition.js'

export interface GeneratorOutputs {
  /** Path to the npm-shipped TOOLS.md (e.g. `<package>/TOOLS.md`). */
  toolsMd?: string
  /** Path to the site-consumed markdown (e.g. `apps/upg-site/content/generated/mcp-tools.md`). */
  siteMd?: string
  /** Path to the JSON manifest (e.g. `<package>/dist/tools-manifest.json`). */
  manifest?: string
}

export interface GeneratorConfig {
  /** Absolute path to the package root (used to resolve outputs and trim source paths). */
  packageRoot: string
  /** Package name as published (e.g. `@unified-product-graph/mcp-server`). */
  packageName: string
  /** Package version (read from package.json by the consuming shim). */
  packageVersion: string
  /** Absolute path to the directory holding handler files (`<root>/src/tools`). */
  toolsDir: string
  /** Domain order. Controls section ordering and TOC. */
  domains: readonly string[]
  /** Human-readable section header per domain. */
  domainLabels: Record<string, string>
  /** Optional one-line blurb under each section header. */
  domainBlurbs?: Record<string, string>
  /** Map of exported handler symbol to MCP tool name. Helpers map to
   *  nothing. */
  symbolToToolName: Record<string, string>
  /** Wire-shape definitions from the consumer's tool-registry. */
  toolDefinitions: readonly ToolDefinition[]
  /** Output paths. Any subset works; missing entries are skipped. */
  outputs: GeneratorOutputs
  /** Title for the npm-shipped TOOLS.md. */
  toolsMdTitle: string
  /** Lead paragraph for the npm-shipped TOOLS.md. */
  toolsMdIntro: string
  /** Title for the site-consumed markdown. */
  siteMdTitle: string
  /** Lead paragraph for the site-consumed markdown. */
  siteMdIntro: string
  /** Optional footer for the site-consumed markdown. */
  generatedFooter?: string
  /** When true, behaves as a check (no writes). Diffs against disk and
   *  reports. */
  check?: boolean
  /** Optional repo root for trimming output paths in messages.
   *  Defaults to `packageRoot`. */
  repoRoot?: string
}

export interface GeneratorResult {
  ok: boolean
  toolCount: number
  domainCount: number
  /** Files whose disk content differs from what the generator produced (check mode only). */
  drifts: string[]
  /** Walker, audit, and missing-handler errors that fail the run. */
  errors: string[]
  /** Files written (write mode). */
  written: string[]
}

export async function runGenerator(config: GeneratorConfig): Promise<GeneratorResult> {
  const repoRoot = config.repoRoot ?? config.packageRoot
  const result: GeneratorResult = {
    ok: false,
    toolCount: 0,
    domainCount: 0,
    drifts: [],
    errors: [],
    written: [],
  }

  // 1. Walk every handler file.
  const blocksByName = new Map<string, { block: JSDocBlock; domain: string }>()
  for (const domain of config.domains) {
    const file = join(config.toolsDir, `${domain}.ts`)
    if (!existsSync(file)) {
      result.errors.push(`Missing handler file: ${file}`)
      continue
    }
    const walked = walkHandlerFile(file, config.packageRoot)
    for (const e of walked.errors) {
      result.errors.push(`${e.source} ${e.symbol ?? ''}: ${e.message}`)
    }
    for (const block of walked.blocks) {
      const toolName = config.symbolToToolName[block.symbol]
      if (!toolName) continue // helper export, not a tool. Skip silently.
      blocksByName.set(toolName, { block, domain })
    }
  }

  // 2. Pair each registry entry with its JSDoc block.
  const tools: AuditedTool[] = []
  const missing: string[] = []
  for (const def of config.toolDefinitions) {
    const found = blocksByName.get(def.name)
    if (!found) {
      missing.push(def.name)
      continue
    }
    tools.push({ definition: def, block: found.block, domain: found.domain })
  }

  if (missing.length > 0) {
    result.errors.push(
      `${missing.length} tool${missing.length === 1 ? '' : 's'} declared in toolDefinitions but no JSDoc'd handler found: ${missing.join(', ')}`,
    )
    return result
  }

  if (result.errors.length > 0) {
    return result
  }

  // 3. Audit gate.
  const failures = runAudit(tools)
  if (failures.length > 0) {
    result.errors.push(formatFailures(failures))
    return result
  }

  result.toolCount = tools.length
  result.domainCount = config.domains.length

  // 4. Render outputs.
  const toolsMd = renderMarkdown(tools, {
    title: config.toolsMdTitle,
    intro: config.toolsMdIntro,
    domains: config.domains,
    domainLabels: config.domainLabels,
    domainBlurbs: config.domainBlurbs,
  })

  const siteMd = renderMarkdown(tools, {
    title: config.siteMdTitle,
    intro: config.siteMdIntro,
    domains: config.domains,
    domainLabels: config.domainLabels,
    domainBlurbs: config.domainBlurbs,
    includeGeneratedFooter: true,
    generatedFooter: config.generatedFooter,
  })

  const manifest = renderManifest(tools, {
    packageName: config.packageName,
    packageVersion: config.packageVersion,
    domains: config.domains,
  })
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

  // 5. Write or check.
  if (config.check) {
    const drifts: string[] = []
    if (config.outputs.toolsMd && !matchesDisk(config.outputs.toolsMd, toolsMd)) {
      drifts.push(relPath(config.outputs.toolsMd, repoRoot))
    }
    if (config.outputs.siteMd && !matchesDisk(config.outputs.siteMd, siteMd)) {
      drifts.push(relPath(config.outputs.siteMd, repoRoot))
    }
    // The manifest lives under dist/ (gitignored). No checked-in baseline.
    void manifestJson
    result.drifts = drifts
    result.ok = drifts.length === 0
    return result
  }

  if (config.outputs.toolsMd) {
    writeFile(config.outputs.toolsMd, toolsMd)
    result.written.push(relPath(config.outputs.toolsMd, repoRoot))
  }
  if (config.outputs.siteMd) {
    writeFile(config.outputs.siteMd, siteMd)
    result.written.push(relPath(config.outputs.siteMd, repoRoot))
  }
  if (config.outputs.manifest) {
    writeFile(config.outputs.manifest, manifestJson)
    result.written.push(relPath(config.outputs.manifest, repoRoot))
  }

  result.ok = true
  return result
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function relPath(p: string, repoRoot: string): string {
  return p.startsWith(repoRoot) ? p.slice(repoRoot.length + 1) : p
}

function matchesDisk(path: string, expected: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf-8') === expected
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

// ─── Re-exports ────────────────────────────────────────────────────────────

export { walkHandlerFile, type JSDocBlock, type WalkerError, type WalkerResult } from './jsdoc-walker.js'
export { runAudit, formatFailures, isWriteTool, type AuditedTool, type AuditFailure } from './audit.js'
export {
  renderMarkdown,
  renderManifest,
  type MarkdownOptions,
  type ManifestOptions,
  type ToolManifest,
  type ToolManifestEntry,
} from './emit.js'
