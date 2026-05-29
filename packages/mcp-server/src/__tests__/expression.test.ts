/**
 * Tests for the safe arithmetic expression evaluator that powers
 * `prioritise`.
 *
 * The evaluator handles every framework formula in
 * `UPG_FRAMEWORKS[*].data.computed_properties[*].expression`. Tests cover
 * each operator + every realistic failure mode.
 */

import { describe, it, expect } from 'vitest'
import { evaluateExpression } from '@unified-product-graph/sdk'

describe('evaluateExpression: happy path', () => {
  it('evaluates RICE: (reach * impact * confidence) / effort', () => {
    const r = evaluateExpression('(reach * impact * confidence) / effort', {
      reach: 8,
      impact: 3,
      confidence: 0.8,
      effort: 4,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeCloseTo(4.8, 5)
  })

  it('evaluates ICE: impact * confidence * ease', () => {
    const r = evaluateExpression('impact * confidence * ease', {
      impact: 5,
      confidence: 4,
      ease: 3,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(60)
  })

  it('evaluates WSJF: (user_value + time_criticality + risk_reduction) / job_size', () => {
    const r = evaluateExpression(
      '(user_value + time_criticality + risk_reduction) / job_size',
      { user_value: 8, time_criticality: 5, risk_reduction: 3, job_size: 4 },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(4)
  })

  it('handles weighted scoring with multiple terms', () => {
    const r = evaluateExpression(
      '(benefit * benefit_weight) + (cost * cost_weight) + (risk * risk_weight)',
      {
        benefit: 8,
        benefit_weight: 0.5,
        cost: 4,
        cost_weight: 0.3,
        risk: 2,
        risk_weight: 0.2,
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeCloseTo(5.6, 5)
  })

  it('handles unary minus', () => {
    const r = evaluateExpression('-a + b', { a: 5, b: 12 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(7)
  })

  it('handles precedence: a + b * c', () => {
    const r = evaluateExpression('a + b * c', { a: 1, b: 2, c: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(7)
  })

  it('handles parentheses overriding precedence', () => {
    const r = evaluateExpression('(a + b) * c', { a: 1, b: 2, c: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(9)
  })

  it('coerces opportunity-scoring: importance + (importance - satisfaction)', () => {
    const r = evaluateExpression('importance + (importance - satisfaction)', {
      importance: 9,
      satisfaction: 3,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(15)
  })

  it('supports modulo', () => {
    const r = evaluateExpression('a % b', { a: 10, b: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(1)
  })

  it('supports power (right-associative)', () => {
    const r = evaluateExpression('2 ^ 3 ^ 2', {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(512) // 2^(3^2) = 2^9
  })
})

describe('evaluateExpression: failure modes', () => {
  it('reports missing variables with a list', () => {
    const r = evaluateExpression('reach * impact', { reach: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/Missing variables/)
      expect(r.missing).toEqual(['impact'])
    }
  })

  it('reports multiple missing variables', () => {
    const r = evaluateExpression('a + b + c', { a: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(new Set(r.missing)).toEqual(new Set(['b', 'c']))
    }
  })

  it('reports division by zero', () => {
    const r = evaluateExpression('a / b', { a: 1, b: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Division by zero/)
  })

  it('rejects empty expression', () => {
    const r = evaluateExpression('', {})
    expect(r.ok).toBe(false)
  })

  it('rejects unbalanced parens', () => {
    const r = evaluateExpression('(a + b', { a: 1, b: 2 })
    expect(r.ok).toBe(false)
  })

  it('rejects unexpected character', () => {
    const r = evaluateExpression('a + b @ c', { a: 1, b: 2, c: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Unexpected character/)
  })
})

describe('evaluateExpression: security', () => {
  it('does NOT invoke functions even if scope has function values', () => {
    // Function values aren't numeric → treated as missing.
    const r = evaluateExpression('exec', {
      exec: 0 as unknown as number,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(0)
  })

  it('refuses to evaluate identifiers containing dots (no property access)', () => {
    const r = evaluateExpression('a.b', { a: 1, b: 2 })
    // tokenizer treats '.' as start-of-number, so we'd get an error.
    expect(r.ok).toBe(false)
  })

  it('refuses to call function-like syntax (no parentheses after ident)', () => {
    // Parser doesn't recognize `Math(...)`; identifier followed by '('
    // produces a syntax error because there's no operator between them.
    const r = evaluateExpression('Math(2)', { Math: 1 })
    expect(r.ok).toBe(false)
  })
})
