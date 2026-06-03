/**
 * N2 (UPG QA 0.8.7) — MCP cross-tool parameter-name consistency. Each
 * "identify the thing" param accepts the canonical key OR the reasonable
 * first-guess alias, and missing/wrong-param errors name the expected key(s)
 * instead of leaking internal messages. The get_node alias is covered in
 * tool-registry.test.ts; this file covers get_framework and switch_product.
 */
import { describe, it, expect } from 'vitest'
import { getFramework } from '../tools/spec.js'
import { switchProduct } from '../tools/workspace.js'
import type { ToolContext } from '../lib/server-context.js'

const ctx = {} as ToolContext

describe('N2: get_framework accepts framework_id alias for id', () => {
  it('accepts framework_id as an alias for id', async () => {
    const viaId = await getFramework({ id: 'moscow' }, ctx)
    const viaAlias = await getFramework({ framework_id: 'moscow' }, ctx)
    expect(viaId.isError).toBeUndefined()
    expect(viaAlias.isError).toBeUndefined()
    expect(viaAlias.content[0].text).toBe(viaId.content[0].text)
  })
  it('error names both id and framework_id when neither passed', async () => {
    const r = await getFramework({}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/id/)
    expect(r.content[0].text).toMatch(/framework_id/)
  })
})

describe('N2: switch_product wrong-param error names the expected key', () => {
  it('names file (alias product) instead of leaking paths[0]', async () => {
    const r = await switchProduct({ wrongkey: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).not.toMatch(/paths\[0\]/)
    expect(r.content[0].text).toMatch(/file/)
    expect(r.content[0].text).toMatch(/product/)
  })
})
