import { describe, it, expect } from 'vitest'
import { parse } from '../parse.js'
import { toTipTapJSON } from '../to-tiptap.js'
import type { TipTapNode } from '../to-tiptap.js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findNodes(doc: { content: TipTapNode[] }, type: string): TipTapNode[] {
  const results: TipTapNode[] = []
  function walk(nodes: TipTapNode[]) {
    for (const node of nodes) {
      if (node.type === type) results.push(node)
      if (node.content) walk(node.content)
    }
  }
  walk(doc.content)
  return results
}

function makeDoc(body: string) {
  const source = `---
title: "Test"
upg_product: test
upg_version: "0.4.0"
entity_type: document
entity_id: doc_test
---

${body}`
  return toTipTapJSON(parse(source))
}

// ─── Basic structure ──────────────────────────────────────────────────────────

describe('toTipTapJSON basic structure', () => {
  it('produces a doc node', () => {
    const doc = makeDoc('Hello world.')
    expect(doc.type).toBe('doc')
    expect(doc.content.length).toBeGreaterThan(0)
  })

  it('converts paragraphs', () => {
    const doc = makeDoc('Hello world.')
    expect(doc.content[0].type).toBe('paragraph')
    expect(doc.content[0].content?.[0]?.text).toBe('Hello world.')
  })

  it('converts headings with level', () => {
    const doc = makeDoc('## Section Title')
    const heading = doc.content[0]
    expect(heading.type).toBe('heading')
    expect(heading.attrs?.level).toBe(2)
    expect(heading.content?.[0]?.text).toBe('Section Title')
  })

  it('converts bullet lists', () => {
    const doc = makeDoc('- Item one\n- Item two\n- Item three')
    const list = doc.content[0]
    expect(list.type).toBe('bulletList')
    expect(list.content?.length).toBe(3)
    expect(list.content?.[0]?.type).toBe('listItem')
  })

  it('converts numbered lists', () => {
    const doc = makeDoc('1. First\n2. Second')
    const list = doc.content[0]
    expect(list.type).toBe('orderedList')
    expect(list.content?.length).toBe(2)
  })

  it('converts code blocks', () => {
    const doc = makeDoc('```typescript\nconst x = 1\n```')
    const code = doc.content[0]
    expect(code.type).toBe('codeBlock')
    expect(code.attrs?.language).toBe('typescript')
    expect(code.content?.[0]?.text).toBe('const x = 1')
  })

  it('converts horizontal rules', () => {
    const doc = makeDoc('Above\n\n---\n\nBelow')
    const hrs = findNodes(doc, 'horizontalRule')
    expect(hrs.length).toBe(1)
  })

  it('converts blockquotes', () => {
    const doc = makeDoc('> This is a quote')
    const bq = doc.content[0]
    expect(bq.type).toBe('blockquote')
  })
})

// ─── Inline formatting ───────────────────────────────────────────────────────

describe('inline formatting', () => {
  it('converts bold text', () => {
    const doc = makeDoc('This is **bold** text.')
    const para = doc.content[0]
    const boldNode = para.content?.find(n => n.marks?.some(m => m.type === 'bold'))
    expect(boldNode).toBeDefined()
    expect(boldNode!.text).toBe('bold')
  })

  it('converts italic text', () => {
    const doc = makeDoc('This is *italic* text.')
    const para = doc.content[0]
    const italicNode = para.content?.find(n => n.marks?.some(m => m.type === 'italic'))
    expect(italicNode).toBeDefined()
    expect(italicNode!.text).toBe('italic')
  })

  it('converts inline code', () => {
    const doc = makeDoc('Use `parse()` function.')
    const para = doc.content[0]
    const codeNode = para.content?.find(n => n.marks?.some(m => m.type === 'code'))
    expect(codeNode).toBeDefined()
    expect(codeNode!.text).toBe('parse()')
  })
})

// ─── Entity references ───────────────────────────────────────────────────────

