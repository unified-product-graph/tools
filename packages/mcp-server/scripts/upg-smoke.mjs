// One-shot smoke probe — read a .upg file and dump the anti-pattern evaluation.
// Not part of the test suite — meant for manual verification during PR review.
//
// Usage:
//   node scripts/upg-smoke.mjs --file path/to/product.upg
//   node scripts/upg-smoke.mjs --file test-fixtures/sample.upg
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { UPGFileStore } from '../src/store.js'
import { collectAntiPatternInputs } from '../src/lib/anti-pattern-inputs.js'
import { evaluateAntiPatterns } from '@unified-product-graph/core'

const __dirname = dirname(fileURLToPath(import.meta.url))

const { values } = parseArgs({
  options: { file: { type: 'string', short: 'f' } },
})

const upgPath = values.file
  ? resolve(values.file)
  : resolve(__dirname, '..', 'test-fixtures', 'sample.upg')

const store = new UPGFileStore()
await store.load(upgPath)
store.stopWatching()

const product = store.getProduct()
const inputs = collectAntiPatternInputs(store, product.stage)

console.log(`File: ${upgPath}`)
console.log(`Stage: ${product.stage}`)
console.log(`Total nodes: ${inputs.totalEntityCount}`)
console.log(`Domain count: ${inputs.domainCount}`)
console.log(`Orphan count: ${inputs.orphanCount}`)
console.log()

const fires = evaluateAntiPatterns(inputs)
console.log(`Anti-pattern fires (with stage gating @ ${product.stage}): ${fires.length}`)
for (const f of fires) {
  console.log(`  ${f.severity}: ${f.anti_pattern_id}`)
}

// Optional: re-evaluate without stage gating to see what would fire across the
// full catalog.
const allInputs = { ...inputs, productStage: undefined }
const allFires = evaluateAntiPatterns(allInputs)
console.log(`\nAll fires (stage gating off): ${allFires.length}`)
for (const f of allFires) {
  console.log(`  ${f.severity}: ${f.anti_pattern_id}`)
}

console.log()
console.log('Counts by relevant type:')
for (const t of ['persona', 'job', 'need', 'opportunity', 'feature', 'hypothesis_claim', 'experiment_run', 'objective', 'key_result', 'competitor', 'learning']) {
  console.log(`  ${t}: ${inputs.countsByType[t] ?? 0}`)
}
