/**
 * CLI wrapper for the portfolio-saturated fixture builder.
 *
 * The build logic lives in `src/testing/build-portfolio-saturated.ts` (so it can
 * be imported in-process by the E2E test without crossing the package rootDir).
 * This wrapper materialises the committed fixture on disk and writes
 * GENERATED-SUMMARY.json.
 *
 * Run: npx tsx scripts/build-portfolio-saturated.ts [targetDir]
 *   - no arg  → builds the committed fixture at test-fixtures/portfolio-saturated/
 *   - targetDir → builds into that dir instead (used by the E2E test)
 */

import { writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPortfolioSaturated } from '../src/testing/build-portfolio-saturated.js'

async function main() {
  const TARGET = process.argv[2]
    ? realpathSync(process.argv[2])
    : realpathSync(
        join(new URL('.', import.meta.url).pathname, '..', 'test-fixtures', 'portfolio-saturated'),
      )
  console.log(`Building portfolio-saturated fixture (Atlassian) at ${TARGET}`)
  const { summary } = await buildPortfolioSaturated(TARGET)
  writeFileSync(join(TARGET, 'GENERATED-SUMMARY.json'), JSON.stringify(summary, null, 2))
  console.log('\n=== Verification ===')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nDone. Fixture at ${TARGET}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
