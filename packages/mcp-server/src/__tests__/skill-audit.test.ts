/**
 *: `skill_audit` reports source-vs-deployed status for UPG skills.
 *
 * Surfaces the exact failure mode caught in a 2026-05-23 QA E2E
 * audit: deployed `.claude/skills/<name>/SKILL.md` files diverging silently
 * from canonical source because a real directory was committed instead of
 * a symlink. Runners need an in-session signal that "what I'm about to
 * recommend is what the user will see."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'
import { skillAudit, type SkillAuditRecord } from '../tools/skills.js'
import type { UPGDocument } from '@unified-product-graph/core'

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Skill Audit Fixture', stage: 'concept' },
    nodes: [],
    edges: [],
  }
}

async function loadStore(): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-skill-audit-store-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function readSkills(
  result: { content: Array<{ type: string; text?: string }> } | Promise<unknown>,
): SkillAuditRecord[] {
  if (result instanceof Promise) throw new Error('expected a synchronous ToolResult')
  const block = result.content[0]
  if (block.type !== 'text') throw new Error('expected text block')
  const parsed = JSON.parse(block.text as string) as { skills: SkillAuditRecord[] }
  return parsed.skills
}

const HEALTHY_SKILL_BODY = `---
name: ro-healthy
description: "A healthy fixture skill"
user-invocable: true
---

# /ro-healthy: Healthy Fixture

A skill body.
`

const ADVANCED_SKILL_BODY = `---
name: ro-mutation
description: "A mutation-class fixture skill"
user-invocable: false
audience: advanced
category: schema
---

> ⚠️ **Advanced skill** (for UPG contributors only).

# /ro-mutation: Mutation Fixture

A skill body.
`

const STALE_DEPLOYED_BODY = `---
name: ro-mutation
description: "STALE copy from an earlier era"
user-invocable: true
---

# /ro-mutation: STALE Fixture

OLD body.
`

describe(': skill_audit reports source-vs-deployed status', () => {
  let fixtureRoot: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    fixtureRoot = mkdtempSync(join(tmpdir(), 'upg-skill-audit-fixture-'))
    mkdirSync(join(fixtureRoot, 'packages/upg-mcp-server/skills'), { recursive: true })
    mkdirSync(join(fixtureRoot, '.claude/skills'), { recursive: true })

    // Canonical sources
    mkdirSync(join(fixtureRoot, 'packages/upg-mcp-server/skills/ro-healthy'))
    writeFileSync(join(fixtureRoot, 'packages/upg-mcp-server/skills/ro-healthy/SKILL.md'), HEALTHY_SKILL_BODY)

    mkdirSync(join(fixtureRoot, 'packages/upg-mcp-server/skills/ro-mutation'))
    writeFileSync(join(fixtureRoot, 'packages/upg-mcp-server/skills/ro-mutation/SKILL.md'), ADVANCED_SKILL_BODY)

    // Deployed: ro-healthy is a correct symlink; ro-mutation is a stale real directory
    symlinkSync(
      join(fixtureRoot, 'packages/upg-mcp-server/skills/ro-healthy'),
      join(fixtureRoot, '.claude/skills/ro-healthy'),
    )
    mkdirSync(join(fixtureRoot, '.claude/skills/ro-mutation'))
    writeFileSync(join(fixtureRoot, '.claude/skills/ro-mutation/SKILL.md'), STALE_DEPLOYED_BODY)

    process.chdir(fixtureRoot)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('reports healthy symlinked skill as in_sync with no issues', async () => {
    const ctx = makeCtx(await loadStore())
    const result = skillAudit({ name: 'ro-healthy' }, ctx)
    const skills = readSkills(result)
    expect(skills).toHaveLength(1)
    const s = skills[0]
    expect(s.name).toBe('ro-healthy')
    expect(s.is_symlink).toBe(true)
    expect(s.in_sync).toBe(true)
    expect(s.deployed_frontmatter).toMatchObject({ name: 'ro-healthy', 'user-invocable': true })
    expect(s.deployed_first_heading).toBe('# /ro-healthy: Healthy Fixture')
    expect(s.issues).toEqual([])
  })

  it('flags stale real-directory deployment with multiple issues', async () => {
    const ctx = makeCtx(await loadStore())
    const result = skillAudit({ name: 'ro-mutation' }, ctx)
    const skills = readSkills(result)
    const s = skills[0]
    expect(s.is_symlink).toBe(false)
    expect(s.in_sync).toBe(false)
    expect(s.issues).toContain(
      'Deployed entry is a real directory, not a symlink; stale copy will not pick up source updates; run ./scripts/link-skills.sh',
    )
    expect(s.issues).toContain(
      'Deployed SKILL.md differs from canonical source; symlink is stale or broken',
    )
    // The deployed frontmatter reflects the STALE file, not the canonical one; that's the whole point
    expect(s.deployed_frontmatter).toMatchObject({ 'user-invocable': true })
  })

  it('audits all skills when name is omitted', async () => {
    const ctx = makeCtx(await loadStore())
    const result = skillAudit({}, ctx)
    const skills = readSkills(result)
    expect(skills.map((s) => s.name).sort()).toEqual(['ro-healthy', 'ro-mutation'])
  })
})
