/**
 * Step resolver tests (ticket #3b, updated)
 *
 * Locks the W2 invariant on the CLI surface: a `domain_guide` step is
 * expanded at runtime by reading `DomainUsageGuide`. Adding a step that
 * points at a missing domain fails loudly.
 *
 * `WorkflowStep` was renamed to `Step` (private internal).
 * `sub_workflow` step kind was renamed to `sub_sequence`.
 */

import { describe, it, expect } from 'vitest'
import type { Step } from '@unified-product-graph/core'

import { resolveStep } from '../playbooks/step-resolver.js'

describe('resolveStep', () => {
 it('expands a domain_guide step from DomainUsageGuide at runtime', () => {
 const step: Step = {
 kind: 'domain_guide',
 order: 1,
 phase: 'Scope',
 domain_id: 'market_intelligence',
 }

 const resolved = resolveStep(step)
 expect(resolved.kind).toBe('domain_guide')
 if (resolved.kind === 'domain_guide') {
 expect(resolved.anchor_entity).toBe('competitive_analysis')
 expect(resolved.creation_sequence).toContain('competitor')
 expect(resolved.required_bridges.length).toBeGreaterThan(0)
 expect(resolved.anti_patterns.length).toBeGreaterThan(0)
 }
 })

 it('throws on a domain_guide step pointing at an unregistered domain', () => {
 const step: Step = {
 kind: 'domain_guide',
 order: 1,
 phase: 'Scope',
 domain_id: 'not_a_real_domain',
 }

 expect(() => resolveStep(step)).toThrow(/no DomainUsageGuide/)
 })

 it('passes through framework step unchanged', () => {
 const step: Step = {
 kind: 'framework',
 order: 1,
 phase: 'Validation',
 framework_id: 'lean-canvas',
 }

 const resolved = resolveStep(step)
 expect(resolved.kind).toBe('framework')
 if (resolved.kind === 'framework') {
 expect(resolved.framework_id).toBe('lean-canvas')
 }
 })

 it('passes through entity_sequence step unchanged', () => {
 const step: Step = {
 kind: 'entity_sequence',
 order: 1,
 phase: 'Setup',
 entity_types: ['persona', 'jtbd'],
 }

 const resolved = resolveStep(step)
 expect(resolved.kind).toBe('entity_sequence')
 if (resolved.kind === 'entity_sequence') {
 expect(resolved.entity_types).toEqual(['persona', 'jtbd'])
 }
 })

 it('passes through sub_sequence step unchanged', () => {
 const step: Step = {
 kind: 'sub_sequence',
 order: 1,
 phase: 'Discovery',
 sub_sequence_id: 'playbook:users-needs',
 }

 const resolved = resolveStep(step)
 expect(resolved.kind).toBe('sub_sequence')
 if (resolved.kind === 'sub_sequence') {
 expect(resolved.sub_sequence_id).toBe('playbook:users-needs')
 }
 })

 it('preserves step labels (name, phase, prompt_hint)', () => {
 const step: Step = {
 kind: 'domain_guide',
 order: 3,
 phase: 'Strategy',
 name: 'OKR set',
 prompt_hint: 'Define objectives and key results.',
 domain_id: 'strategy',
 }

 const resolved = resolveStep(step)
 expect(resolved.order).toBe(3)
 expect(resolved.phase).toBe('Strategy')
 expect(resolved.name).toBe('OKR set')
 expect(resolved.prompt_hint).toBe('Define objectives and key results.')
 })
})

describe('resolveStep: representative domain playbooks', () => {
 it.each([
 ['market_intelligence', 'competitive_analysis'],
 ['strategy', 'outcome'],
 ['validation', 'hypothesis'],
 ['engineering', 'service'],
 ['ux_design', 'user_journey'],
 ])(
 'domain %s resolves with anchor %s',
 (domain_id, expected_anchor_substring) => {
 const step: Step = {
 kind: 'domain_guide',
 order: 1,
 phase: 'Test',
 domain_id,
 }
 const resolved = resolveStep(step)
 expect(resolved.kind).toBe('domain_guide')
 if (resolved.kind === 'domain_guide') {
 expect(resolved.anchor_entity).toContain(expected_anchor_substring)
 expect(resolved.creation_sequence.length).toBeGreaterThan(0)
 }
 },
 )
})
