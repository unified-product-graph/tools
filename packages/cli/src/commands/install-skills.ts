/**
 * `upg install-skills`: link bundled UPG skills into Claude Code.
 *
 * Source resolution: 1) bundled `<pkg-root>/skills/`, 2) monorepo dev fallback
 * to `packages/upg-mcp-server/skills/`, 3) error.
 *
 * Scopes: `project` → `<cwd>/.claude/skills/` (default). `user` → `~/.claude/skills/`.
 *
 * `<dest>/.upg-manifest.json` records UPG-owned skills. `--remove` reads it
 * and leaves user-owned skills intact.
 */

import { Command } from 'commander'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createInterface } from 'node:readline'
import chalk from 'chalk'

export type InstallMode = 'symlink' | 'copy'
export type InstallScope = 'user' | 'project'

export interface Manifest {
  version: string
  installed_at: string
  mode: InstallMode
  scope: InstallScope
  skills: string[]
}

const MANIFEST_NAME = '.upg-manifest.json'

/**
 * Symlink creator indirection. Exposed so tests can inject a failing impl
 * (ESM export namespaces on `fs/promises` are not spy-able in vitest).
 */
let symlinkImpl: (target: string, dest: string) => Promise<void> =
  async (target, dest) => { await fsp.symlink(target, dest, 'dir') }

/** Test hook: override or restore the symlink implementation. */
export function __setSymlinkImpl(
  impl: ((target: string, dest: string) => Promise<void>) | null,
): void {
  symlinkImpl = impl ?? (async (target, dest) => { await fsp.symlink(target, dest, 'dir') })
}

/**
 * Locate the compiled/source entry file. For the bundled build (`dist/cli.cjs`)
 * `__filename` points inside `<pkg-root>/dist/`, so we walk up one level to find
 * the skills bundle. For `tsx src/cli.ts` (ESM dev mode) we fall back to
 * `process.argv[1]`, and the dev-mode monorepo walk-up handles resolution.
 */
function getEntryFilename(): string {
  // CJS (production build emits cli.cjs, tsup bundles everything)
  if (typeof __filename !== 'undefined') return __filename
  // ESM dev (tsx). Using argv[1] avoids a direct `eval` call that tsup warns
  // on; either entry is fine for resolveSkillsSource's walk-up logic.
  return process.argv[1] || process.cwd()
}

/**
 * Resolve the directory containing the skills bundle.
 * Returns null if no source can be found.
 */
export function resolveSkillsSource(entry: string = getEntryFilename()): string | null {
  const entryDir = path.dirname(entry)

  // 1. Bundled: <pkg-root>/skills/. Try a handful of likely layouts.
  const bundledCandidates = [
    path.resolve(entryDir, '..', 'skills'),       // dist/cli.cjs -> ../skills
    path.resolve(entryDir, '..', '..', 'skills'), // dist/sub/.. edge case
    path.resolve(entryDir, 'skills'),             // entry next to skills
  ]
  for (const candidate of bundledCandidates) {
    if (isSkillsDir(candidate)) return candidate
  }

  // 2. Monorepo dev fallback: walk up looking for packages/upg-mcp-server/skills.
  let dir = entryDir
  for (let i = 0; i < 12; i++) {
    const monorepoCandidate = path.join(dir, 'packages', 'upg-mcp-server', 'skills')
    if (isSkillsDir(monorepoCandidate)) return monorepoCandidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

function isSkillsDir(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isDirectory()) return false
    // A skills dir should contain at least one subdirectory with a SKILL.md.
    const entries = fs.readdirSync(candidate, { withFileTypes: true })
    return entries.some((e) => e.isDirectory() && fs.existsSync(path.join(candidate, e.name, 'SKILL.md')))
  } catch {
    return false
  }
}

/** List skills (directory names) found in a skills source dir. */
export function listSkillsInSource(src: string): string[] {
  return fs
    .readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

function resolveDestination(scope: InstallScope): string {
  if (scope === 'user') return path.join(os.homedir(), '.claude', 'skills')
  return path.join(process.cwd(), '.claude', 'skills')
}

async function readManifest(destDir: string): Promise<Manifest | null> {
  try {
    const raw = await fsp.readFile(path.join(destDir, MANIFEST_NAME), 'utf-8')
    return JSON.parse(raw) as Manifest
  } catch {
    return null
  }
}

async function writeManifest(destDir: string, manifest: Manifest): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true })
  await fsp.writeFile(
    path.join(destDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  )
}

/** Read the CLI package version for the manifest. Best-effort. */
function readCliVersion(entry: string = getEntryFilename()): string {
  // Try the published-tarball layout: package.json sits next to dist/
  const entryDir = path.dirname(entry)
  const candidates = [
    path.resolve(entryDir, '..', 'package.json'),
    path.resolve(entryDir, 'package.json'),
    path.resolve(entryDir, '..', '..', 'package.json'),
  ]
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(c, 'utf-8'))
      if (pkg?.name === '@unified-product-graph/mcp' && typeof pkg.version === 'string') return pkg.version
    } catch { /* try next */ }
  }
  return '0.0.0'
}

