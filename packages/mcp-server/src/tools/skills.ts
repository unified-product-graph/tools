/**
 * Skills introspection tools.
 *
 * `skill_audit` reports source-vs-deployed status for every UPG skill. Agents
 * use it to verify that a SKILL.md they're about to recommend is actually the
 * file users will see; closes the source/deployed divergence trust gap.
 */

import { existsSync, lstatSync, readlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text, type ToolHandler, type ToolResult } from '../lib/server-context.js'

/** Per-skill audit record returned by `skill_audit`. */
export interface SkillAuditRecord {
  /** Skill directory name (matches the `name:` frontmatter, e.g. `upg-trace`). */
  name: string
  /** Absolute path to the deployed SKILL.md (what users actually run). */
  deployed_path: string
  /** Absolute path to the canonical source SKILL.md. */
  source_path: string
  /** Does `.claude/skills/<name>/` exist at all? */
  deployed_exists: boolean
  /** Does `packages/upg-mcp-server/skills/<name>/` exist? */
  source_exists: boolean
  /** Is the deployed entry a symlink? */
  is_symlink: boolean
  /** Symlink target (absolute) if `is_symlink`, otherwise null. */
  symlink_target: string | null
  /** Do deployed and source SKILL.md files byte-match? */
  in_sync: boolean
  /** Parsed YAML frontmatter from the DEPLOYED file (the source of truth for runtime). */
  deployed_frontmatter: Record<string, unknown> | null
  /** First heading line (e.g. `# /upg-trace: Walk a Path…`). */
  deployed_first_heading: string | null
  /** Human-readable list of problems. Empty array means everything's healthy. */
  issues: string[]
}

/** Repo-root resolution. MCP server is invoked from the repo root in practice. */
function repoRoot(): string {
  return process.cwd()
}

/** Resolve symlinks etc. so two paths pointing at the same inode compare equal. */
function canonicalisePath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Does `candidate` look like a skills bundle (>=1 subdir with a SKILL.md)? */
function isSkillsDir(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false
    return readdirSync(candidate, { withFileTypes: true }).some(
      (e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(candidate, e.name, 'SKILL.md')),
    )
  } catch {
    return false
  }
}

/**
 * Resolve the bundled skills dir relative to THIS module (not cwd). Mirrors the
 * CLI's `resolveSkillsSource`: when the server runs from an npm/npx install, its
 * skills ship inside the package (`<pkg-root>/skills`), reachable from the
 * compiled module location even though `process.cwd()` is the user's project.
 */
function resolveBundledSkillsDir(): string | null {
  let md: string
  try {
    md = dirname(fileURLToPath(import.meta.url))
  } catch {
    md = process.cwd()
  }
  for (const c of [resolve(md, '..', 'skills'), resolve(md, '..', '..', 'skills'), resolve(md, 'skills')]) {
    if (isSkillsDir(c)) return c
  }
  let dir = md
  for (let i = 0; i < 12; i++) {
    const mono = join(dir, 'packages', 'upg-mcp-server', 'skills')
    if (isSkillsDir(mono)) return mono
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function sourceSkillsDir(): string {
  // Dev + tests run from the monorepo root (or a fixture cwd) where this exists.
  const cwdPath = resolve(repoRoot(), 'packages/upg-mcp-server/skills')
  if (existsSync(cwdPath)) return cwdPath
  // Published / npx: the server runs from the user's project, so cwd has no
  // monorepo source. The canonical source is the skills bundled in the installed
  // package, resolved relative to this module. Without this, skill_audit diffs
  // every deployed skill against a monorepo path that does not exist in a user's
  // project and false-reports them all as out of sync.
  return resolveBundledSkillsDir() ?? cwdPath
}

function deployedSkillsDir(): string {
  return resolve(repoRoot(), '.claude/skills')
}

/**
 * Minimal YAML frontmatter parser. Handles the SKILL.md shape:
 *   ---
 *   name: foo
 *   user-invocable: false
 *   ---
 *
 * Returns `null` if the file has no frontmatter block. Anything that requires
 * real YAML (nested objects, arrays, multiline strings) is intentionally not
 * supported; SKILL.md frontmatter is flat by convention.
 */
function parseFrontmatter(body: string): Record<string, unknown> | null {
  if (!body.startsWith('---\n')) return null
  const end = body.indexOf('\n---\n', 4)
  if (end < 0) return null
  const block = body.slice(4, end)
  const fm: Record<string, unknown> = {}
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let value: string = line.slice(colon + 1).trim()
    // Strip wrapping quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // Coerce booleans
    if (value === 'true') fm[key] = true
    else if (value === 'false') fm[key] = false
    else fm[key] = value
  }
  return fm
}

function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line
  }
  return null
}

