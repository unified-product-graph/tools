import { describe, it, expect } from 'vitest'
import { updateRefs } from '../export.js'
import type { RefResolution } from '../export.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FM = `---
title: "Update Refs Test"
upg_product: acme-compass
upg_version: "0.4.0"
entity_type: document
entity_id: doc_update_refs_test
---

`

// ─── updateRefs ───────────────────────────────────────────────────────────────

describe('updateRefs', () => {
  it('updates entity ref type and id', async () => {
    const source = FM + 'See [[persona:old-id]] for details.\n'
    const resolver = (key: string): RefResolution | null => {
      if (key === 'persona:old-id') return { type: 'persona', id: 'new-id' }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[persona:new-id]]')
    expect(result).not.toContain('[[persona:old-id]]')
  })

  it('updates cross-product entity ref', async () => {
    const source = FM + 'See [[persona:alex@external-product]] here.\n'
    const resolver = (key: string): RefResolution | null => {
      if (key === 'persona:alex@external-product') {
        return { type: 'persona', id: 'alex-renamed', product: 'external-product' }
      }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[persona:alex-renamed@external-product]]')
    expect(result).not.toContain('[[persona:alex@external-product]]')
  })

  it('updates entity refs inside edge refs', async () => {
    const source = FM + '{{insight:old-src -> opportunity:old-tgt|informs}} the roadmap.\n'
    const resolver = (key: string): RefResolution | null => {
      if (key === 'insight:old-src') return { type: 'insight', id: 'new-src' }
      if (key === 'opportunity:old-tgt') return { type: 'opportunity', id: 'new-tgt' }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('{{insight:new-src -> opportunity:new-tgt|informs}}')
    expect(result).not.toContain('old-src')
    expect(result).not.toContain('old-tgt')
  })

  it('keeps original when resolver returns null', async () => {
    const source = FM + 'See [[persona:stays-same]] here.\n'
    const resolver = (_key: string): RefResolution | null => null
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[persona:stays-same]]')
  })

  it('preserves modifiers when rewriting entity ref', async () => {
    const source = FM + 'See [[persona:old-id|"Display Text"]] here.\n'
    const resolver = (key: string): RefResolution | null => {
      if (key === 'persona:old-id') return { type: 'persona', id: 'new-id' }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[persona:new-id|"Display Text"]]')
  })

  it('preserves creation prefix when rewriting entity ref', async () => {
    const source = FM + 'Found [[+need:old-id|valence:pain]] in session.\n'
    const resolver = (key: string): RefResolution | null => {
      if (key === 'need:old-id') return { type: 'need', id: 'new-id' }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[+need:new-id|valence:pain]]')
  })

  it('handles async resolver', async () => {
    const source = FM + 'See [[persona:async-id]] here.\n'
    const resolver = async (key: string): Promise<RefResolution | null> => {
      await Promise.resolve() // simulate async work
      if (key === 'persona:async-id') return { type: 'persona', id: 'resolved-id' }
      return null
    }
    const result = await updateRefs(source, resolver)
    expect(result).toContain('[[persona:resolved-id]]')
  })
})
