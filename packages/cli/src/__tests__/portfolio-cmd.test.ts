/**
 * Portfolio command group tests.
 *
 * Drives the built binary against throwaway fixtures: a workspace with
 * portfolio.upg + two product .upg files. Covers:
 *   - `portfolio list` returns empty list when no portfolio exists
 *   - `portfolio list --json` with a real portfolio document
 *   - `portfolio check` (validate all workspace products, json output)
 *   - `portfolio edges --json` (list cross-product edges, empty baseline)
 *   - `portfolio health --json` (multi-product digest)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from './helpers/exec.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'dist', 'cli.cjs')

function run(args: string[], cwd: string) {
  return execFileNoThrow(CLI, args, { cwd, stdinFromNull: true, timeoutMs: 60_000 })
}

/** A minimal product document. */
function productDoc(id: string, title: string) {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    product: { id, title },
    nodes: [
      { id: `${id}_persona`, type: 'persona', title: 'A User' },
      { id: `${id}_feature`, type: 'feature', title: 'A Feature' },
    ],
    edges: [],
  }
}

/** A minimal portfolio document with one portfolio entry. */
function portfolioDoc(portfolioId: string, portfolioTitle: string) {
  return {
    upg_version: '0.9.0',
    exported_at: new Date().toISOString(),
    source: { tool: 'test', tool_version: '0' },
    type: 'portfolio',
    organization: { id: 'org_abc12345', title: 'Test Org' },
    portfolios: [{ id: portfolioId, title: portfolioTitle }],
    product_areas: [],
    products: [],
    cross_edges: [],
  }
}

describe('portfolio list', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-list-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('returns empty portfolios list when no portfolio.upg exists', () => {
    const r = run(['portfolio', 'list', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.portfolios).toEqual([])
    expect(out.total).toBe(0)
  })

  it('lists portfolios from portfolio.upg when present', async () => {
    const pfPath = path.join(tmp, '.upg', 'portfolio.upg')
    await fsp.writeFile(pfPath, JSON.stringify(portfolioDoc('pf_main', 'Main Portfolio'), null, 2))
    const r = run(['portfolio', 'list', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.total).toBe(1)
    expect(out.portfolios[0].id).toBe('pf_main')
    expect(out.portfolios[0].title).toBe('Main Portfolio')
  })

  it('human output mentions portfolio title', async () => {
    const pfPath = path.join(tmp, '.upg', 'portfolio.upg')
    await fsp.writeFile(pfPath, JSON.stringify(portfolioDoc('pf_main', 'My Portfolio'), null, 2))
    const r = run(['portfolio', 'list'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/My Portfolio/)
  })
})

describe('portfolio check', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-check-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(
      path.join(upgDir, 'alpha.upg'),
      JSON.stringify(productDoc('p_alpha', 'Alpha'), null, 2),
    )
    await fsp.writeFile(
      path.join(upgDir, 'beta.upg'),
      JSON.stringify(productDoc('p_beta', 'Beta'), null, 2),
    )
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('reports two products and all_valid in json output', () => {
    const r = run(['portfolio', 'check', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.rollup.products).toBe(2)
    expect(typeof out.rollup.all_valid).toBe('boolean')
    expect(Array.isArray(out.products)).toBe(true)
  })

  it('human output shows product titles', () => {
    const r = run(['portfolio', 'check'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Alpha|Beta/)
  })

  it('returns empty when no products match scope', () => {
    const r = run(['portfolio', 'check', '--scope', 'nonexistent', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.rollup.products).toBe(0)
  })
})

describe('portfolio edges', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-edges-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(
      path.join(upgDir, 'portfolio.upg'),
      JSON.stringify(portfolioDoc('pf_main', 'Main'), null, 2),
    )
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('returns empty cross_edges list when no edges exist', () => {
    const r = run(['portfolio', 'edges', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.cross_edges).toEqual([])
    expect(out.total).toBe(0)
  })
})

describe('portfolio health', () => {
  let tmp: string

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`Build the CLI first: ${CLI} missing`)
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-health-'))
    const upgDir = path.join(tmp, '.upg')
    await fsp.mkdir(upgDir, { recursive: true })
    await fsp.writeFile(
      path.join(upgDir, 'alpha.upg'),
      JSON.stringify(productDoc('p_alpha', 'Alpha Product'), null, 2),
    )
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('returns product summaries in json output', () => {
    const r = run(['portfolio', 'health', '--json'], tmp)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.rollup.products).toBe(1)
    expect(out.products[0].title).toBe('Alpha Product')
    expect(typeof out.products[0].total_nodes).toBe('number')
    expect(typeof out.products[0].total_edges).toBe('number')
  })

  it('human output mentions product title', () => {
    const r = run(['portfolio', 'health'], tmp)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Alpha Product/)
  })

  it('note present when workspace is empty', async () => {
    // fresh empty workspace
    const emptyTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upg-pf-empty-'))
    try {
      const upgDir = path.join(emptyTmp, '.upg')
      await fsp.mkdir(upgDir, { recursive: true })
      const r = run(['portfolio', 'health', '--json'], emptyTmp)
      expect(r.status).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.rollup.products).toBe(0)
      expect(typeof out.note).toBe('string')
    } finally {
      await fsp.rm(emptyTmp, { recursive: true, force: true }).catch(() => {})
    }
  })
})
