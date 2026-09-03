import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  runInstallSkills,
  resolveSkillsSource,
  listSkillsInSource,
  __setSymlinkImpl,
} from '../commands/install-skills.js'

// Canonical source: resolve the MCP server package's skills dir via node_modules.
// This works both in the monorepo (workspace:* symlink) and in standalone repos
// (published tarball). Falls back to a monorepo-relative path for safety.
function resolveRepoSkills(): string {
  try {
    // In workspace: resolves via the symlink in node_modules
    const pkgMain = require.resolve('@unified-product-graph/mcp-server/lib')
    // pkgMain → node_modules/@unified-product-graph/mcp-server/dist/lib-index.js
    // skills  → node_modules/@unified-product-graph/mcp-server/skills/
    const pkgDist = path.dirname(pkgMain)
    const pkgRoot = path.dirname(pkgDist)
    return path.join(pkgRoot, 'skills')
  } catch {
    // Fallback: monorepo relative path (dev without node_modules installed)
    return path.resolve(__dirname, '../../../upg-mcp-server/skills')
  }
}
const REPO_SKILLS = resolveRepoSkills()

async function mkTmp(prefix = 'upg-cli-test-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* noop */ })
}

function makeFakeSource(root: string, skills: string[]): string {
  const src = path.join(root, 'skills')
  fs.mkdirSync(src, { recursive: true })
  for (const s of skills) {
    const dir = path.join(src, s)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${s}\n`, 'utf-8')
    // Add a sub-asset to ensure copy-fallback handles nested files.
    fs.writeFileSync(path.join(dir, 'notes.md'), 'notes\n', 'utf-8')
  }
  return src
}

describe('install-skills: source resolution', () => {
  it('finds a valid skills dir by walking up from this test file', () => {
    const src = resolveSkillsSource(__filename)
    expect(src).not.toBeNull()
    // Accepts either the CLI's own bundled skills dir or the MCP server's monorepo
    // source dir; both contain the same canonical skill set.
    const isCliSkills = src!.includes(path.join('packages', 'upg-cli', 'skills'))
    const isMcpSkills = src!.includes(path.join('packages', 'upg-mcp-server', 'skills'))
    expect(isCliSkills || isMcpSkills).toBe(true)
  })

  it('listSkillsInSource returns the canonical skill set (non-empty, sorted)', () => {
    const src = REPO_SKILLS
    const skills = listSkillsInSource(src)
    expect(skills.length).toBeGreaterThan(0)
    // sorted
    const sorted = [...skills].sort()
    expect(skills).toEqual(sorted)
    // sanity-check a known skill
    expect(skills).toContain('upg')
  })
})

describe('install-skills: --list', () => {
  let dest: string
  beforeEach(async () => { dest = await mkTmp() })
  afterEach(async () => { await cleanup(dest) })

  it('prints names and returns the full skill list without writing anything', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
    const result = await runInstallSkills({
      scope: 'project',
      mode: 'auto',
      force: false,
      list: true,
      remove: false,
      sourceOverride: REPO_SKILLS,
      destOverride: dest,
    })
    logSpy.mockRestore()

    expect(result.action).toBe('list')
    expect(result.installed.length).toBeGreaterThan(0)
    expect(result.installed).toEqual(listSkillsInSource(REPO_SKILLS))
    // No manifest should have been written.
    await expect(fsp.stat(path.join(dest, '.upg-manifest.json'))).rejects.toBeDefined()
  })
})

describe('install-skills: install into a temp dir', () => {
  let dest: string
  let fakeRoot: string
  let fakeSrc: string
  const skills = ['upg-a', 'upg-b', 'upg-c']

  beforeEach(async () => {
    dest = await mkTmp()
    fakeRoot = await mkTmp()
    fakeSrc = makeFakeSource(fakeRoot, skills)
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(dest)
    await cleanup(fakeRoot)
  })

  it('creates the destination, installs each skill, and writes a manifest', async () => {
    const result = await runInstallSkills({
      scope: 'project',
      mode: 'auto',
      force: false,
      list: false,
      remove: false,
      sourceOverride: fakeSrc,
      destOverride: dest,
    })

    expect(result.action).toBe('install')
    expect(result.installed.sort()).toEqual(skills.sort())
    for (const s of skills) {
      expect(fs.existsSync(path.join(dest, s, 'SKILL.md'))).toBe(true)
    }
    const manifest = JSON.parse(await fsp.readFile(path.join(dest, '.upg-manifest.json'), 'utf-8'))
    expect(manifest.skills.sort()).toEqual(skills.sort())
    expect(manifest.scope).toBe('project')
    expect(['symlink', 'copy']).toContain(manifest.mode)
  })

  it('is idempotent: second run produces same state (all updated)', async () => {
    await runInstallSkills({
      scope: 'project', mode: 'auto', force: false, list: false, remove: false,
      sourceOverride: fakeSrc, destOverride: dest,
    })
    const second = await runInstallSkills({
      scope: 'project', mode: 'auto', force: false, list: false, remove: false,
      sourceOverride: fakeSrc, destOverride: dest,
    })
    expect(second.installed).toEqual([])
    expect(second.updated.sort()).toEqual(skills.sort())
    for (const s of skills) {
      expect(fs.existsSync(path.join(dest, s, 'SKILL.md'))).toBe(true)
    }
  })
})

describe('install-skills: --remove', () => {
  let dest: string
  let fakeRoot: string
  let fakeSrc: string
  const skills = ['upg-alpha', 'upg-beta']

  beforeEach(async () => {
    dest = await mkTmp()
    fakeRoot = await mkTmp()
    fakeSrc = makeFakeSource(fakeRoot, skills)
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(dest)
    await cleanup(fakeRoot)
  })

  it('removes manifest-listed skills only; user skills survive', async () => {
    await runInstallSkills({
      scope: 'project', mode: 'auto', force: false, list: false, remove: false,
      sourceOverride: fakeSrc, destOverride: dest,
    })
    // Create a user-owned skill that was never installed by UPG.
    const userSkill = path.join(dest, 'user-skill')
    fs.mkdirSync(userSkill, { recursive: true })
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n', 'utf-8')

    const result = await runInstallSkills({
      scope: 'project', mode: 'auto', force: false, list: false, remove: true,
      sourceOverride: fakeSrc, destOverride: dest,
    })

    expect(result.action).toBe('remove')
    expect(result.removed.sort()).toEqual(skills.sort())
    // Manifest-listed skills gone.
    for (const s of skills) {
      expect(fs.existsSync(path.join(dest, s))).toBe(false)
    }
    // User skill intact.
    expect(fs.existsSync(userSkill)).toBe(true)
    expect(fs.existsSync(path.join(userSkill, 'SKILL.md'))).toBe(true)
    // Manifest file removed.
    expect(fs.existsSync(path.join(dest, '.upg-manifest.json'))).toBe(false)
  })

  it('errors clearly when there is no manifest', async () => {
    await expect(
      runInstallSkills({
        scope: 'project', mode: 'auto', force: false, list: false, remove: true,
        sourceOverride: fakeSrc, destOverride: dest,
      }),
    ).rejects.toThrow(/No UPG manifest found/)
  })
})

describe('install-skills: symlink fallback', () => {
  let dest: string
  let fakeRoot: string
  let fakeSrc: string
  const skills = ['upg-x']

  beforeEach(async () => {
    dest = await mkTmp()
    fakeRoot = await mkTmp()
    fakeSrc = makeFakeSource(fakeRoot, skills)
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(dest)
    await cleanup(fakeRoot)
  })

  it('falls back to copy when symlink throws (default mode=auto)', async () => {
    __setSymlinkImpl(async () => {
      const err: NodeJS.ErrnoException = new Error('simulated EPERM')
      err.code = 'EPERM'
      throw err
    })
    try {
      const result = await runInstallSkills({
        scope: 'project', mode: 'auto', force: false, list: false, remove: false,
        sourceOverride: fakeSrc, destOverride: dest,
      })

      expect(result.modes).toContain('copy')
      expect(result.modes).not.toContain('symlink')
      for (const s of skills) {
        const p = path.join(dest, s, 'SKILL.md')
        expect(fs.existsSync(p)).toBe(true)
        const stat = fs.lstatSync(path.join(dest, s))
        expect(stat.isSymbolicLink()).toBe(false)
        expect(stat.isDirectory()).toBe(true)
      }
    } finally {
      __setSymlinkImpl(null)
    }
  })

  it('--mode symlink is strict and propagates the failure', async () => {
    __setSymlinkImpl(async () => {
      const err: NodeJS.ErrnoException = new Error('simulated EPERM')
      err.code = 'EPERM'
      throw err
    })
    try {
      await expect(
        runInstallSkills({
          scope: 'project', mode: 'symlink', force: false, list: false, remove: false,
          sourceOverride: fakeSrc, destOverride: dest,
        }),
      ).rejects.toThrow(/symlink failed/)
    } finally {
      __setSymlinkImpl(null)
    }
  })
})

describe('install-skills: conflict handling', () => {
  let dest: string
  let fakeRoot: string
  let fakeSrc: string
  const skills = ['upg-conflict']

  beforeEach(async () => {
    dest = await mkTmp()
    fakeRoot = await mkTmp()
    fakeSrc = makeFakeSource(fakeRoot, skills)
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(dest)
    await cleanup(fakeRoot)
  })

  it('skips unmanaged pre-existing skills when answer is "no"', async () => {
    // User already has this skill by the same name.
    const existing = path.join(dest, 'upg-conflict')
    fs.mkdirSync(existing, { recursive: true })
    fs.writeFileSync(path.join(existing, 'SKILL.md'), '# user-owned\n', 'utf-8')

    const result = await runInstallSkills({
      scope: 'project', mode: 'auto', force: false, list: false, remove: false,
      sourceOverride: fakeSrc, destOverride: dest,
      autoAnswer: 'no',
    })
    expect(result.skipped).toEqual(['upg-conflict'])
    expect(result.installed).toEqual([])
    // User file still there.
    const content = fs.readFileSync(path.join(existing, 'SKILL.md'), 'utf-8')
    expect(content).toContain('user-owned')
  })

  it('--force overwrites unmanaged pre-existing skills', async () => {
    const existing = path.join(dest, 'upg-conflict')
    fs.mkdirSync(existing, { recursive: true })
    fs.writeFileSync(path.join(existing, 'SKILL.md'), '# user-owned\n', 'utf-8')

    const result = await runInstallSkills({
      scope: 'project', mode: 'auto', force: true, list: false, remove: false,
      sourceOverride: fakeSrc, destOverride: dest,
    })
    expect(result.installed).toEqual(['upg-conflict'])
    const content = fs.readFileSync(path.join(existing, 'SKILL.md'), 'utf-8')
    expect(content).toContain('upg-conflict')
    expect(content).not.toContain('user-owned')
  })
})

describe('install-skills: --target cursor (0.38.0, F6)', () => {
  let tmp: string
  let prevCwd: string
  beforeEach(async () => {
    tmp = await mkTmp()
    prevCwd = process.cwd()
    process.chdir(tmp)
  })
  afterEach(async () => {
    process.chdir(prevCwd)
    await cleanup(tmp)
  })

  it('resolves the project destination to .cursor/skills (same layout, different root)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
    const result = await runInstallSkills({
      scope: 'project',
      target: 'cursor',
      mode: 'copy',
      force: true,
      list: false,
      remove: false,
      sourceOverride: REPO_SKILLS,
    })
    logSpy.mockRestore()
    expect(result.dest).toBe(path.join(fs.realpathSync(tmp), '.cursor', 'skills'))
    // The layout Cursor reads: .cursor/skills/<name>/SKILL.md
    expect(fs.existsSync(path.join(result.dest, 'upg', 'SKILL.md'))).toBe(true)
  })

  it('default target stays .claude/skills, unchanged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
    const result = await runInstallSkills({
      scope: 'project',
      mode: 'copy',
      force: true,
      list: false,
      remove: false,
      sourceOverride: REPO_SKILLS,
    })
    logSpy.mockRestore()
    expect(result.dest).toBe(path.join(fs.realpathSync(tmp), '.claude', 'skills'))
  })
})
