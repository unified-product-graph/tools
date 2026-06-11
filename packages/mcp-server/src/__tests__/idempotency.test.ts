/**
 * Idempotent dispatch (batch-write duplicate-delivery fix).
 *
 * A re-delivered mutating MCP call (same JSON-RPC request id, e.g. a transport
 * resend) must not execute twice and write a second copy. This pins the
 * memoisation the tools/call handler wraps every call in.
 */
import { describe, it, expect } from 'vitest'
import { createIdempotentDispatch } from '../server.js'

describe('createIdempotentDispatch', () => {
  it('runs once per request id and replays the cached result on re-delivery', async () => {
    const d = createIdempotentDispatch<number>()
    let calls = 0
    const exec = async () => ++calls
    const first = await d.run('req-1', exec)
    const replay = await d.run('req-1', exec) // same id arrives again
    expect(calls).toBe(1)
    expect(first).toBe(1)
    expect(replay).toBe(1)
  })

  it('a concurrent re-delivery awaits the same in-flight execution (no second write)', async () => {
    const d = createIdempotentDispatch<number>()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const exec = async () => { calls++; await gate; return calls }
    const p1 = d.run('req-7', exec)
    const p2 = d.run('req-7', exec) // arrives while p1 is still in flight
    release()
    expect(await p1).toBe(1)
    expect(await p2).toBe(1)
    expect(calls).toBe(1)
  })

  it('distinct request ids execute independently', async () => {
    const d = createIdempotentDispatch<number>()
    let calls = 0
    const exec = async () => ++calls
    await d.run('a', exec)
    await d.run('b', exec)
    expect(calls).toBe(2)
  })

  it('an undefined request id is never memoised (always executes)', async () => {
    const d = createIdempotentDispatch<number>()
    let calls = 0
    const exec = async () => ++calls
    await d.run(undefined, exec)
    await d.run(undefined, exec)
    expect(calls).toBe(2)
  })

  it('evicts the oldest entry past the bound', async () => {
    const d = createIdempotentDispatch<number>(2)
    await d.run('a', async () => 1)
    await d.run('b', async () => 2)
    await d.run('c', async () => 3) // size 3 > 2 → evict oldest ('a')
    expect(d.has('a')).toBe(false)
    expect(d.has('b')).toBe(true)
    expect(d.has('c')).toBe(true)
  })
})