function auditOne(name: string): SkillAuditRecord {
  const deployedDir = join(deployedSkillsDir(), name)
  const sourceDir = join(sourceSkillsDir(), name)
  const deployedPath = join(deployedDir, 'SKILL.md')
  const sourcePath = join(sourceDir, 'SKILL.md')
  const issues: string[] = []

  const sourceExists = existsSync(sourcePath)
  const deployedExists = existsSync(deployedPath)

  if (!sourceExists) issues.push('Canonical source SKILL.md is missing')
  if (!deployedExists) issues.push('Deployed SKILL.md is missing; run ./scripts/link-skills.sh')

  // Content match is the real signal: does the file the user runs equal the
  // canonical source? Compute it first so the deployment-method warnings below
  // fire only on real drift. A symlink to a different but byte-identical bundle
  // (the CLI's skills vs the mcp-server's), or a matching copy, is how a healthy
  // npm/npx install looks and must not be flagged.
  let inSync = false
  let deployedFrontmatter: Record<string, unknown> | null = null
  let deployedFirstHeading: string | null = null
  if (deployedExists) {
    const deployedBody = readFileSync(deployedPath, 'utf8')
    deployedFrontmatter = parseFrontmatter(deployedBody)
    deployedFirstHeading = firstHeading(deployedBody)
    if (sourceExists) {
      const sourceBody = readFileSync(sourcePath, 'utf8')
      inSync = deployedBody === sourceBody
      if (!inSync) {
        issues.push('Deployed SKILL.md differs from canonical source; symlink is stale or broken')
      }
    }
  }

  let isSymlink = false
  let symlinkTarget: string | null = null
  if (existsSync(deployedDir)) {
    const stat = lstatSync(deployedDir)
    isSymlink = stat.isSymbolicLink()
    if (isSymlink) {
      symlinkTarget = readlinkSync(deployedDir)
      // Only flag a target mismatch when the bytes ALSO differ. Canonicalise
      // both sides first; on macOS /tmp vs /private/tmp and other
      // symlink-in-path situations make a string compare unreliable.
      if (!inSync && sourceExists) {
        const targetReal = canonicalisePath(symlinkTarget)
        const expectedReal = canonicalisePath(sourceDir)
        if (targetReal !== expectedReal) {
          issues.push(`Symlink points to ${symlinkTarget}, expected ${sourceDir}`)
        }
      }
    } else if (deployedExists && !inSync) {
      issues.push('Deployed entry is a real directory, not a symlink; stale copy will not pick up source updates; run ./scripts/link-skills.sh')
    }
  }

  return {
    name,
    deployed_path: deployedPath,
    source_path: sourcePath,
    deployed_exists: deployedExists,
    source_exists: sourceExists,
    is_symlink: isSymlink,
    symlink_target: symlinkTarget,
    in_sync: inSync,
    deployed_frontmatter: deployedFrontmatter,
    deployed_first_heading: deployedFirstHeading,
    issues,
  }
}

/**
 * All skill names to audit: the UNION of every directory under the canonical
 * source (`packages/upg-mcp-server/skills`) and the deployed dir
 * (`.claude/skills`).
 *
 * The union matters because the no-args sweep used to read only the source
 * dir, which is absent whenever the server is invoked from a location whose
 * `process.cwd()` is not the monorepo root (e.g. the published/npx/homebrew
 * package) — yielding `{ skills: [] }` (DT-MACH-1). Auditing the union means
 * the sweep still surfaces every deployed skill (and its symlink/in_sync
 * issues) even when the source tree isn't reachable from cwd, and still
 * surfaces source-only skills that haven't been deployed.
 */
function allSkillNames(): string[] {
  const names = new Set<string>()
  for (const dir of [sourceSkillsDir(), deployedSkillsDir()]) {
    if (!existsSync(dir)) continue
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      // Follow symlinked dirs: `.claude/skills/<name>` is typically a symlink
      // to the source skill directory, so `isDirectory()` is false on it.
      if (d.isDirectory() || d.isSymbolicLink()) names.add(d.name)
    }
  }
  return [...names].sort()
}

/**
 * Audit one or every UPG skill for source-vs-deployed integrity.
 *
 * Use before recommending a skill to a user; confirms `.claude/skills/<name>/SKILL.md`
 * is a symlink to canonical source and the bodies match. When `in_sync: false`,
 * what the runner read from `packages/upg-mcp-server/skills/` is NOT what the
 * user will experience.
 *
 * @param name optional skill name; if omitted, audits all canonical skills
 * @returns `{ skills: SkillAuditRecord[] }`
 * @atomicity atomic (read-only filesystem stat + read)
 */
export const skillAudit: ToolHandler = (args: { name?: unknown }): ToolResult => {
  const filter = typeof args?.name === 'string' && args.name.length > 0 ? args.name : null
  const names = filter ? [filter] : allSkillNames()
  const skills = names.map((n) => auditOne(n))
  return text(JSON.stringify({ skills }, null, 2))
}
