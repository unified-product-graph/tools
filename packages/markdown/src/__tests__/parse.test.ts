import { describe, it, expect } from 'vitest'
import { parse } from '../parse.js'
import { buildIndex } from '../index-builder.js'
import { toPlainMarkdown } from '../export.js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MINIMAL = `---
title: "Test Document"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

# Test

Our persona is [[persona:alex]].
`

const FULL_SYNTAX = `---
title: "Full Syntax Test"
upg_product: acme-compass
upg_version: "0.4.0"
entity_type: document
entity_id: doc_full_test
author: Alice Chen
created_at: 2026-04-07
tags: [test, syntax]
status: draft
composition_pattern: experiment_report
graph_source: test.upg
---

# Full Syntax Test

## Basic reference
Our primary user is [[persona:alex-senior-pm]].

## Display override
We validated with [[experiment:enterprise-pilot-q2|"the Q2 pilot"]].

## Inline properties
The [[need:no-single-source-of-truth|valence:pain|severity:Significant]] is critical.

## Combined
[[need:no-single-source-of-truth|valence:pain|"the source-of-truth problem"]]

## Creation reference
We found [[+need:context-loss|valence:pain|severity:3|"Context loss between sprints"]].

## Edge reference
{{insight:tool-fragmentation -> opportunity:unified-knowledge|informs}} the roadmap.

## Edge with arrow unicode
{{persona:alex-senior-pm → job:keep-team-aligned|pursues}} alignment.

## Reference in code block (should NOT be parsed)
\`\`\`
[[persona:should-not-parse]]
\`\`\`

## Inline code (should NOT be parsed)
The syntax is \`[[type:id]]\` for references.

## Multiple refs on one line
Both [[persona:alex-senior-pm]] and [[need:no-single-source-of-truth]] matter.
`

// ─── Frontmatter ──────────────────────────────────────────────────────────────

describe('frontmatter parsing', () => {
  it('extracts required fields', () => {
    const result = parse(MINIMAL)
    expect(result.errors).toHaveLength(0)
    expect(result.frontmatter.title).toBe('Test Document')
    expect(result.frontmatter.upg_product).toBe('test')
    expect(result.frontmatter.upg_version).toBe('0.4.0')
    expect(result.frontmatter.entity_type).toBe('document')
    expect(result.frontmatter.entity_id).toBe('doc_test')
  })

  it('extracts optional fields', () => {
    const result = parse(FULL_SYNTAX)
    expect(result.frontmatter.author).toBe('Alice Chen')
    expect(result.frontmatter.created_at).toBe('2026-04-07')
    expect(result.frontmatter.tags).toEqual(['test', 'syntax'])
    expect(result.frontmatter.status).toBe('draft')
    expect(result.frontmatter.composition_pattern).toBe('experiment_report')
    expect(result.frontmatter.graph_source).toBe('test.upg')
  })

  it('errors on missing frontmatter', () => {
    const result = parse('# No frontmatter\n\nJust text.')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].code).toBe('MISSING_FRONTMATTER')
  })

  it('errors on missing required fields', () => {
    const result = parse('---\ntitle: "Test"\n---\n\nBody.')
    const codes = result.errors.map(e => e.code)
    expect(codes).toContain('MISSING_REQUIRED_FIELD')
  })
})

// ─── Entity references ───────────────────────────────────────────────────────

