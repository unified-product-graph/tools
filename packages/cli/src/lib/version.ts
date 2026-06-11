/**
 * Single source of truth for the CLI version (CLI-FEEDBACK #5).
 *
 * Read from package.json at runtime so `upg --version`, the no-args logo, and
 * the `init` banner can never drift from each other or from the published
 * package. (Previously `init` printed the spec's `UPG_VERSION`, e.g. v0.8.0,
 * while `--version` reported the package version, e.g. 0.8.1.)
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// tsup bundles the whole CLI into a single `dist/cli.cjs`, so at runtime
// `import.meta.url` points at `dist/` and package.json sits one level up. But
// when imported from source (e.g. the help-drift regression test loads the
// command registry directly), this file lives at `src/lib/`, two levels deep.
// Walk up to the nearest package.json so the version resolves in both layouts.
function findPackageJson(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fall back to the bundled assumption (dist/../package.json).
  return resolve(start, '..', 'package.json')
}

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = findPackageJson(here)

export const CLI_VERSION = (
  JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
).version
