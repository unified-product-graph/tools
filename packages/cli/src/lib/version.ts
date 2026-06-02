/**
 * Single source of truth for the CLI version (CLI-FEEDBACK #5).
 *
 * Read from package.json at runtime so `upg --version`, the no-args logo, and
 * the `init` banner can never drift from each other or from the published
 * package. (Previously `init` printed the spec's `UPG_VERSION`, e.g. v0.8.0,
 * while `--version` reported the package version, e.g. 0.8.1.)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// NOTE: tsup bundles the whole CLI into a single `dist/cli.cjs`, so at runtime
// `import.meta.url` always points at `dist/`, regardless of this file's source
// location. The package.json therefore sits one level up (`dist/../`).
const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(here, '..', 'package.json')

export const CLI_VERSION = (
  JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
).version
