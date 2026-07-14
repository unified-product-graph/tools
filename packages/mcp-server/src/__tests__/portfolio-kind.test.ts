/**
 * Watched/owned portfolio classification (spec issue #39, UPG 0.9.27).
 *
 * The `kind` field on a portfolio drives whether product-management
 * expectations apply. This test pins the classification logic that
 * `validate_graph` and `portfolio_digest` read to decide whether a graph is a
 * watched intelligence graph (anti-patterns advisory) or an owned product.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildProductKindMap, classifyProductKind } from '../lib/portfolio-kind.js'

const tmpdirs: string[] = []
function makeWorkspace(portfolios: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-kind-'))
  tmpdirs.push(dir)
  fs.mkdirSync(path.join(dir, '.upg'))
  fs.writeFileSync(path.join(dir, '.upg', 'portfolio.upg'), JSON.stringify({ type: 'portfolio', portfolios }))
  return dir
}
afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true })
})

describe('portfolio-kind classification (#39)', () => {
  it('marks a product in only a watched portfolio as watched', () => {
    const cwd = makeWorkspace([
      { id: 'pf_owned', title: 'Owned', kind: 'owned', products: ['p_app'] },
      { id: 'pf_watch', title: 'Competitive Landscape', kind: 'watched', products: ['p_larch'] },
    ])
    const map = buildProductKindMap(cwd)
    expect(map.get('p_larch')).toBe('watched')
    expect(map.get('p_app')).toBe('owned')
    expect(classifyProductKind(cwd, 'p_larch')).toBe('watched')
  })

  it('keeps a product owned when co-listed under an owned portfolio', () => {
    const cwd = makeWorkspace([
      { id: 'pf_owned', kind: 'owned', products: ['p_dual'] },
      { id: 'pf_watch', kind: 'watched', products: ['p_dual'] },
    ])
    expect(buildProductKindMap(cwd).get('p_dual')).toBe('owned')
    expect(classifyProductKind(cwd, 'p_dual')).toBe('owned')
  })

  it('treats portfolios with no kind as owned (back-compat)', () => {
    const cwd = makeWorkspace([{ id: 'pf', products: ['p_legacy'] }])
    expect(classifyProductKind(cwd, 'p_legacy')).toBe('owned')
  })

  it('defaults to owned for unaffiliated / null / missing-doc', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-empty-'))
    tmpdirs.push(empty)
    expect(classifyProductKind(empty, 'p_x')).toBe('owned') // no portfolio.upg
    const cwd = makeWorkspace([{ id: 'pf', kind: 'watched', products: ['p_x'] }])
    expect(classifyProductKind(cwd, 'p_unaffiliated')).toBe('owned')
    expect(classifyProductKind(cwd, null)).toBe('owned')
  })
})