describe('entity reference extraction', () => {
  it('extracts basic references', () => {
    const result = parse(MINIMAL)
    expect(result.entityRefs).toHaveLength(1)
    expect(result.entityRefs[0].type).toBe('persona')
    expect(result.entityRefs[0].id).toBe('alex')
    expect(result.entityRefs[0].isCreation).toBe(false)
  })

  it('extracts display overrides', () => {
    const result = parse(FULL_SYNTAX)
    const ref = result.entityRefs.find(r => r.id === 'enterprise-pilot-q2')
    expect(ref).toBeDefined()
    expect(ref!.displayText).toBe('the Q2 pilot')
  })

  it('extracts inline properties', () => {
    const result = parse(FULL_SYNTAX)
    const refs = result.entityRefs.filter(r => r.id === 'no-single-source-of-truth')
    expect(refs.length).toBeGreaterThan(0)

    const withProps = refs.find(r => r.properties.length > 0 && !r.displayText)
    expect(withProps).toBeDefined()
    expect(withProps!.properties).toContainEqual({ key: 'valence', value: 'pain' })
    expect(withProps!.properties).toContainEqual({ key: 'severity', value: 'Significant' })
  })

  it('extracts combined display + properties', () => {
    const result = parse(FULL_SYNTAX)
    const ref = result.entityRefs.find(
      r => r.id === 'no-single-source-of-truth' && r.displayText === 'the source-of-truth problem',
    )
    expect(ref).toBeDefined()
    expect(ref!.properties).toContainEqual({ key: 'valence', value: 'pain' })
  })

  it('extracts creation references', () => {
    const result = parse(FULL_SYNTAX)
    const ref = result.entityRefs.find(r => r.id === 'context-loss')
    expect(ref).toBeDefined()
    expect(ref!.isCreation).toBe(true)
    expect(ref!.type).toBe('need')
    expect(ref!.displayText).toBe('Context loss between sprints')
  })

  it('skips references inside code blocks', () => {
    const result = parse(FULL_SYNTAX)
    const shouldNotExist = result.entityRefs.find(r => r.id === 'should-not-parse')
    expect(shouldNotExist).toBeUndefined()
  })

  it('skips references inside inline code', () => {
    const result = parse(FULL_SYNTAX)
    // The inline code `[[type:id]]` should not be parsed
    const typeRef = result.entityRefs.find(r => r.type === 'type' && r.id === 'id')
    expect(typeRef).toBeUndefined()
  })

  it('handles multiple refs on one line', () => {
    const result = parse(FULL_SYNTAX)
    const alexRefs = result.entityRefs.filter(r => r.id === 'alex-senior-pm')
    const needRefs = result.entityRefs.filter(r => r.id === 'no-single-source-of-truth')
    expect(alexRefs.length).toBeGreaterThanOrEqual(2) // basic + multiple line
    expect(needRefs.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Edge references ──────────────────────────────────────────────────────────

describe('edge reference extraction', () => {
  it('extracts edge with ASCII arrow', () => {
    const result = parse(FULL_SYNTAX)
    const edge = result.edgeRefs.find(r => r.verb === 'informs')
    expect(edge).toBeDefined()
    expect(edge!.source).toEqual({ type: 'insight', id: 'tool-fragmentation' })
    expect(edge!.target).toEqual({ type: 'opportunity', id: 'unified-knowledge' })
  })

  it('extracts edge with unicode arrow', () => {
    const result = parse(FULL_SYNTAX)
    const edge = result.edgeRefs.find(r => r.verb === 'pursues')
    expect(edge).toBeDefined()
    expect(edge!.source).toEqual({ type: 'persona', id: 'alex-senior-pm' })
    expect(edge!.target).toEqual({ type: 'job', id: 'keep-team-aligned' })
  })
})

// ─── Reference index ──────────────────────────────────────────────────────────

describe('reference index', () => {
  it('deduplicates entities', () => {
    const result = parse(FULL_SYNTAX)
    const index = buildIndex(result)

    // alex-senior-pm appears multiple times but should be one entry
    const alex = index.entities.get('persona:alex-senior-pm')
    expect(alex).toBeDefined()
    expect(alex!.count).toBeGreaterThanOrEqual(2)
  })

  it('includes entities from edge refs', () => {
    const result = parse(FULL_SYNTAX)
    const index = buildIndex(result)

    // insight:tool-fragmentation only appears in an edge ref
    expect(index.entities.has('insight:tool-fragmentation')).toBe(true)
  })

  it('tracks creation refs', () => {
    const result = parse(FULL_SYNTAX)
    const index = buildIndex(result)

    expect(index.creationRefs).toContain('need:context-loss')
  })

  it('indexes edges', () => {
    const result = parse(FULL_SYNTAX)
    const index = buildIndex(result)

    expect(index.edges.length).toBe(2)
    const informsEdge = index.edges.find(e => e.verb === 'informs')
    expect(informsEdge).toBeDefined()
    expect(informsEdge!.source).toBe('insight:tool-fragmentation')
    expect(informsEdge!.target).toBe('opportunity:unified-knowledge')
  })
})

// ─── Plain markdown export ────────────────────────────────────────────────────

describe('plain markdown export', () => {
  it('strips frontmatter by default', async () => {
    const md = await toPlainMarkdown(MINIMAL)
    expect(md).not.toContain('---')
    expect(md).not.toContain('upg_product')
  })

  it('resolves references to humanised ids without resolver', async () => {
    const md = await toPlainMarkdown(MINIMAL)
    expect(md).toContain('Alex')
    expect(md).not.toContain('[[')
  })

  it('uses title resolver when provided', async () => {
    const titles: Record<string, string> = {
      'persona:alex': 'Alex the Senior PM',
    }
    const md = await toPlainMarkdown(MINIMAL, {
      resolveTitle: (key) => titles[key] ?? null,
    })
    expect(md).toContain('Alex the Senior PM')
  })

  it('preserves display text overrides', async () => {
    const doc = `---
title: "Test"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

We ran [[experiment:pilot|"the Q2 pilot"]].
`
    const md = await toPlainMarkdown(doc)
    expect(md).toContain('the Q2 pilot')
    expect(md).not.toContain('[[')
  })

  it('resolves edge references to prose', async () => {
    const doc = `---
title: "Test"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

{{insight:frag -> opportunity:unified|informs}} the roadmap.
`
    const md = await toPlainMarkdown(doc)
    expect(md).not.toContain('{{')
    expect(md).toContain('informs')
  })
})

// ─── Cross-product references ─────────────────────────────────────────────────

describe('cross-product references', () => {
  const makeDoc = (body: string) => `---
title: "Cross-Product Test"
upg_product: acme-compass
upg_version: "0.4.0"
entity_type: document
entity_id: doc_xp_test
---

${body}
`

  it('parses entity ref with @product suffix', () => {
    const result = parse(makeDoc('See [[persona:alex@other-product]] for details.'))
    expect(result.entityRefs).toHaveLength(1)
    const ref = result.entityRefs[0]
    expect(ref.type).toBe('persona')
    expect(ref.id).toBe('alex')
    expect(ref.product).toBe('other-product')
    expect(ref.isCreation).toBe(false)
  })

  it('parses creation ref with @product suffix', () => {
    const result = parse(makeDoc('We found [[+need:context-loss@external-product|"Context loss"]].'))
    expect(result.entityRefs).toHaveLength(1)
    const ref = result.entityRefs[0]
    expect(ref.type).toBe('need')
    expect(ref.id).toBe('context-loss')
    expect(ref.product).toBe('external-product')
    expect(ref.isCreation).toBe(true)
    expect(ref.displayText).toBe('Context loss')
  })

  it('parses edge ref with cross-product endpoints', () => {
    const result = parse(makeDoc('{{insight:frag@product-a -> opportunity:unified@product-b|informs}} the roadmap.'))
    expect(result.edgeRefs).toHaveLength(1)
    const edge = result.edgeRefs[0]
    expect(edge.source).toEqual({ type: 'insight', id: 'frag', product: 'product-a' })
    expect(edge.target).toEqual({ type: 'opportunity', id: 'unified', product: 'product-b' })
    expect(edge.verb).toBe('informs')
  })

  it('omits product when not present', () => {
    const result = parse(makeDoc('See [[persona:alex]] for details.'))
    expect(result.entityRefs).toHaveLength(1)
    expect(result.entityRefs[0].product).toBeUndefined()
  })

  it('includes product in index key', () => {
    const result = parse(makeDoc('See [[persona:alex@other-product]] for details.'))
    const index = buildIndex(result)
    expect(index.entities.has('persona:alex@other-product')).toBe(true)
    expect(index.entities.has('persona:alex')).toBe(false)
    const entry = index.entities.get('persona:alex@other-product')!
    expect(entry.product).toBe('other-product')
    expect(entry.key).toBe('persona:alex@other-product')
  })
})

// ─── Real example file ────────────────────────────────────────────────────────

describe('real example: enterprise-pilot-results.upg.md', () => {
  const examplePath = resolve(__dirname, '../../../upg-spec/spec/examples/enterprise-pilot-results.upg.md')

  let source: string
  try {
    source = readFileSync(examplePath, 'utf-8')
  } catch {
    source = '' // File might not exist in CI
  }

  it.skipIf(!source)('parses without errors', () => {
    const result = parse(source)
    expect(result.errors).toHaveLength(0)
    expect(result.frontmatter.title).toBe('Enterprise Pilot Results: Q2 2026')
    expect(result.frontmatter.upg_product).toBeTruthy()
    expect(result.frontmatter.composition_pattern).toBe('experiment_report')
  })

  it.skipIf(!source)('extracts all entity references', () => {
    const result = parse(source)
    const index = buildIndex(result)

    // Expected entities from the worked example
    const expectedEntities = [
      'persona:alex-senior-pm',
      'need:no-single-source-of-truth',
      'hypothesis:structured-knowledge-reduces-planning',
      'solution:unified-product-graph',
      'experiment:enterprise-pilot-q2',
      'learning:planning-time-reduction',
      'metric:planning-time',
      'objective:reduce-context-switching',
      'opportunity:unified-knowledge',
    ]

    for (const key of expectedEntities) {
      expect(index.entities.has(key), `Expected entity ${key} to be in index`).toBe(true)
    }
  })

  it.skipIf(!source)('finds creation reference', () => {
    const result = parse(source)
    const index = buildIndex(result)
    expect(index.creationRefs).toContain('need:context-loss-between-sprints')
  })

  it.skipIf(!source)('extracts edge references', () => {
    const result = parse(source)
    expect(result.edgeRefs.length).toBeGreaterThanOrEqual(3)

    const verbs = result.edgeRefs.map(e => e.verb)
    expect(verbs).toContain('informs')
    expect(verbs).toContain('pursues')
    expect(verbs).toContain('produces')
  })

  it.skipIf(!source)('code block refs are not parsed', () => {
    const result = parse(source)
    // The evidence chain at the bottom is inside a code block
    // Refs there should NOT be double-counted
    const index = buildIndex(result)

    // persona:alex-senior-pm should appear in prose, not just in code block
    const alex = index.entities.get('persona:alex-senior-pm')
    expect(alex).toBeDefined()
  })
})
