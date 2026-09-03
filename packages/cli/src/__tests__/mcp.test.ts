import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { runMcpSetup, runMcpStatus, detectMcpCommand } from '../commands/mcp.js'

async function mkTmp(prefix = 'upg-mcp-test-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function cleanup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* noop */ })
}

// ── detectMcpCommand ──────────────────────────────────────────────────────────

describe('detectMcpCommand', () => {
  it('returns npx fallback when no override and no monorepo path', () => {
    // We're likely in the monorepo, but we'll just verify the override path works.
    const result = detectMcpCommand('node /tmp/index.js')
    expect(result).toEqual({ command: 'node', args: ['/tmp/index.js'] })
  })

  it('handles a single-token override (command only, no args)', () => {
    const result = detectMcpCommand('my-mcp-server')
    expect(result).toEqual({ command: 'my-mcp-server', args: [] })
  })

  it('splits multi-token override correctly', () => {
    const result = detectMcpCommand('npx -y @unified-product-graph/mcp-server')
    expect(result).toEqual({
      command: 'npx',
      args: ['-y', '@unified-product-graph/mcp-server'],
    })
  })

  it('returns the mcp-server package by default; monorepo runs the server dist directly', () => {
    // The server is its own package (@unified-product-graph/mcp-server). Default
    // launch is the package via npx -y; in the monorepo, the server's own built
    // entry — never `upg mcp run` with `mcp`/`run` positionals (which crashed it).
    const monoServer = path.join(process.cwd(), 'packages', 'upg-mcp-server', 'dist', 'index.js')
    const exists = fs.existsSync(monoServer)
    const result = detectMcpCommand()
    if (exists) {
      expect(result.command).toBe('node')
      expect(result.args).toEqual(['./packages/upg-mcp-server/dist/index.js'])
    } else {
      expect(result).toEqual({ command: 'npx', args: ['-y', '@unified-product-graph/mcp-server@latest'] })
    }
  })
})

// ── runMcpSetup ──────────────────────────────────────────────────────────────

describe('mcp setup: write correct JSON', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkTmp()
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(tmp)
  })

  it('creates settings.json with the mcp entry when file does not exist', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    const result = await runMcpSetup({
      scope: 'project',
      force: false,
      commandOverride: 'npx @unified-product-graph/mcp-server',
      settingsPathOverride: settingsPath,
    })

    expect(result.skipped).toBe(false)
    expect(result.overwrote).toBe(false)
    expect(result.settingsPath).toBe(settingsPath)

    const raw = await fsp.readFile(settingsPath, 'utf-8')
    const json = JSON.parse(raw)
    expect(json.mcpServers['unified-product-graph']).toEqual({
      command: 'npx',
      args: ['@unified-product-graph/mcp-server'],
    })
  })

  it('uses node command for monorepo-style override', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    const result = await runMcpSetup({
      scope: 'project',
      force: false,
      commandOverride: 'node ./packages/upg-mcp-server/dist/index.js',
      settingsPathOverride: settingsPath,
    })

    expect(result.entry.command).toBe('node')
    expect(result.entry.args).toEqual(['./packages/upg-mcp-server/dist/index.js'])
  })

  it('preserves existing top-level keys when merging', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
    await fsp.writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash'] }, mcpServers: {} }, null, 2),
      'utf-8',
    )

    await runMcpSetup({
      scope: 'project',
      force: true,
      commandOverride: 'npx @unified-product-graph/mcp-server',
      settingsPathOverride: settingsPath,
    })

    const raw = await fsp.readFile(settingsPath, 'utf-8')
    const json = JSON.parse(raw)
    // Pre-existing key preserved.
    expect(json.permissions).toEqual({ allow: ['Bash'] })
    // New entry present.
    expect(json.mcpServers['unified-product-graph']).toBeDefined()
  })

  it('preserves other mcpServers entries when merging', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
    const existing = {
      mcpServers: {
        'some-other-server': { command: 'other', args: [] },
      },
    }
    await fsp.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf-8')

    await runMcpSetup({
      scope: 'project',
      force: false,
      commandOverride: 'npx @unified-product-graph/mcp-server',
      settingsPathOverride: settingsPath,
    })

    const raw = await fsp.readFile(settingsPath, 'utf-8')
    const json = JSON.parse(raw)
    expect(json.mcpServers['some-other-server']).toEqual({ command: 'other', args: [] })
    expect(json.mcpServers['unified-product-graph']).toBeDefined()
  })
})

