/**
 * Skills introspection tools.
 *
 * `skill_audit` reports source-vs-deployed status for every UPG skill. Agents
 * use it to verify that a SKILL.md they're about to recommend is actually the
 * file users will see — closes the source/deployed divergence trust gap.
 */

import { existsSync, lstatSync, readlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  /** First heading line (e.g. `# /upg-trace — Walk a Path…`). */
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

function sourceSkillsDir(): string {
  return resolve(repoRoot(), 'packages/upg-mcp-server/skills')
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
 * supported — SKILL.md frontmatter is flat by convention.
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
  if (!deployedExists) issues.push('Deployed SKILL.md is missing — run ./scripts/link-skills.sh')

  let isSymlink = false
  let symlinkTarget: string | null = null
  if (existsSync(deployedDir)) {
    const stat = lstatSync(deployedDir)
    isSymlink = stat.isSymbolicLink()
    if (isSymlink) {
      symlinkTarget = readlinkSync(deployedDir)
      // Canonicalise both sides before comparing — on macOS, /tmp ↔ /private/tmp
      // and other symlink-in-path situations make a string compare unreliable.
      const targetReal = canonicalisePath(symlinkTarget)
      const expectedReal = canonicalisePath(sourceDir)
      if (targetReal !== expectedReal) {
        issues.push(`Symlink points to ${symlinkTarget}, expected ${sourceDir}`)
      }
    } else if (deployedExists) {
      issues.push('Deployed entry is a real directory, not a symlink — stale copy will not pick up source updates; run ./scripts/link-skills.sh')
    }
  }

  let inSync = false
  let deployedFrontmatter: Record<string, unknown> | null = null
  let deployedFirstHeading: string | null = null
  if (deployedExists && sourceExists) {
    const deployedBody = readFileSync(deployedPath, 'utf8')
    const sourceBody = readFileSync(sourcePath, 'utf8')
    inSync = deployedBody === sourceBody
    deployedFrontmatter = parseFrontmatter(deployedBody)
    deployedFirstHeading = firstHeading(deployedBody)
    if (!inSync) {
      issues.push('Deployed SKILL.md differs from canonical source — symlink is stale or broken')
    }
  } else if (deployedExists) {
    const deployedBody = readFileSync(deployedPath, 'utf8')
    deployedFrontmatter = parseFrontmatter(deployedBody)
    deployedFirstHeading = firstHeading(deployedBody)
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

/** All canonical skill names (every directory under `packages/upg-mcp-server/skills`). */
function allSkillNames(): string[] {
  const dir = sourceSkillsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

/**
 * Audit one or every UPG skill for source-vs-deployed integrity.
 *
 * Use before recommending a skill to a user — confirms `.claude/skills/<name>/SKILL.md`
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