describe('entity references', () => {
  it('converts basic entity ref to upgEntityRef node', () => {
    const doc = makeDoc('Our user is [[persona:alex]].')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.entityType).toBe('persona')
    expect(refs[0].attrs?.entityId).toBe('alex')
    expect(refs[0].attrs?.isCreation).toBe(false)
  })

  it('preserves display text', () => {
    const doc = makeDoc('We ran [[experiment:pilot|"the Q2 pilot"]].')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.displayText).toBe('the Q2 pilot')
  })

  it('preserves inline properties', () => {
    const doc = makeDoc('The [[need:ssot|valence:pain|severity:Significant]] is critical.')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.properties).toEqual({ valence: 'pain', severity: 'Significant' })
  })

  it('handles creation references', () => {
    const doc = makeDoc('Found [[+need:new-pain|valence:pain|"A new pain"]].')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.isCreation).toBe(true)
    expect(refs[0].attrs?.entityType).toBe('need')
    expect(refs[0].attrs?.displayText).toBe('A new pain')
  })

  it('places text before and after ref correctly', () => {
    const doc = makeDoc('Before [[persona:alex]] after.')
    const para = doc.content[0]
    expect(para.content?.length).toBe(3)
    expect(para.content?.[0]?.text).toBe('Before ')
    expect(para.content?.[1]?.type).toBe('upgEntityRef')
    expect(para.content?.[2]?.text).toBe(' after.')
  })

  it('handles multiple refs on one line', () => {
    const doc = makeDoc('Both [[persona:alex]] and [[need:ssot]] matter.')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(2)
    expect(refs[0].attrs?.entityId).toBe('alex')
    expect(refs[1].attrs?.entityId).toBe('ssot')
  })

  it('does not convert refs inside code blocks', () => {
    const doc = makeDoc('```\n[[persona:alex]]\n```')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(0)
  })

  it('converts ref inside a heading', () => {
    const doc = makeDoc('## About [[persona:alex]]')
    const heading = doc.content[0]
    expect(heading.type).toBe('heading')
    const refs = findNodes({ content: heading.content ?? [] }, 'upgEntityRef')
    expect(refs.length).toBe(1)
  })

  it('converts ref inside a list item', () => {
    const doc = makeDoc('- Check [[persona:alex]]')
    const refs = findNodes(doc, 'upgEntityRef')
    expect(refs.length).toBe(1)
  })
})

// ─── Edge references ──────────────────────────────────────────────────────────

describe('edge references', () => {
  it('converts edge ref to upgEdgeRef node', () => {
    const doc = makeDoc('{{insight:frag -> opportunity:opp|informs}} the plan.')
    const refs = findNodes(doc, 'upgEdgeRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.sourceType).toBe('insight')
    expect(refs[0].attrs?.sourceId).toBe('frag')
    expect(refs[0].attrs?.targetType).toBe('opportunity')
    expect(refs[0].attrs?.targetId).toBe('opp')
    expect(refs[0].attrs?.verb).toBe('informs')
  })

  it('handles unicode arrow', () => {
    const doc = makeDoc('{{persona:alex → job:align|pursues}} alignment.')
    const refs = findNodes(doc, 'upgEdgeRef')
    expect(refs.length).toBe(1)
    expect(refs[0].attrs?.verb).toBe('pursues')
  })
})

// ─── Real example file ───────────────────────────────────────────────────────

describe('real example: enterprise-pilot-results.upg.md', () => {
  const examplePath = resolve(__dirname, '../../../upg-spec/spec/examples/enterprise-pilot-results.upg.md')

  let source: string
  try {
    source = readFileSync(examplePath, 'utf-8')
  } catch {
    source = ''
  }

  it.skipIf(!source)('converts to TipTap JSON without errors', () => {
    const result = parse(source)
    const doc = toTipTapJSON(result)

    expect(doc.type).toBe('doc')
    expect(doc.content.length).toBeGreaterThan(5)
  })

  it.skipIf(!source)('contains entity ref nodes', () => {
    const result = parse(source)
    const doc = toTipTapJSON(result)
    const refs = findNodes(doc, 'upgEntityRef')

    // Should have multiple entity refs
    expect(refs.length).toBeGreaterThanOrEqual(8)

    // Check specific entities
    const types = refs.map(r => r.attrs?.entityType)
    expect(types).toContain('persona')
    expect(types).toContain('need')
    expect(types).toContain('hypothesis')
    expect(types).toContain('experiment')
  })

  it.skipIf(!source)('contains edge ref nodes', () => {
    const result = parse(source)
    const doc = toTipTapJSON(result)
    const refs = findNodes(doc, 'upgEdgeRef')

    expect(refs.length).toBeGreaterThanOrEqual(2)

    const verbs = refs.map(r => r.attrs?.verb)
    expect(verbs).toContain('informs')
    expect(verbs).toContain('produces')
  })

  it.skipIf(!source)('preserves headings and structure', () => {
    const result = parse(source)
    const doc = toTipTapJSON(result)

    const headings = findNodes(doc, 'heading')
    expect(headings.length).toBeGreaterThanOrEqual(5)

    // H1 title
    const h1 = headings.find(h => h.attrs?.level === 1)
    expect(h1).toBeDefined()
  })

  it.skipIf(!source)('has a creation ref for context-loss-between-sprints', () => {
    const result = parse(source)
    const doc = toTipTapJSON(result)
    const refs = findNodes(doc, 'upgEntityRef')

    const creationRef = refs.find(r => r.attrs?.isCreation === true)
    expect(creationRef).toBeDefined()
    expect(creationRef!.attrs?.entityId).toBe('context-loss-between-sprints')
  })
})
