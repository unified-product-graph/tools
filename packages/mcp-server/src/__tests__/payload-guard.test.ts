/**
 * Unit tests for the pre-flight payload-size estimator.
 *
 * The estimator is heuristic; these tests assert monotonicity, threshold
 * behaviour at the soft/hard boundaries, and env-var overrides. The
 * end-to-end refusal-via-tool-handler check lives in
 * `read-tool-guardrail.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  estimatePayloadBytes,
  preflightPayload,
  getSoftLimit,
  getHardLimit,
} from '../lib/payload-guard.js'

describe('estimatePayloadBytes', () => {
  it('returns 0 for an empty graph', () => {
    expect(estimatePayloadBytes({ nodeCount: 0, edgeCount: 0 })).toBe(0)
  })

  it('is monotonic in node count', () => {
    const a = estimatePayloadBytes({ nodeCount: 10, edgeCount: 0 })
    const b = estimatePayloadBytes({ nodeCount: 100, edgeCount: 0 })
    expect(b).toBeGreaterThan(a)
  })

  it('is monotonic in edge count', () => {
    const a = estimatePayloadBytes({ nodeCount: 0, edgeCount: 10 })
    const b = estimatePayloadBytes({ nodeCount: 0, edgeCount: 100 })
    expect(b).toBeGreaterThan(a)
  })

  it('counts compact edges as cheaper than full edges', () => {
    const full = estimatePayloadBytes({ nodeCount: 0, edgeCount: 100 })
    const compact = estimatePayloadBytes({ nodeCount: 0, edgeCount: 100, compactEdges: true })
    expect(compact).toBeLessThan(full)
  })
})

describe('env-tunable limits', () => {
  const ORIGINAL_SOFT = process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
  const ORIGINAL_HARD = process.env.UPG_MCP_PAYLOAD_HARD_LIMIT

  afterEach(() => {
    if (ORIGINAL_SOFT === undefined) delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    else process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT = ORIGINAL_SOFT
    if (ORIGINAL_HARD === undefined) delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
    else process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = ORIGINAL_HARD
  })

  it('defaults to 50K soft / 150K hard', () => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
    expect(getSoftLimit()).toBe(50_000)
    expect(getHardLimit()).toBe(150_000)
  })

  it('reads valid overrides from env vars', () => {
    process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT = '10000'
    process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = '20000'
    expect(getSoftLimit()).toBe(10_000)
    expect(getHardLimit()).toBe(20_000)
  })

  it('falls back to defaults on garbage env values', () => {
    process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT = 'not-a-number'
    process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = '-5'
    expect(getSoftLimit()).toBe(50_000)
    expect(getHardLimit()).toBe(150_000)
  })
})

describe('preflightPayload', () => {
  beforeEach(() => {
    delete process.env.UPG_MCP_PAYLOAD_SOFT_LIMIT
    delete process.env.UPG_MCP_PAYLOAD_HARD_LIMIT
  })

  it('returns ok for tiny payloads', () => {
    const outcome = preflightPayload({
      toolName: 'list_nodes',
      nodeCount: 5,
      edgeCount: 5,
    })
    expect(outcome.kind).toBe('ok')
  })

  it('returns warn between soft and hard', () => {
    // 100 nodes × 800 = 80_000 bytes (between 50K soft and 150K hard)
    const outcome = preflightPayload({
      toolName: 'list_nodes',
      nodeCount: 100,
      edgeCount: 0,
    })
    expect(outcome.kind).toBe('warn')
    if (outcome.kind === 'warn') {
      expect(outcome.fields._warning).toMatch(/query/)
      expect(outcome.fields._payload_bytes).toBeGreaterThanOrEqual(50_000)
    }
  })

  it('returns refuse at or above hard', () => {
    // 200 nodes × 800 + 500 edges × 250 = 285_000 bytes (above 150K hard)
    const outcome = preflightPayload({
      toolName: 'list_nodes',
      nodeCount: 200,
      edgeCount: 500,
    })
    expect(outcome.kind).toBe('refuse')
    if (outcome.kind === 'refuse') {
      expect(outcome.result.isError).toBe(true)
      const msg = outcome.result.content[0].text
      expect(msg).toMatch(/query/)
      expect(msg).toMatch(/list_nodes/)
      expect(msg).toMatch(/UPG_MCP_PAYLOAD_HARD_LIMIT/)
    }
  })

  it('honours env overrides', () => {
    process.env.UPG_MCP_PAYLOAD_HARD_LIMIT = '5000'
    const outcome = preflightPayload({
      toolName: 'query',
      nodeCount: 10,
      edgeCount: 0,
    })
    // 10 × 800 = 8_000 > 5_000 hard
    expect(outcome.kind).toBe('refuse')
  })

  it('embeds the offending tool name and args hint in the refusal', () => {
    const outcome = preflightPayload({
      toolName: 'get_area_graph',
      nodeCount: 200,
      edgeCount: 500,
      argsHint: 'area_id=area_alpha, depth=5',
    })
    if (outcome.kind !== 'refuse') throw new Error('expected refuse')
    const msg = outcome.result.content[0].text
    expect(msg).toMatch(/get_area_graph/)
    expect(msg).toMatch(/area_id=area_alpha/)
  })
})