describe('mcp setup: --force and existing entry', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkTmp()
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(tmp)
  })

  it('--force overwrites existing entry without prompting', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
    await fsp.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          'unified-product-graph': { command: 'old-command', args: ['old-arg'] },
        },
      }, null, 2),
      'utf-8',
    )

    const result = await runMcpSetup({
      scope: 'project',
      force: true,
      commandOverride: 'npx @unified-product-graph/mcp-server',
      settingsPathOverride: settingsPath,
    })

    expect(result.skipped).toBe(false)
    expect(result.overwrote).toBe(true)

    const raw = await fsp.readFile(settingsPath, 'utf-8')
    const json = JSON.parse(raw)
    expect(json.mcpServers['unified-product-graph'].command).toBe('npx')
  })

  it('non-TTY skips overwrite when entry exists and --force not set (defaults to no)', async () => {
    const settingsPath = path.join(tmp, '.claude', 'settings.json')
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
    await fsp.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          'unified-product-graph': { command: 'old', args: [] },
        },
      }, null, 2),
      'utf-8',
    )

    // process.stdin.isTTY is false in test runner; promptConfirm returns false.
    const result = await runMcpSetup({
      scope: 'project',
      force: false,
      commandOverride: 'npx @unified-product-graph/mcp-server',
      settingsPathOverride: settingsPath,
    })

    expect(result.skipped).toBe(true)

    // File should be unchanged; old command still there.
    const raw = await fsp.readFile(settingsPath, 'utf-8')
    const json = JSON.parse(raw)
    expect(json.mcpServers['unified-product-graph'].command).toBe('old')
  })
})

// ── runMcpStatus ─────────────────────────────────────────────────────────────

describe('mcp status: configured vs not-configured', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkTmp()
    vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup(tmp)
  })

  it('reports not-configured when both settings files are absent', async () => {
    const projectPath = path.join(tmp, 'project', '.claude', 'settings.json')
    const userPath = path.join(tmp, 'user', '.claude', 'settings.json')
    const result = await runMcpStatus({
      projectPathOverride: projectPath,
      userPathOverride: userPath,
    })
    expect(result.project.configured).toBe(false)
    expect(result.user.configured).toBe(false)
    expect(result.project.settingsPath).toBe(projectPath)
    expect(result.user.settingsPath).toBe(userPath)
  })

  it('reports configured for project scope when entry exists', async () => {
    const projectPath = path.join(tmp, 'project', '.claude', 'settings.json')
    const userPath = path.join(tmp, 'user', '.claude', 'settings.json')

    await fsp.mkdir(path.dirname(projectPath), { recursive: true })
    await fsp.writeFile(
      projectPath,
      JSON.stringify({
        mcpServers: {
          'unified-product-graph': { command: 'npx', args: ['@unified-product-graph/mcp-server'] },
        },
      }, null, 2),
      'utf-8',
    )

    const result = await runMcpStatus({
      projectPathOverride: projectPath,
      userPathOverride: userPath,
    })
    expect(result.project.configured).toBe(true)
    expect(result.project.entry).toEqual({
      command: 'npx',
      args: ['@unified-product-graph/mcp-server'],
    })
    // User scope not configured.
    expect(result.user.configured).toBe(false)
  })

  it('reports configured for user scope when entry exists', async () => {
    const projectPath = path.join(tmp, 'project', '.claude', 'settings.json')
    const userPath = path.join(tmp, 'user', '.claude', 'settings.json')

    await fsp.mkdir(path.dirname(userPath), { recursive: true })
    await fsp.writeFile(
      userPath,
      JSON.stringify({
        mcpServers: {
          'unified-product-graph': { command: 'node', args: ['./dist/index.js'] },
        },
      }, null, 2),
      'utf-8',
    )

    const result = await runMcpStatus({
      projectPathOverride: projectPath,
      userPathOverride: userPath,
    })
    expect(result.user.configured).toBe(true)
    expect(result.user.entry?.command).toBe('node')
    expect(result.project.configured).toBe(false)
  })

  it('reports both scopes configured when both files have the entry', async () => {
    const projectPath = path.join(tmp, 'project', '.claude', 'settings.json')
    const userPath = path.join(tmp, 'user', '.claude', 'settings.json')

    const entry = { mcpServers: { 'unified-product-graph': { command: 'npx', args: ['@unified-product-graph/mcp-server'] } } }
    for (const p of [projectPath, userPath]) {
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, JSON.stringify(entry, null, 2), 'utf-8')
    }

    const result = await runMcpStatus({
      projectPathOverride: projectPath,
      userPathOverride: userPath,
    })
    expect(result.project.configured).toBe(true)
    expect(result.user.configured).toBe(true)
  })
})

describe('mcp setup: --target cursor (0.38.0, F6)', () => {
  it('writes .cursor/mcp.json in the cwd for project scope', async () => {
    const os = await import('node:os')
    const fsp = await import('node:fs/promises')
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-mcp-cursor-'))
    const prevCwd = process.cwd()
    process.chdir(tmp)
    try {
      const result = await runMcpSetup({ scope: 'project', target: 'cursor', force: true })
      expect(result.settingsPath).toBe(path.join(await fsp.realpath(tmp), '.cursor', 'mcp.json'))
      const written = JSON.parse(await fsp.readFile(result.settingsPath, 'utf-8'))
      expect(written.mcpServers['unified-product-graph']).toBeTruthy()
    } finally {
      process.chdir(prevCwd)
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
})
