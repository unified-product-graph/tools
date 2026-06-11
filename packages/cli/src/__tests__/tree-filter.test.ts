/**
 * `upg tree [filter]` regression tests.
 *
 * Field report §10.7: an unknown filter token used to no-op into the FULL tree,
 * mislabeled as "Tree - <filter>". A typo silently showed everything. These
 * tests pin the corrected contract:
 *   - a valid entity type with instances renders that forest (exit 0)
 *   - a valid entity type with NO instances reports cleanly, NOT the full tree
 *   - a valid domain id renders the domain's entities
 *   - an unknown token exits 3 (usage error) and renders nothing
 *   - no filter still renders the whole graph
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileNoThrow } from './helpers/exec.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function fixtureDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Tree Filter Test' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Power User', status: 'active' },
      { id: 'n_job', type: 'job', title: 'Organise tasks', status: 'active' },
      { id: 'n_need', type: 'need', title: 'Quick capture', status: 'active' },
      { id: 'n_feature', type: 'feature', title: 'Dark mode', status: 'proposed' },
    ],
    edges: [
      { id: 'e_pj', source: 'n_persona', target: 'n_job', type: 'persona_pursues_job' },
      { id: 'e_jn', source: 'n_job', target: 'n_need', type: 'job_generates_need' },
    ],
  }
}

describe('upg tree filter contract', () => {
  let tmp: string
  let file: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-tree-filter-'))
    file = path.join(tmp, 'product.upg')
    await fsp.writeFile(file, JSON.stringify(fixtureDoc(), null, 2))
  })

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  function run(args: string[]) {
    return execFileNoThrow(CLI, [...args, '--file', file], { cwd: tmp, stdinFromNull: true, timeoutMs: 60_000 })
  }

  it('a valid entity type with instances renders that forest (exit 0)', () => {
    const r = run(['tree', 'persona'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Power User/)
  })

  it('an unknown filter exits 3 and renders nothing (no silent full tree)', () => {
    const r = run(['tree', 'zzznotatype'])
    expect(r.status).toBe(3)
    expect((r.stderr + r.stdout).toLowerCase()).toContain('unknown tree filter')
    // The whole-graph forest must NOT have been rendered.
    expect(r.stdout).not.toMatch(/Power User/)
    expect(r.stdout).not.toMatch(/Dark mode/)
  })

  it('a valid type with no instances reports cleanly, not the full tree', () => {
    const r = run(['tree', 'epic'])
    expect(r.status).toBe(0)
    expect((r.stderr + r.stdout)).toMatch(/No "epic" entities/)
    // Crucially: it did NOT fall back to dumping every root.
    expect(r.stdout).not.toMatch(/Power User/)
    expect(r.stdout).not.toMatch(/Dark mode/)
  })

  it('a valid domain id renders the domain entities (exit 0)', () => {
    // persona + job both live in the "user" domain.
    const r = run(['tree', 'user'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Power User/)
  })

  it('no filter still renders the whole graph (exit 0)', () => {
    const r = run(['tree'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Power User/)
    expect(r.stdout).toMatch(/Dark mode/)
  })
})
