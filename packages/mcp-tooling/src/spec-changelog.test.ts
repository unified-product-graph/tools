import { describe, it, expect } from 'vitest'
import { readSpecChangelog, compareSemver } from './spec-changelog'

/**
 * Regression guard for the 0.19.0 dead-changelog defect.
 *
 * `readSpecChangelog` resolves `@unified-product-graph/core/package.json` to
 * locate CHANGELOG.md beside it. If core's `exports` map does not expose
 * `./package.json`, `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED, the
 * reader's never-throw catch swallows it, and `get_spec_version(changelog:true)`
 * silently returns []. The original gate only asserted `Array.isArray(...)`,
 * which passes on [] — so these tests assert the list is actually POPULATED.
 */
describe('readSpecChangelog', () => {
  it('resolves and parses core CHANGELOG.md into a non-empty, well-formed list', () => {
    const entries = readSpecChangelog()
    expect(entries.length).toBeGreaterThan(0)

    const top = entries[0]
    expect(top.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(top.date).toBeTruthy()
    expect(top.body.length).toBeGreaterThan(0)
  })

  it('filters to entries strictly newer than `since`', () => {
    const all = readSpecChangelog()
    const newer = readSpecChangelog('0.11.5')
    expect(newer.length).toBeGreaterThan(0)
    expect(newer.length).toBeLessThan(all.length)
    expect(newer.every((e) => compareSemver(e.version, '0.11.5') > 0)).toBe(true)
  })

  it('returns [] for a `since` newer than everything — a real empty, not a failure', () => {
    expect(readSpecChangelog('999.0.0')).toEqual([])
  })
})

describe('compareSemver', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareSemver('0.19.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareSemver('0.11.5', '0.11.5')).toBe(0)
    expect(compareSemver('0.18.0', '0.19.0')).toBeLessThan(0)
  })
})