/** Prompt for y/N/a. Returns 'yes' | 'no' | 'all'. Non-TTY defaults to 'no'. */
async function promptOverwrite(skillName: string): Promise<'yes' | 'no' | 'all'> {
  if (!process.stdin.isTTY) return 'no'
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((resolve) => {
    rl.question(`  ${chalk.yellow('?')} ${skillName} exists. Overwrite? [y/N/a] `, (a) => {
      rl.close()
      resolve(a.trim().toLowerCase())
    })
  })
  if (answer === 'y' || answer === 'yes') return 'yes'
  if (answer === 'a' || answer === 'all') return 'all'
  return 'no'
}

async function removeTarget(target: string): Promise<void> {
  try {
    const stat = await fsp.lstat(target)
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fsp.unlink(target)
    } else if (stat.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: true })
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(srcPath)
      await fsp.symlink(linkTarget, destPath)
    } else {
      await fsp.copyFile(srcPath, destPath)
    }
  }
}

/**
 * Install a single skill directory. Returns the mode actually used ('symlink'
 * or 'copy'). Throws if `requestedMode === 'symlink'` and symlink creation
 * fails.
 */
async function installOne(
  srcSkillDir: string,
  destSkillDir: string,
  requestedMode: InstallMode,
): Promise<InstallMode> {
  await removeTarget(destSkillDir)
  await fsp.mkdir(path.dirname(destSkillDir), { recursive: true })

  if (requestedMode === 'symlink') {
    try {
      await symlinkImpl(srcSkillDir, destSkillDir)
      return 'symlink'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Strict mode: propagate
      throw Object.assign(new Error(`symlink failed for ${path.basename(srcSkillDir)}: ${code ?? (err as Error).message}`), { cause: err })
    }
  }

  if (requestedMode === 'copy') {
    await copyDir(srcSkillDir, destSkillDir)
    return 'copy'
  }

  return 'copy'
}

/**
 * Default mode: try symlink, fall back to copy on EPERM / EACCES / ENOSYS
 * (Windows without dev mode) or any symlink failure.
 */
async function installOneAuto(srcSkillDir: string, destSkillDir: string): Promise<InstallMode> {
  await removeTarget(destSkillDir)
  await fsp.mkdir(path.dirname(destSkillDir), { recursive: true })
  try {
    await symlinkImpl(srcSkillDir, destSkillDir)
    return 'symlink'
  } catch {
    await copyDir(srcSkillDir, destSkillDir)
    return 'copy'
  }
}

export interface RunOptions {
  scope: InstallScope
  mode: 'symlink' | 'copy' | 'auto'
  force: boolean
  list: boolean
  remove: boolean
  /** Override source dir (test hook). */
  sourceOverride?: string
  /** Override destination (test hook). */
  destOverride?: string
  /** Non-interactive overwrite policy (test hook). */
  autoAnswer?: 'yes' | 'no' | 'all'
}

export interface RunResult {
  action: 'list' | 'install' | 'remove'
  source?: string
  dest: string
  installed: string[]
  updated: string[]
  skipped: string[]
  removed: string[]
  modes: InstallMode[]
}

/**
 * Core runner. Exported for tests, and does no `process.exit` calls.
 */
