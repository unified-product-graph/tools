/**
 * — `upg verify` content-depth gate.
 *
 * Drives the BUILT binary against throwaway `.upg` graphs and pins:
 *   - a property TYPE mismatch  (need.frequency = number) -> violation, exit 2
 *   - a property ENUM violation (need.valence = "banana")  -> violation, exit 2
 *   - a self-loop edge           (source === target)         -> violation, exit 2
 *   - a clean graph                                          -> exit 0
 *   - the drifted graph STILL LOADS for reads (warnings, not load errors), so
 *     `verify` reaches the violation logic instead of dying on an Invalid doc.
 *   - `--no-content-depth` opts out of all three checks.
 *
 * The exit-2 contract matches the published table (validation/policy = 2).
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

function cleanDoc() {
  return {
    upg_version: '0.8.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id: 'p_test', title: 'Verify Depth Test', stage: 'concept' },
    nodes: [
      { id: 'n_persona', type: 'persona', title: 'Busy Parent' },
      {
        id: 'n_need',
        type: 'need',
        title: 'A real need',
        properties: { valence: 'pain', frequency: { value: 4, label: 'often' } },
      },
    ] as Array<Record<string, unknown>>,
    edges: [
      { id: 'e1', source: 'n_persona', target: 'n_need', type: 'relates_to' },
    ] as Array<Record<string, unknown>>,
  }
}

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

describe('upg verify — content-depth checks', () => {
  let tmp: string
  let file: string
  const args = (a: string[]) => [...a, '--file', file]

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-verify-depth-'))
    file = path.join(tmp, 'product.upg')
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ })
  })

  async function write(doc: unknown) {
    await fsp.writeFile(file, JSON.stringify(doc, null, 2))
  }

  it('passes (exit 0) on a clean graph', async () => {
    await write(cleanDoc())
    const r = run(args(['verify']), tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('All checks passed')
  })

  it('flags a property TYPE mismatch and exits 2', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { frequency: 99 }
    await write(doc)
    const r = run(args(['verify']), tmp)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('property-type')
    expect(r.stdout).toContain('frequency')
  })

  it('flags a property ENUM violation and exits 2', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { valence: 'banana' }
    await write(doc)
    const r = run(args(['verify']), tmp)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('property-enum')
    expect(r.stdout).toContain('banana')
  })

  it('flags a self-loop edge and exits 2', async () => {
    const doc = cleanDoc()
    doc.edges.push({ id: 'e_self', source: 'n_persona', target: 'n_persona', type: 'relates_to' })
    await write(doc)
    const r = run(args(['verify']), tmp)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('self-loop')
  })

  it('reproduces the canonical F5 bug: both findings, exit 2', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { frequency: 99, valence: 'banana' }
    await write(doc)
    const r = run(args(['verify']), tmp)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('property-type')
    expect(r.stdout).toContain('property-enum')
  })

  it('still LOADS the drifted graph for reads (warnings do not brick the file)', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { frequency: 99, valence: 'banana' }
    doc.edges.push({ id: 'e_self', source: 'n_persona', target: 'n_persona', type: 'relates_to' })
    await write(doc)
    // `list` must succeed — proves property/enum/self-loop are warnings, not
    // load-blocking errors. (This is the "do not brick real graphs" contract.)
    const r = run(args(['list']), tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('A real need')
  })

  it('--no-content-depth opts out of the three checks', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { frequency: 99, valence: 'banana' }
    doc.edges.push({ id: 'e_self', source: 'n_persona', target: 'n_persona', type: 'relates_to' })
    await write(doc)
    const r = run(args(['verify', '--no-content-depth']), tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('All checks passed')
  })

  it('reports content-depth violations in --json output', async () => {
    const doc = cleanDoc()
    ;(doc.nodes[1] as Record<string, unknown>).properties = { valence: 'banana' }
    await write(doc)
    const r = run(args(['verify', '--json']), tmp)
    expect(r.status).toBe(2)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.passed).toBe(false)
    expect(parsed.violations.some((v: { rule: string }) => v.rule === 'property-enum')).toBe(true)
  })
})
