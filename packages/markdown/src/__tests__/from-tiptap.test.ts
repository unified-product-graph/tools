import { describe, it, expect } from 'vitest'
import { parse } from '../parse.js'
import { toTipTapJSON } from '../to-tiptap.js'
import { fromTipTapJSON } from '../from-tiptap.js'
import type { UPGMarkdownFrontmatter } from '../types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FM: UPGMarkdownFrontmatter = {
  title: 'Test Document',
  upg_product: 'test',
  upg_version: '0.4.0',
  entity_type: 'document',
  entity_id: 'doc_test',
}

function roundTrip(body: string): string {
  const source = `---
title: "Test Document"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

${body}`
  const parsed = parse(source)
  const tiptap = toTipTapJSON(parsed)
  return fromTipTapJSON(tiptap, { frontmatter: FM })
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

describe('frontmatter serialisation', () => {
  it('includes all required fields', () => {
    const result = roundTrip('Hello.')
    expect(result).toContain('title: "Test Document"')
    expect(result).toContain('upg_product: test')
    expect(result).toContain('upg_version: "0.4.0"')
    expect(result).toContain('entity_type: document')
    expect(result).toContain('entity_id: doc_test')
  })

  it('includes optional fields when present', () => {
    const fm: UPGMarkdownFrontmatter = {
      ...FM,
      author: 'Jordan Park',
      tags: ['test', 'spec'],
      status: 'draft',
      composition_pattern: 'experiment_report',
    }
    const tiptap = toTipTapJSON(parse(`---
title: "Test"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

Hello.`))
    const result = fromTipTapJSON(tiptap, { frontmatter: fm })
    expect(result).toContain('author: Jordan Park')
    expect(result).toContain('tags: [test, spec]')
    expect(result).toContain('status: draft')
    expect(result).toContain('composition_pattern: experiment_report')
  })
})

// ─── Basic markdown ───────────────────────────────────────────────────────────

describe('basic markdown round-trip', () => {
  it('preserves paragraphs', () => {
    const result = roundTrip('Hello world.')
    expect(result).toContain('Hello world.')
  })

  it('preserves headings', () => {
    const result = roundTrip('## Section Title')
    expect(result).toContain('## Section Title')
  })

  it('preserves bold', () => {
    const result = roundTrip('This is **bold** text.')
    expect(result).toContain('**bold**')
  })

  it('preserves italic', () => {
    const result = roundTrip('This is *italic* text.')
    expect(result).toContain('*italic*')
  })

  it('preserves inline code', () => {
    const result = roundTrip('Use `parse()` here.')
    expect(result).toContain('`parse()`')
  })

  it('preserves bullet lists', () => {
    const result = roundTrip('- Item one\n- Item two\n- Item three')
    expect(result).toContain('- Item one')
    expect(result).toContain('- Item two')
    expect(result).toContain('- Item three')
  })

  it('preserves numbered lists', () => {
    const result = roundTrip('1. First\n2. Second')
    expect(result).toContain('1. First')
    expect(result).toContain('2. Second')
  })

  it('preserves code blocks', () => {
    const result = roundTrip('```typescript\nconst x = 1\n```')
    expect(result).toContain('```typescript')
    expect(result).toContain('const x = 1')
  })

  it('preserves horizontal rules', () => {
    const result = roundTrip('Above\n\n---\n\nBelow')
    expect(result).toContain('---')
  })

  it('preserves blockquotes', () => {
    const result = roundTrip('> This is a quote')
    expect(result).toContain('> This is a quote')
  })
})

// ─── Entity references ───────────────────────────────────────────────────────

describe('entity reference round-trip', () => {
  it('preserves basic entity ref', () => {
    const result = roundTrip('Our user is [[persona:alex]].')
    expect(result).toContain('[[persona:alex]]')
  })

  it('preserves entity ref with display text', () => {
    const result = roundTrip('We ran [[experiment:pilot|"the Q2 pilot"]].')
    expect(result).toContain('[[experiment:pilot|"the Q2 pilot"]]')
  })

  it('preserves entity ref with properties', () => {
    const result = roundTrip('The [[need:ssot|valence:pain|severity:Significant]] is critical.')
    expect(result).toContain('[[need:ssot|valence:pain|severity:Significant]]')
  })

  it('preserves creation ref', () => {
    const result = roundTrip('Found [[+need:new-pain|valence:pain|"A new pain"]].')
    expect(result).toContain('[[+need:new-pain')
  })
})

// ─── Edge references ──────────────────────────────────────────────────────────

describe('edge reference round-trip', () => {
  it('preserves edge ref', () => {
    const result = roundTrip('{{insight:frag -> opportunity:opp|informs}} the plan.')
    // The raw is preserved, so it should contain the original
    expect(result).toContain('insight:frag')
    expect(result).toContain('opportunity:opp')
    expect(result).toContain('informs')
  })
})

// ─── Full round-trip ──────────────────────────────────────────────────────────

describe('full document round-trip', () => {
  it('preserves a complex document structure', () => {
    const body = `# Enterprise Pilot Results

## Background

Our primary persona [[persona:alex-senior-pm]] faces a need:
[[need:no-single-source-of-truth|valence:pain|severity:Significant]].

## What We Tested

- [[hypothesis:structured-knowledge|"The planning hypothesis"]]
- [[solution:unified-product-graph]]
- [[experiment:enterprise-pilot-q2]]

## Results

The experiment produced a 22% reduction.

1. Proceed with investment
2. Adjust the target
3. Investigate the new need`

    const result = roundTrip(body)

    // Structure preserved
    expect(result).toContain('# Enterprise Pilot Results')
    expect(result).toContain('## Background')
    expect(result).toContain('## What We Tested')
    expect(result).toContain('## Results')

    // Entity refs preserved
    expect(result).toContain('[[persona:alex-senior-pm]]')
    expect(result).toContain('[[need:no-single-source-of-truth')
    expect(result).toContain('[[hypothesis:structured-knowledge')
    expect(result).toContain('[[solution:unified-product-graph]]')

    // Lists preserved
    expect(result).toContain('- ')
    expect(result).toContain('1. Proceed')
  })
})