export async function runInstallSkills(opts: RunOptions): Promise<RunResult> {
  const dest = opts.destOverride ?? resolveDestination(opts.scope)

  // --remove: manifest-driven cleanup.
  if (opts.remove) {
    const manifest = await readManifest(dest)
    if (!manifest) {
      throw new Error(`No UPG manifest found in ${dest}; nothing to remove.`)
    }
    const removed: string[] = []
    for (const skill of manifest.skills) {
      const target = path.join(dest, skill)
      await removeTarget(target)
      removed.push(skill)
    }
    await fsp.unlink(path.join(dest, MANIFEST_NAME)).catch(() => { /* ignore */ })
    return {
      action: 'remove',
      dest,
      installed: [],
      updated: [],
      skipped: [],
      removed,
      modes: [],
    }
  }

  // Resolve source.
  const source = opts.sourceOverride ?? resolveSkillsSource()
  if (!source) {
    throw new Error(
      'Could not locate bundled skills. If running from the monorepo, ensure ' +
      '`packages/upg-mcp-server/skills/` exists. If installed from npm, the ' +
      'package may be missing its `skills/` directory. Try reinstalling @unified-product-graph/mcp.',
    )
  }

  const skills = listSkillsInSource(source)
  if (skills.length === 0) {
    throw new Error(`No skills found in ${source}.`)
  }

  // --list: print names, no installation.
  if (opts.list) {
    for (const name of skills) console.log(name)
    return {
      action: 'list',
      source,
      dest,
      installed: skills.slice(),
      updated: [],
      skipped: [],
      removed: [],
      modes: [],
    }
  }

  await fsp.mkdir(dest, { recursive: true })
  const existingManifest = await readManifest(dest)
  const managed = new Set(existingManifest?.skills ?? [])

  const installed: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  const modesUsed = new Set<InstallMode>()
  let yesToAll = opts.force || opts.autoAnswer === 'all'

  for (const skill of skills) {
    const srcSkillDir = path.join(source, skill)
    const destSkillDir = path.join(dest, skill)

    let exists = false
    try {
      await fsp.lstat(destSkillDir)
      exists = true
    } catch { /* not present */ }

    const isManaged = managed.has(skill)

    if (exists && !isManaged && !opts.force && !yesToAll) {
      const answer = opts.autoAnswer ?? (await promptOverwrite(skill))
      if (answer === 'all') {
        yesToAll = true
      } else if (answer === 'no') {
        console.log(`  ${chalk.yellow('⚠')} skipped ${skill} ${chalk.dim('(exists; use --force)')}`)
        skipped.push(skill)
        continue
      }
    }

    let mode: InstallMode
    if (opts.mode === 'symlink') {
      mode = await installOne(srcSkillDir, destSkillDir, 'symlink')
    } else if (opts.mode === 'copy') {
      mode = await installOne(srcSkillDir, destSkillDir, 'copy')
    } else {
      mode = await installOneAuto(srcSkillDir, destSkillDir)
    }
    modesUsed.add(mode)

    if (isManaged) {
      console.log(`  ${chalk.cyan('→')} updated ${skill}`)
      updated.push(skill)
    } else {
      const verb = mode === 'symlink' ? 'linked' : 'copied'
      console.log(`  ${chalk.green('→')} ${verb} ${skill}`)
      installed.push(skill)
    }
  }

  // Write manifest. Record exactly what we currently own: new installs + updates
  // + previously-managed skills that still exist on disk.
  const nowManaged = new Set<string>([...installed, ...updated])
  for (const prior of managed) {
    try {
      await fsp.lstat(path.join(dest, prior))
      nowManaged.add(prior)
    } catch { /* gone, drop */ }
  }
  const finalMode: InstallMode = modesUsed.has('symlink') && !modesUsed.has('copy')
    ? 'symlink'
    : modesUsed.has('copy') && !modesUsed.has('symlink')
      ? 'copy'
      : // mixed or none: record the predominant one, defaulting to copy
        (modesUsed.has('symlink') ? 'symlink' : 'copy')

  const manifest: Manifest = {
    version: readCliVersion(),
    installed_at: new Date().toISOString(),
    mode: finalMode,
    scope: opts.scope,
    skills: [...nowManaged].sort(),
  }
  await writeManifest(dest, manifest)

  return {
    action: 'install',
    source,
    dest,
    installed,
    updated,
    skipped,
    removed: [],
    modes: [...modesUsed],
  }
}

export const installSkillsCommand = new Command('install-skills')
  .description('Link bundled UPG skills into Claude Code.')
  .option('--scope <user|project>', 'project = <cwd>/.claude/skills. user = ~/.claude/skills', 'project')
  .option('--force', 'Overwrite existing skills without prompting', false)
  .option('--mode <symlink|copy>', 'auto (default), symlink, or copy. auto falls back to copy on Windows', 'auto')
  .option('--list', 'Print skill names. Skips the install', false)
  .option('--remove', 'Remove UPG skills recorded in the manifest', false)
  .action(async (opts) => {
    try {
      const scope = opts.scope as InstallScope
      if (scope !== 'user' && scope !== 'project') {
        console.error(`Invalid --scope "${opts.scope}". Use "user" or "project".`)
        process.exit(2)
      }
      const modeRaw = opts.mode as string
      if (!['symlink', 'copy', 'auto'].includes(modeRaw)) {
        console.error(`Invalid --mode "${modeRaw}". Use "symlink", "copy", or "auto".`)
        process.exit(2)
      }

      const result = await runInstallSkills({
        scope,
        mode: modeRaw as 'symlink' | 'copy' | 'auto',
        force: Boolean(opts.force),
        list: Boolean(opts.list),
        remove: Boolean(opts.remove),
      })

      if (result.action === 'list') {
        // --list already printed names; nothing else.
        return
      }

      if (result.action === 'remove') {
        console.log()
        console.log(chalk.green(`✓ ${result.removed.length} skill${result.removed.length === 1 ? '' : 's'} removed from ${result.dest}`))
        return
      }

      const scopeLabel = scope === 'project' ? 'project' : 'user'
      const modeLabel = result.modes.length === 0
        ? 'n/a'
        : result.modes.length === 1
          ? result.modes[0]
          : result.modes.join('+')
      const total = result.installed.length + result.updated.length
      const parts: string[] = []
      if (result.installed.length) parts.push(`${result.installed.length} installed`)
      if (result.updated.length) parts.push(`${result.updated.length} updated`)
      if (result.skipped.length) parts.push(chalk.yellow(`${result.skipped.length} skipped`))
      console.log()
      console.log(chalk.green(`✓ ${total} skills in ${result.dest} (${scopeLabel}, mode=${modeLabel})`))
      if (parts.length) console.log(`  ${parts.join(', ')}`)
      console.log(chalk.dim('  Next: run `upg mcp setup` to wire the MCP server, then open Claude Code and type /upg'))
    } catch (err) {
      console.error((err as Error).message)
      process.exit(2)
    }
  })
