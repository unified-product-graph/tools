/**
 * Shared spec-changelog reader (0.19.0 consolidation). Folds the proposed
 * `get_changelog` / `whats_new` tool into `get_spec_version` on BOTH servers
 * from one code path — parses the canonical CHANGELOG.md that ships with
 * `@unified-product-graph/core` (Keep-a-Changelog: `## [x.y.z] - date`).
 *
 * Best-effort by design: returns `[]` when the file is absent or unparseable,
 * never throws. The #16 CHANGELOG backfill enriches the SOURCE; this reader
 * must not block on it.
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface SpecChangelogEntry {
  version: string
  date: string
  body: string
}

/** Numeric-tuple semver compare. Returns >0 when `a` is newer than `b`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Parse core's CHANGELOG.md into entries. When `since` is given, returns only
 * entries strictly newer than it. Returns `[]` on any failure.
 */
export function readSpecChangelog(since?: string): SpecChangelogEntry[] {
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve('@unified-product-graph/core/package.json')
    const changelogPath = path.join(path.dirname(pkgJson), 'CHANGELOG.md')
    const raw = fs.readFileSync(changelogPath, 'utf-8')
    const headerRe = /^## \[([^\]]+)\] - (.+)$/gm
    const headers: { version: string; date: string; index: number; endOfLine: number }[] = []
    let m: RegExpExecArray | null
    while ((m = headerRe.exec(raw)) !== null) {
      headers.push({ version: m[1], date: m[2].trim(), index: m.index, endOfLine: headerRe.lastIndex })
    }
    const entries: SpecChangelogEntry[] = headers.map((h, i) => {
      const bodyStart = h.endOfLine
      const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : raw.length
      return { version: h.version, date: h.date, body: raw.slice(bodyStart, bodyEnd).trim() }
    })
    if (since) return entries.filter((e) => compareSemver(e.version, since) > 0)
    return entries
  } catch {
    return []
  }
}
